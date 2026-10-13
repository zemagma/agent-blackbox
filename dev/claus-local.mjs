#!/usr/bin/env node
// A private Claus Network on your machine, for development and tests.
//
// Runs the open-source Claus API (github.com/contractclaus/claus-network) with
// a SQLite store, switches on public collaboration and public-data services,
// and runs the service probe worker. Nothing here touches the real network.
//
//   CLAUS_SOURCE=/path/to/claus-network node dev/claus-local.mjs [port]
//
// Requires Node 24.14+ (Claus uses node:sqlite) and `npm ci` inside CLAUS_SOURCE.
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

export async function startLocalClaus({ source = process.env.CLAUS_SOURCE, port = 0, file } = {}) {
  if (!source) throw new Error('Set CLAUS_SOURCE to a checkout of github.com/contractclaus/claus-network');
  const root = resolve(source);
  const load = (p) => import(pathToFileURL(join(root, p)).href);
  const { createApplication, listen } = await load('runtime/server.mjs');
  const { openStore } = await load('src/storage/index.mjs');
  const { createServiceConformance } = await load('runtime/service-conformance.mjs');
  const { ACCESS_DEFAULTS } = await load('src/access/index.mjs');
  const { digest } = await load('src/shared/index.mjs');

  const store = openStore(file ?? join(mkdtempSync(join(tmpdir(), 'claus-local-')), 'network.sqlite'));
  // Turn on the same admission the public network reports today.
  await store.transaction(async (tx) => {
    const put = async (collection, id, value) => {
      const old = await tx.read(collection, id);
      await tx.write(collection, id, value, old?.revision ?? 0);
    };
    await put('network-capabilities', 'collaboration', { enabled: true });
    const config = { ...ACCESS_DEFAULTS, publicCollaboration: true, publicDataServices: true };
    const version = 'local-dev-1';
    const record = { module: 'project-access', version, config, hash: digest({ module: 'project-access', version, config }) };
    await put('policy-versions', digest({ module: 'project-access', version }), record);
    await put('policy-active', 'project-access', { version });
  });

  const server0 = await listen({ fetch: () => new Response('starting', { status: 503 }) }, { port });
  const origin = 'http://127.0.0.1:' + server0.address().port;
  server0.close();
  const app = createApplication({ store, origin, rateSalt: randomBytes(32).toString('hex') });
  const server = await listen(app, { port: Number(new URL(origin).port) });
  const conformance = createServiceConformance({ store, services: app.services });

  // The probe worker: certifies new service versions and reports itself healthy.
  let stopped = false;
  const worker = (async () => {
    while (!stopped) {
      try {
        await conformance.tick();
        await store.transaction(async (tx) => {
          const old = await tx.read('worker-health', 'services');
          await tx.write('worker-health', 'services', { state: 'ready', observedAt: Date.now(), release: 'local' }, old?.revision ?? 0);
        });
      } catch (err) { if (!stopped) console.error('local worker:', err.code ?? err.message); }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  return {
    origin, app, store,
    async stop() { stopped = true; await worker; await new Promise((r) => server.close(r)); await store.close(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const local = await startLocalClaus({ port: Number(process.argv[2] ?? 8787) });
  console.log('Local Claus Network at ' + local.origin + '  (Ctrl+C to stop)');
  console.log('Use it with:  CLAUS_NETWORK_URL=' + local.origin + ' node bin/blackbox.mjs ...');
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => { await local.stop(); process.exit(0); });
}
