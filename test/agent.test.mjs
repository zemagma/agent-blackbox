import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBlackbox, readLog, verifyLog } from '../src/log.mjs';
import { createTools, recordedTools, runScripted, runClaude } from '../agent/demo.mjs';

function fakeRpc(gasWei) {
  return async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const result = {
      eth_gasPrice: '0x' + BigInt(gasWei).toString(16),
      eth_getBlockByNumber: { number: '0x1406f40', baseFeePerGas: '0x' + BigInt(gasWei).toString(16) },
      eth_getBalance: '0xde0b6b3a7640000',
    }[method];
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
}

async function setupBox() {
  const dir = await mkdtemp(join(tmpdir(), 'blackbox-agent-'));
  const box = await openBlackbox({ file: join(dir, 'log.jsonl'), agent: 'gas-watcher' });
  await box.append({ type: 'genesis', summary: 'start' });
  return { dir, box };
}

test('scripted agent: every tool call is recorded, alert only when gas is cheap', async () => {
  const { dir, box } = await setupBox();
  const alertsFile = join(dir, 'alerts.log');
  const tools = recordedTools(box, createTools({ fetchImpl: fakeRpc(420_000_000n), alertsFile }));
  const answer = await runScripted(tools);
  assert.match(answer, /cheap/);
  const lines = await readLog(box.file);
  assert.deepEqual(lines.map((l) => l.entry.tool ?? l.entry.type), ['genesis', 'get_gas_price', 'get_latest_block', 'post_alert']);
  assert.equal(lines[1].entry.summary, 'gas price is 0.420 gwei');
  assert.equal(verifyLog(lines).ok, true);
  assert.match(await readFile(alertsFile, 'utf8'), /cheap moment/);

  const expensive = recordedTools(box, createTools({ fetchImpl: fakeRpc(30_000_000_000n), alertsFile }));
  assert.match(await runScripted(expensive), /nothing to report/);
  assert.equal((await readLog(box.file)).length, 6, 'no alert recorded when gas is expensive');
});

test('claude loop: tool calls requested by the model are executed and recorded, errors included', async () => {
  const { box } = await setupBox();
  const tools = recordedTools(box, createTools({ fetchImpl: fakeRpc(1_000_000_000n) }));
  const script = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'get_gas_price', input: {} },
      { type: 'tool_use', id: 't2', name: 'get_eth_balance', input: { address: 'not-an-address' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Gas is 1.000 gwei.' }] },
  ];
  const seen = [];
  const client = { messages: { create: async (req) => { seen.push(req); return script.shift(); } } };
  const answer = await runClaude(tools, 'check gas', { client, model: 'test-model' });
  assert.equal(answer, 'Gas is 1.000 gwei.');
  assert.equal(seen[1].messages.at(-2).content[1].is_error, true, 'the failed call is reported back to the model');
  const lines = await readLog(box.file);
  assert.deepEqual(lines.slice(1).map((l) => [l.entry.tool, l.payload.ok]), [['get_gas_price', true], ['get_eth_balance', false]]);
});
