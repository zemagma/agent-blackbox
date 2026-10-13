#!/usr/bin/env node
// Demo agent: an Ethereum gas watcher whose every tool call goes into the blackbox.
//
//   node agent/demo.mjs [--state DIR] [--task "..."] [--scripted] [--checkpoint]
//
// With ANTHROPIC_API_KEY set it is a real Claude agent that decides which tools
// to call. Without it (or with --scripted) it runs a fixed plan, which is handy
// for trying the recorder without an API key.
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openState, checkpoint } from '../src/operator.mjs';
import { openBlackbox } from '../src/log.mjs';

const RPC = process.env.ETH_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const MODEL = process.env.BLACKBOX_MODEL ?? 'claude-sonnet-5-5';
const gwei = (hex) => (Number(BigInt(hex)) / 1e9).toFixed(3);

export function createTools({ rpc = RPC, fetchImpl = globalThis.fetch, alertsFile }) {
  async function call(method, params = []) {
    const res = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? 'rpc error');
    return json.result;
  }
  return {
    get_gas_price: {
      description: 'Current Ethereum mainnet gas price in gwei.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => ({ gwei: gwei(await call('eth_gasPrice')) }),
      summarize: (_, o) => `gas price is ${o.gwei} gwei`,
    },
    get_latest_block: {
      description: 'Latest Ethereum block number and its base fee in gwei.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const b = await call('eth_getBlockByNumber', ['latest', false]);
        return { number: Number(BigInt(b.number)), baseFeeGwei: gwei(b.baseFeePerGas ?? '0x0') };
      },
      summarize: (_, o) => `block ${o.number}, base fee ${o.baseFeeGwei} gwei`,
    },
    get_eth_balance: {
      description: 'ETH balance of an address.',
      schema: { type: 'object', properties: { address: { type: 'string', description: '0x address' } }, required: ['address'] },
      run: async ({ address }) => {
        if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) throw new Error('invalid address');
        return { address, eth: (Number(BigInt(await call('eth_getBalance', [address, 'latest']))) / 1e18).toFixed(6) };
      },
      summarize: (i, o) => `${i.address.slice(0, 8)}… holds ${o.eth} ETH`,
    },
    post_alert: {
      description: 'Post a short alert for the operator. Use only when something is worth telling them.',
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: async ({ text }) => {
        const clean = String(text ?? '').slice(0, 280);
        if (alertsFile) await appendFile(alertsFile, new Date().toISOString() + ' ' + clean + '\n');
        return { posted: true };
      },
      summarize: (i) => 'alert: ' + String(i.text ?? '').slice(0, 120),
    },
  };
}

/** Wraps every tool with the blackbox recorder. */
export function recordedTools(box, tools) {
  return Object.fromEntries(Object.entries(tools).map(([name, t]) =>
    [name, { ...t, run: box.wrapTool(name, t.run, { summarize: t.summarize, summarizeError: t.summarizeError }) }]));
}

export async function runScripted(tools) {
  const gas = await tools.get_gas_price.run({});
  const block = await tools.get_latest_block.run({});
  const cheap = Number(gas.gwei) < 2;
  if (cheap) await tools.post_alert.run({ text: `Gas is ${gas.gwei} gwei at block ${block.number}: a cheap moment to deploy.` });
  return cheap ? `Gas is cheap (${gas.gwei} gwei); I posted an alert.` : `Gas is ${gas.gwei} gwei; nothing to report.`;
}

const GAS_SYSTEM = 'You are a careful Ethereum gas watcher. Use the tools to answer. Every tool call you make is recorded in a public, tamper-evident log, so act deliberately.';

export async function runClaude(tools, task, { client, model = MODEL, maxTurns = 8, system = GAS_SYSTEM } = {}) {
  const messages = [{ role: 'user', content: task }];
  const toolDefs = Object.entries(tools).map(([name, t]) => ({ name, description: t.description, input_schema: t.schema }));
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await client.messages.create({ model, max_tokens: 1024, tools: toolDefs, messages,
      system });
    messages.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || uses.length === 0) {
      return res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    }
    const results = [];
    for (const use of uses) {
      try {
        const out = await tools[use.name].run(use.input ?? {});
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: String(err.message), is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return 'Stopped after the turn limit.';
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] ?? true) : undefined; };
  const ctx = await openState(opt('state') ?? '.blackbox');
  if (!ctx.state.agent) throw new Error('run `node bin/blackbox.mjs setup` first');
  if (ctx.state.revokedAt) throw new Error('this agent\'s mandate was revoked; it may not act any more');
  const box = await openBlackbox({ file: ctx.logFile, agent: ctx.state.agent.name });
  const tools = recordedTools(box, createTools({ alertsFile: join(ctx.directory, 'alerts.log') }));
  const task = typeof opt('task') === 'string' ? opt('task') : 'Check Ethereum gas right now and alert me if it is a cheap moment to deploy a contract.';
  let answer;
  if (process.env.ANTHROPIC_API_KEY && !argv.includes('--scripted')) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    await box.append({ type: 'note', summary: 'task: ' + task.slice(0, 180), payload: { task, model: MODEL } });
    answer = await runClaude(tools, task, { client: new Anthropic() });
  } else {
    await box.append({ type: 'note', summary: 'task (scripted): ' + task.slice(0, 160), payload: { task, model: null } });
    answer = await runScripted(tools);
  }
  await box.append({ type: 'note', summary: 'answer: ' + answer.slice(0, 180), payload: { answer } });
  console.log(answer);
  if (argv.includes('--checkpoint')) console.log(JSON.stringify(await checkpoint(ctx), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('error:', err.message); process.exitCode = 1; });
}
