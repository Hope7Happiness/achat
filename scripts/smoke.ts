// End-to-end smoke test. Runs the daemon in-process on a temp home, then exercises:
// register, live push, offline queue, unread-count semantics, non-destructive history,
// explicit mark-read, presence, username ownership, and rename-keeps-history.
// Run: node scripts/smoke.ts

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ACHAT_HOME = mkdtempSync(join(tmpdir(), 'achat-smoke-'));
const PORT = 4399;
process.env.ACHAT_PORT = String(PORT);
process.env.ACHAT_HOST = '127.0.0.1';

const { startServer } = await import('../src/server/server.ts');
const client = await import('../src/client/client.ts');
const { generateSecret, deriveUserId } = await import('../src/shared/identity.ts');
const { dbPath, writeServerInfo, readCursor, writeCursor } = await import('../src/shared/paths.ts');
import type { Message } from '../src/shared/types.ts';

let failures = 0;
const check = (cond: boolean, label: string) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
};

const aliceSecret = generateSecret();
const bobSecret = generateSecret();
const carolSecret = generateSecret();
const aliceId = deriveUserId(aliceSecret);

const running = await startServer(dbPath(), '127.0.0.1', PORT);
writeServerInfo({ host: '127.0.0.1', port: PORT });
console.log(`daemon up on ${PORT}`);

// Register straight over HTTP with a *foreign* machine secret, i.e. as if from another box.
async function registerFromOtherMachine(session: string, username: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${PORT}/identities`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, username, machine: generateSecret() }),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
}

// Try to delete someone else's identity while presenting a foreign machine secret.
async function forgetFromOtherMachine(userId: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${PORT}/identities/${userId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machine: generateSecret() }),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
}

try {
  // 1. Register
  const a = await client.start(aliceSecret, 'alice');
  await client.start(bobSecret, 'bob');
  await client.start(carolSecret, 'carol');
  check(a.userId === aliceId && a.username === 'alice', 'alice registered with hashed userId');

  // 2. Live push over WebSocket delivers the message object to the client
  const received: Message[] = [];
  const w = client.watch(aliceSecret, readCursor(aliceId), (m) => received.push(m));
  await new Promise((r) => setTimeout(r, 200));
  const sendRes = await client.send(bobSecret, 'alice', 'hey alice, live ping');
  check(sendRes.delivered === true, 'send reports delivered (alice online via watch)');
  await new Promise((r) => setTimeout(r, 300));
  check(received.length === 1 && received[0].fromName === 'bob', 'watch delivered the message with sender snapshot');
  if (received.length) writeCursor(aliceId, received[received.length - 1].seq);
  w.close();
  await w.promise.catch(() => {});

  // 3. Unread is COUNT-only and grouped by sender
  await client.send(bobSecret, 'alice', 'second from bob');
  await client.send(carolSecret, 'alice', 'hi from carol');
  const u1 = await client.unread(aliceSecret);
  check(u1.total === 3, 'alice has 3 unread total');
  check(
    u1.bySender.find((s) => s.username === 'bob')?.count === 2 &&
      u1.bySender.find((s) => s.username === 'carol')?.count === 1,
    'unread breakdown is bob:2, carol:1',
  );

  // 4. Reading history is non-destructive; explicit mark-read clears that peer only
  const hist = await client.history(aliceSecret, 'bob', 50);
  check(hist.length === 2, 'history returns the full bob conversation');
  const uStill = await client.unread(aliceSecret);
  check(uStill.total === 3, 'reading history does NOT change unread (non-destructive)');
  const afterRead = await client.markRead(aliceSecret, 'bob');
  check(
    afterRead.total === 1 && afterRead.bySender[0]?.username === 'carol',
    'mark-read clears bob only, carol remains',
  );

  // 5. Offline queue: message to an offline user is queued and shows as unread on their side
  const off = await client.send(aliceSecret, 'carol', 'msg while carol offline');
  check(off.delivered === false, 'send to offline carol is queued');
  const cu = await client.unread(carolSecret);
  check(cu.total === 1 && cu.bySender[0]?.username === 'alice', 'carol sees 1 unread from alice');

  // 6. Username uniqueness while online
  const w2 = client.watch(aliceSecret, readCursor(aliceId), () => {});
  await new Promise((r) => setTimeout(r, 150));
  let taken = false;
  try {
    await client.start(generateSecret(), 'alice');
  } catch {
    taken = true;
  }
  check(taken, 'cannot claim a username held by an online user');
  w2.close();
  await w2.promise.catch(() => {});

  // 7. Rename keeps history (same userId)
  const renamed = await client.start(aliceSecret, 'alice-prime');
  check(renamed.userId === aliceId, 'rename preserves the same userId');
  const hist2 = await client.history(bobSecret, 'alice-prime', 50);
  check(hist2.some((m) => m.body === 'hey alice, live ping'), 'history follows the identity across the rename');

  // 8. Names are owned by the MACHINE. A new session on this machine reclaims the name its
  //    own dead session left behind (one session == one user, so this happens constantly).
  const carol2 = generateSecret();
  const c2 = await client.start(carol2, 'carol'); // carol is offline; same machine (same ACHAT_HOME)
  check(
    c2.username === 'carol' && c2.userId === deriveUserId(carol2),
    'a new session on the same machine reclaims its own offline username',
  );

  // 9. ...but a session on a DIFFERENT machine never can — that would be impersonation,
  //    since the username is how people address you.
  let blocked = false;
  try {
    await registerFromOtherMachine(generateSecret(), 'carol');
  } catch {
    blocked = true;
  }
  check(blocked, 'another machine cannot claim an offline username');

  // 10. Forgetting an identity. Same ownership rule: this machine may, another may not.
  let foreignBlocked = false;
  try {
    await forgetFromOtherMachine(deriveUserId(bobSecret));
  } catch {
    foreignBlocked = true;
  }
  check(foreignBlocked, 'another machine cannot forget an identity it does not own');

  // Leave alice with a fresh unread from bob, then delete bob out from under it.
  await client.send(bobSecret, 'alice-prime', 'one last word before I vanish');
  const before = await client.unread(aliceSecret);
  check(before.bySender.some((s) => s.username === 'bob'), 'sanity: alice has an unread from bob');

  await client.forget('bob');
  const rosterAfter = await client.list();
  check(!rosterAfter.some((i) => i.username === 'bob'), 'forget removes the identity from the roster');

  // Deleting an identity must not delete the other party's mail. The sender's name is
  // resolved from the message's own snapshot once the identity row is gone.
  const after = await client.unread(aliceSecret);
  check(
    after.total === before.total && after.bySender.some((s) => s.username === 'bob'),
    "alice's unread from bob survives, still named 'bob' via the message snapshot",
  );

  // 11. prune sweeps the offline identities this machine owns.
  const pruned = await client.prune();
  check(pruned.forgotten.length > 0, `prune forgot this machine's offline identities (${pruned.forgotten.join(', ')})`);
} finally {
  await running.close();
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
