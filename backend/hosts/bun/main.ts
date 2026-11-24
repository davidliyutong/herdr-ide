// The command line: one executable, the core (`serve`, the default) and,
// while machines run the Go build, the local node's commands passed on to
// the machine build this executable carries.
import { spawnSync } from 'node:child_process';
import { CORE_BIN, env } from '#shared/lib/brand.ts';
import { stderrLogger } from '#shared/lib/log.ts';
import { dirsFor } from '#shared/host/hostdirs.ts';
import { VERSION } from '#shared/proto/agentproto/index.ts';
import { installLocal } from '#kernel/machines/transport/local.ts';
import { openPayloads } from './payloads.ts';
import { serve } from './serve.ts';

const USAGE = `usage: ${CORE_BIN} [serve] [flags] | node serve|dial|stop [flags] | version`;

async function main(argv: string[]): Promise<void> {
  let cmd = 'serve';
  if (argv.length > 0 && !argv[0].startsWith('-')) [cmd, ...argv] = argv;
  switch (cmd) {
    case 'serve':
      return serve(argv);
    case 'version':
      console.log(CORE_BIN, VERSION);
      return;
    case 'node': {
      // The local machine's node is the machine build's: install it as the
      // core would and run the command there (`node stop` of the tests).
      const inst = argv.indexOf('--instance');
      const instance = inst >= 0 ? (argv[inst + 1] ?? '') : '';
      const agentDir = process.env[env('AGENT_DIR')] ?? '';
      const payloads = await openPayloads({ agentDir, extDir: '', webDir: '' });
      const { exe } = await installLocal(payloads.agent.bind(payloads), dirsFor(instance).home);
      const r = spawnSync(exe, ['node', ...argv], { stdio: 'inherit' });
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
