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
  writeSessionSecret,
  DEFAULT_HOST,
  DEFAULT_PORT,
} from '../shared/paths.ts';
import { WS_PROTOCOL, sessionProtocol } from '../shared/wire.ts';
import { deriveUserId } from '../shared/identity.ts';
import type { Identity, Message, SendResponse, StartResponse, ServerFrame } from '../shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, '..', 'cli', 'achat.ts');

async function health(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
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
    if (await health(remote)) return;
    throw new Error(`achat daemon unreachable at ${remote} (ACHAT_SERVER). Is it running, and is this machine on the same network?`);
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
    body: JSON.stringify({ session, username }),
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
  const promise = new Promise<void>((resolve, reject) => {
    ws.on('open', () => onOpen?.());
    ws.on('message', (data) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data.toString()) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'message') onMessage(frame.message);
      else if (frame.type === 'error') reject(new Error(frame.error));
    });
    ws.on('close', () => resolve());
    ws.on('error', (err) => reject(err));
  });
  return { promise, close: () => ws.close() };
}

export { deriveUserId };
