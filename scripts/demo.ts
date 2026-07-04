// One-command demo. Starts the daemon, brings two echo-bots online (they stay
// connected so they show as online and reply live), and prints the URL to open.
//
//   node scripts/demo.ts
//
// Then open the printed URL, log in as any username (e.g. "me"), and chat with
// bob or carol — they answer in real time. Ctrl-C to stop.

import { mkdirSync } from 'node:fs';

const HOME = process.env.ACHAT_HOME ?? '/private/tmp/achat-demo';
const PORT = Number(process.env.ACHAT_PORT ?? 4410);
mkdirSync(HOME, { recursive: true });
process.env.ACHAT_HOME = HOME;
process.env.ACHAT_PORT = String(PORT);
process.env.ACHAT_HOST = '127.0.0.1';

const { startServer } = await import('../src/server/server.ts');
const client = await import('../src/client/client.ts');
const { dbPath, writeServerInfo } = await import('../src/shared/paths.ts');
import type { Message } from '../src/shared/types.ts';

await startServer(dbPath(), '127.0.0.1', PORT);
writeServerInfo({ host: '127.0.0.1', port: PORT });

// Deterministic secrets so the bots keep the same identity across restarts.
const bots: { name: string; secret: string; reply: (m: Message) => string }[] = [
  {
    name: 'bob',
    secret: 'demo-bot-secret-bob-0000000000000000000000',
    reply: (m) => `got it — "${m.body}" 👍  (bob is a demo echo-bot)`,
  },
  {
    name: 'carol',
    secret: 'demo-bot-secret-carol-000000000000000000000',
    reply: (m) => `carol here! you said: "${m.body}" ✨`,
  },
];

async function runBot(bot: (typeof bots)[number]): Promise<void> {
  await client.start(bot.secret, bot.name);
  // Only react to messages that arrive from now on.
  const { highWater } = await client.unread(bot.secret);
  let since = highWater;

  const loop = () => {
    const { promise } = client.watch(bot.secret, since, (m) => {
      since = Math.max(since, m.seq);
      // reply after a short, human-ish delay
      setTimeout(() => {
        client.send(bot.secret, m.fromName, bot.reply(m)).catch(() => {});
      }, 600);
    });
    // Reconnect if the socket drops so the bot stays online.
    promise.then(() => setTimeout(loop, 500)).catch(() => setTimeout(loop, 1000));
  };
  loop();
}

for (const bot of bots) await runBot(bot);

console.log(`
  ┌─────────────────────────────────────────────────────────────┐
  │  achat demo is running                                        │
  │                                                               │
  │  Open:  http://127.0.0.1:${PORT}                                 │
  │  Log in as any username (e.g. "me"), then chat with:          │
  │     ● bob      ● carol   (both online, they reply live)       │
  │                                                               │
  │  Open a second browser tab as another name to DM yourself.    │
  │  Ctrl-C to stop.                                              │
  └─────────────────────────────────────────────────────────────┘
`);

// keep alive
process.stdin.resume();
