// The on-chain kill switch, end to end: a private Claus network plus a local chain that
// pretends to be Sepolia (Anvil, chain id 11155111), driving the real CLI commands.
//   CLAUS_SOURCE=/path/to/claus-network ANVIL_BIN=/path/to/anvil npm run test:e2e   (Node 24.14+)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { startLocalClaus } from '../../dev/claus-local.mjs';
import { openState, setup, verify, exportBundle } from '../../src/operator.mjs';
import { writeFile } from 'node:fs/promises';
import { readLog, verifyLog } from '../../src/log.mjs';
import { createClaus } from '../../src/claus.mjs';
import { abi } from '../../src/grant.mjs';

const run = promisify(execFile);
const ready = process.env.CLAUS_SOURCE && process.env.ANVIL_BIN && Number(process.versions.node.split('.')[0]) >= 24;
// Anvil's well-known development accounts (public test keys, never used on a real network).
const FUNDER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CLI = new URL('../../agent/grant-wallet.mjs', import.meta.url).pathname;

test('GrantWallet: pay, revoke on Claus and on-chain, direct call refused by the chain, sweep', { skip: !ready && 'needs CLAUS_SOURCE, ANVIL_BIN and Node 24', timeout: 300000 }, async (t) => {
  const port = 18545 + Math.floor(Math.random() * 1000);
  const anvil = spawn(process.env.ANVIL_BIN, ['--chain-id', '11155111', '--port', String(port), '--silent'], { stdio: 'ignore' });
  t.after(() => anvil.kill());
  const rpc = `http://127.0.0.1:${port}`;
  const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
  for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

  const claus = await startLocalClaus();
  t.after(() => claus.stop());
  const dir = await mkdtemp(join(tmpdir(), 'blackbox-grant-'));
  await chmod(dir, 0o700);
  const ctx = await openState(dir, { origin: claus.origin });
  await setup(ctx, { agentName: 'grant-wallet', mandateHours: 2, probeTimeoutMs: 60000 });

  const env = { ...process.env, SEPOLIA_RPC_URL: rpc };
  const cli = async (...args) => {
    const { stdout } = await run(process.execPath, [CLI, ...args, '--state', dir], { env, maxBuffer: 1 << 22 });
    try { return JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch { return stdout; }
  };

  // init prints the owner key to fund; fund it like the user would.
  const init = await cli('init', '--owner', RECIPIENT, '--max-tx', '0.01', '--max-day', '0.05');
  const ownerKeyAddress = init.contractOwner;
  const funder = createWalletClient({ account: FUNDER, chain: sepolia, transport: http(rpc) });
  await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: ownerKeyAddress, value: parseEther('0.07') }) });

  // deploy: contract funded, agent key gets gas, owner signs the grant.
  const dep = await cli('deploy');
  assert.ok(dep.contract && dep.grantId);
  assert.equal(await pub.getBalance({ address: dep.contract }), parseEther('0.05'));
  assert.equal(await pub.readContract({ address: dep.contract, abi, functionName: 'owner' }), ownerKeyAddress);

  // run: the scripted agent pays 0.001 back through the contract; then a stamped checkpoint.
  const before = await pub.getBalance({ address: RECIPIENT });
  await cli('run', '--scripted', '--checkpoint');
  assert.equal(await pub.getBalance({ address: RECIPIENT }) - before, parseEther('0.001'));
  assert.equal(await pub.getBalance({ address: dep.contract }), parseEther('0.049'));

  // revoke: on-chain first, then Claus.
  const rev = await cli('revoke', '--reason', 'test finished');
  assert.equal(rev.grantRevokedOnchain, true);
  assert.ok(rev.revokedAt);

  // prove-revoked: the tool path is denied by Claus; the direct call is refused by the chain.
  const proof = await cli('prove-revoked');
  assert.equal(proof.viaTool.denied, true, JSON.stringify(proof.viaTool));
  assert.match(proof.viaTool.why, /Claus denied/);
  assert.equal(proof.direct.refusedOnchain, true);
  assert.equal(proof.direct.reason, 'GrantIsRevoked');
  assert.equal(await pub.getBalance({ address: dep.contract }), parseEther('0.049'), 'nothing left the contract');

  // sweep: contract and leftover gas back to the recipient.
  const sweep = await cli('sweep');
  assert.equal(sweep.contract.amountEth, '0.049');
  assert.equal(await pub.getBalance({ address: dep.contract }), 0n);

  // The record: intact, every checkpoint matches its public Claus copy, and it tells the story.
  const lines = await readLog(ctx.logFile);
  assert.equal(verifyLog(lines).ok, true);
  const fresh = await openState(dir);
  const guest = createClaus({ origin: claus.origin });
  const fetchPublic = async (url) => guest.call('public_service_result', { orderId: decodeURIComponent(url.split('/').pop()) });
  const report = await verify({ lines, checkpoints: fresh.state.checkpoints, fetchPublic });
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  const summaries = lines.map((l) => `${l.entry.type}:${l.entry.tool ?? ''}:${l.entry.summary}`);
  assert.ok(summaries.some((x) => /^note::GrantWallet .* holds 0\.05 ETH/.test(x)));
  assert.ok(summaries.some((x) => /^action:send_eth:sent 0\.001 ETH/.test(x)));
  assert.ok(summaries.some((x) => /^note::owner revoked the spending grant on-chain/.test(x)));
  assert.ok(summaries.some((x) => /^revocation:/.test(x)));
  assert.ok(summaries.some((x) => /^action:send_eth:send_eth refused: Claus denied/.test(x)));
  assert.ok(summaries.some((x) => /^action:pay_direct:direct contract call .* refused on-chain \(GrantIsRevoked\)/.test(x)));
  assert.ok(summaries.some((x) => /^note::owner withdrew 0\.049 ETH/.test(x)));

  // Optionally keep the record, to look at it in the viewer.
  if (process.env.BLACKBOX_SAMPLE_OUT) {
    const bundle = await exportBundle(fresh, { fetchPublic });
    await writeFile(process.env.BLACKBOX_SAMPLE_OUT, JSON.stringify({ ...bundle, note: 'Sample: made on a local test network, not a live record.' }, null, 2));
  }
});
