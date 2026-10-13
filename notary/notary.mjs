// The Blackbox Notary: a free Claus public-data service.
//
// An agent's operator orders a checkpoint stamp. The notary checks the shape,
// adds the time it received the checkpoint plus the ABI-encoded form for a
// future Ethereum signal feed, and delivers it. Claus records the order, the
// delivery and (once the buyer publishes it) a public, provenance-linked copy.
//
// The notary never sees the log itself, so it attests "this root and head were
// presented at this time", not that the agent behaved well.
import { encodeOnchain } from '../src/checkpoint.mjs';

export const CAPABILITY = 'blackbox.checkpoint.v1';

// Claus accepts a small JSON Schema subset: no minLength or patterns, and every
// integer needs explicit bounds. Exact formats are checked in stamp().
const hash = { type: 'string', maxLength: 66 };
const int = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const CHECKPOINT_FIELDS = {
  v: { type: 'integer', minimum: 1, maximum: 1 }, agent: { type: 'string', maxLength: 80 },
  fromSeq: int, toSeq: int, count: int, root: hash, head: hash, from: int, to: int,
};
export const INPUT_SCHEMA = {
  type: 'object', properties: CHECKPOINT_FIELDS,
  required: Object.keys(CHECKPOINT_FIELDS), additionalProperties: false,
};
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ...CHECKPOINT_FIELDS, notarizedAt: int, capability: { type: 'string', maxLength: 64 },
    onchainData: { type: 'string', maxLength: 386 }, probe: { type: 'boolean' } },
  required: [...Object.keys(CHECKPOINT_FIELDS), 'notarizedAt', 'capability', 'onchainData', 'probe'],
  additionalProperties: false,
};

export function manifest({ recipient, validDays = 29, now = Date.now() }) {
  return {
    name: 'Agent Blackbox Notary', capability: CAPABILITY, version: '1.0.0',
    inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA,
    priceWei: '0', recipient, maxDurationSeconds: 600,
    validUntil: now + validDays * 86400000, dataPolicy: 'public-data-v1',
  };
}

const isHash = (x) => typeof x === 'string' && /^0x[0-9a-f]{64}$/.test(x);

/** Pure function: checkpoint in, stamped checkpoint out. Throws on bad input. */
export function stamp(input, { now = Date.now(), probe = false } = {}) {
  const cp = input ?? {};
  const okInts = ['v', 'fromSeq', 'toSeq', 'count', 'from', 'to'].every((k) => Number.isSafeInteger(cp[k]) && cp[k] >= 0);
  if (!okInts || cp.v !== 1 || !isHash(cp.root) || !isHash(cp.head) || typeof cp.agent !== 'string' || !cp.agent ||
      cp.toSeq < cp.fromSeq || cp.count !== cp.toSeq - cp.fromSeq + 1 || cp.to < cp.from || cp.to > now + 60000) {
    throw new Error('notary: checkpoint is not well formed');
  }
  const clean = { v: 1, agent: cp.agent, fromSeq: cp.fromSeq, toSeq: cp.toSeq, count: cp.count,
    root: cp.root, head: cp.head, from: cp.from, to: cp.to };
  return { ...clean, notarizedAt: now, capability: CAPABILITY, onchainData: encodeOnchain(clean), probe };
}

/** A transport probe from the Claus host carries schema-shaped dummy input. */
function probeOutput(input, now) {
  const fake = '0x' + '0'.repeat(63) + '1';
  const base = { v: 1, agent: 'probe', fromSeq: 0, toSeq: 0, count: 1, root: fake, head: fake, from: now - 1000, to: now - 1000 };
  try { return stamp({ ...base, ...input }, { now, probe: true }); } catch { return stamp(base, { now, probe: true }); }
}

/**
 * Worker loop for the notary project. `client` must hold a credential with
 * service.provide / service.read for `projectId`.
 */
export function createNotary({ client, projectId, serviceId, log = () => {} }) {
  return {
    async tick({ now = () => Date.now() } = {}) {
      const page = await client.call('provider_orders', { projectId });
      let delivered = 0, rejected = 0;
      for (const order of page.orders ?? []) {
        if (serviceId && order.serviceId !== serviceId) continue;
        if (order.leaseUntil && order.leaseUntil > now()) continue;
        const claim = await client.call('provider_claim', { projectId, orderId: order.id });
        if (claim.state !== 'working') continue;
        // Claus labels its schema/transport probe with purpose 'conformance'.
        const probe = claim.purpose === 'conformance' || order.purpose === 'conformance';
        let output;
        try {
          output = probe ? probeOutput(claim.input, now()) : stamp(claim.input, { now: now() });
        } catch (err) {
          // Malformed checkpoints are not stamped; the lease simply expires.
          rejected++; log({ event: 'rejected', orderId: order.id, reason: err.message }); continue;
        }
        await client.call('provider_deliver', { projectId, orderId: order.id, lease: claim.lease, output });
        delivered++; log({ event: probe ? 'probe-delivered' : 'stamped', orderId: order.id });
      }
      return { delivered, rejected };
    },
  };
}
