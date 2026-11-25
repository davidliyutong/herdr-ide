// The command line: one executable, the core (`serve`, the default) and
// the machine side's commands (`node`, `node dial`, `node stop`). A build
// that deploys the TypeScript machine side is that machine build itself,
// on every platform: its `node` runs here. One that deploys the Go machine
// build passes `node` on to the Go program it carries, installed as the core
// installs it for the local machine.
import { withoutForeignRuntimeVars } from '#shared/lib/bunenv.ts';
import { spawnSync } from 'node:child_process';
import { CORE_BIN, env } from '#shared/lib/brand.ts';
import { stderrLogger } from '#shared/lib/log.ts';
import { dirsFor } from '#shared/host/hostdirs.ts';
import { VERSION } from '#shared/proto/agentproto/index.ts';
import { installLocal } from '#kernel/machines/transport/local.ts';
import { fetchAssets } from '#features/vscode/fetchassets.ts';
import { nodeCommand } from '#hosts/machine/cli.ts';
import { dropForeignRuntimeVars } from '#machine/self.ts';
import { openPayloads } from './payloads.ts';
import { serve } from './serve.ts';

const USAGE = `usage: ${CORE_BIN} [serve] [flags] | fetch-assets [flags] DIR | node serve|dial|stop [flags] | version`;

async function main(argv: string[]): Promise<void> {
  // Nothing this process starts gets them (machine/self.ts).
  dropForeignRuntimeVars();
  let cmd = 'serve';
  if (argv.length > 0 && !argv[0].startsWith('-')) [cmd, ...argv] = argv;
  switch (cmd) {
    case 'serve':
      return serve(argv);
    case 'version':
      console.log(CORE_BIN, VERSION);
      return;
    case 'fetch-assets':
      process.exit(await fetchAssets(argv, { logger: stderrLogger(`${CORE_BIN}: `) }));
    case 'node': {
      const agentDir = process.env[env('AGENT_DIR')] ?? '';
      const payloads = await openPayloads({ agentDir, extDir: '', webDir: '' });
      if (await payloads.deploysTS()) process.exit(await nodeCommand(argv));
      // The Go machine build's: installed as the core installs it for the
      // local machine, the command run there (`node stop` of the tests).
      const inst = argv.indexOf('--instance');
      const instance = inst >= 0 ? (argv[inst + 1] ?? '') : '';
      const { exe } = await installLocal(payloads.machine.bind(payloads), dirsFor(instance).home);
      const r = spawnSync(exe, ['node', ...argv], { stdio: 'inherit', env: withoutForeignRuntimeVars(process.env) });
      process.exit(r.status ?? 1);
    }
  }
  stderrLogger()(USAGE);
  process.exit(2);
}

void main(process.argv.slice(2)).catch((e) => {
  stderrLogger(`${CORE_BIN}: `)((e as Error).stack ?? String(e));
  process.exit(1);
});
