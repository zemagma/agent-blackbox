// Browser-side verification, using only WebCrypto. Mirrors src/hash.mjs,
// src/merkle.mjs, src/log.mjs and src/checkpoint.mjs so a viewer never has to
// trust the server that hosts the bundle.

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('only safe integers are allowed');
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new TypeError('unsupported value');
}

const hex = (buf) => '0x' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (h) => Uint8Array.from(h.slice(2).match(/../g).map((x) => parseInt(x, 16)));

export async function sha256(data) {
  const input = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', input));
}
export const hashOf = (v) => sha256(canonical(v));

async function hashPair(a, b) {
  const buf = new Uint8Array(65);
  buf[0] = 1; buf.set(bytes(a), 1); buf.set(bytes(b), 33);
  return sha256(buf);
}

export async function merkleRoot(leaves) {
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? await hashPair(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

const ZERO = '0x' + '0'.repeat(64);

/** Returns per-entry status plus overall chain result. */
export async function verifyLines(lines) {
  const results = [];
  let prev = ZERO, lastAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const { entry, hash, payload } = lines[i];
    const problems = [];
    const actual = await hashOf(entry);
    if (actual !== hash) problems.push('content does not match its hash');
    if (entry.seq !== i) problems.push('out of sequence');
    if (entry.prev !== prev) problems.push('broken link to the previous entry');
    if (entry.at < lastAt) problems.push('time goes backwards');
    if (i === 0 && entry.type !== 'genesis') problems.push('log does not start with genesis');
    if (payload !== undefined && (await hashOf(payload)) !== entry.payloadHash) problems.push('payload was changed');
    results.push({ seq: i, ok: problems.length === 0, problems, hash: actual });
    prev = actual; lastAt = entry.at;
  }
  return { ok: results.every((r) => r.ok), results, head: prev };
}

/** Recomputes a checkpoint's root and head from the log and compares with the stamped copy. */
export async function checkCheckpoint(lines, stamped) {
  const range = lines.slice(stamped.fromSeq, stamped.toSeq + 1);
  if (range.length !== stamped.count || range.length === 0) return { ok: false, why: 'range not present in this log' };
  const hashes = await Promise.all(range.map((l) => hashOf(l.entry)));
  const root = await merkleRoot(hashes);
  const head = hashes[hashes.length - 1];
  if (root !== stamped.root) return { ok: false, why: 'Merkle root differs: entries in this range were changed' };
  if (head !== stamped.head) return { ok: false, why: 'head differs' };
  return { ok: true };
}
