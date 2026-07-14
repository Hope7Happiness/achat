// SQLite storage for the achat daemon. Uses Node's built-in node:sqlite (no native build).
//
// Identity: user_id (hash of a session secret) is the stable PK. username is a unique,
// mutable label owned by the MACHINE that claimed it: a new session there may reclaim a name
// its own dead session left behind, and a session on any other machine never may. See
// register() for why both halves of that are necessary.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Attachment, Identity, Message } from '../shared/types.ts';

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username "${username}" is taken by someone who is online`);
    this.name = 'UsernameTakenError';
  }
}

export class Db {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identities (
        user_id    TEXT PRIMARY KEY,
        username   TEXT UNIQUE,          -- nullable: a displaced identity keeps its id but loses its name
        machine_id TEXT,                 -- hash of the machine secret this identity came from
        created_at INTEGER NOT NULL,
        last_seen  INTEGER
      );
      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        seq        INTEGER NOT NULL,
        from_id    TEXT NOT NULL,
        from_name  TEXT NOT NULL,
        to_id      TEXT NOT NULL,
        to_name    TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_to_seq ON messages (to_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (from_id, to_id, seq);
      -- per-conversation read state: how far user_id has read messages from peer_id
      CREATE TABLE IF NOT EXISTS read_state (
        user_id       TEXT NOT NULL,
        peer_id       TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL,
        PRIMARY KEY (user_id, peer_id)
      );
      CREATE TABLE IF NOT EXISTS seq_counter (id INTEGER PRIMARY KEY CHECK (id = 0), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO seq_counter (id, value) VALUES (0, 0);
    `);
    // Added after the initial schema; older databases predate them.
    const identityCols = this.db.prepare('PRAGMA table_info(identities)').all() as { name: string }[];
    if (!identityCols.some((c) => c.name === 'machine_id')) {
      this.db.exec('ALTER TABLE identities ADD COLUMN machine_id TEXT');
    }
    const readCols = this.db.prepare('PRAGMA table_info(read_state)').all() as { name: string }[];
    if (!readCols.some((c) => c.name === 'read_at')) {
      this.db.exec('ALTER TABLE read_state ADD COLUMN read_at INTEGER');
    }
    // Attachments live on the message row, not in a table of their own. The bytes are on
    // disk; this is the metadata, denormalised like from_name so history stays
    // self-contained. It also *is* the access-control record: you may fetch a file exactly
    // when a message carrying it was sent by you or to you, so there is no second notion of
    // who owns what to keep in sync.
    const msgCols = this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    for (const [col, type] of [
      ['file_id', 'TEXT'],
      ['file_name', 'TEXT'],
      ['file_size', 'INTEGER'],
      ['file_sha256', 'TEXT'],
    ]) {
      if (!msgCols.some((c) => c.name === col)) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_file ON messages (file_id)');
  }

  private nextSeq(): number {
    this.db.exec('UPDATE seq_counter SET value = value + 1 WHERE id = 0');
    return (this.db.prepare('SELECT value FROM seq_counter WHERE id = 0').get() as { value: number }).value;
  }

  // Register or rename an identity.
  //
  // One session == one user, and sessions are short-lived, so a name has to outlive the
  // identity that holds it — otherwise reopening a window would find "alice" permanently
  // squatted by your own dead session, and the roster would fill with alice-2, alice-3.
  // But a name is also how you are *addressed*, so letting just anyone take an idle name
  // is impersonation: close your window, and someone else starts receiving your mail.
  //
  // So a name is owned by the **machine** that claimed it. A new session on that machine
  // reclaims it freely once the previous holder is offline; a session on any other machine
  // cannot, ever. The machine proves itself the same way a session does — it presents a
  // secret and the server keeps only the hash.
  register(
    userId: string,
    username: string,
    machineId: string,
    now: number,
    isOnline: (userId: string) => boolean,
  ): { userId: string; username: string } {
    this.db.exec('BEGIN');
    try {
      const holder = this.db
        .prepare('SELECT user_id, machine_id FROM identities WHERE username = ?')
        .get(username) as { user_id: string; machine_id: string | null } | undefined;

      if (holder && holder.user_id !== userId) {
        const sameMachine = !!machineId && holder.machine_id === machineId;
        if (!sameMachine || isOnline(holder.user_id)) throw new UsernameTakenError(username);
        this.db.prepare('UPDATE identities SET username = NULL WHERE user_id = ?').run(holder.user_id);
      }

      const exists = this.db.prepare('SELECT 1 FROM identities WHERE user_id = ?').get(userId);
      if (exists) {
        this.db
          .prepare('UPDATE identities SET username = ?, machine_id = ? WHERE user_id = ?')
          .run(username, machineId, userId);
      } else {
        this.db
          .prepare(
            'INSERT INTO identities (user_id, username, machine_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?)',
          )
          .run(userId, username, machineId, now, null);
      }
      this.db.exec('COMMIT');
      return { userId, username };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  usernameOf(userId: string): string | null {
    const row = this.db.prepare('SELECT username FROM identities WHERE user_id = ?').get(userId) as
      | { username: string | null }
      | undefined;
    return row?.username ?? null;
  }

  resolveUsername(username: string): string | null {
    const row = this.db.prepare('SELECT user_id FROM identities WHERE username = ?').get(username) as
      | { user_id: string }
      | undefined;
    return row?.user_id ?? null;
  }

  machineOf(userId: string): string | null {
    const row = this.db.prepare('SELECT machine_id FROM identities WHERE user_id = ?').get(userId) as
      | { machine_id: string | null }
      | undefined;
    return row?.machine_id ?? null;
  }

  // Forget an identity: it leaves the roster and frees its username.
  //
  // Messages are deliberately kept. Every message carries the sender's and recipient's name
  // as it was at send time, and unreadSummary falls back to that snapshot, so the other
  // party's history and unread counts survive intact — deleting an identity must not delete
  // someone else's conversation. Only the identity's own read cursors go with it.
  deleteIdentity(userId: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM read_state WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM identities WHERE user_id = ?').run(userId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Every identity claimed by this machine — used to sweep up the dead sessions it left
  // behind (one session == one user, so a busy machine accumulates them fast).
  identitiesOfMachine(machineId: string): { userId: string; username: string | null }[] {
    const rows = this.db
      .prepare('SELECT user_id, username FROM identities WHERE machine_id = ?')
      .all(machineId) as { user_id: string; username: string | null }[];
    return rows.map((r) => ({ userId: r.user_id, username: r.username }));
  }

  touchLastSeen(userId: string, now: number): void {
    this.db.prepare('UPDATE identities SET last_seen = ? WHERE user_id = ?').run(now, userId);
  }

  listIdentities(onlineIds: Set<string>): Identity[] {
    const rows = this.db
      .prepare('SELECT user_id, username, created_at, last_seen FROM identities WHERE username IS NOT NULL ORDER BY username')
      .all() as { user_id: string; username: string; created_at: number; last_seen: number | null }[];
    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      online: onlineIds.has(r.user_id),
      lastSeen: r.last_seen,
      createdAt: r.created_at,
    }));
  }

  insertMessage(
    fromId: string,
    fromName: string,
    toId: string,
    toName: string,
    body: string,
    now: number,
    file?: Attachment,
  ): Message {
    const seq = this.nextSeq();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO messages
           (id, seq, from_id, from_name, to_id, to_name, body, created_at, file_id, file_name, file_size, file_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        seq,
        fromId,
        fromName,
        toId,
        toName,
        body,
        now,
        file?.id ?? null,
        file?.name ?? null,
        file?.size ?? null,
        file?.sha256 ?? null,
      );
    return { id, seq, fromId, fromName, toId, toName, body, createdAt: now, ...(file ? { file } : {}) };
  }

  // May `userId` fetch this file? Exactly when a message carrying it was sent by them or to
  // them — the message is the access-control record, so there is nothing else to keep in sync.
  fileFor(fileId: string, userId: string): Attachment | null {
    const row = this.db
      .prepare(
        `SELECT file_name, file_size, file_sha256 FROM messages
         WHERE file_id = ? AND (from_id = ? OR to_id = ?) LIMIT 1`,
      )
      .get(fileId, userId, userId) as
      | { file_name: string; file_size: number; file_sha256: string }
      | undefined;
    if (!row) return null;
    return { id: fileId, name: row.file_name, size: row.file_size, sha256: row.file_sha256 };
  }

  // Messages addressed TO `userId` with seq greater than `since` (the inbox / unread feed).
  messagesForSince(userId: string, since: number): Message[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE to_id = ? AND seq > ? ORDER BY seq',
      )
      .all(userId, since) as RawMessage[];
    return rows.map(toMessage);
  }

  // Highest seq of any message addressed to `userId` (the inbox high-water mark).
  maxInboxSeq(userId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS hw FROM messages WHERE to_id = ?')
      .get(userId) as { hw: number };
    return row.hw;
  }

  // Highest seq of a message sent FROM peer TO user (used to mark a conversation read).
  latestFromPeer(userId: string, peerId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS hw FROM messages WHERE to_id = ? AND from_id = ?')
      .get(userId, peerId) as { hw: number };
    return row.hw;
  }

  markRead(userId: string, peerId: string, seq: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO read_state (user_id, peer_id, last_read_seq, read_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, peer_id) DO UPDATE SET
           last_read_seq = MAX(last_read_seq, excluded.last_read_seq),
           read_at       = excluded.read_at`,
      )
      .run(userId, peerId, seq, now);
  }

  // Has the peer read what I sent them?
  //
  // The same read_state row that drives *their* unread badge answers this, read from the
  // other side: it records how far they have read in the conversation with me. So a receipt
  // costs nothing extra to maintain — it is the existing state, queried by the sender.
  //
  // Read receipts are pull-only on purpose. They must never announce: a read is not news,
  // and waking an agent because someone opened its message would be the worst kind of
  // interruption — one that carries no information.
  receipt(
    me: string,
    peer: string,
  ): { lastReadSeq: number; readAt: number | null; sent: number; readByThem: number; unreadByThem: number } {
    const row = this.db
      .prepare('SELECT last_read_seq, read_at FROM read_state WHERE user_id = ? AND peer_id = ?')
      .get(peer, me) as { last_read_seq: number; read_at: number | null } | undefined;
    const lastReadSeq = row?.last_read_seq ?? 0;

    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS sent,
                COALESCE(SUM(CASE WHEN seq <= ? THEN 1 ELSE 0 END), 0) AS readByThem
         FROM messages WHERE from_id = ? AND to_id = ?`,
      )
      .get(lastReadSeq, me, peer) as { sent: number; readByThem: number };

    return {
      lastReadSeq,
      readAt: row?.read_at ?? null,
      sent: counts.sent,
      readByThem: counts.readByThem,
      unreadByThem: counts.sent - counts.readByThem,
    };
  }

  // Unread counts for `userId`, grouped by sender, plus the inbox high-water mark.
  unreadSummary(userId: string): { total: number; bySender: { username: string; count: number }[]; highWater: number } {
    const rows = this.db
      .prepare(
        `SELECT m.from_id AS fromId,
                COALESCE(id.username, MAX(m.from_name)) AS username,
                COUNT(*) AS count
         FROM messages m
         LEFT JOIN read_state r ON r.user_id = ? AND r.peer_id = m.from_id
         LEFT JOIN identities id ON id.user_id = m.from_id
         WHERE m.to_id = ? AND m.seq > COALESCE(r.last_read_seq, 0)
         GROUP BY m.from_id
         ORDER BY username`,
      )
      .all(userId, userId) as { fromId: string; username: string; count: number }[];
    const total = rows.reduce((n, r) => n + r.count, 0);
    return { total, bySender: rows.map((r) => ({ username: r.username, count: r.count })), highWater: this.maxInboxSeq(userId) };
  }

  // Last `limit` messages of the pairwise conversation between two userIds, chronological.
  conversation(aId: string, bId: string, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(aId, bId, bId, aId, limit) as RawMessage[];
    return rows.map(toMessage).reverse();
  }
}

interface RawMessage {
  id: string;
  seq: number;
  from_id: string;
  from_name: string;
  to_id: string;
  to_name: string;
  body: string;
  created_at: number;
  file_id: string | null;
  file_name: string | null;
  file_size: number | null;
  file_sha256: string | null;
}

function toMessage(r: RawMessage): Message {
  const message: Message = {
    id: r.id,
    seq: r.seq,
    fromId: r.from_id,
    fromName: r.from_name,
    toId: r.to_id,
    toName: r.to_name,
    body: r.body,
    createdAt: r.created_at,
  };
  if (r.file_id) {
    message.file = {
      id: r.file_id,
      name: r.file_name ?? 'file',
      size: r.file_size ?? 0,
      sha256: r.file_sha256 ?? '',
    };
  }
  return message;
}
