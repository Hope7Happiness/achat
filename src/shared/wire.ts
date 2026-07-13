// How a client presents its session secret when opening the WebSocket.
//
// It travels as a WebSocket *subprotocol*, not as a `?session=` query parameter. Query
// strings end up in access logs, proxy logs, and browser history — fine on localhost,
// a credential leak the moment the daemon is reachable from another machine. Subprotocols
// are the one header a browser's WebSocket constructor can set, so this works for the web
// UI and for Node clients alike.

export const WS_PROTOCOL = 'achat.v1';
const SESSION_PREFIX = 'achat.session.';

// Secrets are base64url (A-Za-z0-9-_), all valid RFC 6455 token characters.
export function sessionProtocol(secret: string): string {
  return SESSION_PREFIX + secret;
}

export function secretFromProtocols(header: string | undefined): string {
  if (!header) return '';
  for (const raw of header.split(',')) {
    const p = raw.trim();
    if (p.startsWith(SESSION_PREFIX)) return p.slice(SESSION_PREFIX.length);
  }
  return '';
}
