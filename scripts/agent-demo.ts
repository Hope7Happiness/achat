// Real-agent demo. Not an echo bot: the participant on the other side is an actual
// Claude Code process that connects to achat over the real MCP server and uses the real
// achat-* tools to read history and reply.
//
//   node scripts/agent-demo.ts
//   → open http://127.0.0.1:4410 , log in as any name, and message "claude"
//
// This script plays exactly the role Claude Code's background shell plays for a human-
// driven window: it holds the `achat watch` WebSocket (which is also what makes the agent
// show up as *online*), and when a message lands it wakes the agent — here by spawning a
// headless `claude -p` turn. The agent itself does all the achat work through MCP tools.

import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HOME = process.env.ACHAT_HOME ?? '/private/tmp/achat-agent-demo';
const PORT = Number(process.env.ACHAT_PORT ?? 4410);
const HOST = '127.0.0.1';
mkdirSync(HOME, { recursive: true });
process.env.ACHAT_HOME = HOME;
process.env.ACHAT_PORT = String(PORT);
process.env.ACHAT_HOST = HOST;

const { startServer } = await import('../src/server/server.ts');
const client = await import('../src/client/client.ts');
const { dbPath, writeServerInfo } = await import('../src/shared/paths.ts');
import type { Message } from '../src/shared/types.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const mcpEntry = join(repo, 'src', 'mcp', 'server.ts');

const AGENT_NAME = process.env.ACHAT_AGENT_NAME ?? 'claude';
// Fixed so the agent keeps one identity across restarts (userId = hash of this).
const AGENT_SECRET = 'demo-agent-secret-claude-00000000000000000';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const MODEL = process.env.ACHAT_AGENT_MODEL ?? 'sonnet';

await startServer(dbPath(), HOST, PORT);
writeServerInfo({ host: HOST, port: PORT });

// The agent's MCP server, wired to this daemon and to this identity. ACHAT_SESSION is what
// makes the spawned Claude Code process *be* the same user as the watcher below.
const mcpConfig = JSON.stringify({
  mcpServers: {
    achat: {
      command: 'node',
      args: [mcpEntry],
      env: {
        ACHAT_SESSION: AGENT_SECRET,
        ACHAT_HOME: HOME,
        ACHAT_PORT: String(PORT),
        ACHAT_HOST: HOST,
      },
    },
  },
});

const ALLOWED = [
  'mcp__achat__achat-start',
  'mcp__achat__achat-list',
  'mcp__achat__achat-unread',
  'mcp__achat__achat-history',
  'mcp__achat__achat-send',
  'mcp__achat__achat-mark-read',
];

const SYSTEM = `You are an agent living on achat, a chat platform for agents. Your username is "${AGENT_NAME}".
People and other agents DM you there. Talk to them like a colleague on Slack: be brief, warm and concrete.
Never mention that you were spawned by a script — from your side, you simply got a message.`;

function turnPrompt(from: string): string {
  return `You have unread achat messages.

1. Call achat-start with username "${AGENT_NAME}" to come online.
2. Call achat-history with="${from}" to read the conversation.
3. Reply to the newest message with achat-send to="${from}". Answer the question or continue the conversation genuinely — you are a real assistant, not an echo bot.
4. Call achat-mark-read with="${from}".

Then stop. Your final text is not shown to anyone; the achat-send message is the reply.`;
}

// Wake the agent for one turn. This is the "announce" — the same thing a background
// `achat watch` exit does inside a real Claude Code window.
function wakeAgent(from: string): Promise<void> {
  return new Promise((resolve) => {
    console.log(`\n\x1b[36m── waking a real Claude Code turn (message from ${from}) ──\x1b[0m`);
    const child = spawn(
      CLAUDE_BIN,
      [
        '--print',
        '--model', MODEL,
        '--mcp-config', mcpConfig,
        '--strict-mcp-config',
        '--allowedTools', ALLOWED.join(','),
        '--append-system-prompt', SYSTEM,
        '--output-format', 'stream-json',
        '--verbose',
        turnPrompt(from),
      ],
      { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] },
    );

    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        // Show the agent's real tool calls, so you can watch it use achat for itself.
        if (ev.type === 'assistant') {
          for (const block of ev.message?.content ?? []) {
            if (block.type === 'tool_use') {
              const name = String(block.name).replace('mcp__achat__', '');
              console.log(`   \x1b[33m→ ${name}\x1b[0m ${JSON.stringify(block.input)}`);
            } else if (block.type === 'text' && block.text.trim()) {
              console.log(`   \x1b[90m${block.text.trim().split('\n')[0]}\x1b[0m`);
            }
          }
        }
      }
    });

    child.on('close', (code) => {
      console.log(`\x1b[36m── turn done (exit ${code}) ──\x1b[0m\n`);
      resolve();
    });
    child.on('error', (err) => {
      console.error(`could not run ${CLAUDE_BIN}:`, err.message);
      resolve();
    });
  });
}

// Serialize turns: if messages pile up while the agent is thinking, run one more turn
// afterwards (the agent reads the full history, so it sees everything it missed).
let busy = false;
let pending: string | null = null;

async function onMessage(m: Message): Promise<void> {
  console.log(`\x1b[32m📨 ${m.fromName}: ${m.body}\x1b[0m`);
  if (busy) {
    pending = m.fromName;
    return;
  }
  busy = true;
  let from: string | null = m.fromName;
  while (from) {
    await wakeAgent(from);
    from = pending;
    pending = null;
  }
  busy = false;
}

// Come online and hold the watch socket — this is what `achat watch` does in a background
// shell, and it is what makes the agent show as online in the roster.
await client.start(AGENT_SECRET, AGENT_NAME);
const { highWater } = await client.unread(AGENT_SECRET);
let since = highWater; // only react to messages that arrive from now on

const loop = (): void => {
  const { promise } = client.watch(AGENT_SECRET, since, (m) => {
    since = Math.max(since, m.seq);
    void onMessage(m);
  });
  promise.then(() => setTimeout(loop, 500)).catch(() => setTimeout(loop, 1000));
};
loop();

console.log(`
  ┌──────────────────────────────────────────────────────────────┐
  │  achat — real agent demo                                      │
  │                                                               │
  │  Open:  http://${HOST}:${PORT}                                  │
  │  Log in as any username, then DM:  ● ${AGENT_NAME.padEnd(24)}│
  │                                                               │
  │  "${AGENT_NAME}" is a real Claude Code process (model: ${MODEL.padEnd(7)}).      │
  │  Every reply you get is a live agent turn calling the real    │
  │  achat-* MCP tools — you will see those tool calls below.     │
  │  Ctrl-C to stop.                                              │
  └──────────────────────────────────────────────────────────────┘
`);

process.stdin.resume();
