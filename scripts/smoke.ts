// End-to-end smoke test. Runs the daemon in-process on a temp home, then exercises:
// register, live push, offline queue, unread-count semantics, non-destructive history,
// explicit mark-read, presence, username ownership, and rename-keeps-history.
// Run: node scripts/smoke.ts

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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

  // 5b. Read receipts: the mirror image of unread — has the PEER read what I sent?
  const r0 = await client.receipt(bobSecret, 'alice');
  check(r0.sent === 2 && r0.readByThem === 2 && r0.unreadByThem === 0, 'bob sees that alice read both of his messages');
  check(r0.readAt !== null, 'the receipt records when they read');

  const carolR = await client.receipt(carolSecret, 'alice');
  check(
    carolR.sent === 1 && carolR.readByThem === 0 && carolR.unreadByThem === 1,
    "carol sees that alice has NOT read hers (alice only marked bob's conversation read)",
  );

  // A receipt reflects explicit mark-read, not mere reading. Alice pulling up the history
  // must not tell carol she has read it — the badge and the receipt are the same state, and
  // that state is only moved by achat-mark-read.
  await client.history(aliceSecret, 'carol', 50);
  const carolAfterPeek = await client.receipt(carolSecret, 'alice');
  check(
    carolAfterPeek.unreadByThem === 1,
    'alice reading the history does not flip carol’s receipt (only mark-read does)',
  );

  // 5c. File transfer.
  const payload = Buffer.from('binary\x00\xff\xfe payload — not valid utf8 if mishandled');
  const srcPath = join(process.env.ACHAT_HOME!, 'outgoing.bin');
  writeFileSync(srcPath, payload);

  const fileMsg = await client.sendFile(bobSecret, 'alice', srcPath, 'here is that dump');
  check(fileMsg.message.file?.name === 'outgoing.bin', 'the file arrives as a message with an attachment');
  check(fileMsg.message.body === 'here is that dump', 'the note becomes the message body');

  const bobHistory = await client.history(aliceSecret, 'bob', 50);
  const withFile = bobHistory.find((m) => m.file);
  check(!!withFile?.file?.id, 'the attachment shows up in history (a file you cannot see is a file you never got)');

  const dl = await client.saveFile(aliceSecret, withFile!.file!.id, join(process.env.ACHAT_HOME!, 'incoming.bin'));
  check(
    readFileSync(dl.path).equals(payload),
    'the bytes round-trip exactly (binary is not mangled by a utf8 decode somewhere)',
  );

  // Access control is the message itself: carol was never sent this file.
  let outsiderBlocked = false;
  try {
    await client.saveFile(carolSecret, withFile!.file!.id);
  } catch {
    outsiderBlocked = true;
  }
  check(outsiderBlocked, 'someone the file was not sent to cannot fetch it');

  // 5d. Reclaiming a username must not orphan the mail addressed to the previous holder.
  //
  // Reported from the field: someone sent a file to an offline peer ("queued — they are
  // offline"), and moments later the whole conversation was empty — not even their own sent
  // message. It looked like the offline queue had lost it. It had not: the peer's machine had
  // opened a new window under the same name, which reclaimed it under a NEW userId, and the
  // message was addressed to the old one. Invisible to both sides. A name is how you are
  // addressed, so a name that moves must bring its mail with it.
  const dave1 = generateSecret();
  await client.start(dave1, 'dave');
  await client.send(aliceSecret, 'dave', 'sent while dave was offline');
  await client.sendFile(bobSecret, 'dave', srcPath, 'and a file, too');

  const dave2 = generateSecret(); // a NEW session on the same machine reclaims the name
  const reborn2 = await client.start(dave2, 'dave');
  check(reborn2.userId !== deriveUserId(dave1), 'sanity: the new dave session has a different userId');

  const aliceView = await client.history(aliceSecret, 'dave', 50);
  check(
    aliceView.some((m) => m.body === 'sent while dave was offline'),
    "the sender's own message survives the recipient reclaiming its name",
  );

  const daveUnread = await client.unread(dave2);
  check(daveUnread.total === 2, 'the new session inherits the mail addressed to the name (2 unread)');

  const daveFiles = await client.history(dave2, 'bob', 50);
  check(daveFiles.some((m) => m.file?.name === 'outgoing.bin'), 'the queued FILE survives the reclaim too');

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
