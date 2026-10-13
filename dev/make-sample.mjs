#!/usr/bin/env node
// Builds viewer/bundle.json: a complete sample run on a private local Claus
// network (setup, a scripted agent with canned chain data, two checkpoints, a
// revocation). Used for the viewer demo and screenshots.
//   CLAUS_SOURCE=/path/to/claus-network node dev/make-sample.mjs
import { mkdtemp, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalClaus } from './claus-local.mjs';
import { openState, setup, checkpoint, revoke, exportBundle } from '../src/operator.mjs';
import { openBlackbox } from '../src/log.mjs';
import { createTools, recordedTools, runScripted } from '../agent/demo.mjs';
import { createClaus } from '../src/claus.mjs';

const canned = (gasWei, block) => async (_url, init) => {
  const { method } = JSON.parse(init.body);
  const result = { eth_gasPrice: '0x' + BigInt(gasWei).toString(16),
    eth_getBlockByNumber: { number: '0x' + block.toString(16), baseFeePerGas: '0x' + BigInt(gasWei).toString(16) } }[method];
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
};

const claus = await startLocalClaus();
try {
  const dir = await mkdtemp(join(tmpdir(), 'blackbox-sample-'));
  await chmod(dir, 0o700);
  const ctx = await openState(dir, { origin: claus.origin });
  await setup(ctx, { agentName: 'gas-watcher', mandateHours: 24, probeTimeoutMs: 60000 });
  const box = await openBlackbox({ file: ctx.logFile, agent: 'gas-watcher' });
  const run = async (gas, block) => {
    await box.append({ type: 'note', summary: 'task (scripted): check gas and alert if it is cheap', payload: { task: 'check gas', model: null } });
    const answer = await runScripted(recordedTools(box, createTools({ fetchImpl: canned(gas, block), alertsFile: join(dir, 'alerts.log') })));
    await box.append({ type: 'note', summary: 'answer: ' + answer, payload: { answer } });
  };
  await run(31_200_000_000n, 21_004_311);
  await run(410_000_000n, 21_004_612);
  await checkpoint(ctx);
  await run(2_900_000_000n, 21_004_913);
  await revoke(ctx, { reason: 'demo finished: access no longer needed' });
  const guest = createClaus({ origin: claus.origin });
  const bundle = await exportBundle(ctx, { fetchPublic: (url) => guest.call('public_service_result', { orderId: decodeURIComponent(url.split('/').pop()) }) });
  bundle.note = 'Sample generated on a private local Claus network; public result links point at that local host.';
  const out = new URL('../viewer/bundle.json', import.meta.url);
  await writeFile(out, JSON.stringify(bundle, null, 2) + '\n');
  console.log('wrote', out.pathname, bundle.lines.length, 'entries,', bundle.checkpoints.length, 'checkpoints');
} finally {
  await claus.stop();
}
