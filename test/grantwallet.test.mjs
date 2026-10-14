// GrantWallet in a local EVM: payments under an owner-signed grant, every limit,
// and on-chain revocation that no caller can get around.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, encodeDeployData, hexToBytes, bytesToHex, parseEther } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { abi, artifact, makeGrant, grantId, signGrant } from '../src/grant.mjs';

const require = createRequire(import.meta.url);
let createEVM, createAddressFromString, createAccount, compileGrantWallet;
try {
  require.resolve('solc');
  ({ createEVM } = await import('@ethereumjs/evm'));
  ({ createAddressFromString, createAccount } = await import('@ethereumjs/util'));
  ({ compileGrantWallet } = await import('../dev/compile.mjs'));
} catch { /* dev dependencies not installed */ }
const skip = !createEVM && 'dev dependencies not installed';

const DAY = 86_400n;
const T0 = 1_800_000_000n;                    // a fixed "now" in unix seconds

async function chain() {
  const evm = await createEVM();
  const chainId = evm.common.chainId();
  const fund = async (addr, eth) => evm.stateManager.putAccount(createAddressFromString(addr), createAccount({ balance: parseEther(eth) }));
  const balance = async (addr) => (await evm.stateManager.getAccount(createAddressFromString(addr)))?.balance ?? 0n;
  async function send({ from, to, data = '0x', value = 0n, now = T0 }) {
    const r = await evm.runCall({ caller: createAddressFromString(from), to: to && createAddressFromString(to),
      data: hexToBytes(data), value, gasLimit: 3_000_000n,
      block: { header: { timestamp: now, number: 1n, baseFeePerGas: 0n, getBlobGasPrice: () => 0n } } });
    const out = bytesToHex(r.execResult.returnValue);
    if (r.execResult.exceptionError) {
      let error = 'reverted';
      try { error = decodeErrorResult({ abi, data: out }).errorName; } catch {}
      return { reverted: true, error };
    }
    return { out, created: r.createdAddress?.toString(), gas: r.execResult.executionGasUsed };
  }
  return { evm, chainId, fund, balance, send };
}

async function setup() {
  const c = await chain();
  const owner = privateKeyToAccount(generatePrivateKey());
  const agent = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const recipient = '0xDEDA1E33769c1E2978aA2e11f929876C9EB2B71a';
  for (const a of [owner, agent, stranger]) await c.fund(a.address, '1');
  const deployed = await c.send({ from: owner.address, value: parseEther('0.05'),
    data: encodeDeployData({ abi, bytecode: artifact.bytecode, args: [owner.address] }) });
  assert.equal(deployed.reverted, undefined, 'deploys');
  const wallet = deployed.created;
  const grant = makeGrant({ agent: agent.address, recipient, maxPerPayment: parseEther('0.01'),
    maxPerDay: parseEther('0.015'), expiresAt: T0 + DAY });
  const sign = (g = grant, by = owner) => signGrant(by, { chainId: c.chainId, wallet, grant: g });
  const pay = async ({ g = grant, sig, from = agent.address, to = recipient, amount = parseEther('0.001'), now = T0 } = {}) =>
    c.send({ from, to: wallet, now, data: encodeFunctionData({ abi, functionName: 'pay',
      args: [g, sig ?? await sign(g), to, amount, '0x' + '00'.repeat(32)] }) });
  const call = async (functionName, args, from = owner.address) =>
    c.send({ from, to: wallet, data: encodeFunctionData({ abi, functionName, args }) });
  const read = async (functionName, args) =>
    decodeFunctionResult({ abi, functionName, data: (await call(functionName, args)).out });
  return { ...c, owner, agent, stranger, recipient, wallet, grant, sign, pay, call, read };
}

test('the committed artifact matches the Solidity source', { skip }, async () => {
  const fresh = await compileGrantWallet();
  assert.equal(fresh.bytecode, artifact.bytecode, 'run node dev/compile.mjs');
});

test('the agent pays within its grant; the contract enforces every limit', { skip }, async () => {
  const t = await setup();
  // The on-chain grant id is the same EIP-712 digest the owner signed.
  assert.equal(await t.read('grantId', [t.grant]), grantId({ chainId: t.chainId, wallet: t.wallet, grant: t.grant }));

  const before = await t.balance(t.recipient);
  const ok = await t.pay();
  assert.equal(ok.reverted, undefined);
  assert.equal(await t.balance(t.recipient) - before, parseEther('0.001'));
  assert.ok(ok.gas < 100_000n, 'a payment is cheap: ' + ok.gas);

  assert.equal((await t.pay({ from: t.stranger.address })).error, 'NotAgent', 'only the grant\'s agent may spend');
  assert.equal((await t.pay({ to: t.stranger.address })).error, 'RecipientNotAllowed');
  assert.equal((await t.pay({ amount: parseEther('0.02') })).error, 'OverPaymentLimit');
  assert.equal((await t.pay({ amount: 0n })).error, 'OverPaymentLimit');
  assert.equal((await t.pay({ amount: parseEther('0.01') })).reverted, undefined, '0.001 + 0.01 = 0.011 fits the 0.015 day');
  assert.equal((await t.pay({ amount: parseEther('0.005') })).error, 'OverDailyLimit', '0.016 would exceed it');
  assert.equal((await t.pay({ amount: parseEther('0.005'), now: T0 + DAY / 2n })).error, 'OverDailyLimit', 'same UTC day');
  const nextDay = (T0 / DAY + 1n) * DAY + 10n;
  assert.equal((await t.pay({ amount: parseEther('0.005'), now: nextDay })).reverted, undefined, 'a new UTC day resets the daily limit');
  assert.equal((await t.pay({ now: T0 + DAY })).error, 'GrantExpired', 'nothing after the grant expires');
});

test('signatures: only the owner\'s, only for exactly this grant, no malleated copies', { skip }, async () => {
  const t = await setup();
  assert.equal((await t.pay({ sig: await t.sign(t.grant, t.stranger) })).error, 'BadSignature', 'a stranger cannot sign grants');
  assert.equal((await t.pay({ sig: await t.sign(t.grant, t.agent) })).error, 'BadSignature', 'the agent cannot sign its own grant');
  // Raising a limit changes the grant, so the owner's signature no longer matches.
  const sig = await t.sign();
  const greedy = { ...t.grant, maxPerPayment: parseEther('1'), maxPerDay: parseEther('1') };
  assert.equal((await t.pay({ g: greedy, sig, amount: parseEther('0.5') })).error, 'BadSignature');
  // The same signature with s flipped to the high half of the curve is refused.
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const r = sig.slice(0, 66), s = BigInt('0x' + sig.slice(66, 130)), v = parseInt(sig.slice(130, 132), 16);
  const flipped = r + (n - s).toString(16).padStart(64, '0') + (v === 27 ? '1c' : '1b');
  assert.equal((await t.pay({ sig: flipped })).error, 'BadSignature');
  assert.equal((await t.pay({ sig: '0x1234' })).error, 'BadSignature');
  assert.equal((await t.pay({ sig })).reverted, undefined, 'the genuine signature still works');
});

test('revocation is on-chain: after it, no caller can spend under the grant', { skip }, async () => {
  const t = await setup();
  const id = grantId({ chainId: t.chainId, wallet: t.wallet, grant: t.grant });
  assert.equal((await t.pay()).reverted, undefined);
  assert.equal((await t.call('revoke', [id], t.agent.address)).error, 'NotOwner', 'the agent cannot touch revocation');
  assert.equal((await t.call('revoke', [id])).reverted, undefined);
  assert.equal(await t.read('revoked', [id]), true);
  // The agent's own key, a valid owner signature, a payment within every limit: refused.
  assert.equal((await t.pay()).error, 'GrantIsRevoked');
  // A grant can be revoked before it is ever used, and a new nonce is a new grant.
  const next = { ...t.grant, nonce: 1n };
  const nextId = grantId({ chainId: t.chainId, wallet: t.wallet, grant: next });
  await t.call('revoke', [nextId]);
  assert.equal((await t.pay({ g: next })).error, 'GrantIsRevoked');
  const fresh = { ...t.grant, nonce: 2n };
  assert.equal((await t.pay({ g: fresh })).reverted, undefined, 'only an explicit new grant restores spending');
});

test('only the owner withdraws; funds go where the owner says', { skip }, async () => {
  const t = await setup();
  const amount = parseEther('0.02');
  assert.equal((await t.call('withdraw', [t.agent.address, amount], t.agent.address)).error, 'NotOwner');
  const before = await t.balance(t.recipient);
  assert.equal((await t.call('withdraw', [t.recipient, amount])).reverted, undefined);
  assert.equal(await t.balance(t.recipient) - before, amount);
  assert.equal(await t.balance(t.wallet), parseEther('0.03'));
  assert.equal((await t.call('withdraw', [t.recipient, parseEther('1')])).error, 'TransferFailed', 'cannot overdraw');
});
