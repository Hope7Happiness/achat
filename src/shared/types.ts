// Shared wire types used by the server, the client library, the MCP server and the CLI.
//
// Identity model: a stable `userId` (hash of a per-session secret) is the routing key.
// `username` is a user-chosen, mutable, unique display label on top of it. Messages
// snapshot the sender/recipient username at send time so history reads correctly even
// after someone renames.

export interface Identity {
  userId: string;
  username: string;
  online: boolean;
  lastSeen: number | null; // epoch ms of last WS activity, null if never connected
  createdAt: number;
}

export interface Message {
  id: string; // uuid
  seq: number; // global monotonic sequence, used as a cursor
  fromId: string;
  fromName: string; // sender username snapshot at send time
  toId: string;
  toName: string; // recipient username snapshot at send time
  body: string;
  createdAt: number; // epoch ms
}

// POST /identities  (start / rename) — authenticated by the session secret in the body
export interface StartRequest {
  session: string; // the session secret (bearer)
  username: string; // desired display name
}
export interface StartResponse {
  userId: string;
  username: string;
}

// POST /messages
export interface SendRequest {
  to: string; // recipient username
  body: string;
}
export interface SendResponse {
  message: Message;
  delivered: boolean; // true if recipient had a live WS connection at send time
}

// GET /identities
export interface ListResponse {
  identities: Identity[];
}

// GET /messages?with=&limit=
export interface HistoryResponse {
  messages: Message[];
}

// WebSocket frames pushed from server -> client on /ws
export type ServerFrame =
  | { type: 'hello'; userId: string; username: string }
  | { type: 'message'; message: Message }
  | { type: 'error'; error: string };
