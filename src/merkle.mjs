// Ordered binary Merkle tree over entry hashes.
// Internal nodes are sha256(0x01 || left || right); an odd node at the end of a
// level is carried up unchanged. The same rules are implemented in viewer/verify.js.
import { hashPair, isHash } from './hash.mjs';

export function merkleRoot(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new Error('merkle: need at least one leaf');
  if (!leaves.every(isHash)) throw new Error('merkle: leaves must be 0x-prefixed sha256 hashes');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

/** Proof that leaves[index] is in the tree: a list of { hash, left } siblings. */
export function merkleProof(leaves, index) {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error('merkle: index out of range');
  const proof = [];
  let level = leaves.slice();
  let i = index;
  while (level.length > 1) {
    const sibling = i % 2 === 0 ? i + 1 : i - 1;
    if (sibling < level.length) proof.push({ hash: level[sibling], left: sibling < i });
    const next = [];
    for (let j = 0; j < level.length; j += 2) {
      next.push(j + 1 < level.length ? hashPair(level[j], level[j + 1]) : level[j]);
    }
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

export function verifyProof(leaf, proof, root) {
  let node = leaf;
  for (const step of proof) node = step.left ? hashPair(step.hash, node) : hashPair(node, step.hash);
  return node === root;
}
