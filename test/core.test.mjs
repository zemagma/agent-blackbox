import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashOf, sha256 } from '../src/hash.mjs';
import { merkleRoot, merkleProof, verifyProof } from '../src/merkle.mjs';
import { openBlackbox, readLog, verifyLog, redact } from '../src/log.mjs';
import { buildCheckpoint, checkCheckpoint, encodeOnchain, decodeOnchain, agentKey } from '../src/checkpoint.mjs';
import { stamp, INPUT_SCHEMA, OUTPUT_SCHEMA } from '../notary/notary.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'blackbox-'));
let clock = 1_800_000_000_000;
const now = () => (clock += 1000);

async function sampleLog() {
  const file = join(await tmp(), 'log.jsonl');
  const box = await openBlackbox({ file, agent: 'tester', now });
  await box.append({ type: 'genesis', summary: 'start', payload: { scopes: ['service.call'] } });
  const add = box.wrapTool('add', async ({ a, b }) => a + b, { summarize: (i, o) => `${i.a}+${i.b}=${o}` });
  const fail = box.wrapTool('fail', async () => { throw new Error('nope'); });
  await add({ a: 2, b: 3 });
  await assert.rejects(fail({}), /nope/);
  await add({ a: 10, b: 20 });
  return { file, box };
}

test('canonical JSON is key-order independent and rejects floats', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(hashOf({ x: 1, y: 2 }), hashOf({ y: 2, x: 1 }));
  assert.throws(() => canonical({ x: 1.5 }));
});

test('merkle proofs verify for every leaf, including odd-sized trees', () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const leaves = Array.from({ length: n }, (_, i) => sha256('leaf' + i));
    const root = merkleRoot(leaves);
    leaves.forEach((leaf, i) => assert.ok(verifyProof(leaf, merkleProof(leaves, i), root), `n=${n} i=${i}`));
    if (n > 1) assert.ok(!verifyProof(sha256('other'), merkleProof(leaves, 0), root));
  }
});

test('the log records successes and failures and verifies', async () => {
  const { file, box } = await sampleLog();
  const lines = await readLog(file);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => l.entry.type), ['genesis', 'action', 'action', 'action']);
  assert.equal(lines[1].entry.summary, '2+3=5');
  assert.equal(lines[2].payload.ok, false);
  assert.equal(verifyLog(lines).ok, true);
  assert.equal(verifyLog(lines).head, box.head);
});

test('any edit, deletion, reordering or payload swap is detected', async () => {
  const { file } = await sampleLog();
  const lines = await readLog(file);
  const edited = structuredClone(lines); edited[1].entry.summary = '2+3=6';
  assert.match(verifyLog(edited).errors[0].reason, /hash/);
  const deleted = lines.filter((_, i) => i !== 2);
  assert.equal(verifyLog(deleted).ok, false);
  const swapped = [lines[0], lines[2], lines[1], lines[3]];
  assert.equal(verifyLog(swapped).ok, false);
  const payload = structuredClone(lines); payload[1].payload.output = 999;
  assert.match(verifyLog(payload).errors[0].reason, /payload/);
  // Re-hashing an edited entry still breaks the next link.
  const rehashed = structuredClone(lines); rehashed[1].entry.summary = 'x'; rehashed[1].hash = hashOf(rehashed[1].entry);
  assert.match(verifyLog(rehashed).errors[0].reason, /previous/);
});

test('reopening a tampered file refuses to append', async () => {
  const { file } = await sampleLog();
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('2+3=5', '2+3=7'));
  await assert.rejects(openBlackbox({ file, agent: 'tester' }), /failed verification/);
});

test('redacted logs still verify the chain', async () => {
  const { file } = await sampleLog();
  const lines = await readLog(file);
  const pub = redact(lines);
  assert.ok(pub.every((l) => l.payload === undefined));
  assert.equal(verifyLog(pub).ok, true);
});

test('checkpoints pin ranges, detect rewrites, and round-trip their onchain form', async () => {
  const { file, box } = await sampleLog();
  const lines = await readLog(file);
  const cp1 = buildCheckpoint(lines.slice(0, 2));
  assert.deepEqual([cp1.fromSeq, cp1.toSeq, cp1.count], [0, 1, 2]);
  await box.append({ type: 'note', summary: 'later' });
  const all = await readLog(file);
  const cp2 = buildCheckpoint(all, { fromSeq: 2 });
  assert.deepEqual([cp2.fromSeq, cp2.toSeq, cp2.head], [2, 4, box.head]);
  assert.ok(checkCheckpoint(all, cp1).ok && checkCheckpoint(all, cp2).ok);
  const forged = structuredClone(all); forged[3].entry.summary = 'forged';
  assert.equal(checkCheckpoint(forged, cp2).ok, false);
  const decoded = decodeOnchain(encodeOnchain(cp2));
  assert.deepEqual(decoded, { agentKey: agentKey('tester'), fromSeq: 2, toSeq: 4, root: cp2.root, head: cp2.head,
    endedAt: Math.floor(cp2.to / 1000) });
});

test('the notary stamps well-formed checkpoints and refuses malformed ones', async () => {
  const { file } = await sampleLog();
  const cp = buildCheckpoint(await readLog(file));
  const out = stamp(cp, { now: cp.to + 5000 });
  assert.equal(out.notarizedAt, cp.to + 5000);
  assert.equal(out.probe, false);
  assert.ok(Object.keys(OUTPUT_SCHEMA.properties).every((k) => k in out));
  assert.ok(Object.keys(INPUT_SCHEMA.properties).every((k) => k in cp));
  assert.throws(() => stamp({ ...cp, count: 99 }, { now: cp.to }));
  assert.throws(() => stamp({ ...cp, root: 'nothex' }, { now: cp.to }));
  assert.throws(() => stamp({ ...cp, to: cp.to + 10 * 60000 }, { now: cp.to }), 'future checkpoints are refused');
});

test('site files: bundle as a script, claus.json lets the page reach the Claus API only', async () => {
  const { siteFiles } = await import('../src/site.mjs');
  const { readFile } = await import('node:fs/promises');
  const bundle = JSON.parse(await readFile(new URL('../viewer/bundle.json', import.meta.url), 'utf8'));
  const files = await siteFiles({ bundle });
  const manifest = JSON.parse(files.find((f) => f.path === 'claus.json').content);
  assert.deepEqual(manifest.connect, ['https://claus-network-api.vercel.app']);
  assert.equal(manifest.schema, 'claus-project/1');
  assert.ok(manifest.description.length <= 500 && manifest.name.length <= 80);
  const raw = files.map((f) => f.content).join('\n');
  for (const secret of ['privateKey', '"token"', 'sk-ant']) assert.equal(raw.includes(secret), false, secret);
  await assert.rejects(siteFiles({ bundle: { format: 'other' } }), /not an agent-blackbox bundle/);
});
