#!/usr/bin/env node
// achat CLI. The acting identity is a session secret, resolved from (in order):
//   --session <secret> | --user <userId> (reads the stored secret) | $ACHAT_SESSION
//
//   version                                       what code am I running, and what code is the daemon running?
//   update                                        pull + install, and restart the daemon if this machine hosts it
//   serve   [--host H] [--port P]                 run the daemon
//   start   [--session S] <username>              register / rename (prints userId; makes a secret if none)
//   send    --session S --to B <body...>          send a message
//   send-file --session S --to B <path> [--note]  send a file (arrives as a message with an attachment)
//   get-file  --session S <fileId> [--dest path]  download a file someone sent you (hash-verified)
//   list                                          roster + presence
//   history --session S --with B [--limit N]      print a conversation (does NOT mark read)
//   unread  --session S                           unread counts by sender (no bodies)
//   read    --session S --with B                  mark a conversation read
//   receipt --session S --with B                  has B read what you sent them? (pull-only)
//   watch   --user U | --session S [--timeout S]  block until a message arrives, notify, exit.
//                                                  Blocks forever by default and reconnects
//                                                  underneath, so exiting means "you have mail".
//                                                  (run via Claude Code background Bash for push)
//   forget  <username|userId>                     delete an identity this machine owns
//   prune                                         delete every offline identity this machine owns

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { startServer } from '../server/server.ts';
import * as client from '../client/client.ts';
import { generateSecret, deriveUserId } from '../shared/identity.ts';
import { dbPath, writeServerInfo, readCursor, writeCursor, readSessionSecret, runningCommit, appDir, baseUrl, DEFAULT_HOST, DEFAULT_PORT } from '../shared/paths.ts';
import type { Message } from '../shared/types.ts';

function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = 'true';
    } else positional.push(a);
  }
  return { flags, positional };
}

// Resolve the acting session secret from flags/env, or null if none provided.
function resolveSession(flags: Record<string, string>): string | null {
  if (flags.session) return flags.session;
  if (flags.user) {
    const s = readSessionSecret(flags.user);
    if (!s) throw new Error(`no stored session for user ${flags.user} — start that identity first`);
    return s;
  }
  return process.env.ACHAT_SESSION ?? null;
}

function requireSession(flags: Record<string, string>): string {
  const s = resolveSession(flags);
  if (!s) throw new Error('need an identity: pass --session <secret>, --user <userId>, or set ACHAT_SESSION');
  return s;
}

function fmt(m: Message): string {
  const line = `[${new Date(m.createdAt).toLocaleTimeString()}] ${m.fromName} → ${m.toName}: ${m.body}`;
  return m.file ? `${line}\n    \u{1F4CE} ${m.file.name} (${m.file.size} bytes)  id=${m.file.id}` : line;
}

// What code am I running, and what code is the daemon running? These drift: a daemon keeps
// serving whatever it started with, so `git pull` on the host changes nothing until it is
// restarted — and we lost time more than once to a host that was quietly stale.
async function cmdVersion(): Promise<void> {
  const local = runningCommit();
  process.stdout.write(`client   ${local}  (${appDir()})\n`);
  try {
    const h = await client.serverHealth();
    const stale = h.commit !== 'unknown' && local !== 'unknown' && h.commit !== local;
    process.stdout.write(`daemon   ${h.commit}  (${baseUrl()})${stale ? '   ← different code than this client' : ''}\n`);
    if (stale) process.stdout.write(`\nRun \`achat update\` on the daemon's machine to bring it up to date.\n`);
  } catch (err) {
    process.stdout.write(`daemon   unreachable (${(err as Error).message})\n`);
  }
}

// Update this machine's achat, whatever role it plays. Pull, install, and — if a daemon is
// supervised here — restart it, because otherwise the new code sits on disk doing nothing.
async function cmdUpdate(): Promise<void> {
  const dir = appDir();
  const before = runningCommit();
  const run = (cmd: string, args: string[]): string => {
    const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
    return (r.stdout ?? '').trim();
  };

  process.stdout.write(`updating ${dir} (currently ${before})\n`);
  run('git', ['pull', '--ff-only', '--quiet']);
  const after = readCommitFresh(dir);
  if (after === before) {
    process.stdout.write(`already up to date (${before})\n`);
  } else {
    process.stdout.write(`${before} → ${after}\n`);
  }
  // Dependencies can change with the code; installing when nothing moved is cheap and safe.
  // Drive npm with *this* node — the machine's `node` on PATH may be an ancient one (that is
  // why the installer ships a private Node at all), and npm on PATH belongs to it.
  const bundledNpm = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundledNpm)) run(process.execPath, [bundledNpm, 'install', '--silent', '--omit=dev']);
  else run('npm', ['install', '--silent', '--omit=dev']);

  const restarted = restartLocalDaemon();
  process.stdout.write(
    restarted
      ? `restarted the local daemon (${restarted}) — it is now running ${after}\n`
      : `no daemon supervised on this machine; new code takes effect when the MCP server restarts (open a new window)\n`,
  );
}

// Returns how it was restarted, or null if this machine does not host the daemon.
function restartLocalDaemon(): string | null {
  const mac = spawnSync('launchctl', ['list', 'com.achat.daemon'], { encoding: 'utf8' });
  if (mac.status === 0) {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.achat.daemon.plist');
    spawnSync('launchctl', ['unload', plist]);
    spawnSync('launchctl', ['load', plist]);
    return 'launchd';
  }
  const unit = spawnSync('systemctl', ['--user', 'is-enabled', 'achat.service'], { encoding: 'utf8' });
  if (unit.status === 0) {
    const r = spawnSync('systemctl', ['--user', 'restart', 'achat.service'], { encoding: 'utf8' });
    if (r.status === 0) return 'systemd';
  }
  return null;
}

function readCommitFresh(dir: string): string {
  const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

async function cmdServe(flags: Record<string, string>): Promise<void> {
  const host = flags.host ?? process.env.ACHAT_HOST ?? DEFAULT_HOST;
  const port = Number(flags.port ?? process.env.ACHAT_PORT ?? DEFAULT_PORT);
  const running = await startServer(dbPath(), host, port);
  writeServerInfo({ host, port: running.port });
  process.stderr.write(`achat daemon listening on http://${host}:${running.port}\n`);
  const shutdown = () => running.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdStart(flags: Record<string, string>, positional: string[]): Promise<void> {
  const username = positional[0];
  if (!username) throw new Error('usage: achat start [--session S] <username>');
  const generated = resolveSession(flags) === null;
  const session = resolveSession(flags) ?? generateSecret();
  const out = await client.start(session, username);
  process.stdout.write(`started as "${out.username}" (userId=${out.userId})\n`);
  if (generated) {
    process.stdout.write(`session secret (reuse via ACHAT_SESSION or --user ${out.userId}):\n  ${session}\n`);
  }
}

async function cmdSend(flags: Record<string, string>, positional: string[]): Promise<void> {
  const session = requireSession(flags);
  const to = flags.to;
  const body = positional.join(' ');
  if (!to || !body) throw new Error('usage: achat send --session S --to B <body>');
  const out = await client.send(session, to, body);
  process.stdout.write(`sent (delivered=${out.delivered})\n`);
}

async function cmdSendFile(flags: Record<string, string>, positional: string[]): Promise<void> {
  const session = requireSession(flags);
  const to = flags.to;
  const path = positional[0];
  if (!to || !path) throw new Error('usage: achat send-file --session S --to B <path> [--note "..."]');
  const out = await client.sendFile(session, to, path, flags.note);
  process.stdout.write(`sent ${out.message.file?.name} (${out.message.file?.size} bytes, delivered=${out.delivered})\n`);
}

async function cmdGetFile(flags: Record<string, string>, positional: string[]): Promise<void> {
  const session = requireSession(flags);
  const id = positional[0];
  if (!id) throw new Error('usage: achat get-file --session S <fileId> [--dest path]');
  const out = await client.saveFile(session, id, flags.dest);
  process.stdout.write(`saved ${out.size} bytes to ${out.path}\n`);
}

async function cmdList(): Promise<void> {
  const ids = await client.list();
  if (ids.length === 0) return void process.stdout.write('(no users yet)\n');
  for (const id of ids) {
    const seen = id.lastSeen ? new Date(id.lastSeen).toLocaleString() : 'never';
    process.stdout.write(`${id.online ? '●' : '○'} ${id.username}  [${id.userId}]  (last seen: ${seen})\n`);
  }
}

async function cmdHistory(flags: Record<string, string>): Promise<void> {
  const session = requireSession(flags);
  const other = flags.with;
  if (!other) throw new Error('usage: achat history --session S --with B [--limit N]');
  const msgs = await client.history(session, other, Number(flags.limit ?? 50));
  if (msgs.length === 0) return void process.stdout.write('(no messages)\n');
  for (const m of msgs) process.stdout.write(fmt(m) + '\n');
}

// Block until mail arrives, then print who it is from and exit.
//
// The exit is the announcement: Claude Code re-invokes the agent when a background process
// ends. So this must exit ONLY when there is actually mail. It used to also exit after a
// 30-minute idle timeout — which meant every idle window was woken every 30 minutes, as a
// *failure* (exit 2), to be told nothing had happened. The agent then had to reason about
// the "error" and relaunch, forever. That is pure context pollution, and it costs a turn
// each time.
//
// The timeout existed because a WebSocket can die quietly and leave the agent deaf. The
// answer to that is not to wake the agent periodically to check — it is for the watcher to
// heal itself: reconnect underneath, and stay silent while doing it. So "the process
// exited" now means exactly "you have mail", with no false positives.
async function cmdWatch(flags: Record<string, string>): Promise<void> {
  const session = requireSession(flags);
  const userId = deriveUserId(session);
  // Opt-in only (tests). 0 = block forever.
  const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 0;

  // Fail fast if the daemon is unreachable *now*: that is a real, actionable problem and it
  // wakes the agent once. Drops after a successful connection are transient and get healed
  // below without bothering anyone.
  await client.ensureServer();

  const since = readCursor(userId);
  const collected: Message[] = [];
  let maxSeq = since;
  let timedOut = false;
  let closeCurrent: (() => void) | null = null;

  if (timeoutMs) {
    setTimeout(() => {
      timedOut = true;
      closeCurrent?.();
    }, timeoutMs).unref();
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let backoff = 1000;

  while (collected.length === 0 && !timedOut) {
    let burstTimer: ReturnType<typeof setTimeout> | null = null;
    let openedAt = 0;

    const { promise, close } = client.watch(
      session,
      since,
      (m) => {
        collected.push(m);
        maxSeq = Math.max(maxSeq, m.seq);
        // Coalesce a burst so several messages arriving together are one announcement.
        if (burstTimer) clearTimeout(burstTimer);
        burstTimer = setTimeout(close, 300);
      },
      () => {
        openedAt = Date.now();
      },
    );
    closeCurrent = close;

    try {
      await promise;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // Being unregistered is not something reconnecting can fix.
      if (/not registered/i.test(message)) {
        process.stderr.write(`achat watch: ${message}\n`);
        process.exit(1);
      }
      // anything else is a network blip — fall through and reconnect
    }
    if (burstTimer) clearTimeout(burstTimer);
    if (collected.length > 0 || timedOut) break;

    // A connection that stayed up a while and then dropped is a blip, not a broken setup:
    // start the backoff over so a long-lived watcher reconnects promptly.
    if (openedAt && Date.now() - openedAt > 30_000) backoff = 1000;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }

  if (collected.length === 0) {
    process.stderr.write('achat watch: timed out with no new messages\n');
    process.exit(2);
  }
  writeCursor(userId, maxSeq); // advance the announce cursor so we don't re-notify

  const senders = [...new Set(collected.map((m) => m.fromName))].join(', ');
  const unread = await client.unread(session).catch(() => null);
  process.stdout.write(`📨 New message from: ${senders}\n`);
  if (unread) process.stdout.write(`${client.formatUnread(unread)} — read with: achat-history --with <user>\n`);
  process.exit(0);
}

async function cmdUnread(flags: Record<string, string>): Promise<void> {
  const session = requireSession(flags);
  process.stdout.write(client.formatUnread(await client.unread(session)) + '\n');
}

async function cmdRead(flags: Record<string, string>): Promise<void> {
  const session = requireSession(flags);
  const other = flags.with;
  if (!other) throw new Error('usage: achat read --session S --with B');
  const u = await client.markRead(session, other);
  process.stdout.write(`marked ${other} read. now: ${client.formatUnread(u)}\n`);
}

async function cmdReceipt(flags: Record<string, string>): Promise<void> {
  const session = requireSession(flags);
  const other = flags.with;
  if (!other) throw new Error('usage: achat receipt --session S --with B');
  process.stdout.write(client.formatReceipt(await client.receipt(session, other)) + '\n');
}

async function cmdForget(flags: Record<string, string>, positional: string[]): Promise<void> {
  const target = positional[0];
  if (!target) throw new Error('usage: achat forget <username|userId>');
  // Pass a session if we have one, so an identity can also forget *itself* while online.
  const session = flags.session ?? (flags.user ? readSessionSecret(flags.user) : null) ?? process.env.ACHAT_SESSION;
  const { forgotten } = await client.forget(target, session ?? undefined);
  process.stdout.write(`forgot ${target} (${forgotten})\n`);
}

async function cmdPrune(): Promise<void> {
  const { forgotten } = await client.prune();
  process.stdout.write(
    forgotten.length
      ? `forgot ${forgotten.length} offline identit${forgotten.length === 1 ? 'y' : 'ies'} owned by this machine: ${forgotten.join(', ')}\n`
      : 'nothing to forget — this machine has no offline identities\n',
  );
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const { flags, positional } = parseFlags(rest);
  switch (cmd) {
    case 'version': return cmdVersion();
    case 'update': return cmdUpdate();
    case 'serve': return cmdServe(flags);
    case 'start': return cmdStart(flags, positional);
    case 'send': return cmdSend(flags, positional);
    case 'send-file': return cmdSendFile(flags, positional);
    case 'get-file': return cmdGetFile(flags, positional);
    case 'list': return cmdList();
    case 'history': return cmdHistory(flags);
    case 'unread': return cmdUnread(flags);
    case 'read': return cmdRead(flags);
    case 'receipt': return cmdReceipt(flags);
    case 'watch': return cmdWatch(flags);
    case 'forget': return cmdForget(flags, positional);
    case 'prune': return cmdPrune();
    default:
      process.stderr.write('usage: achat <version|update|serve|start|send|send-file|get-file|list|history|unread|read|receipt|watch|forget|prune> ...\n');
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`achat: ${err.message ?? err}\n`);
  process.exit(1);
});
