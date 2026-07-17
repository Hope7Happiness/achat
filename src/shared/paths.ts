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
import { randomBytes, createHash } from 'node:crypto';
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
//
// NB: the daemon's behaviour depends on this function, but paths.ts is deliberately OUTSIDE the
// daemon-code fingerprint (DAEMON_CODE_PATHS, below). If you change what the daemon reads from
// here, the fingerprint won't notice — add the relevant check yourself.
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

// ---- what code is the *daemon* running? ----
//
// runningCommit() is the whole-repo commit, which changes for a docs tweak, a hook, a
// client-only edit — none of which change how the daemon behaves. Comparing it cried "the
// host is running old code!" on every such change (false alarms train people to ignore the
// real one). So the daemon also fingerprints just the files its *behaviour* depends on, and
// clients compare THAT. A README or watch-guard change leaves it untouched; a real
// server/protocol change moves it.
//
// paths.ts is deliberately NOT in the list even though the daemon imports it: it also holds a
// lot of client-only state (session-user, cursors), so including it would reintroduce the
// false alarms. The daemon touches only a little of it (dbPath, filesDir), and so far those
// have only changed alongside server.ts — but that is an *observation*, not a guarantee, so a
// daemon-relevant change here can slip the fingerprint (see the note by filesDir). If you add a
// file the daemon's wire behaviour depends on, list it.
const DAEMON_CODE_PATHS = [
  'src/server/server.ts',
  'src/server/db.ts',
  'src/shared/wire.ts',
  'src/shared/identity.ts',
  'src/shared/types.ts',
];

function computeDaemonCodeHash(): string {
  try {
    const h = createHash('sha256');
    for (const rel of DAEMON_CODE_PATHS) {
      h.update(rel);
      h.update('\0');
      h.update(readFileSync(join(appDir(), rel)));
    }
    return h.digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
}

// Computed once at import — like COMMIT, what matters is the code this process is *running*,
// not what is on disk now.
const CODE_HASH = computeDaemonCodeHash();

export function daemonCodeHash(): string {
  return CODE_HASH;
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

// ---- per-window session→userId map (so a Stop hook can pick out THIS window's watcher) ----
//
// The watch-guard hook needs to know which running `achat watch --user <id>` is THIS window's.
// It keys off CLAUDE_CODE_SESSION_ID. THE LOAD-BEARING SUBTLETY, learned the hard way: the MCP
// server's CLAUDE_CODE_SESSION_ID is NOT the same as the hook's after a `--resume` or `/compact`
// — the MCP process gets respawned with a fresh id, while the Bash tools, the watcher they
// launch, and the hooks all keep the window's original, stable id. So the only value guaranteed
// same-source between writer and reader is the one on the Bash/watcher/hook side. That is why
// this map is written by the WATCHER (a Bash-launched process, same id as the hook), NOT by the
// MCP server. **Do not move the write back into the MCP** — it would key the map by an id the
// hook never sees, and every resumed window would false-block. Each watch launch overwrites its
// own key with the current userId, so the map self-heals on every relaunch and never needs the
// id to be globally stable — only writer==reader source. (This is the weaker, and therefore
// more durable, assumption.)
function sessionUserPath(sessionId: string): string {
  const dir = join(achatHome(), 'session-user');
  mkdirSync(dir, { recursive: true });
  return join(dir, encodeURIComponent(sessionId));
}

export function writeSessionUser(sessionId: string, userId: string): void {
  writeFileSync(sessionUserPath(sessionId), userId);
}

// Deliberately NO garbage collection of this map. It is tempting (old builds and the churning
// MCP id leave keys nobody reads), but any GC is actively dangerous, because the hook treats
// "entry present, no matching watcher" as the BLOCK signal — that is *exactly* the state of a
// live window whose watcher just died and needs rescuing. A cleaner cannot tell that from a
// truly-stale entry, so it would delete the very entries that are about to fire the guard,
// permanently de-guarding a deaf window (no entry → allowed idle → never woken → never
// re-registers). And GC buys nothing: a stale *value* self-heals (the watcher overwrites its
// own key on every launch), and an orphan *key* is never read (the hook only reads its own
// CLAUDE_CODE_SESSION_ID's entry, and session ids are non-reused UUIDs). Orphans are a few
// inert bytes each. Leave them.
