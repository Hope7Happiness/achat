// SQLite storage for the achat daemon. Uses Node's built-in node:sqlite (no native build).
//
// Identity: user_id (hash of a session secret) is the stable PK. username is a unique,
// mutable label. A username currently held by an OFFLINE identity can be taken over by a
// new one (dead sessions shouldn't squat names); an ONLINE holder blocks it.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Identity, Message } from '../shared/types.ts';

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
  }

  private nextSeq(): number {
    this.db.exec('UPDATE seq_counter SET value = value + 1 WHERE id = 0');
    return (this.db.prepare('SELECT value FROM seq_counter WHERE id = 0').get() as { value: number }).value;
  }

  // Register or rename an identity. Enforces username uniqueness with offline-takeover.
  // `isOnline` decides whether a current holder blocks the takeover.
  register(
    userId: string,
    username: string,
    now: number,
    isOnline: (userId: string) => boolean,
  ): { userId: string; username: string } {
    this.db.exec('BEGIN');
    try {
      const holder = this.db
        .prepare('SELECT user_id FROM identities WHERE username = ?')
        .get(username) as { user_id: string } | undefined;

      if (holder && holder.user_id !== userId) {
        if (isOnline(holder.user_id)) throw new UsernameTakenError(username);
        // take the name from the offline holder
        this.db.prepare('UPDATE identities SET username = NULL WHERE user_id = ?').run(holder.user_id);
      }

      const exists = this.db.prepare('SELECT 1 FROM identities WHERE user_id = ?').get(userId);
      if (exists) {
        this.db.prepare('UPDATE identities SET username = ? WHERE user_id = ?').run(username, userId);
      } else {
        this.db
          .prepare('INSERT INTO identities (user_id, username, created_at, last_seen) VALUES (?, ?, ?, ?)')
          .run(userId, username, now, null);
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
  ): Message {
    const seq = this.nextSeq();
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO messages (id, seq, from_id, from_name, to_id, to_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, seq, fromId, fromName, toId, toName, body, now);
    return { id, seq, fromId, fromName, toId, toName, body, createdAt: now };
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

  markRead(userId: string, peerId: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO read_state (user_id, peer_id, last_read_seq) VALUES (?, ?, ?)
         ON CONFLICT (user_id, peer_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`,
      )
      .run(userId, peerId, seq);
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
}

function toMessage(r: RawMessage): Message {
  return {
    id: r.id,
    seq: r.seq,
    fromId: r.from_id,
    fromName: r.from_name,
    toId: r.to_id,
    toName: r.to_name,
    body: r.body,
    createdAt: r.created_at,
  };
}
