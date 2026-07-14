// Reaching the daemon through an HTTP proxy.
//
// A machine without root cannot run Tailscale in its normal mode: creating a TUN interface
// and installing routes needs CAP_NET_ADMIN. Tailscale's answer is `--tun=userspace-networking`,
// where it implements the network stack in userspace — no kernel involvement, no root. The
// catch is that the *operating system* then knows nothing about the tailnet: there is no
// route for 100.64.0.0/10, so an ordinary connect() to a peer just hangs. Instead tailscaled
// exposes a local HTTP proxy, and applications have to go through it.
//
// So on such a machine:
//
//   ACHAT_PROXY=http://127.0.0.1:1055  ACHAT_SERVER=http://host.tailnet.ts.net:4360
//
// Everything — the JSON API and the WebSocket — is tunnelled with CONNECT, which is the one
// primitive that works for both: it hands back a raw TCP socket, so an HTTP request, a TLS
// handshake, and a WebSocket upgrade all ride on it unchanged.

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { Socket } from 'node:net';

export function proxyUrl(): URL | null {
  const raw = (process.env.ACHAT_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '').trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:') {
    throw new Error(`ACHAT_PROXY must be an http:// proxy (CONNECT), got ${url.protocol}`);
  }
  return url;
}

// Open a raw TCP tunnel to host:port through the proxy.
function tunnel(proxy: URL, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
      // The proxy connection itself must not be pooled or reused: we are taking the socket.
      agent: false,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${host}:${port} failed: HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.once('error', reject);
    req.end();
  });
}

// An Agent whose sockets are CONNECT tunnels. Works for http/ws (plain) and https/wss (TLS
// negotiated on top of the tunnel), which is what lets one mechanism cover the whole client.
function makeAgent(proxy: URL, secure: boolean): HttpAgent {
  const Base = secure ? HttpsAgent : HttpAgent;
  const agent = new Base({ keepAlive: false });
  // Node calls createConnection to get the socket for each request.
  (agent as unknown as { createConnection: unknown }).createConnection = (
    options: { host?: string; port?: number; servername?: string },
    cb: (err: Error | null, socket?: Socket) => void,
  ): void => {
    const host = options.host ?? '';
    const port = options.port ?? (secure ? 443 : 80);
    tunnel(proxy, host, port).then(
      (socket) => {
        if (!secure) return cb(null, socket);
        const tlsSocket = tlsConnect({ socket, servername: options.servername ?? host });
        tlsSocket.once('secureConnect', () => cb(null, tlsSocket as unknown as Socket));
        tlsSocket.once('error', (err) => cb(err));
      },
      (err) => cb(err as Error),
    );
  };
  return agent;
}

const agents = new Map<string, HttpAgent>();

// The agent to use for `target`, or null when no proxy is configured (the normal case).
export function agentFor(target: string | URL): HttpAgent | null {
  const proxy = proxyUrl();
  if (!proxy) return null;
  const url = typeof target === 'string' ? new URL(target) : target;
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const key = `${proxy.href}|${secure}`;
  let agent = agents.get(key);
  if (!agent) agents.set(key, (agent = makeAgent(proxy, secure)));
  return agent;
}
