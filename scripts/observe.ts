// Proof-of-realness observer. Connects to the SAME running daemon as bob & carol and
// waits for the next inbound human message. Whatever you type in the browser shows up
// here verbatim — it cannot be pre-scripted, because it depends on your live input.
//
//   node scripts/observe.ts
//
// Exits after it catches one message (or after 180s).

const HOME = process.env.ACHAT_HOME ?? '/private/tmp/achat-demo';
const PORT = Number(process.env.ACHAT_PORT ?? 4410);
process.env.ACHAT_HOME = HOME;
process.env.ACHAT_PORT = String(PORT);
process.env.ACHAT_HOST = '127.0.0.1';

const client = await import('../src/client/client.ts');
import type { Message } from '../src/shared/types.ts';

const watchAs = [
  { name: 'bob', secret: 'demo-bot-secret-bob-0000000000000000000000' },
  { name: 'carol', secret: 'demo-bot-secret-carol-000000000000000000000' },
];

console.log('👂 observer online as bob + carol — send a message from the browser...\n');

let done = false;
const handles: { close: () => void }[] = [];

for (const bot of watchAs) {
  const { highWater } = await client.unread(bot.secret); // only react to NEW messages
  const h = client.watch(bot.secret, highWater, (m: Message) => {
    if (done) return;
    done = true;
    const t = new Date(m.createdAt).toLocaleTimeString();
    console.log('════════════════════════════════════════════════');
    console.log(`  CAUGHT A REAL HUMAN MESSAGE (from the server):`);
    console.log(`  [${t}]  ${m.fromName}  →  ${bot.name}`);
    console.log(`  "${m.body}"`);
    console.log('════════════════════════════════════════════════');
    handles.forEach((x) => x.close());
    setTimeout(() => process.exit(0), 100);
  });
  handles.push(h);
}

const TIMEOUT_S = Number(process.argv[2] ?? 1500);
setTimeout(() => {
  if (!done) {
    console.log(`(no message received within ${TIMEOUT_S}s)`);
    handles.forEach((x) => x.close());
    process.exit(2);
  }
}, TIMEOUT_S * 1000);
