// Client behaviour required by the Claus docs (MCP, SDK and CLI page).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaus } from '../src/claus.mjs';
import { openState } from '../src/operator.mjs';

const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('reads wait for Retry-After on 429; mutations are never retried', async () => {
  let calls = 0;
  const reads = createClaus({ origin: 'http://localhost:1', fetch: async () =>
    (++calls === 1 ? reply(429, { error: 'capacity_reached' }, { 'retry-after': '0' }) : reply(200, { ok: true })) });
  assert.deepEqual(await reads.call('capabilities'), { ok: true });
  assert.equal(calls, 2);

  calls = 0;
  const writes = createClaus({ origin: 'http://localhost:1', token: 't', fetch: async () => { calls++; return reply(429, { error: 'capacity_reached' }, { 'retry-after': '7' }); } });
  await assert.rejects(writes.call('credential_create', { mandateId: 'm1' }),
    (err) => err.code === 'capacity_reached' && err.status === 429 && err.retryAfterMs === 7000);
  assert.equal(calls, 1);
});

test('non-JSON responses become invalid_api_response without their contents; redirects refused', async () => {
  let options;
  const client = createClaus({ origin: 'http://localhost:1', fetch: async (_, o) => { options = o; return new Response('<html>secret</html>', { status: 502 }); } });
  await assert.rejects(client.call('capabilities'), (err) => err.code === 'invalid_api_response' && !String(err.details ?? '').includes('secret'));
  assert.equal(options.redirect, 'error');
});

test('a lost credential response is never silently re-issued', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blackbox-state-'));
  await chmod(dir, 0o700);
  const ctx = await openState(dir, { origin: 'http://localhost:1' });
  // First attempt: the request goes out, the response is lost.
  await assert.rejects(ctx.step('agent:credential', async () => { throw new TypeError('fetch failed'); }, { secret: true }));
  // Resuming must not call credential_create again for the same mandate.
  let issued = false;
  await assert.rejects(ctx.step('agent:credential', async () => { issued = true; }, { secret: true }),
    (err) => err.code === 'pending_credential');
  assert.equal(issued, false);
  // A definite 4xx means nothing was issued, so that step can be retried.
  await assert.rejects(ctx.step('notary:credential', async () => { throw Object.assign(new Error('scope_denied'), { status: 403 }); }, { secret: true }));
  assert.equal(await ctx.step('notary:credential', async () => 'ok', { secret: true }), 'ok');
});
