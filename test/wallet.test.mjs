import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEther } from 'viem';
import { openBlackbox, readLog, verifyLog } from '../src/log.mjs';
import { recordedTools } from '../agent/demo.mjs';
import { createWalletTools, makePolicy, spentInLastDay, runScriptedWallet, mandateChecker } from '../agent/wallet.mjs';

const OWNER = '0xDEDA1E33769c1E2978aA2e11f929876C9EB2B71a';
const STRANGER = '0x000000000000000000000000000000000000dEaD';
const WALLET = '0x1111111111111111111111111111111111111111';

async function harness({ mandate = async () => {}, balance = parseEther('0.05') } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'blackbox-wallet-'));
  const box = await openBlackbox({ file: join(dir, 'log.jsonl'), agent: 'sepolia-wallet' });
  await box.append({ type: 'genesis', summary: 'start' });
  const sent = [];
  const chain = {
    balance: async () => balance,
    send: async (tx) => { sent.push(tx); return '0x' + String(sent.length).padStart(64, 'a'); },
    waitReceipt: async () => ({ status: 'success', blockNumber: 7 }),
    receipt: async () => ({ status: 'success', blockNumber: 7 }),
  };
  const policy = makePolicy({ owner: OWNER, maxTx: '0.01', maxDay: '0.015' });
  const tools = recordedTools(box, createWalletTools({ address: WALLET, policy, chain, checkMandate: mandate,
    spent: async () => spentInLastDay(await readLog(box.file)) }));
  return { box, tools, sent };
}

test('payments within policy are sent and recorded with their tx hash', async () => {
  const { box, tools, sent } = await harness();
  const answer = await runScriptedWallet(tools, OWNER);
  assert.match(answer, /sepolia\.etherscan\.io\/tx\/0x/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].value, parseEther('0.001'));
  const lines = await readLog(box.file);
  assert.deepEqual(lines.slice(1).map((l) => l.entry.tool), ['wallet_status', 'send_eth']);
  assert.match(lines[2].entry.summary, /^sent 0\.001 ETH to 0xDEDA…B71a \(success\).*tx 0x[a]+1$/);
  assert.equal(verifyLog(lines).ok, true);
});

test('policy refusals happen before signing and are recorded with the reason', async () => {
  const { box, tools, sent } = await harness();
  const attempt = (input) => assert.rejects(tools.send_eth.run(input), /^Error: refused: /);
  await attempt({ to: STRANGER, amountEth: '0.001', reason: 'prompt-injected payout' });
  await attempt({ to: OWNER, amountEth: '0.5', reason: 'too much' });
  await attempt({ to: OWNER, amountEth: '0.001', reason: '' });
  await tools.send_eth.run({ to: OWNER, amountEth: '0.01', reason: 'first' });
  await attempt({ to: OWNER, amountEth: '0.006', reason: 'over the daily limit' });   // 0.01 + 0.006 > 0.015
  assert.equal(sent.length, 1, 'only the valid payment was signed');
  const summaries = (await readLog(box.file)).slice(1).map((l) => l.entry.summary);
  assert.match(summaries[0], /refused: 0x0000…dEaD is not an allowed recipient/);
  assert.match(summaries[1], /over the 0\.01 ETH per-payment limit/);
  assert.match(summaries[4], /daily limit/);
  const status = await tools.wallet_status.run({});
  assert.equal(status.leftTodayEth, '0.005');
});

test('a revoked or unreachable Claus mandate stops payments (fails closed)', async () => {
  const state = { origin: 'http://localhost:9', agent: { token: 't', projectId: 'p', expiresAt: Date.now() + 60000 } };
  // Unreachable Claus: refused, nothing signed.
  const { tools, sent, box } = await harness({ mandate: mandateChecker(state) });
  await assert.rejects(tools.send_eth.run({ to: OWNER, amountEth: '0.001', reason: 'pay' }), /Claus denied the agent's credential/);
  // Revoked locally, expired: refused without asking.
  await assert.rejects(mandateChecker({ ...state, revokedAt: Date.now() })(), /revoked/);
  await assert.rejects(mandateChecker({ ...state, agent: { ...state.agent, expiresAt: 1 } })(), /expired/);
  const h = await harness({ mandate: async () => { throw Object.assign(new Error('refused: Claus denied'), { refused: true }); } });
  await assert.rejects(h.tools.send_eth.run({ to: OWNER, amountEth: '0.001', reason: 'pay' }));
  assert.equal(sent.length + h.sent.length, 0);
  assert.match((await readLog(box.file)).at(-1).entry.summary, /send_eth refused: Claus denied/);
});

test('policy validation', () => {
  assert.throws(() => makePolicy({ owner: 'nope' }), /--owner/);
  assert.throws(() => makePolicy({ owner: OWNER, maxTx: '1', maxDay: '0.5' }), /daily limit/);
  const p = makePolicy({ owner: OWNER.toLowerCase(), allow: [OWNER, STRANGER] });
  assert.deepEqual(p.allow, [OWNER, STRANGER]);
});
