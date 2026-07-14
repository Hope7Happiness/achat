// MCP-layer smoke test: two "windows" each connect to their own achat MCP server,
// register as alice/bob, exchange a message, and read it back via tools.
// Run: node scripts/mcp-smoke.ts

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const home = mkdtempSync(join(tmpdir(), 'achat-mcp-'));
const env = { ...process.env, ACHAT_HOME: home, ACHAT_PORT: '4402', ACHAT_HOST: '127.0.0.1' } as Record<string, string>;
const mcpEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.ts');

function makeClient(): Client {
  return new Client({ name: 'test', version: '0.0.0' });
}
function transport(): StdioClientTransport {
  return new StdioClientTransport({ command: process.execPath, args: [mcpEntry], env });
}

function textOf(res: any): string {
  return (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
}

let failures = 0;
const check = (cond: boolean, label: string) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures++;
};

const alice = makeClient();
const bob = makeClient();
await alice.connect(transport());
await bob.connect(transport());

try {
  const tools = await alice.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  // Exact, not a subset check: a subset check silently tolerates a tool you forgot to
  // register, and forgetting to register one is precisely the mistake worth catching.
  const expected = [
    'achat-history',
    'achat-list',
    'achat-mark-read',
    'achat-receipt',
    'achat-send',
    'achat-start',
    'achat-unread',
  ];
  check(
    names.length === expected.length && expected.every((n, i) => names[i] === n),
    `exactly the expected achat-* tools are registered (${names.join(', ')})`,
  );

  const startA = await alice.callTool({ name: 'achat-start', arguments: { username: 'alice' } });
  check(textOf(startA).includes('online as "alice"'), 'alice started');
  await bob.callTool({ name: 'achat-start', arguments: { username: 'bob' } });

  const sendRes = await bob.callTool({ name: 'achat-send', arguments: { to: 'alice', body: 'hi from bob (mcp)' } });
  check(textOf(sendRes).includes('Sent to alice'), 'bob sent to alice');

  const unread = await alice.callTool({ name: 'achat-unread', arguments: {} });
  check(/1 unread/.test(textOf(unread)) && textOf(unread).includes('bob'), 'alice sees unread COUNT from bob (no body)');
  check(!textOf(unread).includes('hi from bob (mcp)'), 'unread does not leak the message body');

  const list = await alice.callTool({ name: 'achat-list', arguments: {} });
  check(textOf(list).includes('alice') && textOf(list).includes('bob'), 'roster lists both');

  const hist = await alice.callTool({ name: 'achat-history', arguments: { with: 'bob' } });
  check(textOf(hist).includes('hi from bob (mcp)'), 'history shows the full message body');

  const stillUnread = await alice.callTool({ name: 'achat-unread', arguments: {} });
  check(/1 unread/.test(textOf(stillUnread)), 'reading history did NOT clear unread');

  // Bob asks whether alice has read him. Before she marks it read, she has not — which is
  // the distinction that matters to an agent waiting on a reply: "unread" means unseen, not
  // ignored.
  const beforeRead = await bob.callTool({ name: 'achat-receipt', arguments: { with: 'alice' } });
  check(/1 still unread/.test(textOf(beforeRead)), 'achat-receipt: bob sees alice has not read him yet');

  const marked = await alice.callTool({ name: 'achat-mark-read', arguments: { with: 'bob' } });
  check(/no unread/.test(textOf(marked)), 'achat-mark-read clears the unread');

  const afterRead = await bob.callTool({ name: 'achat-receipt', arguments: { with: 'alice' } });
  check(/has read all 1/.test(textOf(afterRead)), 'achat-receipt: bob now sees alice read his message');
} finally {
  await alice.close();
  await bob.close();
  // The MCP servers auto-started a daemon; kill it so the test process can exit.
  const { spawnSync } = await import('node:child_process');
  spawnSync('pkill', ['-f', 'achat.ts serve']);
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
