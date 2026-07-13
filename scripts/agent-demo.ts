// Real-agent demo. Not echo bots: each participant is an actual Claude Code process that
// connects to achat over the real MCP server and uses the real achat-* tools.
//
//   node scripts/agent-demo.ts            # brings up "alice" and "bob"
//   ACHAT_AGENTS=alice,bob,carol node scripts/agent-demo.ts
//   → open http://127.0.0.1:4410 , log in as any name, and DM one of them.
//
// Try asking one to talk to the other:
//   "alice, ask bob what his favourite sorting algorithm is and tell me what he says"
// Nothing here relays that for her — alice has to call achat-list / achat-send herself.
//
// This script plays exactly the role Claude Code's background shell plays for a human-
// driven window: for each agent it holds the `achat watch` WebSocket (which is also what
// makes that agent show up as *online*), and when a message lands it wakes the agent — here
// by spawning a headless `claude -p` turn. The agents do all the achat work through MCP.

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

const NAMES = (process.env.ACHAT_AGENTS ?? 'alice,bob').split(',').map((s) => s.trim()).filter(Boolean);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const MODEL = process.env.ACHAT_AGENT_MODEL ?? 'sonnet';
// Runaway guard: two agents chatting can ping-pong forever and burn API calls.
const MAX_TURNS = Number(process.env.ACHAT_MAX_TURNS ?? 40);

await startServer(dbPath(), HOST, PORT);
writeServerInfo({ host: HOST, port: PORT });

const ALLOWED = [
  'mcp__achat__achat-start',
  'mcp__achat__achat-list',
  'mcp__achat__achat-unread',
  'mcp__achat__achat-history',
  'mcp__achat__achat-send',
  'mcp__achat__achat-mark-read',
].join(',');

const COLORS = ['\x1b[35m', '\x1b[34m', '\x1b[36m', '\x1b[33m'];
let turns = 0;

class Agent {
  readonly name: string;
  readonly color: string;
  readonly secret: string;
  private busy = false;
  private pending = false;
  private since = 0;

  constructor(name: string, color: string) {
    this.name = name;
    this.color = color;
    // Fixed so the agent keeps one identity (userId = hash of this) across restarts.
    this.secret = `demo-agent-secret-${name}-${'0'.repeat(Math.max(8, 40 - name.length))}`;
  }

  private log(line: string): void {
    console.log(`${this.color}[${this.name}]\x1b[0m ${line}`);
  }

  // The agent's MCP server, wired to this daemon and to this identity. ACHAT_SESSION is
  // what makes the spawned Claude Code process *be* the same user as the watcher below.
  private mcpConfig(): string {
    return JSON.stringify({
      mcpServers: {
        achat: {
          command: 'node',
          args: [mcpEntry],
          env: {
            ACHAT_SESSION: this.secret,
            ACHAT_HOME: HOME,
            ACHAT_PORT: String(PORT),
            ACHAT_HOST: HOST,
          },
        },
      },
    });
  }

  private system(): string {
    const others = NAMES.filter((n) => n !== this.name);
    return `You are an agent living on achat, a chat platform for agents. Your username is "${this.name}".
People and other agents DM you there. Other agents currently on achat: ${others.join(', ') || '(none)'} — you can message them with achat-send exactly like you message a human.
Talk like a colleague on Slack: brief, warm, concrete. Never mention that you were spawned by a script — from your side, you simply got a message.
Do not send messages just to acknowledge or be polite. If a conversation has reached its natural end, say nothing and stop — an unnecessary reply keeps the other side awake for no reason.`;
  }

  // One turn. Deliberately open-ended: nothing here says "reply to the sender". If the
  // message asks the agent to talk to someone else, that is the agent's own decision.
  private prompt(): string {
    return `You have unread achat messages.

1. Call achat-start with username "${this.name}" to come online.
2. Call achat-unread to see who messaged you, then achat-history to read each conversation.
3. Act on what you read. Usually that means replying with achat-send. If a message asks you to
   involve someone else, use achat-list to see who is around and achat-send to talk to them —
   they are real agents and they will answer you. Note that their answer arrives as a *new*
   message later, not as a return value, so send your question and end your turn; you will be
   woken again when they reply.
4. Call achat-mark-read for each conversation you handled.

Then stop. Your final text is shown to nobody; the achat-send messages are what count.`;
  }

  private wake(): Promise<void> {
    return new Promise((resolve) => {
      if (++turns > MAX_TURNS) {
        this.log(`\x1b[31mturn cap (${MAX_TURNS}) reached — not waking. Set ACHAT_MAX_TURNS higher.\x1b[0m`);
        return resolve();
      }
      this.log(`\x1b[90m── waking a real Claude Code turn (${turns}/${MAX_TURNS}) ──\x1b[0m`);
      const child = spawn(
        CLAUDE_BIN,
        [
          '--print',
          '--model', MODEL,
          '--mcp-config', this.mcpConfig(),
          '--strict-mcp-config',
          '--allowedTools', ALLOWED,
          '--append-system-prompt', this.system(),
          '--output-format', 'stream-json',
          '--verbose',
          this.prompt(),
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
          if (ev.type !== 'assistant') continue;
          for (const block of ev.message?.content ?? []) {
            if (block.type === 'tool_use' && String(block.name).startsWith('mcp__achat__')) {
              const tool = String(block.name).replace('mcp__achat__', '');
              this.log(`  \x1b[33m→ ${tool}\x1b[0m ${JSON.stringify(block.input)}`);
            }
          }
        }
      });

      child.on('close', () => resolve());
      child.on('error', (err) => {
        this.log(`could not run ${CLAUDE_BIN}: ${err.message}`);
        resolve();
      });
    });
  }

  // Serialize turns per agent: messages arriving mid-turn queue up one more turn (the agent
  // reads full history, so it sees everything it missed).
  private async onMessage(m: Message): Promise<void> {
    this.log(`\x1b[32m📨 from ${m.fromName}: ${m.body}\x1b[0m`);
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    do {
      this.pending = false;
      await this.wake();
    } while (this.pending);
    this.busy = false;
  }

  // Come online and hold the watch socket — this is what `achat watch` does in a background
  // shell, and it is what makes the agent show as online in the roster.
  async run(): Promise<void> {
    await client.start(this.secret, this.name);
    this.since = (await client.unread(this.secret)).highWater; // ignore backlog
    const loop = (): void => {
      const { promise } = client.watch(this.secret, this.since, (m) => {
        this.since = Math.max(this.since, m.seq);
        void this.onMessage(m);
      });
      promise.then(() => setTimeout(loop, 500)).catch(() => setTimeout(loop, 1000));
    };
    loop();
  }
}

const agents = NAMES.map((name, i) => new Agent(name, COLORS[i % COLORS.length]));
for (const a of agents) await a.run();

console.log(`
  ┌──────────────────────────────────────────────────────────────────────┐
  │  achat — real agent demo                                              │
  │                                                                       │
  │  Open:  http://${HOST}:${PORT}                                          │
  │  Online agents (each a real Claude Code process, model ${MODEL}):
  │     ${agents.map((a) => '● ' + a.name).join('   ')}
  │                                                                       │
  │  Every reply is a live agent turn calling the real achat-* MCP tools; │
  │  you will see those calls below. Try asking one to talk to another:   │
  │     "${NAMES[0]}, ask ${NAMES[1] ?? 'someone'} what their favourite sorting algorithm is, then tell me"
  │                                                                       │
  │  Ctrl-C to stop.  Turn cap: ${MAX_TURNS} (ACHAT_MAX_TURNS)
  └──────────────────────────────────────────────────────────────────────┘
`);

process.stdin.resume();
