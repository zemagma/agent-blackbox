// Operator workflows: set up the Claus projects, stamp checkpoints, revoke an
// agent and verify everything afterwards. Used by bin/blackbox.mjs and tests.
//
// Two Claus projects are created, each with its own owner key:
//   - the notary, which runs the free "blackbox.checkpoint.v1" service
//   - the agent's home project, where the agent holds a scoped, expiring mandate
// The keys only sign Claus logins. They never hold funds.
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createClaus, ownerLogin, publicResultUrl, DEFAULT_ORIGIN } from './claus.mjs';
import { openBlackbox, readLog, verifyLog, redact } from './log.mjs';
import { buildCheckpoint, checkCheckpoint } from './checkpoint.mjs';
import { createNotary, manifest } from '../notary/notary.mjs';

export const AGENT_SCOPES = ['project.read', 'service.call', 'service.read', 'service.settle', 'project.publish'];
const NOTARY_SCOPES = ['project.read', 'service.manage', 'service.read', 'service.provide', 'project.publish'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openState(dir, { origin } = {}) {
  const directory = resolve(dir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (((await stat(directory)).mode & 0o077) !== 0) throw new Error('state directory must be private: chmod 700 ' + directory);
  const file = join(directory, 'state.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    state = { origin: origin ?? process.env.CLAUS_NETWORK_URL ?? DEFAULT_ORIGIN, tag: randomBytes(4).toString('hex'),
      steps: {}, checkpoints: [] };
  }
  const save = async () => {
    await writeFile(file + '.next', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(file + '.next', file);
  };
  await save();
  // Each remote creation is recorded before and after, so an interrupted run
  // can resume without creating duplicates (Claus calls also carry idempotency keys).
  async function step(key, action) {
    const old = state.steps[key];
    if (old?.done) return old.value;
    const value = await action();
    state.steps[key] = { done: true, value }; await save();
    return value;
  }
  return { directory, state, save, step, logFile: join(directory, 'blackbox.jsonl') };
}

async function owner(ctx, role) {
  const s = ctx.state;
  s.keys ??= {};
  s.keys[role] ??= generatePrivateKey();
  s.sessions ??= {};
  const account = privateKeyToAccount(s.keys[role]);
  const cached = s.sessions[role];
  if (!cached || cached.expiresAt < Date.now() + 120000) {
    const { session } = await ownerLogin(s.origin, account);
    s.sessions[role] = { token: session.token, expiresAt: session.credential?.expiresAt ?? Date.now() + 3000000 };
  }
  await ctx.save();
  return { account, client: createClaus({ origin: s.origin, token: s.sessions[role].token }) };
}

async function publishProfile(client, projectId, description) {
  const project = await client.call('project_get', { projectId });
  if (project.publication?.published) return;
  try {
    await client.call('project_publish', { projectId, published: true, expectedRevision: project.publication?.revision ?? 0, description });
  } catch (err) { if (err.code !== 'revision_conflict') throw err; }
}

/** Creates (or resumes) both projects, the notary service and the agent's mandate. */
export async function setup(ctx, { agentName = 'demo-agent', mandateHours = 24, probeTimeoutMs = 180000, log = () => {} } = {}) {
  const s = ctx.state, tag = s.tag;
  s.agentName ??= agentName;

  // --- Notary project and service -------------------------------------------
  const notaryOwner = await owner(ctx, 'notary');
  const nProject = await ctx.step('notary:project', () => notaryOwner.client.call('project_create', {
    name: 'Agent Blackbox Notary', slug: 'blackbox-notary-' + tag, idempotencyKey: tag + ':notary' }));
  const nAgent = await ctx.step('notary:agent', () => notaryOwner.client.call('agent_create', {
    projectId: nProject.id, name: 'Notary worker', idempotencyKey: tag + ':notary-agent' }));
  const nMandate = await ctx.step('notary:mandate', () => notaryOwner.client.call('mandate_create', {
    projectId: nProject.id, principalId: nAgent.id, scopes: NOTARY_SCOPES,
    expiresAt: Date.now() + 29 * 86400000, idempotencyKey: tag + ':notary-mandate' }));
  const nCredential = await ctx.step('notary:credential', () => notaryOwner.client.call('credential_create', { mandateId: nMandate.id }));
  const notaryClient = createClaus({ origin: s.origin, token: nCredential.token });
  const service = await ctx.step('notary:service', () => notaryClient.call('service_register', {
    projectId: nProject.id, manifest: manifest({ recipient: notaryOwner.account.address }) }));
  const notary = createNotary({ client: notaryClient, projectId: nProject.id, serviceId: service.id, log });
  const deadline = Date.now() + probeTimeoutMs;
  for (;;) {
    const current = await notaryClient.call('service_get', { projectId: nProject.id, serviceId: service.id });
    if (current.state === 'available') break;
    if (current.state === 'rejected') throw new Error('Claus rejected the notary service probe');
    await notary.tick();
    if (Date.now() > deadline) throw new Error('waiting for the Claus probe of the notary service; run setup again to resume');
    await sleep(2000);
  }
  await publishProfile(notaryOwner.client, nProject.id,
    'Agent Blackbox Notary: stamps checkpoints of AI agent action logs (Merkle root + head). It attests what was presented and when, not agent behaviour.');
  await ctx.step('notary:publication', async () => {
    const current = await notaryClient.call('service_get', { projectId: nProject.id, serviceId: service.id });
    if (current.publication?.published) return current.publication;
    return notaryClient.call('service_publish', { projectId: nProject.id, serviceId: service.id, published: true,
      expectedRevision: current.publication?.revision ?? 0 });
  });
  s.notary = { projectId: nProject.id, serviceId: service.id, token: nCredential.token };

  // --- The agent's home project and its mandate ------------------------------
  const op = await owner(ctx, 'operator');
  const project = await ctx.step('agent:project', () => op.client.call('project_create', {
    name: 'Agent ' + s.agentName, slug: (s.agentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) + '-' + tag).replace(/^-+/, ''),
    idempotencyKey: tag + ':agent-project' }));
  const agent = await ctx.step('agent:agent', () => op.client.call('agent_create', {
    projectId: project.id, name: s.agentName, idempotencyKey: tag + ':agent' }));
  const expiresAt = Date.now() + mandateHours * 3600000;
  const mandate = await ctx.step('agent:mandate', () => op.client.call('mandate_create', {
    projectId: project.id, principalId: agent.id, scopes: AGENT_SCOPES, expiresAt, idempotencyKey: tag + ':agent-mandate' }));
  const credential = await ctx.step('agent:credential', () => op.client.call('credential_create', { mandateId: mandate.id }));
  await publishProfile(op.client, project.id,
    `Agent Blackbox for "${s.agentName}": a public, tamper-evident record of what this AI agent was allowed to do and what it did.`);
  s.agent = { name: s.agentName, projectId: project.id, agentId: agent.id, mandateId: mandate.id,
    credentialId: credential.id ?? credential.credential?.id ?? null, token: credential.token,
    scopes: mandate.scopes ?? AGENT_SCOPES, expiresAt: mandate.expiresAt ?? expiresAt, operator: op.account.address };
  await ctx.save();

  // --- Genesis entry: the permission the agent starts with -------------------
  const box = await openBlackbox({ file: ctx.logFile, agent: s.agentName });
  if (box.lines.length === 0) {
    await box.append({ type: 'genesis',
      summary: `Agent "${s.agentName}" starts with a Claus mandate: ${s.agent.scopes.join(', ')}; expires ${new Date(s.agent.expiresAt).toISOString()}`,
      payload: { claus: { origin: s.origin, projectId: project.id, agentId: agent.id, mandateId: mandate.id,
        scopes: s.agent.scopes, expiresAt: s.agent.expiresAt }, operator: op.account.address } });
  }
  // Tokens stay in the private state file; never print them.
  return { notary: { ...s.notary, token: undefined }, agent: { ...s.agent, token: undefined } };
}

/** Runs the notary worker once (useful when the operator also hosts the notary). */
export async function notaryTick(ctx, opts) {
  const n = ctx.state.notary;
  const client = createClaus({ origin: ctx.state.origin, token: n.token });
  return createNotary({ client, projectId: n.projectId, serviceId: n.serviceId, ...opts }).tick();
}

/**
 * Stamps every entry since the last checkpoint. `as: 'agent'` uses the agent's
 * own credential (normal case); `as: 'owner'` is used after revocation.
 */
export async function checkpoint(ctx, { as = 'agent', runNotary = true, timeoutMs = 120000, log = () => {} } = {}) {
  const s = ctx.state;
  const client = as === 'owner' ? (await owner(ctx, 'operator')).client : createClaus({ origin: s.origin, token: s.agent.token });
  const lines = await readLog(ctx.logFile);
  const fromSeq = s.checkpoints.length ? s.checkpoints[s.checkpoints.length - 1].toSeq + 1 : 0;
  // Only the note about the previous stamp is new: nothing worth stamping yet.
  // (That note is included automatically in the next real checkpoint.)
  if (lines.slice(fromSeq).every((l) => l.entry.type === 'checkpoint')) {
    return { skipped: true, reason: 'nothing new since the last checkpoint', lastCheckpoint: s.checkpoints.at(-1) ?? null };
  }
  const cp = buildCheckpoint(lines, { fromSeq });
  const key = `${s.tag}:cp:${cp.fromSeq}-${cp.toSeq}`;
  const projectId = s.agent.projectId;
  const quote = await client.call('service_quote', { projectId, serviceId: s.notary.serviceId, input: cp, idempotencyKey: key });
  if (quote.maximumWei !== '0') throw new Error('notary quote is not free; refusing');
  const order = await client.call('service_accept', { projectId, quoteId: quote.id });
  const deadline = Date.now() + timeoutMs;
  let current;
  for (;;) {
    if (runNotary) await notaryTick(ctx, { log });
    current = await client.call('service_order', { projectId, orderId: order.id });
    if (current.state === 'delivered') break;
    if (['cancelled', 'expired', 'failed'].includes(current.state)) throw new Error('notary order ended as ' + current.state);
    if (Date.now() > deadline) throw new Error('notary did not deliver in time; order ' + order.id);
    await sleep(1500);
  }
  const result = await client.call('service_result', { projectId, orderId: order.id });
  const stamped = result.output ?? result;
  const check = checkCheckpoint(lines, stamped);
  if (!check.ok || stamped.probe) throw new Error('notary returned a checkpoint that does not match the log: ' + check.wrong.join(','));
  await client.call('service_accept_result', { projectId, orderId: order.id, outputHash: current.outputHash, accepted: true });
  const publication = await client.call('service_result_publication', { projectId, orderId: order.id });
  if (!publication.published) {
    const service = await createClaus({ origin: s.origin, token: s.notary.token })
      .call('service_get', { projectId: s.notary.projectId, serviceId: s.notary.serviceId });
    const expiresAt = Math.min(service.manifest.validUntil, Date.now() + 29 * 86400000) - 60000;
    await client.call('service_result_publish', { projectId, orderId: order.id, outputHash: current.outputHash,
      published: true, expectedRevision: publication.revision ?? 0, expiresAt });
  }
  const url = publicResultUrl(s.origin, order.id);
  const record = { orderId: order.id, url, fromSeq: cp.fromSeq, toSeq: cp.toSeq, root: cp.root, head: cp.head,
    notarizedAt: stamped.notarizedAt, outputHash: current.outputHash, onchainData: stamped.onchainData };
  s.checkpoints.push(record); await ctx.save();
  const box = await openBlackbox({ file: ctx.logFile, agent: s.agent.name });
  await box.append({ type: 'checkpoint', summary: `Entries ${cp.fromSeq}-${cp.toSeq} stamped by the notary and published on Claus`,
    payload: { orderId: order.id, url, root: cp.root, head: cp.head, toSeq: cp.toSeq } });
  return record;
}

/** Takes the agent's permission away, proves it no longer works, and records it. */
export async function revoke(ctx, { reason = 'operator revoked access' } = {}) {
  const s = ctx.state;
  const op = await owner(ctx, 'operator');
  if (!s.revokedAt) {
    await op.client.call('mandate_revoke', { mandateId: s.agent.mandateId });
    s.revokedAt = Date.now(); await ctx.save();
  }
  let denied = null;
  try { await createClaus({ origin: s.origin, token: s.agent.token }).call('project_get', { projectId: s.agent.projectId }); }
  catch (err) { denied = err.code; }
  if (!denied) throw new Error('the agent credential still works after revocation');
  const box = await openBlackbox({ file: ctx.logFile, agent: s.agent.name });
  if (!box.lines.some((l) => l.entry.type === 'revocation')) {
    await box.append({ type: 'revocation', summary: `Mandate revoked by the operator: ${reason}`,
      payload: { mandateId: s.agent.mandateId, revokedAt: s.revokedAt, reason, agentCredentialNowReturns: denied } });
  }
  const final = await checkpoint(ctx, { as: 'owner' });
  return { revokedAt: s.revokedAt, denied, final };
}

/** Full verification: chain, payloads, and every checkpoint against its public Claus copy. */
export async function verify({ lines, checkpoints, fetchPublic = (url) => fetch(url).then((r) => r.json()) }) {
  const chain = verifyLog(lines);
  const results = [];
  for (const cp of checkpoints) {
    let publicCopy = null, error = null;
    try { publicCopy = await fetchPublic(cp.url); } catch (err) { error = err.message; }
    const stamped = publicCopy?.output;
    const matches = stamped ? checkCheckpoint(lines, stamped) : { ok: false, wrong: ['unavailable'] };
    results.push({ orderId: cp.orderId, range: [cp.fromSeq, cp.toSeq], public: !!stamped,
      matchesLog: matches.ok, wrong: matches.wrong, notarizedAt: stamped?.notarizedAt ?? null,
      deliveredAt: publicCopy?.deliveredAt ?? null, error: error ?? publicCopy?.error ?? null });
  }
  return { ok: chain.ok && results.every((r) => r.matchesLog), chain, checkpoints: results };
}

/** Writes the bundle the static viewer reads. Payloads are left out unless asked for. */
export async function exportBundle(ctx, { includePayloads = false, fetchPublic = (url) => fetch(url).then((r) => r.json()) } = {}) {
  const s = ctx.state;
  const lines = await readLog(ctx.logFile);
  const checkpoints = [];
  for (const cp of s.checkpoints) {
    let publicCopy = null;
    try { publicCopy = await fetchPublic(cp.url); } catch { publicCopy = null; }
    checkpoints.push({ ...cp, publicCopy });
  }
  return {
    format: 'agent-blackbox/1', exportedAt: Date.now(), agent: s.agent.name, origin: s.origin,
    claus: { projectId: s.agent.projectId, mandateId: s.agent.mandateId, notaryProjectId: s.notary.projectId,
      notaryServiceId: s.notary.serviceId },
    mandate: { scopes: s.agent.scopes, expiresAt: s.agent.expiresAt, revokedAt: s.revokedAt ?? null },
    lines: includePayloads ? lines : redact(lines, (l) => l.entry.type !== 'action'),
    checkpoints,
  };
}
