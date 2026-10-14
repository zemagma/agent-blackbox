// Publishes the Agent Blackbox viewer, with a recorded bundle, as a static website
// on the Claus network (https://claus.si/build.txt). It then appears on the
// network map and at https://claus.si/c/<slug>.
//
// Claus hosts static files only, in a sandbox that may not fetch its own files,
// so the bundle ships as bundle.js. claus.json lets the page reach the Claus API,
// so the viewer re-checks each stamp live.
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { owner, publishProfile } from './operator.mjs';
import { DEFAULT_ORIGIN } from './claus.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE = 1_000_000;
export const SITE_DESCRIPTION = 'A flight recorder for AI agents. A Sepolia wallet agent under a Claus mandate: every action in a '
  + 'tamper-evident log, each checkpoint stamped on Claus, and proof that revoking the mandate stopped the money.';

/** The files of the release, ready for snapshot_create. Pure, so it can be tested. */
export async function siteFiles({ bundle, apiOrigin = DEFAULT_ORIGIN, name = 'Agent Blackbox', description = SITE_DESCRIPTION } = {}) {
  if (bundle?.format !== 'agent-blackbox/1') throw new Error('not an agent-blackbox bundle');
  const text = (path) => readFile(join(ROOT, path), 'utf8');
  // Claus only accepts HTTPS origins here (a local test network runs on plain http).
  const api = new URL(apiOrigin);
  const manifest = { schema: 'claus-project/1', name, description, logo: 'logo.svg', preview: 'preview.svg',
    ...(api.protocol === 'https:' ? { connect: [api.origin] } : {}) };
  const files = [
    { path: 'index.html', content: await text('viewer/index.html') },
    { path: 'verify.js', content: await text('viewer/verify.js') },
    { path: 'bundle.js', content: "window.BLACKBOX_HOST = 'claus';\nwindow.BLACKBOX_BUNDLE = " + JSON.stringify(bundle) + ';\n' },
    { path: 'claus.json', content: JSON.stringify(manifest, null, 2) + '\n' },
    { path: 'logo.svg', content: await text('site/logo.svg') },
    { path: 'preview.svg', content: await text('site/preview.svg') },
  ];
  if (Buffer.byteLength(files[3].content) > 4096) throw new Error('claus.json is over 4,096 bytes');
  for (const f of files) if (Buffer.byteLength(f.content) > MAX_FILE) throw new Error(`${f.path} is over 1 MB; export a smaller bundle`);
  return files;
}

/**
 * Creates (or reuses) the site project, uploads a new release, publishes it with no
 * expiry, retires the previous release and publishes the project profile.
 */
export async function publishSite(ctx, { bundle, slug = 'agent-blackbox', name = 'Agent Blackbox', log = () => {} } = {}) {
  const s = ctx.state;
  const op = await owner(ctx, 'operator');
  const files = await siteFiles({ bundle, apiOrigin: s.origin, name });
  s.site ??= {};
  const project = await ctx.step('site:project', () => op.client.call('project_create', {
    name, slug, idempotencyKey: s.tag + ':site:' + slug }));
  const current = await op.client.call('project_get', { projectId: project.id });
  const snapshot = await op.client.call('snapshot_create', { projectId: project.id, files,
    expectedProjectRevision: current.revision });
  log({ event: 'snapshot', id: snapshot.id });
  const release = await op.client.call('release_create', { projectId: project.id, snapshotId: snapshot.id,
    paths: files.map((f) => f.path) });
  const fresh = await op.client.call('release_get', { projectId: project.id, releaseId: release.id });
  await op.client.call('release_publish', { projectId: project.id, releaseId: release.id, published: true,
    expiresAt: null, expectedRevision: fresh.publication?.revision ?? 0 });
  log({ event: 'published', releaseId: release.id });

  // Retire the previous release so it cannot reappear later.
  const previous = s.site.releaseId;
  if (previous && previous !== release.id) {
    try {
      const old = await op.client.call('release_get', { projectId: project.id, releaseId: previous });
      if (old.publication?.published) {
        await op.client.call('release_publish', { projectId: project.id, releaseId: previous, published: false,
          expiresAt: null, expectedRevision: old.publication.revision });
      }
    } catch (err) { log({ event: 'retire_failed', releaseId: previous, code: err.code }); }
  }
  await publishProfile(op.client, project.id, SITE_DESCRIPTION);
  s.site = { projectId: project.id, slug: project.slug ?? slug, releaseId: release.id, releaseUrl: release.url,
    publishedAt: Date.now() };
  await ctx.save();
  return { ...s.site, page: 'https://claus.si/c/' + (project.slug ?? slug), files: files.map((f) => f.path) };
}
