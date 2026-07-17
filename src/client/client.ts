// Client library shared by the MCP server and the `achat` CLI.
// Wraps the daemon's HTTP + WebSocket API and can auto-start the daemon on demand.
// The caller identifies itself with a session secret; userId = hash(secret).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { WebSocket } from 'ws';
import { agentFor } from '../shared/proxy.ts';
import {
  readServerInfo,
  writeServerInfo,
  baseUrl,
  wsUrl,
  remoteServer,
  machineSecret,
  writeSessionSecret,
  DEFAULT_HOST,
  DEFAULT_PORT,
} from '../shared/paths.ts';
import { WS_PROTOCOL, sessionProtocol } from '../shared/wire.ts';
import { deriveUserId } from '../shared/identity.ts';
import type { Identity, Message, SendResponse, StartResponse, ServerFrame } from '../shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, '..', 'cli', 'achat.ts');

interface RawResponse {
  status: number;
  ok: boolean;
  body: Buffer;
  headers: Record<string, string | string[] | undefined>;
  text(): string;
}

// One HTTP path for everything, built on node:http rather than fetch — fetch cannot be given
// an agent, and on a machine reaching the tailnet through a userspace proxy the agent is the
// only thing that gets us there (see shared/proxy.ts). Keeping a single code path means the
// proxied and unproxied cases cannot drift apart.
function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number } = {},
): Promise<RawResponse> {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const agent = agentFor(target);
  const payload =
    opts.body === undefined ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, 'utf8');
  const headers = { ...(opts.headers ?? {}) };
  // Be explicit rather than letting node fall back to chunked encoding: body parsers decide
  // whether a request even *has* a body from these headers, and a DELETE that arrives with
  // no parsed body reads on the server as "you sent no credentials".
  if (payload) headers['content-length'] = String(payload.byteLength);

  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: opts.method ?? 'GET',
        headers,
        ...(agent ? { agent } : {}),
      },
      (res) => {
        // Collect bytes, not a string: the same path carries JSON and file downloads, and
        // decoding a binary body as utf8 would quietly corrupt it.
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks);
          resolve({
            status,
            ok: status >= 200 && status < 300,
            body,
            headers: res.headers,
            text: () => body.toString('utf8'),
          });
        });
      },
    );
    if (opts.timeoutMs) {
      req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`timed out after ${opts.timeoutMs}ms`)));
    }
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function health(base: string, timeoutMs = 1500): Promise<boolean> {
  try {
    return (await rawRequest(`${base}/health`, { timeoutMs })).ok;
  } catch {
    return false;
  }
}

function apiError(res: RawResponse): Error {
  let detail: { error?: string } = {};
  try {
    detail = JSON.parse(res.text()) as { error?: string };
  } catch {
    /* not JSON */
  }
  return new Error(detail.error ?? `HTTP ${res.status}`);
}

// Ensure a daemon is reachable; spawn a detached one and wait for it if not.
export async function ensureServer(): Promise<void> {
  const remote = remoteServer();
  if (remote) {
    // Pure-client mode: never auto-spawn. A local daemon here would be a separate,
    // empty world that silently swallows your messages.
    //
    // Retry with a generous timeout. The first packet to an idle tailnet peer has to do NAT
    // traversal (or fall back to a DERP relay), which routinely takes several seconds — far
    // longer than the sub-second round trip you get once the path is warm. A localhost-sized
    // timeout here reports a perfectly healthy daemon as unreachable.
    for (const timeout of [5000, 8000, 8000]) {
      if (await health(remote, timeout)) return;
    }
    throw new Error(
      `achat daemon unreachable at ${remote} (ACHAT_SERVER). Check that this machine is on the tailnet ` +
        `(tailscale status) and that the daemon is up on the host (systemctl --user status achat).`,
    );
  }
  if (await health(baseUrl(readServerInfo()))) return;

  const host = process.env.ACHAT_HOST ?? DEFAULT_HOST;
  const port = process.env.ACHAT_PORT ? Number(process.env.ACHAT_PORT) : DEFAULT_PORT;
  const child = spawn(process.execPath, [cliEntry, 'serve', '--host', host, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const base = `http://${host}:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await health(base)) {
      writeServerInfo({ host, port });
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`achat daemon did not come up on ${base}`);
}

async function api<T>(
  path: string,
  session: string | null,
  opts: { method?: string; body?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session) headers['x-achat-session'] = session;
  const res = await rawRequest(`${baseUrl()}${path}`, { ...opts, headers });
  if (!res.ok) throw apiError(res);
  return JSON.parse(res.text()) as T;
}

// Register (or rename). Persists the session secret locally so the watcher can auth as this userId.
export async function start(session: string, username: string): Promise<StartResponse> {
  await ensureServer();
  const out = await api<StartResponse>('/identities', null, {
    method: 'POST',
    body: JSON.stringify({ session, username, machine: machineSecret() }),
  });
  writeSessionSecret(out.userId, session);
  return out;
}

export async function send(session: string, to: string, body: string): Promise<SendResponse> {
  await ensureServer();
  return api<SendResponse>('/messages', session, { method: 'POST', body: JSON.stringify({ to, body }) });
}

// Send a local file. Returns the message that carries it.
export async function sendFile(
  session: string,
  to: string,
  filePath: string,
  note?: string,
): Promise<SendResponse> {
  await ensureServer();
  const bytes = readFileSync(filePath);
  const q = new URLSearchParams({ to, name: basename(filePath), ...(note ? { note } : {}) });
  const res = await rawRequest(`${baseUrl()}/files?${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-achat-session': session },
    body: bytes,
  });
  if (!res.ok) throw apiError(res);
  return JSON.parse(res.text()) as SendResponse;
}

// Download a file to `dest` (a path, or a directory to drop it into under its own name).
// Verifies the hash: a file that arrives corrupted must fail loudly, not sit on disk looking
// fine. Returns where it landed.
export async function saveFile(session: string, fileId: string, dest?: string): Promise<{ path: string; size: number }> {
  await ensureServer();
  const res = await rawRequest(`${baseUrl()}/files/${encodeURIComponent(fileId)}`, {
    headers: { 'x-achat-session': session },
  });
  if (!res.ok) throw apiError(res);

  const disposition = String(res.headers['content-disposition'] ?? '');
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fileId;
  const expected = String(res.headers['x-achat-sha256'] ?? '');
  const actual = createHash('sha256').update(res.body).digest('hex');
  if (expected && actual !== expected) {
    throw new Error(`file ${fileId} arrived corrupted (sha256 ${actual} != ${expected})`);
  }

  const target = dest && existsSync(dest) && statSync(dest).isDirectory() ? join(dest, name) : (dest ?? name);
  writeFileSync(target, res.body);
  return { path: resolve(target), size: res.body.length };
}

// What the daemon reports about itself, including the commit it is actually running.
export async function serverHealth(): Promise<{ ok: boolean; version: string; commit: string; code?: string }> {
  const res = await rawRequest(`${baseUrl()}/health`, { timeoutMs: 8000 });
  if (!res.ok) throw apiError(res);
  return JSON.parse(res.text()) as { ok: boolean; version: string; commit: string; code?: string };
}

export async function list(): Promise<Identity[]> {
  await ensureServer();
  return (await api<{ identities: Identity[] }>('/identities', null)).identities;
}

// Forget an identity, by username or userId. Authorised by this machine's ownership of it
// (and, for an identity that is still online, only by that identity itself).
export async function forget(target: string, session?: string): Promise<{ forgotten: string }> {
  await ensureServer();
  const roster = await list();
  const userId = roster.find((i) => i.username === target)?.userId ?? target;
  return api<{ forgotten: string }>(`/identities/${encodeURIComponent(userId)}`, session ?? null, {
    method: 'DELETE',
    body: JSON.stringify({ machine: machineSecret() }),
  });
}

// Sweep up every offline identity this machine left behind.
export async function prune(): Promise<{ forgotten: string[] }> {
  await ensureServer();
  return api<{ forgotten: string[] }>('/identities/prune', null, {
    method: 'POST',
    body: JSON.stringify({ machine: machineSecret() }),
  });
}

export async function history(session: string, other: string, limit = 50): Promise<Message[]> {
  await ensureServer();
  const q = new URLSearchParams({ with: other, limit: String(limit) });
  return (await api<{ messages: Message[] }>(`/messages?${q}`, session)).messages;
}

export interface UnreadSummary {
  total: number;
  bySender: { username: string; count: number }[];
  highWater: number;
}

// Count-only unread summary (no bodies, no state change).
export async function unread(session: string): Promise<UnreadSummary> {
  await ensureServer();
  return api<UnreadSummary>('/unread', session);
}

// Explicitly mark a conversation read. Returns the refreshed unread summary.
export interface Receipt {
  with: string;
  lastReadSeq: number;
  readAt: number | null;
  sent: number;
  readByThem: number;
  unreadByThem: number;
}

// Has the peer read what I sent them? Pull-only; never announced.
export async function receipt(session: string, withUser: string): Promise<Receipt> {
  await ensureServer();
  const q = new URLSearchParams({ with: withUser });
  return api<Receipt>(`/receipts?${q}`, session);
}

export function formatReceipt(r: Receipt): string {
  if (r.sent === 0) return `you have not sent ${r.with} anything`;
  if (r.unreadByThem === 0) {
    const when = r.readAt ? ` (last read ${new Date(r.readAt).toLocaleTimeString()})` : '';
    return `${r.with} has read all ${r.sent} of your messages${when}`;
  }
  const seen = r.readByThem === 0 ? 'none' : `${r.readByThem} of ${r.sent}`;
  return `${r.with} has read ${seen} — ${r.unreadByThem} still unread`;
}

export async function markRead(session: string, withUser: string): Promise<UnreadSummary> {
  await ensureServer();
  return api<UnreadSummary>('/read', session, { method: 'POST', body: JSON.stringify({ with: withUser }) });
}

// Human-readable one-liner like "3 unread (bob: 2, carol: 1)" or "no unread messages".
export function formatUnread(u: UnreadSummary): string {
  if (u.total === 0) return 'no unread messages';
  const breakdown = u.bySender.map((s) => `${s.username}: ${s.count}`).join(', ');
  return `${u.total} unread (${breakdown})`;
}

// Read-but-not-done: conversations you have seen but not marked handled.
export interface UndoneSummary {
  total: number;
  bySender: { username: string; count: number }[];
}

export async function undone(session: string): Promise<UndoneSummary> {
  await ensureServer();
  return api<UndoneSummary>('/undone', session);
}

export async function markDone(session: string, withUser: string): Promise<UndoneSummary> {
  await ensureServer();
  return api<UndoneSummary>('/done', session, { method: 'POST', body: JSON.stringify({ with: withUser }) });
}

export function formatUndone(u: UndoneSummary): string {
  if (u.total === 0) return 'nothing awaiting handling';
  const breakdown = u.bySender.map((s) => `${s.username}: ${s.count}`).join(', ');
  return `${u.total} read but not handled (${breakdown})`;
}

// Open a live WebSocket. Replays backlog after `since`, then streams new messages.
export function watch(
  session: string,
  since: number,
  onMessage: (m: Message) => void,
  onOpen?: () => void,
): { promise: Promise<void>; close: () => void } {
  const q = new URLSearchParams({ since: String(since) });
  const url = `${wsUrl()}?${q}`;
  // The secret rides in the subprotocol, never in the URL — see shared/wire.ts.
  // The agent is what carries the socket through a proxy when there is one (shared/proxy.ts);
  // ws upgrades over whatever socket the agent hands it, so a CONNECT tunnel just works.
  const agent = agentFor(url);
  const ws = new WebSocket(`${url}`, [WS_PROTOCOL, sessionProtocol(session)], agent ? { agent } : {});

  // Notice a server that vanished without closing the connection (host powered off, network
  // partition). The socket would otherwise stay OPEN for as long as TCP keeps retrying, and
  // a watcher sitting on it is deaf without knowing it — so it would never reconnect either.
  // The server pings every 30s; missing several of those means the far end is gone.
  const DEAD_AFTER_MS = Number(process.env.ACHAT_DEAD_MS ?? 90_000);
  let deadTimer: ReturnType<typeof setTimeout> | null = null;
  const bump = (): void => {
    if (deadTimer) clearTimeout(deadTimer);
    deadTimer = setTimeout(() => ws.terminate(), DEAD_AFTER_MS);
  };

  const promise = new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      bump();
      onOpen?.();
    });
    ws.on('ping', bump);
    ws.on('message', (data) => {
      bump();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString()) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'message') onMessage(frame.message);
      else if (frame.type === 'error') reject(new Error(frame.error));
    });
    ws.on('close', () => {
      if (deadTimer) clearTimeout(deadTimer);
      resolve();
    });
    ws.on('error', (err) => reject(err));
  });
  return { promise, close: () => ws.close() };
}

export { deriveUserId };
