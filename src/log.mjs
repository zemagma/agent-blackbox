// The blackbox: an append-only, hash-chained log of what an agent did.
//
// Each line of the JSONL file is { entry, hash, payload }:
//   entry   - the public part: who, when, what kind, a short summary, and the
//             hash of the private payload. Its hash links to the previous entry.
//   hash    - sha256 of the canonical entry.
//   payload - the private detail (tool input/output, mandate, ...). It can be
//             withheld when sharing; payloadHash still commits to it.
//
// Editing, removing or reordering any line breaks the chain, and a published
// checkpoint (Merkle root + head) pins the log as it was at that moment.
import { appendFile, readFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hashOf, isHash, ZERO_HASH } from './hash.mjs';

export const ENTRY_TYPES = ['genesis', 'action', 'note', 'checkpoint', 'revocation'];
const MAX_SUMMARY = 200;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export function makeEntry({ agent, seq, at, type, tool, summary, payload, prev }) {
  if (typeof agent !== 'string' || !agent || agent.length > 80) throw new Error('log: agent id must be 1-80 chars');
  if (!ENTRY_TYPES.includes(type)) throw new Error('log: unknown entry type ' + type);
  if (type === 'action' && (typeof tool !== 'string' || !tool)) throw new Error('log: actions need a tool name');
  const text = String(summary ?? '').slice(0, MAX_SUMMARY);
  const payloadValue = payload === undefined ? null : payload;
  const entry = { v: 1, agent, seq, at, type, ...(tool ? { tool } : {}), summary: text,
    payloadHash: hashOf(payloadValue), prev };
  return { entry, hash: hashOf(entry), payload: payloadValue };
}

/** Checks the chain, sequence, timestamps and (when present) payload commitments. */
export function verifyLog(lines, { agent } = {}) {
  const errors = [];
  let prev = ZERO_HASH, lastAt = 0;
  lines.forEach((line, i) => {
    const e = line?.entry;
    if (!e || typeof e !== 'object') { errors.push({ seq: i, reason: 'missing entry' }); return; }
    if (e.v !== 1) errors.push({ seq: i, reason: 'unknown version' });
    if (agent && e.agent !== agent) errors.push({ seq: i, reason: 'different agent' });
    if (e.seq !== i) errors.push({ seq: i, reason: `sequence is ${e.seq}, expected ${i}` });
    if (e.prev !== prev) errors.push({ seq: i, reason: 'broken link to previous entry' });
    if (!Number.isSafeInteger(e.at) || e.at < lastAt) errors.push({ seq: i, reason: 'time goes backwards' });
    if (i === 0 && e.type !== 'genesis') errors.push({ seq: i, reason: 'first entry must be genesis' });
    const hash = hashOf(e);
    if (line.hash !== hash) errors.push({ seq: i, reason: 'entry hash does not match its content' });
    if (line.payload !== undefined && hashOf(line.payload) !== e.payloadHash)
      errors.push({ seq: i, reason: 'payload does not match its commitment' });
    prev = hash; lastAt = e.at;
  });
  return { ok: errors.length === 0, count: lines.length, head: lines.length ? prev : null, errors };
}

export async function readLog(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Opens (or creates) a blackbox log for one agent. Appends are serialised so
 * concurrent tool calls still produce a clean chain.
 */
export async function openBlackbox({ file, agent, now = () => Date.now() }) {
  await mkdir(dirname(file), { recursive: true });
  let lines = [];
  let size = -1;
  const fileSize = async () => { try { return (await stat(file)).size; } catch (err) { if (err.code === 'ENOENT') return 0; throw err; } };
  // Another process (or another handle in this one) may have appended since we
  // last looked, so the file is re-read and re-verified whenever it changed.
  async function sync() {
    const current = await fileSize();
    if (current === size) return;
    const fresh = await readLog(file);
    const check = verifyLog(fresh, { agent });
    if (!check.ok) throw new Error('log: existing file failed verification at seq ' + check.errors[0].seq + ': ' + check.errors[0].reason);
    lines = fresh; size = current;
  }
  await sync();
  let queue = Promise.resolve();

  async function append({ type, tool, summary, payload }) {
    const run = queue.then(async () => {
      await sync();
      const text = JSON.stringify(payload ?? null);
      if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) throw new Error('log: payload larger than 64 KiB');
      const last = lines[lines.length - 1];
      const at = Math.max(now(), last?.entry.at ?? 0);
      const line = makeEntry({ agent, seq: lines.length, at, type, tool, summary, payload,
        prev: last?.hash ?? ZERO_HASH });
      const raw = JSON.stringify(line) + '\n';
      await appendFile(file, raw, { mode: 0o600 });
      lines.push(line); size += Buffer.byteLength(raw);
      return line;
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    agent, file,
    get lines() { return lines.slice(); },
    get head() { return lines.length ? lines[lines.length - 1].hash : null; },
    append,
    /** Wraps an async tool so every call (and failure) is recorded. */
    wrapTool(name, fn, { summarize } = {}) {
      return async (input) => {
        try {
          const output = await fn(input);
          await append({ type: 'action', tool: name, payload: { input: input ?? null, output: output ?? null, ok: true },
            summary: summarize ? summarize(input, output) : name });
          return output;
        } catch (err) {
          await append({ type: 'action', tool: name, payload: { input: input ?? null, ok: false, error: String(err?.message ?? err) },
            summary: name + ' failed' });
          throw err;
        }
      };
    },
  };
}

/** A copy of the log with private payloads removed, for public sharing. */
export function redact(lines, keep = () => false) {
  return lines.map((l) => (keep(l) ? l : { entry: l.entry, hash: l.hash }));
}

export { isHash };
