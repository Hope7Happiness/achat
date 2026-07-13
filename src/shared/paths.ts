// Filesystem layout for local state under ~/.achat (overridable via ACHAT_HOME).
//
//   ~/.achat/
//     achat.db               SQLite store (server-owned)
//     server.json            { host, port } — where the daemon is listening
//     sessions/<userId>      the session secret for that identity (0600), so the
//                            background `achat watch` process can authenticate as it
//     cursors/<userId>       last delivered global seq for `achat watch`, plain integer

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

export const DEFAULT_PORT = 4360;
export const DEFAULT_HOST = '127.0.0.1';

export function achatHome(): string {
  const home = process.env.ACHAT_HOME ?? join(homedir(), '.achat');
  mkdirSync(home, { recursive: true });
  return home;
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
