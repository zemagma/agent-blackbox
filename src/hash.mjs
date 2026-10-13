// Canonical JSON and SHA-256 helpers.
// SHA-256 is used everywhere (rather than keccak) so the static viewer can
// re-verify a log with nothing but the browser's built-in WebCrypto.
import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted, no whitespace, integers only. */
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('canonical JSON only allows safe integers');
    return String(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw new TypeError('unsupported value in canonical JSON: ' + typeof value);
}

/** 0x-prefixed SHA-256 of a string or Buffer. */
export function sha256(data) {
  return '0x' + createHash('sha256').update(data).digest('hex');
}

/** Hash of a JSON-like value via its canonical form. */
export const hashOf = (value) => sha256(canonical(value));

export const isHash = (x) => typeof x === 'string' && /^0x[0-9a-f]{64}$/.test(x);

/** Hash of two 32-byte hashes, domain-separated from leaves with a 0x01 prefix. */
export function hashPair(left, right) {
  return sha256(Buffer.concat([Buffer.from([1]), Buffer.from(left.slice(2), 'hex'), Buffer.from(right.slice(2), 'hex')]));
}

export const ZERO_HASH = '0x' + '0'.repeat(64);
