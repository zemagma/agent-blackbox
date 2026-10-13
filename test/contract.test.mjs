// Compiles contracts/AgentBlackboxModule.sol with solc 0.8.27 (Claus's compiler
// profile: optimizer 200, viaIR, cancun) and runs evaluate() in a local EVM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { encodeAbiParameters, encodeFunctionData, decodeFunctionResult, hexToBytes, bytesToHex, zeroAddress } from 'viem';
import { openBlackbox, readLog } from '../src/log.mjs';
import { buildCheckpoint, encodeOnchain, agentKey } from '../src/checkpoint.mjs';

const require = createRequire(import.meta.url);
let solc, createEVM, createAddressFromString;
try {
  solc = require('solc');
  ({ createEVM } = await import('@ethereumjs/evm'));
  ({ createAddressFromString } = await import('@ethereumjs/util'));
} catch { /* dev dependencies not installed */ }

async function compile() {
  const source = await readFile(new URL('../contracts/AgentBlackboxModule.sol', import.meta.url), 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { 'AgentBlackboxModule.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  assert.deepEqual(errors, []);
  const c = out.contracts['AgentBlackboxModule.sol'].AgentBlackboxModule;
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

const CONTEXT = [{ type: 'tuple', components: [
  { name: 'chainId', type: 'uint256' }, { name: 'store', type: 'address' }, { name: 'projectId', type: 'bytes32' },
  { name: 'feedId', type: 'bytes32' }, { name: 'schemaHash', type: 'bytes32' }, { name: 'publisher', type: 'address' },
  { name: 'sequence', type: 'uint64' }, { name: 'observedAt', type: 'uint64' }, { name: 'validUntil', type: 'uint64' },
  { name: 'sourceHash', type: 'bytes32' }, { name: 'data', type: 'bytes' }] }];

test('the onchain evaluator accepts real checkpoints and rejects bad ones', { skip: !solc && 'dev dependencies not installed' }, async () => {
  const { abi, bytecode } = await compile();
  const evm = await createEVM();
  const deployer = createAddressFromString('0x' + '11'.repeat(20));
  const deployed = await evm.runCall({ caller: deployer, data: hexToBytes(bytecode), gasLimit: 5_000_000n });
  assert.equal(deployed.execResult.exceptionError, undefined);
  const to = deployed.createdAddress;

  // A real checkpoint from a real log.
  const box = await openBlackbox({ file: join(await mkdtemp(join(tmpdir(), 'bb-sol-')), 'log.jsonl'), agent: 'gas-watcher' });
  await box.append({ type: 'genesis', summary: 'start' });
  await box.append({ type: 'note', summary: 'hello' });
  const cp = buildCheckpoint(await readLog(box.file));
  const endedAt = BigInt(Math.floor(cp.to / 1000));

  async function evaluate({ data = encodeOnchain(cp), observedAt = endedAt, validUntil = endedAt + 3600n, now = endedAt + 60n, maxAge = 7200n } = {}) {
    const input = encodeAbiParameters(CONTEXT, [{ chainId: 11155111n, store: zeroAddress, projectId: '0x' + '22'.repeat(32),
      feedId: '0x' + '33'.repeat(32), schemaHash: '0x' + '44'.repeat(32), publisher: zeroAddress, sequence: 1n,
      observedAt, validUntil, sourceHash: '0x' + '55'.repeat(32), data }]);
    const configuration = encodeAbiParameters([{ type: 'uint256' }], [maxAge]);
    const call = encodeFunctionData({ abi, functionName: 'evaluate', args: [configuration, input] });
    const r = await evm.runCall({ to, caller: deployer, data: hexToBytes(call), gasLimit: 200_000n,
      block: { header: { timestamp: now, number: 1n, baseFeePerGas: 0n, getBlobGasPrice: () => 0n } } });
    return r.execResult.exceptionError ? { reverted: true, gas: r.execResult.executionGasUsed }
      : { output: decodeFunctionResult({ abi, functionName: 'evaluate', data: bytesToHex(r.execResult.returnValue) }),
        gas: r.execResult.executionGasUsed };
  }

  const ok = await evaluate();
  assert.equal(ok.reverted, undefined);
  assert.ok(ok.gas < 200_000n, 'fits the Claus 200,000 gas evaluator cap');
  const [key, fromSeq, toSeq, root, head] = (await import('viem')).decodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes32' }, { type: 'bytes32' }], ok.output);
  assert.deepEqual([key, fromSeq, toSeq, root, head], [agentKey('gas-watcher'), 0n, 1n, cp.root, cp.head]);

  assert.ok((await evaluate({ observedAt: endedAt + 1n })).reverted, 'observedAt must equal the checkpoint end');
  assert.ok((await evaluate({ now: endedAt + 10_000n })).reverted, 'stale checkpoints are refused');
  assert.ok((await evaluate({ now: endedAt - 1n })).reverted, 'future checkpoints are refused');
  assert.ok((await evaluate({ validUntil: endedAt + 99_999n })).reverted, 'validity cannot exceed the maximum age');
  assert.ok((await evaluate({ maxAge: 0n })).reverted, 'configuration must be bounded');
  assert.ok((await evaluate({ data: '0x1234' })).reverted, 'malformed data is refused');
  const backwards = encodeOnchain({ ...cp, fromSeq: 5, toSeq: 4 });
  assert.ok((await evaluate({ data: backwards })).reverted, 'ranges cannot run backwards');
  const oneEntryWrongRoot = encodeOnchain({ ...cp, fromSeq: 3, toSeq: 3 });
  assert.ok((await evaluate({ data: oneEntryWrongRoot })).reverted, 'single-entry root must equal head');
});
