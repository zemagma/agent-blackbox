// Publishes the viewer as a Claus static website on a private local network.
//   CLAUS_SOURCE=/path/to/claus-network npm run test:e2e   (Node 24.14+)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalClaus } from '../../dev/claus-local.mjs';
import { openState, owner } from '../../src/operator.mjs';
import { publishSite } from '../../src/site.mjs';
import { createClaus } from '../../src/claus.mjs';

const ready = process.env.CLAUS_SOURCE && Number(process.versions.node.split('.')[0]) >= 24;

test('publish-site: viewer + record as a Claus static release, republish retires the old one', { skip: !ready && 'needs CLAUS_SOURCE and Node 24' }, async (t) => {
  const claus = await startLocalClaus();
  t.after(() => claus.stop());
  const dir = await mkdtemp(join(tmpdir(), 'blackbox-site-'));
  await chmod(dir, 0o700);
  const ctx = await openState(dir, { origin: claus.origin });
  const bundle = JSON.parse(await readFile(new URL('../../viewer/bundle.json', import.meta.url), 'utf8'));

  const first = await publishSite(ctx, { bundle, slug: 'agent-blackbox' });
  assert.equal(first.page, 'https://claus.si/c/agent-blackbox');
  assert.deepEqual(first.files, ['index.html', 'verify.js', 'bundle.js', 'claus.json', 'logo.svg', 'preview.svg']);

  // Anyone can read the published files, without credentials.
  const guest = createClaus({ origin: claus.origin });
  const file = async (releaseId, filePath) => {
    const r = await guest.call('public_release_file', { releaseId, filePath });
    return r.file?.content ?? r.files?.find((f) => f.path === filePath)?.content;
  };
  assert.match(await file(first.releaseId, 'index.html'), /<script src="bundle.js"><\/script>/);
  const js = await file(first.releaseId, 'bundle.js');
  assert.ok(js.includes('window.BLACKBOX_BUNDLE = '));
  assert.equal(JSON.parse(js.slice(js.indexOf('window.BLACKBOX_BUNDLE = ') + 'window.BLACKBOX_BUNDLE = '.length, -2)).agent, bundle.agent);
  const manifest = JSON.parse(await file(first.releaseId, 'claus.json'));
  assert.equal(manifest.name, 'Agent Blackbox');
  assert.equal(manifest.connect, undefined, 'local http origin is not a valid connect source');
  const released = await guest.call('public_release_file', { releaseId: first.releaseId, filePath: 'index.html' });
  assert.equal(released.expiresAt, null, 'published with no expiry');

  // The project profile is public.
  const { client } = await owner(ctx, 'operator');
  const project = await client.call('project_get', { projectId: first.projectId });
  assert.equal(project.publication.published, true);

  // Publishing identical files again is harmless: releases are content-addressed.
  const same = await publishSite(ctx, { bundle, slug: 'agent-blackbox' });
  assert.equal(same.releaseId, first.releaseId);
  assert.ok(await file(first.releaseId, 'index.html'));

  // A newer record makes a new release and retires the old one; no duplicate project.
  const second = await publishSite(ctx, { bundle: { ...bundle, exportedAt: bundle.exportedAt + 1 }, slug: 'agent-blackbox' });
  assert.equal(second.projectId, first.projectId);
  assert.notEqual(second.releaseId, first.releaseId);
  await assert.rejects(guest.call('public_release_file', { releaseId: first.releaseId, filePath: 'index.html' }), (e) => e.status === 404);
  assert.ok(await file(second.releaseId, 'index.html'));

  // State keeps no tokens in the result.
  assert.equal(JSON.stringify(second).includes('token'), false);
});
