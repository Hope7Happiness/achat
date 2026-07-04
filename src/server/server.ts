// The achat daemon: HTTP (request/response) + WebSocket (live push), backed by SQLite.
// Single source of truth for MCP clients, the CLI, and a future frontend.
//
// Auth is self-authenticating: the caller presents its session secret; the server hashes
// it to a userId. It stores no secret, so you can only ever act as your own hash.

import express from 'express';
import type { Request, Response } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Db, UsernameTakenError } from './db.ts';
import { deriveUserId } from '../shared/identity.ts';
import type { ServerFrame } from '../shared/types.ts';

const webIndex = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');

const VERSION = '0.2.0';
const now = () => Date.now();

// Tracks live WebSocket connections per userId for presence + push.
class Hub {
  private sockets = new Map<string, Set<WebSocket>>();

  add(userId: string, ws: WebSocket): void {
    let set = this.sockets.get(userId);
    if (!set) this.sockets.set(userId, (set = new Set()));
    set.add(ws);
  }
  remove(userId: string, ws: WebSocket): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.sockets.delete(userId);
  }
  onlineIds(): Set<string> {
    return new Set(this.sockets.keys());
  }
  isOnline(userId: string): boolean {
    return this.sockets.has(userId);
  }
  send(userId: string, frame: ServerFrame): boolean {
    const set = this.sockets.get(userId);
    if (!set || set.size === 0) return false;
    const data = JSON.stringify(frame);
    let delivered = false;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
        delivered = true;
      }
    }
    return delivered;
  }
}

export interface RunningServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startServer(dbFile: string, host: string, port: number): Promise<RunningServer> {
  const db = new Db(dbFile);
  const hub = new Hub();
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const sessionOf = (req: Request): string =>
    (req.header('x-achat-session') ?? (req.query.session as string | undefined) ?? '').toString();

  // Resolve the authenticated caller. Returns { userId, username } or writes 401/403 and returns null.
  const caller = (req: Request, res: Response): { userId: string; username: string } | null => {
    const secret = sessionOf(req);
    if (!secret) {
      res.status(401).json({ error: 'missing session' });
      return null;
    }
    const userId = deriveUserId(secret);
    const username = db.usernameOf(userId);
    if (!username) {
      res.status(403).json({ error: 'not registered — call achat-start first' });
      return null;
    }
    return { userId, username };
  };

  app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION }));

  // Web UI (served same-origin so it reuses the HTTP + WS API directly).
  app.get('/', (_req, res) => {
    try {
      res.type('html').send(readFileSync(webIndex, 'utf8'));
    } catch {
      res.status(404).send('web UI not found');
    }
  });

  // Register or rename. Body: { session, username }.
  app.post('/identities', (req, res) => {
    const secret = (req.body?.session ?? '').toString();
    const username = (req.body?.username ?? '').toString().trim();
    if (!secret) return res.status(400).json({ error: 'session required' });
    if (!username) return res.status(400).json({ error: 'username required' });
    if (username.length > 64) return res.status(400).json({ error: 'username too long' });
    const userId = deriveUserId(secret);
    try {
      const out = db.register(userId, username, now(), (id) => hub.isOnline(id));
      res.json(out);
    } catch (err) {
      if (err instanceof UsernameTakenError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  // Roster + presence (public).
  app.get('/identities', (_req, res) => {
    res.json({ identities: db.listIdentities(hub.onlineIds()) });
  });

  // Send a pairwise message. Body: { to (username), body }.
  app.post('/messages', (req, res) => {
    const me = caller(req, res);
    if (!me) return;
    const toName = (req.body?.to ?? '').toString().trim();
    const body = (req.body?.body ?? '').toString();
    if (!toName) return res.status(400).json({ error: 'to required' });
    if (!body) return res.status(400).json({ error: 'body required' });
    const toId = db.resolveUsername(toName);
    if (!toId) return res.status(404).json({ error: `unknown recipient: ${toName}` });

    const message = db.insertMessage(me.userId, me.username, toId, toName, body, now());
    const delivered = hub.send(toId, { type: 'message', message });
    res.json({ message, delivered });
  });

  // Pairwise conversation history. ?with=<username>&limit=N
  app.get('/messages', (req, res) => {
    const me = caller(req, res);
    if (!me) return;
    const otherName = (req.query.with ?? '').toString().trim();
    if (!otherName) return res.status(400).json({ error: 'with required' });
    const otherId = db.resolveUsername(otherName);
    if (!otherId) return res.status(404).json({ error: `unknown identity: ${otherName}` });
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
    // Reading is non-destructive: it does NOT change read state. Use POST /read to mark read.
    res.json({ messages: db.conversation(me.userId, otherId, limit) });
  });

  // Unread summary: how many unread and from whom, plus the inbox high-water mark.
  // Does not change read state.
  app.get('/unread', (req, res) => {
    const me = caller(req, res);
    if (!me) return;
    res.json(db.unreadSummary(me.userId));
  });

  // Explicitly mark a conversation read (up to the peer's latest message).
  // Body: { with: <username> }. Returns the refreshed unread summary.
  app.post('/read', (req, res) => {
    const me = caller(req, res);
    if (!me) return;
    const otherName = (req.body?.with ?? '').toString().trim();
    if (!otherName) return res.status(400).json({ error: 'with required' });
    const otherId = db.resolveUsername(otherName);
    if (!otherId) return res.status(404).json({ error: `unknown identity: ${otherName}` });
    db.markRead(me.userId, otherId, db.latestFromPeer(me.userId, otherId));
    res.json(db.unreadSummary(me.userId));
  });

  // Unread feed: messages addressed to caller with seq > since. Non-blocking.
  app.get('/inbox', (req, res) => {
    const me = caller(req, res);
    if (!me) return;
    const since = Number(req.query.since ?? 0) || 0;
    const messages = db.messagesForSince(me.userId, since);
    const cursor = messages.length ? messages[messages.length - 1].seq : since;
    res.json({ messages, cursor });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const secret = url.searchParams.get('session') ?? '';
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    const userId = secret ? deriveUserId(secret) : '';
    const username = userId ? db.usernameOf(userId) : null;

    if (!secret || !username) {
      ws.send(JSON.stringify({ type: 'error', error: 'not registered — call achat-start first' } satisfies ServerFrame));
      ws.close();
      return;
    }

    hub.add(userId, ws);
    db.touchLastSeen(userId, now());
    ws.send(JSON.stringify({ type: 'hello', userId, username } satisfies ServerFrame));

    // Replay any backlog the client hasn't seen (offline queue delivery).
    for (const message of db.messagesForSince(userId, since)) {
      ws.send(JSON.stringify({ type: 'message', message } satisfies ServerFrame));
    }

    const heartbeat = () => db.touchLastSeen(userId, now());
    ws.on('pong', heartbeat);
    ws.on('message', heartbeat);
    ws.on('close', () => {
      hub.remove(userId, ws);
      db.touchLastSeen(userId, now());
    });
    ws.on('error', () => hub.remove(userId, ws));
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      const actualPort = (httpServer.address() as { port: number }).port;
      resolve({
        server: httpServer,
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(interval);
            for (const ws of wss.clients) ws.terminate();
            httpServer.close(() => res());
          }),
      });
    });
  });
}
