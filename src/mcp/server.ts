// achat MCP server (stdio). One instance per Claude Code / Codex window == one session.
//
// Identity: a session secret is generated once at startup and held in memory for the life
// of this process (stable across prompts, /clear, and context compaction — it only resets
// if the MCP server process itself restarts). userId = hash(secret). The username is the
// user-chosen, mutable, unique label set via achat-start.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as client from '../client/client.ts';
import { generateSecret, deriveUserId } from '../shared/identity.ts';
import { writeCursor } from '../shared/paths.ts';
import type { Message } from '../shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const watchCmd = join(here, '..', 'cli', 'achat.ts');

// This window's stable session identity for its whole life.
const SESSION = process.env.ACHAT_SESSION ?? generateSecret();
const USER_ID = deriveUserId(SESSION);

let currentUsername: string | null = null;

function requireStarted(): void {
  if (!currentUsername) throw new Error('call achat-start with your username first');
}

function fmt(m: Message): string {
  return `[${new Date(m.createdAt).toLocaleTimeString()}] ${m.fromName}: ${m.body}`;
}

const server = new McpServer({ name: 'achat', version: '0.2.0' });

server.registerTool(
  'achat-start',
  {
    description:
      'Come online in achat under a username (like logging in). Your underlying identity is ' +
      'stable and automatic; the username is just a display label you can change by calling ' +
      'this again. Returns the roster, your unread messages, and the background watcher command. ' +
      'Run that watcher in a BACKGROUND shell so you get pinged on new messages while you keep working.',
    inputSchema: { username: z.string().describe('the name to appear as, e.g. "alice"') },
  },
  async ({ username }) => {
    try {
      const out = await client.start(SESSION, username);
      currentUsername = out.username;
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Could not take username "${username}": ${(err as Error).message}. Try another name.` }],
      };
    }

    const roster = (await client.list()).filter((r) => r.userId !== USER_ID);
    const unread = await client.unread(SESSION);
    // Anchor the background watcher to "now" so it only pings on messages that arrive
    // from here on. The unread count below already accounts for anything waiting.
    writeCursor(USER_ID, unread.highWater);

    const rosterText = roster.length
      ? roster.map((r) => `  ${r.online ? '●' : '○'} ${r.username}`).join('\n')
      : '  (nobody else online yet)';
    const unreadText =
      `\n\n${client.formatUnread(unread)}.` +
      (unread.total ? ' Read them with achat-history.' : '');
    // Carry any non-default achat env into the watch command. The watcher runs in a plain
    // background shell, which does NOT inherit this MCP server's env — so without this, a
    // client machine's watcher would miss ACHAT_SERVER, fail to find the remote daemon, and
    // quietly spawn an empty local one.
    const envPrefix = ['ACHAT_SERVER', 'ACHAT_PROXY', 'ACHAT_HOME', 'ACHAT_PORT', 'ACHAT_HOST']
      .filter((k) => process.env[k])
      .map((k) => `${k}=${process.env[k]}`)
      .join(' ');
    const watchHint =
      `\n\nTo receive messages while you work, run this in a BACKGROUND shell ` +
      `(it blocks until a message arrives, prints it, then exits — relaunch it each time it returns):\n` +
      // process.execPath, not "node": the machine's `node` on PATH may be an older one that
      // cannot run this code at all (achat needs >= 24), and the installer may have put a
      // private Node under ~/.achat/node precisely because of that.
      `  ${envPrefix ? envPrefix + ' ' : ''}${process.execPath} ${watchCmd} watch --user ${USER_ID}`;

    return {
      content: [
        { type: 'text', text: `You are online as "${currentUsername}".\n\nContacts:\n${rosterText}${unreadText}${watchHint}` },
      ],
    };
  },
);

server.registerTool(
  'achat-send',
  {
    description: 'Send a private message to another achat user by username. Queues if they are offline.',
    inputSchema: { to: z.string().describe('recipient username'), body: z.string().describe('message text') },
  },
  async ({ to, body }) => {
    requireStarted();
    const out = await client.send(SESSION, to, body);
    return {
      content: [
        {
          type: 'text',
          text: out.delivered
            ? `Sent to ${to} (delivered live).`
            : `Sent to ${to} (queued — they are offline, they'll get it when they come online).`,
        },
      ],
    };
  },
);

server.registerTool(
  'achat-list',
  { description: 'List achat users and who is currently online.', inputSchema: {} },
  async () => {
    const roster = await client.list();
    const text = roster.length
      ? roster.map((r) => `${r.online ? '●' : '○'} ${r.username}${r.userId === USER_ID ? ' (you)' : ''}`).join('\n')
      : '(no users yet)';
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'achat-history',
  {
    description:
      'Read your full conversation with another user (the source of truth for message content). ' +
      'This does NOT change unread state — call achat-mark-read when you want to clear it. ' +
      'Pass a larger limit to go further back.',
    inputSchema: {
      with: z.string().describe('the other username'),
      limit: z.number().int().min(1).max(500).optional().describe('how many messages to fetch (default 50, max 500)'),
    },
  },
  async ({ with: other, limit }) => {
    requireStarted();
    const msgs = await client.history(SESSION, other, limit ?? 50);
    const text = msgs.length ? msgs.map(fmt).join('\n') : '(no messages yet)';
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'achat-mark-read',
  {
    description: 'Mark your conversation with a user as read, clearing its unread count. Returns your remaining unread.',
    inputSchema: { with: z.string().describe('the username whose conversation to mark read') },
  },
  async ({ with: other }) => {
    requireStarted();
    const u = await client.markRead(SESSION, other);
    return { content: [{ type: 'text', text: `Marked ${other} read. Now: ${client.formatUnread(u)}.` }] };
  },
);

server.registerTool(
  'achat-unread',
  {
    description:
      'Check how many unread messages you have and from whom (counts only, no bodies and no ' +
      'state change). Read the actual messages with achat-history; clear the count with achat-mark-read.',
    inputSchema: {},
  },
  async () => {
    requireStarted();
    return { content: [{ type: 'text', text: client.formatUnread(await client.unread(SESSION)) }] };
  },
);

server.registerTool(
  'achat-receipt',
  {
    description:
      'Has someone read what YOU sent them? Returns how many of your messages they have read ' +
      'and when. This is the mirror image of achat-unread, which is about your own inbox. ' +
      'Nobody is notified when you check, and nobody is notified when they read you — receipts ' +
      'are pull-only. Useful before concluding that a peer is ignoring you: an unread message ' +
      'means they have not seen it, not that they have declined to answer.',
    inputSchema: { with: z.string().describe('the username whose read state you want') },
  },
  async ({ with: other }) => {
    requireStarted();
    const r = await client.receipt(SESSION, other);
    return { content: [{ type: 'text', text: client.formatReceipt(r) }] };
  },
);

await server.connect(new StdioServerTransport());
