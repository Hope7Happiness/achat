#!/usr/bin/env node
// achat CLI. The acting identity is a session secret, resolved from (in order):
//   --session <secret> | --user <userId> (reads the stored secret) | $ACHAT_SESSION
//
//   serve   [--host H] [--port P]                 run the daemon
//   start   [--session S] <username>              register / rename (prints userId; makes a secret if none)
//   send    --session S --to B <body...>          send a message
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

import { startServer } from '../server/server.ts';
import * as client from '../client/client.ts';
import { generateSecret, deriveUserId } from '../shared/identity.ts';
import { dbPath, writeServerInfo, readCursor, writeCursor, readSessionSecret, DEFAULT_HOST, DEFAULT_PORT } from '../shared/paths.ts';
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
  return `[${new Date(m.createdAt).toLocaleTimeString()}] ${m.fromName} → ${m.toName}: ${m.body}`;
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
    case 'serve': return cmdServe(flags);
    case 'start': return cmdStart(flags, positional);
    case 'send': return cmdSend(flags, positional);
    case 'list': return cmdList();
    case 'history': return cmdHistory(flags);
    case 'unread': return cmdUnread(flags);
    case 'read': return cmdRead(flags);
    case 'receipt': return cmdReceipt(flags);
    case 'watch': return cmdWatch(flags);
    case 'forget': return cmdForget(flags, positional);
    case 'prune': return cmdPrune();
    default:
      process.stderr.write('usage: achat <serve|start|send|list|history|unread|read|receipt|watch|forget|prune> ...\n');
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`achat: ${err.message ?? err}\n`);
  process.exit(1);
});
