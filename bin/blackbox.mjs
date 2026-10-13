#!/usr/bin/env node
// agent-blackbox command line.
//
//   blackbox setup      [--state DIR] [--agent NAME] [--hours N]
//   blackbox checkpoint [--state DIR]
//   blackbox notary     [--state DIR]          run the notary worker until Ctrl+C
//   blackbox revoke     [--state DIR] [--reason TEXT]
//   blackbox verify     [--state DIR]
//   blackbox export     [--state DIR] [--out FILE] [--with-payloads]
//   blackbox status     [--state DIR]
//
// The state directory (default ./.blackbox) holds private keys and tokens.
// Keep it private; it is created with mode 700.
import { writeFile } from 'node:fs/promises';
import { openState, setup, checkpoint, revoke, verify, exportBundle, notaryTick } from '../src/operator.mjs';
import { readLog } from '../src/log.mjs';

const [command = 'help', ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  args[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
}
const stateDir = args.state ?? '.blackbox';
const print = (x) => console.log(JSON.stringify(x, null, 2));
const log = (x) => console.error(JSON.stringify(x));

async function main() {
  if (command === 'help' || command === '--help') {
    console.log(`agent-blackbox — a flight recorder for AI agents, on Claus Network

  setup        create the notary + agent projects on Claus and the agent's mandate
  checkpoint   stamp new log entries with the notary and publish them on Claus
  notary       run the notary worker (if you host the notary separately)
  revoke       revoke the agent's mandate, prove it no longer works, record it
  verify       check the log chain and every checkpoint against its public copy
  export       write the public bundle for viewer/index.html
  status       show projects, mandate and checkpoints

Options: --state DIR (default .blackbox), --agent NAME, --hours N, --reason TEXT,
         --out FILE, --with-payloads. Set CLAUS_NETWORK_URL to use another Claus host.`);
    return;
  }
  const ctx = await openState(stateDir);
  const s = ctx.state;
  switch (command) {
    case 'setup':
      print(await setup(ctx, { agentName: args.agent ?? 'demo-agent', mandateHours: Number(args.hours ?? 24), log }));
      break;
    case 'checkpoint':
      print(await checkpoint(ctx, { log }));
      break;
    case 'notary':
      console.error('notary worker running; Ctrl+C to stop');
      for (;;) { const r = await notaryTick(ctx, { log }); if (r.delivered) log(r); await new Promise((x) => setTimeout(x, 3000)); }
    case 'revoke':
      print(await revoke(ctx, { reason: args.reason ?? 'operator revoked access' }));
      break;
    case 'verify': {
      const report = await verify({ lines: await readLog(ctx.logFile), checkpoints: s.checkpoints });
      print(report);
      if (!report.ok) process.exitCode = 1;
      break;
    }
    case 'export': {
      const bundle = await exportBundle(ctx, { includePayloads: !!args['with-payloads'] });
      const out = args.out ?? 'blackbox-bundle.json';
      await writeFile(out, JSON.stringify(bundle, null, 2) + '\n');
      print({ written: out, entries: bundle.lines.length, checkpoints: bundle.checkpoints.length,
        payloads: args['with-payloads'] ? 'included' : 'tool inputs/outputs withheld' });
      break;
    }
    case 'status':
      print({ origin: s.origin, agent: s.agent && { ...s.agent, token: undefined },
        notary: s.notary && { ...s.notary, token: undefined }, revokedAt: s.revokedAt ?? null,
        entries: (await readLog(ctx.logFile)).length, checkpoints: s.checkpoints });
      break;
    default:
      throw new Error('unknown command: ' + command + ' (try help)');
  }
}
main().catch((err) => { console.error('error:', err.code ?? '', err.message); process.exitCode = 1; });
