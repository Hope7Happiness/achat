// Failure-mode tests. Not "does it work" — "what does it do when things break".
//
//   node scripts/robustness.ts
//
// Uses a real `achat watch` child process, because the interesting failures are process- and
// socket-level: a client that vanishes without closing its TCP connection, and a server that
// does the same. Ping intervals are shortened via ACHAT_PING_MS / ACHAT_DEAD_MS so the
// timeouts these tests exercise take seconds instead of minutes.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

const HOME = mkdtempSync(join(tmpdir(), 'achat-rob-'));
const PORT = 4404;
process.env.ACHAT_HOME = HOME;
process.env.ACHAT_PORT = String(PORT);
process.env.ACHAT_HOST = '127.0.0.1';
process.env.ACHAT_SERVER = `http://127.0.0.1:${PORT}`; // remote mode: the real deployment shape
process.env.ACHAT_PING_MS = '400'; // server pings this often; a socket missing one is reaped
process.env.ACHAT_DEAD_MS = '1500'; // watcher gives up on a silent server after this

const { startServer } = await import('../src/server/server.ts');
const client = await import('../src/client/client.ts');
const { generateSecret, deriveUserId } = await import('../src/shared/identity.ts');
const { dbPath, writeServerInfo, writeCursor } = await import('../src/shared/paths.ts');

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'achat.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (cond: boolean, label: string): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
};
const isOnline = async (name: string): Promise<boolean> =>
  (await client.list()).find((i) => i.username === name)?.online ?? false;

const aliceSecret = generateSecret();
const bobSecret = generateSecret();
const aliceId = deriveUserId(aliceSecret);

let server = await startServer(dbPath(), '127.0.0.1', PORT);
writeServerInfo({ host: '127.0.0.1', port: PORT });
await client.start(aliceSecret, 'alice');
await client.start(bobSecret, 'bob');

let watcher: ChildProcess | null = null;
const spawnWatcher = (): ChildProcess => {
  const child = spawn(process.execPath, [cli, 'watch', '--user', aliceId], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stderr!.on('data', (d) => process.stderr.write(`    [watcher] ${d}`));
  return child;
};

try {
  // ---- 1. A client that vanishes without closing its socket ------------------------------
  // Lid shut, network yanked, process wedged. TCP stays OPEN; no FIN ever arrives.
  watcher = spawnWatcher();
  await sleep(800);
  check(await isOnline('alice'), 'alice is online while her watcher is running');

  watcher.kill('SIGSTOP'); // frozen: socket open, nothing will ever answer on it again
  await sleep(2000); // > 2 ping sweeps
  check(!(await isOnline('alice')), 'a frozen client is reaped from the roster (presence does not lie)');

  const sent = await client.send(bobSecret, 'alice', 'you are a ghost');
  check(!sent.delivered, 'sending to a ghost reports delivered=false (delivery does not lie)');

  // The nastiest consequence: an identity that is "online" holds its username. A ghost that
  // is never reaped therefore locks its own name away from the next window on that machine
  // — forever. Once reaped, the name can be reclaimed.
  const nextSecret = generateSecret();
  const reborn = await client.start(nextSecret, 'alice');
  check(
    reborn.userId === deriveUserId(nextSecret) && reborn.username === 'alice',
    "a new session reclaims the ghost's username once the ghost is reaped",
  );

  watcher.kill('SIGCONT');
  watcher.kill('SIGKILL');
  watcher = null;

  // ---- 2. A server that vanishes without closing its sockets -----------------------------
  // The watcher must not sit deaf on a dead socket: it has to notice and reconnect.
  await client.start(aliceSecret, 'alice'); // re-take the name (same machine)
  // Advance the announce cursor past the backlog, exactly as achat-start does — otherwise a
  // fresh watcher is woken immediately by the messages it missed while it was gone (which is
  // correct behaviour, but it is not what this test is about).
  writeCursor(aliceId, (await client.unread(aliceSecret)).highWater);
  watcher = spawnWatcher();
  await sleep(800);
  check(await isOnline('alice'), 'alice is back online with a fresh watcher');

  await server.close(); // hard stop, sockets terminated
  await sleep(500);
  check(watcher.exitCode === null, 'the watcher stays alive (and silent) while the server is down');

  server = await startServer(dbPath(), '127.0.0.1', PORT);
  await sleep(3000); // watcher must reconnect on its own
  check(await isOnline('alice'), 'the watcher reconnected by itself after the server came back');

  const afterHeal = await client.send(bobSecret, 'alice', 'still there?');
  check(afterHeal.delivered, 'a message after the outage is delivered live to the healed watcher');

  const fired: string = await new Promise((resolve) => {
    let out = '';
    watcher!.stdout!.on('data', (d) => (out += d.toString()));
    watcher!.on('exit', () => resolve(out));
    setTimeout(() => resolve(out), 4000);
  });
  check(/New message from: bob/.test(fired), 'the watcher announced the message and exited');
} finally {
  watcher?.kill('SIGKILL');
  await server.close();
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
