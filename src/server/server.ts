// The achat daemon: HTTP (request/response) + WebSocket (live push), backed by SQLite.
// Single source of truth for MCP clients, the CLI, and a future frontend.
//
// Auth is self-authenticating: the caller presents its session secret; the server hashes
// it to a userId. It stores no secret, so you can only ever act as your own hash.

import express from 'express';
import type { Request, Response } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { Db, UsernameTakenError } from './db.ts';
import { deriveUserId } from '../shared/identity.ts';
import { filesDir, runningCommit } from '../shared/paths.ts';
import { WS_PROTOCOL, secretFromProtocols } from '../shared/wire.ts';
import type { Attachment, ServerFrame } from '../shared/types.ts';

// Attachment bytes never touch SQLite. Cap them: the daemon holds every file anyone ever
// sent, and an unbounded upload is an unbounded disk.
const MAX_FILE = process.env.ACHAT_MAX_FILE ?? '32mb';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

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

// How often we ping clients. A socket that misses one ping is terminated, so a vanished
// peer leaves the roster within ~2 intervals. Overridable so tests don't have to wait.
const PING_MS = Number(process.env.ACHAT_PING_MS ?? 30_000);

export function startServer(dbFile: string, host: string, port: number): Promise<RunningServer> {
  const db = new Db(dbFile);
  const hub = new Hub();
  // Sockets that have answered since the last ping sweep.
  const alive = new Set<WebSocket>();
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // Header only — a secret in the query string would be logged by every proxy in the path.
  const sessionOf = (req: Request): string => (req.header('x-achat-session') ?? '').toString();

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

  // The commit the daemon is *running*, not the one checked out — a long-lived daemon keeps
  // serving the code it started with, and every time that drifted from the repo we could not
  // see it. `achat version` compares this against the client's.
  app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION, commit: runningCommit() }));

  // Web UI (served same-origin so it reuses the HTTP + WS API directly).
  app.get('/', (_req, res) => {
    try {
      res.type('html').send(readFileSync(webIndex, 'utf8'));
    } catch {
      res.status(404).send('web UI not found');
    }
  });

  // Register or rename. Body: { session, username, machine? }.
  // `machine` is the caller's machine secret; we keep only its hash, and it decides who may
  // reclaim a username left behind by an offline session (see Db.register).
  app.post('/identities', (req, res) => {
    const secret = (req.body?.session ?? '').toString();
    const username = (req.body?.username ?? '').toString().trim();
    const machine = (req.body?.machine ?? '').toString();
    if (!secret) return res.status(400).json({ error: 'session required' });
    if (!username) return res.status(400).json({ error: 'username required' });
    if (username.length > 64) return res.status(400).json({ error: 'username too long' });
    const userId = deriveUserId(secret);
    const machineId = machine ? deriveUserId(machine) : '';
    try {
      const out = db.register(userId, username, machineId, now(), (id) => hub.isOnline(id));
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

  // Forget an identity. Body: { machine?: <machine secret> }, or x-achat-session for self.
  //
  // Authorised by *machine ownership*: the machine that claimed an identity may forget it,
  // and no other machine ever can — deleting someone else's identity would be deleting
  // their account. An identity that is currently online is refused (you would be yanking a
  // live window out from under itself), unless the caller proves it *is* that identity by
  // presenting its session secret.
  app.delete('/identities/:userId', (req, res) => {
    const target = req.params.userId;
    if (!db.usernameOf(target) && !db.machineOf(target)) {
      return res.status(404).json({ error: `unknown identity: ${target}` });
    }
    const session = (req.header('x-achat-session') ?? '').toString();
    const isSelf = !!session && deriveUserId(session) === target;

    if (!isSelf) {
      const machine = (req.body?.machine ?? '').toString();
      if (!machine) return res.status(401).json({ error: 'machine secret or own session required' });
      if (deriveUserId(machine) !== db.machineOf(target)) {
        return res.status(403).json({ error: 'that identity belongs to another machine' });
      }
      if (hub.isOnline(target)) {
        return res.status(409).json({ error: 'that identity is online right now' });
      }
    }
    db.deleteIdentity(target);
    res.json({ forgotten: target });
  });

  // Sweep up the dead sessions this machine left behind. Body: { machine }.
  // Online identities are kept. Messages are never deleted (see Db.deleteIdentity).
  app.post('/identities/prune', (req, res) => {
    const machine = (req.body?.machine ?? '').toString();
    if (!machine) return res.status(401).json({ error: 'machine secret required' });
    const machineId = deriveUserId(machine);
    const forgotten: string[] = [];
    for (const id of db.identitiesOfMachine(machineId)) {
      if (hub.isOnline(id.userId)) continue;
      db.deleteIdentity(id.userId);
      forgotten.push(id.username ?? id.userId);
    }
    res.json({ forgotten });
  });

  // Upload a file and send it as a message. Raw bytes in the body.
  //   x-achat-session, ?to=<username>&name=<filename>[&note=<text>]
  //
  // An attachment is a property of the message, not a separate kind of event: it rides the
  // same WebSocket, lands in the same history, and counts toward the same unread badge. So a
  // recipient hears about a file exactly the way it hears about anything else, and nothing
  // downstream needed a new code path.
  app.post('/files', express.raw({ type: '*/*', limit: MAX_FILE }), (req, res) => {
    const me = caller(req, res);
    if (!me) return;
    const toName = (req.query.to ?? '').toString().trim();
    const name = basename((req.query.name ?? '').toString().trim() || 'file');
    const note = (req.query.note ?? '').toString();
    if (!toName) return res.status(400).json({ error: 'to required' });
    const toId = db.resolveUsername(toName);
    if (!toId) return res.status(404).json({ error: `unknown recipient: ${toName}` });

    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return res.status(400).json({ error: 'empty file' });

    const file: Attachment = {
      id: randomUUID(),
      name,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    writeFileSync(join(filesDir(), file.id), bytes);

    const body = note || `sent a file: ${name} (${humanSize(file.size)})`;
    const message = db.insertMessage(me.userId, me.username, toId, toName, body, now(), file);
    const delivered = hub.send(toId, { type: 'message', message });
    res.json({ message, delivered });
  });

  // Download a file. Authorised by the message that carries it (see Db.fileFor).
  app.get('/files/:fileId', (req, res) => {
    const me = caller(req, res);
    if (!me) return;
    const file = db.fileFor(req.params.fileId, me.userId);
    if (!file) return res.status(404).json({ error: 'no such file, or it was not sent to you' });
    const path = join(filesDir(), file.id);
    if (!existsSync(path)) return res.status(410).json({ error: 'file bytes are gone from the host' });
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`);
    res.setHeader('x-achat-sha256', file.sha256);
    res.send(readFileSync(path));
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
    db.markRead(me.userId, otherId, db.latestFromPeer(me.userId, otherId), now());
    res.json(db.unreadSummary(me.userId));
  });

  // Read receipts: has the peer read what *I* sent them? ?with=<username>
  // Pull-only, and deliberately so — see Db.receipt.
  app.get('/receipts', (req, res) => {
    const me = caller(req, res);
    if (!me) return;
    const otherName = (req.query.with ?? '').toString().trim();
    if (!otherName) return res.status(400).json({ error: 'with required' });
    const otherId = db.resolveUsername(otherName);
    if (!otherId) return res.status(404).json({ error: `unknown identity: ${otherName}` });
    res.json({ with: otherName, ...db.receipt(me.userId, otherId) });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    // Clients offer [achat.v1, achat.session.<secret>]; we accept the plain one back.
    handleProtocols: () => WS_PROTOCOL,
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    // The secret arrives as a subprotocol, not a query param: query strings land in access
    // logs, which is a credential leak once the daemon is reachable off-localhost.
    const secret = secretFromProtocols(req.headers['sec-websocket-protocol']);
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

    alive.add(ws);
    const heartbeat = () => {
      alive.add(ws);
      db.touchLastSeen(userId, now());
    };
    ws.on('pong', heartbeat);
    ws.on('message', heartbeat);
    ws.on('close', () => {
      hub.remove(userId, ws);
      alive.delete(ws);
      db.touchLastSeen(userId, now());
    });
    ws.on('error', () => hub.remove(userId, ws));
  });

  // Reap sockets that stopped answering.
  //
  // A peer that vanishes without closing its TCP connection — laptop lid shut, network
  // dropped, process wedged — leaves a socket in readyState OPEN for minutes. We used to
  // ping and never look at the pong, so such a ghost stayed *online* in the roster, and
  // hub.send happily reported delivered=true for messages nobody received. Worse, an online
  // holder blocks its username, so a crashed window locked its own name away from the next
  // session on that machine.
  //
  // So: ping every interval, and terminate anything that did not answer the previous one.
  // Terminating fires 'close', which takes it out of the hub — presence, delivery and
  // username reclaim all become honest again within ~2 intervals.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws); // must be re-added by a pong before the next sweep
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, PING_MS);

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
