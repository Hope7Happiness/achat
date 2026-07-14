// Filesystem layout for local state under ~/.achat (overridable via ACHAT_HOME).
//
//   ~/.achat/
//     achat.db               SQLite store (server-owned)
//     server.json            { host, port } — where the daemon is listening
//     sessions/<userId>      the session secret for that identity (0600), so the
//                            background `achat watch` process can authenticate as it
//     cursors/<userId>       last delivered global seq for `achat watch`, plain integer

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

export const DEFAULT_PORT = 4360;
export const DEFAULT_HOST = '127.0.0.1';

export function achatHome(): string {
  const home = process.env.ACHAT_HOME ?? join(homedir(), '.achat');
  mkdirSync(home, { recursive: true });
  return home;
}

// Where the daemon keeps attachment bytes. Files are big and binary; SQLite is neither the
// place for them nor needed — the message row already holds the metadata and the access rule.
export function filesDir(): string {
  const dir = join(achatHome(), 'files');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return join(achatHome(), 'achat.db');
}

interface ServerInfo {
  host: string;
  port: number;
}

export function serverInfoPath(): string {
  return join(achatHome(), 'server.json');
}

export function readServerInfo(): ServerInfo {
  const path = serverInfoPath();
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ServerInfo;
    } catch {
      /* fall through to defaults */
    }
  }
  return {
    host: process.env.ACHAT_HOST ?? DEFAULT_HOST,
    port: process.env.ACHAT_PORT ? Number(process.env.ACHAT_PORT) : DEFAULT_PORT,
  };
}

export function writeServerInfo(info: ServerInfo): void {
  writeFileSync(serverInfoPath(), JSON.stringify(info, null, 2));
}

// A remote daemon, e.g. ACHAT_SERVER=http://laptop.tailnet.ts.net:4360 (or https://…).
// When set, this machine is a pure client: it must never fall back to a local daemon,
// because a silently-spawned local one would be an empty parallel universe.
export function remoteServer(): string | null {
  const raw = process.env.ACHAT_SERVER?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

export function baseUrl(info = readServerInfo()): string {
  return remoteServer() ?? `http://${info.host}:${info.port}`;
}

export function wsUrl(info = readServerInfo()): string {
  const remote = remoteServer();
  if (!remote) return `ws://${info.host}:${info.port}/ws`;
  return `${remote.replace(/^http/, 'ws')}/ws`;
}

// ---- which code am I? ----
//
// The git commit of the checkout this process was launched from. Read once, at import: a
// daemon keeps serving the code it started with, so what matters is what is *running*, not
// what is on disk now. Reported by /health so a client can tell that the host is stale.

export function appDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function readCommit(): string {
  try {
    const head = readFileSync(join(appDir(), '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? readFileSync(join(appDir(), '.git', ref), 'utf8').trim() : head;
    return sha.slice(0, 7);
  } catch {
    return 'unknown';
  }
}

const COMMIT = readCommit();

export function runningCommit(): string {
  return COMMIT;
}

// ---- per-identity session secret (so the watcher process can auth as this userId) ----

function sessionPath(userId: string): string {
  const dir = join(achatHome(), 'sessions');
  mkdirSync(dir, { recursive: true });
  return join(dir, encodeURIComponent(userId));
}

export function readSessionSecret(userId: string): string | null {
  const path = sessionPath(userId);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim() || null;
}

export function writeSessionSecret(userId: string, secret: string): void {
  writeFileSync(sessionPath(userId), secret, { mode: 0o600 });
}

// ---- machine secret ----
//
// Long-lived, one per machine (~/.achat/machine.key). Usernames are owned by the machine
// that claimed them, so that a *new* session here can reclaim the name its own dead session
// left behind, while a session on any other machine never can. Presented like the session
// secret — the server keeps only its hash.

export function machineSecret(): string {
  const path = join(achatHome(), 'machine.key');
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  }
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

// ---- per-identity watch cursor ----

function cursorPath(userId: string): string {
  const dir = join(achatHome(), 'cursors');
  mkdirSync(dir, { recursive: true });
  return join(dir, encodeURIComponent(userId));
}

export function readCursor(userId: string): number {
  const path = cursorPath(userId);
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, 'utf8').trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function writeCursor(userId: string, seq: number): void {
  writeFileSync(cursorPath(userId), String(seq));
}
