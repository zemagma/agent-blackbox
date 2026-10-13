// Full lifecycle against a private, local Claus Network.
//   CLAUS_SOURCE=/path/to/claus-network npm run test:e2e   (Node 24.14+)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalClaus } from '../../dev/claus-local.mjs';
import { openState, setup, checkpoint, revoke, verify, exportBundle } from '../../src/operator.mjs';
import { openBlackbox, readLog, verifyLog } from '../../src/log.mjs';
import { decodeOnchain, agentKey } from '../../src/checkpoint.mjs';
import { createClaus } from '../../src/claus.mjs';

const ready = process.env.CLAUS_SOURCE && Number(process.versions.node.split('.')[0]) >= 24;

test('setup → actions → checkpoint → revoke → verify on a local Claus network', { skip: !ready && 'needs CLAUS_SOURCE and Node 24' }, async (t) => {
  const claus = await startLocalClaus();
  t.after(() => claus.stop());
  const dir = await mkdtemp(join(tmpdir(), 'blackbox-e2e-'));
  await chmod(dir, 0o700);
  const ctx = await openState(dir, { origin: claus.origin });

  // 1. Two projects, the notary service (probed by Claus) and the agent's mandate.
  const info = await setup(ctx, { agentName: 'gas-watcher', mandateHours: 2, probeTimeoutMs: 60000 });
  assert.ok(info.notary.serviceId && info.agent.mandateId);
  const capabilities = await createClaus({ origin: claus.origin }).call('capabilities');
  assert.equal(capabilities.publicDataServices.enabled, true);

  // Setup is resumable: a second run creates nothing new.
  const again = await setup(ctx, { agentName: 'gas-watcher' });
  assert.equal(again.notary.serviceId, info.notary.serviceId);
  assert.equal(again.agent.mandateId, info.agent.mandateId);

  // 2. The agent works; every tool call lands in the blackbox.
  const box = await openBlackbox({ file: ctx.logFile, agent: 'gas-watcher' });
  const gas = box.wrapTool('get_gas_price', async () => ({ gwei: '0.42' }), { summarize: (_, o) => `gas is ${o.gwei} gwei` });
  const alert = box.wrapTool('post_alert', async ({ text }) => ({ posted: true, text }), { summarize: (i) => 'alert: ' + i.text });
  await gas({}); await alert({ text: 'gas is cheap, good time to deploy' });

  // 3. First checkpoint, ordered with the agent's own credential and published.
  const cp1 = await checkpoint(ctx);
  assert.deepEqual([cp1.fromSeq, cp1.toSeq], [0, 2]);
  const guest = createClaus({ origin: claus.origin });
  const pub1 = await guest.call('public_service_result', { orderId: cp1.orderId });
  assert.equal(pub1.output.root, cp1.root);
  assert.equal(pub1.dataPolicy, 'public-data-v1');
  const onchain = decodeOnchain(pub1.output.onchainData);
  assert.equal(onchain.agentKey, agentKey('gas-watcher'));
  assert.equal(onchain.toSeq, 2);

  // Nothing new since that stamp: a second checkpoint is skipped, not wasted.
  const skipped = await checkpoint(ctx);
  assert.equal(skipped.skipped, true);
  assert.equal(ctx.state.checkpoints.length, 1);

  // 4. More work, then the operator revokes the mandate.
  await gas({});
  const r = await revoke(ctx, { reason: 'test finished' });
  assert.ok(['unauthenticated', 'scope_denied', 'not_found', 'credential_revoked', 'mandate_revoked'].includes(r.denied) || r.denied, 'agent denied after revocation');
  // A revoked agent can no longer use Claus at all, so it cannot order stamps itself.
  const revokedAgent = createClaus({ origin: claus.origin, token: ctx.state.agent.token });
  await assert.rejects(revokedAgent.call('service_quote', { projectId: ctx.state.agent.projectId,
    serviceId: ctx.state.notary.serviceId, input: {}, idempotencyKey: 'after-revoke' }));

  // 5. Everything verifies, and every checkpoint matches its public Claus copy.
  const lines = await readLog(ctx.logFile);
  assert.deepEqual(lines.map((l) => l.entry.type),
    ['genesis', 'action', 'action', 'checkpoint', 'action', 'revocation', 'checkpoint']);
  const fetchPublic = async (url) => guest.call('public_service_result', { orderId: decodeURIComponent(url.split('/').pop()) });
  const report = await verify({ lines, checkpoints: ctx.state.checkpoints, fetchPublic });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(report.checkpoints.length, 2);

  // 6. Tampering with an already-checkpointed entry is caught.
  const forged = structuredClone(lines); forged[2].entry.summary = 'alert: everything is fine';
  const bad = await verify({ lines: forged, checkpoints: ctx.state.checkpoints, fetchPublic });
  assert.equal(bad.ok, false);
  assert.equal(verifyLog(forged).ok, false);

  // 7. The public bundle hides tool payloads but keeps the chain verifiable.
  const bundle = await exportBundle(ctx, { fetchPublic });
  assert.equal(bundle.checkpoints.length, 2);
  assert.ok(bundle.lines.filter((l) => l.entry.type === 'action').every((l) => l.payload === undefined));
  assert.equal(verifyLog(bundle.lines).ok, true);
  assert.ok(bundle.mandate.revokedAt);
});
