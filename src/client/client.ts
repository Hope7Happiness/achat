// Client library shared by the MCP server and the `achat` CLI.
// Wraps the daemon's HTTP + WebSocket API and can auto-start the daemon on demand.
// The caller identifies itself with a session secret; userId = hash(secret).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { WebSocket } from 'ws';
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

async function health(base: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
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

async function api<T>(path: string, session: string | null, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers as any) };
  if (session) headers['x-achat-session'] = session;
  const res = await fetch(`${baseUrl()}${path}`, { ...opts, headers });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(detail.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
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

export async function inbox(session: string, since: number): Promise<{ messages: Message[]; cursor: number }> {
  await ensureServer();
  const q = new URLSearchParams({ since: String(since) });
  return api<{ messages: Message[]; cursor: number }>(`/inbox?${q}`, session);
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

// Open a live WebSocket. Replays backlog after `since`, then streams new messages.
export function watch(
  session: string,
  since: number,
  onMessage: (m: Message) => void,
  onOpen?: () => void,
): { promise: Promise<void>; close: () => void } {
  const q = new URLSearchParams({ since: String(since) });
  // The secret rides in the subprotocol, never in the URL — see shared/wire.ts.
  const ws = new WebSocket(`${wsUrl()}?${q}`, [WS_PROTOCOL, sessionProtocol(session)]);

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
