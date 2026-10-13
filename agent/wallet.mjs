#!/usr/bin/env node
// Sepolia wallet agent: an AI agent with its own hot wallet. It can move funds
// only through one recorded tool, only within a fixed policy, and only while
// its Claus mandate is active. Revoke the mandate and the money stops.
//
//   node agent/wallet.mjs init --owner 0xYOU [--max-tx 0.01] [--max-day 0.05] [--allow 0xA,0xB]
//   node agent/wallet.mjs status
//   node agent/wallet.mjs run [--task "..."] [--scripted] [--checkpoint]
//   node agent/wallet.mjs prove-revoked      after `blackbox revoke`: one send attempt, denied by Claus
//   node agent/wallet.mjs sweep              operator returns the remaining funds to the owner
//
// All commands take --state DIR (default .blackbox-wallet). SEPOLIA_RPC_URL sets the RPC.
// Testnet only: the chain is fixed to Sepolia (11155111).
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, isAddress, getAddress } from 'viem';
import { sepolia } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openState, checkpoint } from '../src/operator.mjs';
import { openBlackbox, readLog } from '../src/log.mjs';
import { createClaus } from '../src/claus.mjs';
import { recordedTools, runClaude } from './demo.mjs';

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const MODEL = process.env.BLACKBOX_MODEL ?? 'claude-sonnet-5-5';
const DAY = 86400000;
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const eth = (wei) => formatEther(BigInt(wei));
export const explorerTx = (hash) => 'https://sepolia.etherscan.io/tx/' + hash;

const SYSTEM = 'You control a Sepolia test wallet through tools. Every tool call you make is recorded in a public, '
  + 'tamper-evident log. Move funds only when the task asks for it, stay within the policy that wallet_status reports, '
  + 'and give a short, honest reason for every payment. If a payment is refused, report the refusal; do not try to get around it.';

/** Value sent by successful send_eth calls in the last 24 hours, read from the log itself. */
export function spentInLastDay(lines, now = Date.now()) {
  let total = 0n;
  for (const l of lines) {
    const e = l.entry;
    if (e.type === 'action' && e.tool === 'send_eth' && e.at > now - DAY && l.payload?.ok && l.payload.output?.valueWei) {
      total += BigInt(l.payload.output.valueWei);
    }
  }
  return total;
}

export function makePolicy({ owner, maxTx = '0.01', maxDay = '0.05', allow = [] }) {
  if (!isAddress(owner ?? '')) throw new Error('--owner must be your 0x address (where funds may be returned)');
  const recipients = [...new Set([owner, ...allow].map((a) => {
    if (!isAddress(a)) throw new Error('not an address: ' + a);
    return getAddress(a);
  }))];
  const maxTxWei = parseEther(String(maxTx)), maxDayWei = parseEther(String(maxDay));
  if (maxTxWei <= 0n || maxDayWei < maxTxWei) throw new Error('limits must be positive, and the daily limit at least the per-payment limit');
  return { owner: getAddress(owner), maxTxWei: maxTxWei.toString(), maxDayWei: maxDayWei.toString(), allow: recipients };
}

const refuse = (why) => Object.assign(new Error('refused: ' + why), { refused: true });

/**
 * The wallet's tools. `chain` does the actual blockchain work and `checkMandate`
 * asks Claus whether the agent's credential still works; both are injected so the
 * policy logic can be tested without a network.
 */
export function createWalletTools({ address, policy, chain, checkMandate, spent }) {
  const allowed = new Set(policy.allow.map((a) => a.toLowerCase()));
  return {
    wallet_status: {
      description: 'This wallet\'s address, Sepolia balance, spending policy and what is left to spend today.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const [balance, used] = await Promise.all([chain.balance(address), spent()]);
        const left = BigInt(policy.maxDayWei) - used;
        return { address, network: 'sepolia', balanceEth: eth(balance), owner: policy.owner,
          maxPerPaymentEth: eth(policy.maxTxWei), maxPerDayEth: eth(policy.maxDayWei),
          sentLast24hEth: eth(used), leftTodayEth: eth(left > 0n ? left : 0n), allowedRecipients: policy.allow };
      },
      summarize: (_, o) => `wallet holds ${o.balanceEth} ETH; ${o.leftTodayEth} ETH left to spend today`,
    },
    send_eth: {
      description: 'Send Sepolia ETH to an allowed recipient. Limited per payment and per day; needs an active Claus mandate.',
      schema: { type: 'object', properties: {
        to: { type: 'string', description: '0x recipient address (must be on the allowed list)' },
        amountEth: { type: 'string', description: 'Amount in ETH, e.g. "0.001"' },
        reason: { type: 'string', description: 'Short reason for the payment (recorded publicly)' },
      }, required: ['to', 'amountEth', 'reason'], additionalProperties: false },
      run: async ({ to, amountEth, reason } = {}) => {
        if (!isAddress(to ?? '')) throw refuse('not a valid address');
        const dest = getAddress(to);
        if (!allowed.has(dest.toLowerCase())) throw refuse(`${short(dest)} is not an allowed recipient`);
        let value;
        try { value = parseEther(String(amountEth)); } catch { throw refuse('invalid amount'); }
        if (value <= 0n) throw refuse('amount must be positive');
        if (value > BigInt(policy.maxTxWei)) throw refuse(`${eth(value)} ETH is over the ${eth(policy.maxTxWei)} ETH per-payment limit`);
        if ((await spent()) + value > BigInt(policy.maxDayWei)) throw refuse(`would exceed the ${eth(policy.maxDayWei)} ETH daily limit`);
        const why = String(reason ?? '').trim();
        if (!why || why.length > 140) throw refuse('a reason of 1-140 characters is required');
        await checkMandate();                       // asks Claus right before signing
        const hash = await chain.send({ to: dest, value });
        const receipt = await chain.waitReceipt(hash);
        return { hash, to: dest, valueWei: value.toString(), amountEth: eth(value), reason: why,
          status: receipt?.status ?? 'pending', blockNumber: receipt?.blockNumber ?? null, explorer: explorerTx(hash) };
      },
      summarize: (i, o) => `sent ${o.amountEth} ETH to ${short(o.to)} (${o.status}): ${o.reason.slice(0, 48)} · tx ${o.hash}`,
      summarizeError: (_, err) => err?.refused ? 'send_eth ' + String(err.message).slice(0, 150) : 'send_eth failed (network or RPC error)',
    },
    get_transaction: {
      description: 'Status of a Sepolia transaction by hash.',
      schema: { type: 'object', properties: { hash: { type: 'string' } }, required: ['hash'], additionalProperties: false },
      run: async ({ hash } = {}) => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) throw refuse('not a transaction hash');
        const r = await chain.receipt(hash);
        return { hash, status: r?.status ?? 'pending', blockNumber: r?.blockNumber ?? null, explorer: explorerTx(hash) };
      },
      summarize: (_, o) => `tx ${o.hash.slice(0, 10)}… is ${o.status}`,
    },
  };
}

export async function runScriptedWallet(tools, owner) {
  const status = await tools.wallet_status.run({});
  if (Number(status.balanceEth) < 0.002) return `The wallet holds ${status.balanceEth} ETH; fund ${status.address} to try a payment.`;
  const sent = await tools.send_eth.run({ to: owner, amountEth: '0.001', reason: 'scripted test payment back to the owner' });
  return `Sent 0.001 ETH back to the owner (${sent.status}): ${sent.explorer}`;
}

function sepoliaChain(privateKey, rpc = RPC) {
  const account = privateKeyToAccount(privateKey);
  const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
  const toReceipt = (r) => ({ status: r.status, blockNumber: Number(r.blockNumber) });
  return {
    pub, wallet, account,
    balance: (address) => pub.getBalance({ address }),
    send: ({ to, value, ...fees }) => wallet.sendTransaction({ to, value, ...fees }),
    waitReceipt: async (hash) => { try { return toReceipt(await pub.waitForTransactionReceipt({ hash, timeout: 90000 })); } catch { return null; } },
    receipt: async (hash) => { try { return toReceipt(await pub.getTransactionReceipt({ hash })); } catch { return null; } },
  };
}

/** Fails closed: any error reaching Claus, or an expired mandate, refuses the payment. */
export function mandateChecker(state) {
  return async () => {
    if (state.revokedAt) throw refuse('the Claus mandate was revoked');
    if (state.agent.expiresAt && Date.now() > state.agent.expiresAt) throw refuse('the Claus mandate has expired');
    try {
      await createClaus({ origin: state.origin, token: state.agent.token }).call('project_get', { projectId: state.agent.projectId });
    } catch (err) { throw refuse(`Claus denied the agent's credential (${err.code ?? 'unreachable'})`); }
  };
}

async function main() {
  const [command = 'help', ...argv] = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] ?? true) : undefined; };
  if (command === 'help' || command === '--help') {
    console.log('commands: init --owner 0x… | status | run [--task …] [--scripted] [--checkpoint] | prove-revoked | sweep   (--state DIR)');
    return;
  }
  const ctx = await openState(opt('state') ?? '.blackbox-wallet');
  const s = ctx.state;
  if (!s.agent) throw new Error('run `node bin/blackbox.mjs setup --state ' + (opt('state') ?? '.blackbox-wallet') + ' --agent sepolia-wallet` first');
  const box = await openBlackbox({ file: ctx.logFile, agent: s.agent.name });
  const print = (x) => console.log(JSON.stringify(x, null, 2));

  if (command === 'init') {
    if (s.revokedAt) throw new Error('this agent was revoked; set up a new state directory');
    const policy = makePolicy({ owner: opt('owner'), maxTx: opt('max-tx') ?? '0.01', maxDay: opt('max-day') ?? '0.05',
      allow: typeof opt('allow') === 'string' ? opt('allow').split(',').map((a) => a.trim()).filter(Boolean) : [] });
    s.wallet ??= { privateKey: generatePrivateKey() };
    const address = privateKeyToAccount(s.wallet.privateKey).address;
    if (JSON.stringify(s.wallet.policy) !== JSON.stringify(policy)) {
      s.wallet.policy = policy; s.wallet.address = address; await ctx.save();
      await box.append({ type: 'note',
        summary: `Sepolia wallet ${short(address)}: up to ${eth(policy.maxTxWei)} ETH per payment, ${eth(policy.maxDayWei)} ETH per day, `
          + `only to ${policy.allow.length === 1 ? short(policy.allow[0]) : policy.allow.length + ' allowed addresses'}`,
        payload: { wallet: address, chainId: sepolia.id, policy } });
    }
    print({ wallet: address, network: 'sepolia', owner: policy.owner, maxPerPaymentEth: eth(policy.maxTxWei),
      maxPerDayEth: eth(policy.maxDayWei), allowedRecipients: policy.allow,
      next: `Fund it from your wallet with a small amount (e.g. 0.05 Sepolia ETH) to ${address}` });
    return;
  }

  if (!s.wallet?.policy) throw new Error('run `node agent/wallet.mjs init --owner 0xYOU` first');
  const chain = sepoliaChain(s.wallet.privateKey);
  const raw = createWalletTools({ address: s.wallet.address, policy: s.wallet.policy, chain,
    checkMandate: mandateChecker(s), spent: async () => spentInLastDay(await readLog(ctx.logFile)) });

  if (command === 'status') {
    print({ ...(await raw.wallet_status.run()), revokedAt: s.revokedAt ?? null });
    return;
  }

  if (command === 'run') {
    if (s.revokedAt) throw new Error('this agent\'s mandate was revoked; it may not act any more (try prove-revoked)');
    const tools = recordedTools(box, raw);
    const owner = s.wallet.policy.owner;
    const task = typeof opt('task') === 'string' ? opt('task')
      : `Check the wallet. If it can afford it, send 0.001 ETH back to the owner (${owner}) as a test payment, then confirm the transaction.`;
    let answer;
    if (process.env.ANTHROPIC_API_KEY && !argv.includes('--scripted')) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      await box.append({ type: 'note', summary: 'task: ' + task.slice(0, 180), payload: { task, model: MODEL } });
      answer = await runClaude(tools, task, { client: new Anthropic(), model: MODEL, system: SYSTEM });
    } else {
      await box.append({ type: 'note', summary: 'task (scripted): ' + task.slice(0, 160), payload: { task, model: null } });
      answer = await runScriptedWallet(tools, owner);
    }
    await box.append({ type: 'note', summary: 'answer: ' + answer.slice(0, 180), payload: { answer } });
    console.log(answer);
    if (argv.includes('--checkpoint')) print(await checkpoint(ctx));
    return;
  }

  if (command === 'prove-revoked') {
    if (!s.revokedAt) throw new Error('revoke first: node bin/blackbox.mjs revoke --state … --reason "…"');
    // Skip the local revoked flag so the refusal has to come from Claus itself.
    const checkClausOnly = mandateChecker({ ...s, revokedAt: undefined });
    const tools = recordedTools(box, createWalletTools({ address: s.wallet.address, policy: s.wallet.policy, chain,
      checkMandate: checkClausOnly, spent: async () => spentInLastDay(await readLog(ctx.logFile)) }));
    let outcome;
    try {
      const r = await tools.send_eth.run({ to: s.wallet.policy.owner, amountEth: '0.0001', reason: 'attempt after revocation (should be denied)' });
      outcome = { denied: false, unexpected: r };
      process.exitCode = 1;
    } catch (err) { outcome = { denied: true, why: err.message }; }
    print({ ...outcome, checkpoint: await checkpoint(ctx, { as: 'owner' }) });
    return;
  }

  if (command === 'sweep') {
    const balance = await chain.balance(s.wallet.address);
    const fees = await chain.pub.estimateFeesPerGas();
    const value = balance - 21000n * fees.maxFeePerGas;
    if (value <= 0n) { print({ swept: false, balanceEth: eth(balance), why: 'nothing left after gas' }); return; }
    const hash = await chain.send({ to: s.wallet.policy.owner, value, gas: 21000n,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    const receipt = await chain.waitReceipt(hash);
    await box.append({ type: 'note', summary: `operator swept ${eth(value)} ETH back to the owner ${short(s.wallet.policy.owner)} · tx ${hash}`,
      payload: { hash, valueWei: value.toString(), to: s.wallet.policy.owner, status: receipt?.status ?? 'pending' } });
    print({ swept: true, amountEth: eth(value), status: receipt?.status ?? 'pending', explorer: explorerTx(hash),
      checkpoint: s.revokedAt ? await checkpoint(ctx, { as: 'owner' }) : 'run `blackbox checkpoint` to stamp it' });
    return;
  }
  throw new Error('unknown command: ' + command);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('error:', err.message); process.exitCode = 1; });
}
