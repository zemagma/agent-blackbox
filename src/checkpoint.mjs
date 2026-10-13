// A checkpoint pins a range of log entries: its Merkle root and the head hash.
// The notary service stamps it, Claus publishes it, and (later) a signal feed
// can store `onchainData` on Ethereum.
import { encodeAbiParameters, decodeAbiParameters } from 'viem';
import { merkleRoot } from './merkle.mjs';
import { sha256, isHash } from './hash.mjs';
import { verifyLog } from './log.mjs';

export function buildCheckpoint(lines, { fromSeq = 0 } = {}) {
  const range = lines.slice(fromSeq);
  if (range.length === 0) throw new Error('checkpoint: no new entries since seq ' + fromSeq);
  // Never trust stored hashes: the whole prefix must verify before it is pinned.
  const check = verifyLog(lines.slice(0, fromSeq + range.length));
  if (!check.ok) throw new Error('checkpoint: log fails verification at seq ' + check.errors[0].seq + ' (' + check.errors[0].reason + ')');
  const first = range[0].entry, last = range[range.length - 1].entry;
  return {
    v: 1,
    agent: first.agent,
    fromSeq,
    toSeq: last.seq,
    count: range.length,
    root: merkleRoot(range.map((l) => l.hash)),
    head: range[range.length - 1].hash,
    from: first.at,
    to: last.at,
  };
}

/** Recomputes a checkpoint from the log and compares it field by field. */
export function checkCheckpoint(lines, cp) {
  try {
    const again = buildCheckpoint(lines.slice(0, cp.toSeq + 1), { fromSeq: cp.fromSeq });
    const fields = ['agent', 'fromSeq', 'toSeq', 'count', 'root', 'head', 'from', 'to'];
    const wrong = fields.filter((f) => again[f] !== cp[f]);
    return { ok: wrong.length === 0, wrong };
  } catch (err) {
    return { ok: false, wrong: ['range'], error: err.message };
  }
}

export const agentKey = (agent) => sha256('agent-blackbox:' + agent);

const ONCHAIN = [
  { name: 'agentKey', type: 'bytes32' }, { name: 'fromSeq', type: 'uint64' }, { name: 'toSeq', type: 'uint64' },
  { name: 'root', type: 'bytes32' }, { name: 'head', type: 'bytes32' }, { name: 'endedAt', type: 'uint64' },
];

/** ABI encoding used by contracts/AgentBlackboxModule.sol. endedAt is Unix seconds. */
export function encodeOnchain(cp) {
  if (!isHash(cp.root) || !isHash(cp.head)) throw new Error('checkpoint: bad hashes');
  return encodeAbiParameters(ONCHAIN, [agentKey(cp.agent), BigInt(cp.fromSeq), BigInt(cp.toSeq), cp.root, cp.head,
    BigInt(Math.floor(cp.to / 1000))]);
}

export function decodeOnchain(data) {
  const [key, fromSeq, toSeq, root, head, endedAt] = decodeAbiParameters(ONCHAIN, data);
  return { agentKey: key, fromSeq: Number(fromSeq), toSeq: Number(toSeq), root, head, endedAt: Number(endedAt) };
}
