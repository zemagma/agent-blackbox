#!/usr/bin/env node
// Compiles contracts/GrantWallet.sol with solc 0.8.27 and writes
// contracts/build/GrantWallet.json (abi + bytecode). The test suite checks that the
// committed artifact matches a fresh compile of the source.
//   node dev/compile.mjs [--check]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const SETTINGS = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' };
const ARTIFACT = new URL('../contracts/build/GrantWallet.json', import.meta.url);

export async function compileGrantWallet() {
  const solc = require('solc');
  const source = await readFile(new URL('../contracts/GrantWallet.sol', import.meta.url), 'utf8');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { 'GrantWallet.sol': { content: source } },
    settings: { ...SETTINGS, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['GrantWallet.sol'].GrantWallet;
  return { contract: 'GrantWallet', compiler: 'solc ' + solc.version(), settings: SETTINGS, abi: c.abi,
    bytecode: '0x' + c.evm.bytecode.object };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifact = await compileGrantWallet();
  if (process.argv.includes('--check')) {
    const saved = JSON.parse(await readFile(ARTIFACT, 'utf8'));
    if (saved.bytecode !== artifact.bytecode) { console.error('artifact is out of date: run node dev/compile.mjs'); process.exit(1); }
    console.log('artifact up to date');
  } else {
    await mkdir(new URL('.', ARTIFACT), { recursive: true });
    await writeFile(ARTIFACT, JSON.stringify(artifact, null, 2) + '\n');
    console.log('wrote contracts/build/GrantWallet.json', (artifact.bytecode.length - 2) / 2, 'bytes');
  }
}
