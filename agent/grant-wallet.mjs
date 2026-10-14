#!/usr/bin/env node
// Sepolia wallet agent with an ON-CHAIN kill switch (Claus signal-grant pattern).
//
// The funds live in a GrantWallet contract. The owner signs a spending grant for the
// agent's key (EIP-712: recipient, per-payment and daily limits, expiry). Every payment
// is checked by the contract. Revoking makes two changes: the Claus mandate is revoked,
// and the grant is revoked ON-CHAIN, so even a direct contract call with the agent's
// own key fails. The agent's key only holds gas money.
//
//   node agent/grant-wallet.mjs init   --owner 0xYOU [--max-tx 0.01] [--max-day 0.05]
//   node agent/grant-wallet.mjs deploy [--fund 0.05]      after funding the printed owner address
//   node agent/grant-wallet.mjs status
//   node agent/grant-wallet.mjs run    [--task "..."] [--scripted] [--checkpoint]
//   node agent/grant-wallet.mjs revoke [--reason TEXT]    on-chain grant revoke + Claus mandate revoke
//   node agent/grant-wallet.mjs prove-revoked             tool attempt (Claus denies) + direct call (chain refuses)
//   node agent/grant-wallet.mjs sweep                     all remaining ETH back to you
//
// All commands take --state DIR (default .blackbox-grant). SEPOLIA_RPC_URL sets the RPC.
// Testnet only: the chain is fixed to Sepolia (11155111).
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, keccak256, toHex,
  encodeFunctionData, ContractFunctionRevertedError } from 'viem';
import { sepolia } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openState, checkpoint, revoke as revokeMandate } from '../src/operator.mjs';
import { openBlackbox, readLog } from '../src/log.mjs';
import { abi, artifact, makeGrant, grantId, signGrant, grantToJson, grantFromJson } from '../src/grant.mjs';
import { recordedTools, runClaude } from './demo.mjs';
import { createWalletTools, makePolicy, spentInLastDay, runScriptedWallet, mandateChecker, explorerTx, refused } from './wallet.mjs';

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const MODEL = process.env.BLACKBOX_MODEL ?? 'claude-sonnet-5-5';
const AGENT_GAS = parseEther('0.005');
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const eth = (wei) => formatEther(BigInt(wei));

const SYSTEM = 'You control a Sepolia test wallet through tools. The funds sit in a GrantWallet contract that only pays within '
  + 'an owner-signed grant. Every tool call you make is recorded in a public, tamper-evident log. Move funds only when the task '
  + 'asks for it, stay within the policy that wallet_status reports, and give a short, honest reason for every payment. If a '
  + 'payment is refused, report the refusal; do not try to get around it.';

/** The custom error name from a reverted contract call, if any. */
export function revertName(err) {
  const r = err?.walk?.((e) => e instanceof ContractFunctionRevertedError);
  return r?.data?.errorName ?? r?.reason ?? err?.shortMessage ?? 'reverted';
}

export function clients(rpc = RPC) {
  const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
  const as = (privateKey) => {
    const account = privateKeyToAccount(privateKey);
    return { account, client: createWalletClient({ account, chain: sepolia, transport: http(rpc) }) };
  };
  const wait = async (hash) => {
    try { const r = await pub.waitForTransactionReceipt({ hash, timeout: 120000 }); return { status: r.status, blockNumber: Number(r.blockNumber), contractAddress: r.contractAddress }; }
    catch { return null; }
  };
  return { pub, as, wait };
}

/** The chain adapter the wallet tools use: balance of the contract, payments through pay(). */
export function grantChain(w, { pub, as, wait }) {
  const agent = as(w.privateKey);
  const grant = grantFromJson(w.grant);
  return {
    balance: () => pub.getBalance({ address: w.contract }),
    send: async ({ to, value, reason }) => {
      const args = [grant, w.grantSignature, to, value, keccak256(toHex(reason ?? ''))];
      try { await pub.simulateContract({ account: agent.account, address: w.contract, abi, functionName: 'pay', args }); }
      catch (err) { throw refused(`the GrantWallet contract refused it (${revertName(err)})`); }
      return agent.client.writeContract({ address: w.contract, abi, functionName: 'pay', args });
    },
    waitReceipt: wait,
    receipt: async (hash) => { try { const r = await pub.getTransactionReceipt({ hash }); return { status: r.status, blockNumber: Number(r.blockNumber) }; } catch { return null; } },
  };
}

async function sendAll({ from, to, pub, wait }) {
  const balance = await pub.getBalance({ address: from.account.address });
  const fees = await pub.estimateFeesPerGas();
  const value = balance - 21000n * fees.maxFeePerGas;
  if (value <= 0n) return null;
  const hash = await from.client.sendTransaction({ to, value, gas: 21000n, maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  return { hash, value, receipt: await wait(hash) };
}

async function main() {
  const [command = 'help', ...argv] = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] ?? true) : undefined; };
  if (command === 'help' || command === '--help') {
    console.log('commands: init --owner 0x… | deploy [--fund 0.05] | status | run [--task …] [--scripted] [--checkpoint] | revoke [--reason …] | prove-revoked | sweep   (--state DIR)');
    return;
  }
  const dir = opt('state') ?? '.blackbox-grant';
  const ctx = await openState(dir);
  const s = ctx.state;
  if (!s.agent) throw new Error(`run \`node bin/blackbox.mjs setup --state ${dir} --agent grant-wallet\` first`);
  const box = await openBlackbox({ file: ctx.logFile, agent: s.agent.name });
  const print = (x) => console.log(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  const net = clients();
  const ownerKey = s.keys?.operator;
  if (!ownerKey) throw new Error('no operator key in this state; run setup first');
  const owner = net.as(ownerKey);

  if (command === 'init') {
    if (s.revokedAt) throw new Error('this agent was revoked; set up a new state directory');
    if (s.wallet?.contract) throw new Error('already deployed at ' + s.wallet.contract);
    const policy = makePolicy({ owner: opt('owner'), maxTx: opt('max-tx') ?? '0.01', maxDay: opt('max-day') ?? '0.05' });
    s.wallet ??= { privateKey: generatePrivateKey(), mode: 'grant' };
    s.wallet.policy = policy;
    s.wallet.address = privateKeyToAccount(s.wallet.privateKey).address;
    await ctx.save();
    print({ mode: 'GrantWallet (on-chain grant)', contractOwner: owner.account.address, agentKey: s.wallet.address,
      recipient: policy.owner, maxPerPaymentEth: eth(policy.maxTxWei), maxPerDayEth: eth(policy.maxDayWei),
      next: `Send about 0.07 Sepolia ETH to ${owner.account.address} (the contract owner key), then run deploy. `
        + '0.05 goes into the GrantWallet, 0.005 to the agent key for gas, the rest pays the owner\'s gas.' });
    return;
  }

  if (command === 'deploy') {
    if (!s.wallet?.policy) throw new Error('run init first');
    if (s.wallet.contract) { print({ contract: s.wallet.contract, already: true }); return; }
    const fund = parseEther(String(opt('fund') ?? '0.05'));
    const need = fund + AGENT_GAS + parseEther('0.005');
    const have = await net.pub.getBalance({ address: owner.account.address });
    if (have < need) throw new Error(`owner key ${owner.account.address} holds ${eth(have)} ETH; it needs about ${eth(need)}`);
    const deployHash = await owner.client.deployContract({ abi, bytecode: artifact.bytecode, args: [owner.account.address], value: fund });
    const deployed = await net.wait(deployHash);
    if (deployed?.status !== 'success' || !deployed.contractAddress) throw new Error('deploy failed or timed out: ' + explorerTx(deployHash));
    const contract = deployed.contractAddress;
    const gasHash = await owner.client.sendTransaction({ to: s.wallet.address, value: AGENT_GAS });
    await net.wait(gasHash);
    const policy = s.wallet.policy;
    const expiresAt = BigInt(Math.floor(Math.min(s.agent.expiresAt, Date.now() + 29 * 86400000) / 1000));
    const grant = makeGrant({ agent: s.wallet.address, recipient: policy.owner, maxPerPayment: policy.maxTxWei,
      maxPerDay: policy.maxDayWei, expiresAt, nonce: 0n });
    const signature = await signGrant(owner.account, { chainId: sepolia.id, wallet: contract, grant });
    const id = grantId({ chainId: sepolia.id, wallet: contract, grant });
    const onchainId = await net.pub.readContract({ address: contract, abi, functionName: 'grantId', args: [grant] });
    if (onchainId !== id) throw new Error('grant id mismatch between this tool and the contract');
    Object.assign(s.wallet, { contract, grant: grantToJson(grant), grantSignature: signature, grantId: id,
      deployTx: deployHash, contractOwner: owner.account.address });
    await ctx.save();
    await box.append({ type: 'note',
      summary: `GrantWallet ${short(contract)} holds ${eth(fund)} ETH; owner-signed grant: ≤${eth(policy.maxTxWei)}/payment, ≤${eth(policy.maxDayWei)}/day, only to ${short(policy.owner)} · tx ${deployHash}`,
      payload: { contract, chainId: sepolia.id, contractOwner: owner.account.address, agentKey: s.wallet.address,
        grant: grantToJson(grant), grantId: id, deployTx: deployHash, agentGasTx: gasHash } });
    print({ contract, grantId: id, grantExpires: new Date(Number(expiresAt) * 1000).toISOString(),
      deploy: explorerTx(deployHash), agentGas: explorerTx(gasHash) });
    return;
  }

  const w = s.wallet;
  if (!w?.contract) throw new Error('run init and deploy first');
  const chain = grantChain(w, net);
  const makeTools = (checkMandate) => createWalletTools({ address: w.contract, policy: w.policy, chain, checkMandate,
    spent: async () => spentInLastDay(await readLog(ctx.logFile)) });

  if (command === 'status') {
    const status = await makeTools(mandateChecker(s)).wallet_status.run();
    const revoked = await net.pub.readContract({ address: w.contract, abi, functionName: 'revoked', args: [w.grantId] });
    print({ ...status, grantId: w.grantId, grantRevokedOnchain: revoked, mandateRevokedAt: s.revokedAt ?? null });
    return;
  }

  if (command === 'run') {
    if (s.revokedAt) throw new Error('this agent\'s mandate was revoked; it may not act any more (try prove-revoked)');
    const tools = recordedTools(box, makeTools(mandateChecker(s)));
    const recipient = w.policy.owner;
    const task = typeof opt('task') === 'string' ? opt('task')
      : `Check the wallet. If it can afford it, send 0.001 ETH back to the owner (${recipient}) as a test payment, then confirm the transaction.`;
    let answer;
    if (process.env.ANTHROPIC_API_KEY && !argv.includes('--scripted')) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      await box.append({ type: 'note', summary: 'task: ' + task.slice(0, 180), payload: { task, model: MODEL } });
      answer = await runClaude(tools, task, { client: new Anthropic(), model: MODEL, system: SYSTEM });
    } else {
      await box.append({ type: 'note', summary: 'task (scripted): ' + task.slice(0, 160), payload: { task, model: null } });
      answer = await runScriptedWallet(tools, recipient);
    }
    await box.append({ type: 'note', summary: 'answer: ' + answer.slice(0, 180), payload: { answer } });
    console.log(answer);
    if (argv.includes('--checkpoint')) print(await checkpoint(ctx));
    return;
  }

  if (command === 'revoke') {
    if (s.revokedAt) throw new Error('already revoked');
    // 1. On-chain: the grant itself, so the contract refuses whoever calls it.
    const hash = await owner.client.writeContract({ address: w.contract, abi, functionName: 'revoke', args: [w.grantId] });
    const receipt = await net.wait(hash);
    if (receipt?.status !== 'success') throw new Error('on-chain revoke failed or timed out: ' + explorerTx(hash));
    const revoked = await net.pub.readContract({ address: w.contract, abi, functionName: 'revoked', args: [w.grantId] });
    await box.append({ type: 'note', summary: `owner revoked the spending grant on-chain (GrantWallet ${short(w.contract)}) · tx ${hash}`,
      payload: { grantId: w.grantId, contract: w.contract, tx: hash, blockNumber: receipt.blockNumber, revokedOnchain: revoked } });
    // 2. On Claus: the mandate, then the final stamp.
    const r = await revokeMandate(ctx, { reason: opt('reason') ?? 'operator revoked access' });
    print({ onchainRevoke: explorerTx(hash), grantRevokedOnchain: revoked, ...r });
    return;
  }

  if (command === 'prove-revoked') {
    if (!s.revokedAt) throw new Error('revoke first: node agent/grant-wallet.mjs revoke --state …');
    const recipient = w.policy.owner;
    const amount = parseEther('0.0001');
    // A. Through the agent's tool, ignoring the local revoked flag: Claus refuses first.
    const tools = recordedTools(box, makeTools(mandateChecker({ ...s, revokedAt: undefined })));
    let viaTool;
    try { viaTool = { denied: false, unexpected: await tools.send_eth.run({ to: recipient, amountEth: '0.0001', reason: 'attempt after revocation (should be denied)' }) }; }
    catch (err) { viaTool = { denied: true, why: err.message }; }
    // B. Straight to the contract with the agent's own key: no tool, no Claus check.
    const agent = net.as(w.privateKey);
    const args = [grantFromJson(w.grant), w.grantSignature, recipient, amount, keccak256(toHex('direct call after revocation'))];
    let reason = 'reverted';
    try { await net.pub.simulateContract({ account: agent.account, address: w.contract, abi, functionName: 'pay', args }); reason = 'not refused'; }
    catch (err) { reason = revertName(err); }
    // Send it anyway, with a fixed gas limit, so the refusal is a real on-chain transaction anyone can look up.
    const hash = await agent.client.sendTransaction({ to: w.contract, gas: 150000n,
      data: encodeFunctionData({ abi, functionName: 'pay', args }) });
    const receipt = await net.wait(hash);
    const refusedOnchain = receipt?.status === 'reverted';
    await box.append({ type: 'action', tool: 'pay_direct',
      summary: refusedOnchain
        ? `direct contract call with the agent's own key, no Claus check: refused on-chain (${reason}) · tx ${hash}`
        : `direct contract call with the agent's own key: NOT refused (${receipt?.status ?? 'unknown'}) · tx ${hash}`,
      payload: { input: { to: recipient, amountWei: amount.toString() }, ok: !refusedOnchain, error: refusedOnchain ? reason : undefined,
        output: { hash, status: receipt?.status ?? 'unknown', blockNumber: receipt?.blockNumber ?? null } } });
    if (!refusedOnchain || viaTool.denied === false) process.exitCode = 1;
    print({ viaTool, direct: { refusedOnchain, reason, tx: explorerTx(hash) }, checkpoint: await checkpoint(ctx, { as: 'owner' }) });
    return;
  }

  if (command === 'sweep') {
    const recipient = w.policy.owner;
    const results = {};
    const inContract = await net.pub.getBalance({ address: w.contract });
    if (inContract > 0n) {
      const hash = await owner.client.writeContract({ address: w.contract, abi, functionName: 'withdraw', args: [recipient, inContract] });
      results.contract = { amountEth: eth(inContract), tx: explorerTx(hash), receipt: await net.wait(hash) };
      await box.append({ type: 'note', summary: `owner withdrew ${eth(inContract)} ETH from the GrantWallet to ${short(recipient)} · tx ${hash}`,
        payload: { tx: hash, valueWei: inContract.toString(), to: recipient } });
    }
    for (const [name, key] of [['agentKey', w.privateKey], ['ownerKey', ownerKey]]) {
      const r = await sendAll({ from: net.as(key), to: recipient, pub: net.pub, wait: net.wait });
      if (r) results[name] = { amountEth: eth(r.value), tx: explorerTx(r.hash), status: r.receipt?.status ?? 'pending' };
    }
    if (results.agentKey || results.ownerKey) {
      await box.append({ type: 'note', summary: `leftover gas money returned to ${short(recipient)}`, payload: results });
    }
    print({ ...results, checkpoint: s.revokedAt ? await checkpoint(ctx, { as: 'owner' }) : 'run `blackbox checkpoint` to stamp it' });
    return;
  }
  throw new Error('unknown command: ' + command);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('error:', err.shortMessage ?? err.message); process.exitCode = 1; });
}
