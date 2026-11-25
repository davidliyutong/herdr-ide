// The machine build's command line: what the core deploys to every machine
// (compiled by Bun into one executable per platform, compile.ts) and runs
// there. Its commands are the Go machine build's (cmd/<slug>), with the
// same flags:
//
//	<slug> node [dial | stop] [--instance NAME] [--client ID] [--takeover] [--terminal-core]
//	<slug> version
import { parseArgs } from 'node:util';
import { CORE_BIN } from '#shared/lib/brand.ts';
import { dirsFor } from '#shared/host/hostdirs.ts';
import { stderrLogger } from '#shared/lib/log.ts';
import { VERSION } from '#shared/proto/agentproto/index.ts';
import { dialNode, stopNodes } from '#machine/dial.ts';
import { TerminalCore } from '#machine/hc.ts';
import { runNode } from '#machine/node.ts';
import { buildFile, dropForeignRuntimeVars } from '#machine/self.ts';
import { machineFeatures } from './features.ts';

const USAGE = `usage: ${CORE_BIN} node [dial | stop] [--instance NAME] | version\n`;

async function nodeCommand(argv: string[]): Promise<number> {
  let sub = '';
  if (argv[0] === 'dial' || argv[0] === 'stop') [sub, ...argv] = argv;
  let flags;
  try {
    flags = parseArgs({
      args: argv,
      options: {
        instance: { type: 'string', default: '' },
        client: { type: 'string', default: '' },
        takeover: { type: 'boolean', default: false },
        'terminal-core': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const instance = flags.instance ?? '';
  const logger = stderrLogger(`${CORE_BIN} node: `);
  switch (sub) {
    case 'dial':
      return dial(instance, flags.client ?? '', logger);
    case 'stop': {
      try {
        const n = await stopNodes(instance);
        process.stdout.write(`stopped ${n} node(s)\n`);
        if (flags['terminal-core']) {
          if (await new TerminalCore(instance, dirsFor(instance)).stopIfRunning()) process.stdout.write('stopped the terminal core\n');
        }
        return 0;
      } catch (e) {
        logger((e as Error).message);
        return 1;
      }
    }
  }
  const ac = new AbortController();
  process.on('SIGTERM', () => ac.abort());
  process.on('SIGINT', () => ac.abort());
  // A node outlives the ssh session or terminal that started it.
  process.on('SIGHUP', () => {});
  try {
    await runNode({ instance, logger, features: machineFeatures(), takeover: flags.takeover, signal: ac.signal, build: buildFile() });
    return 0;
  } catch (e) {
    logger(`exit: ${(e as Error).message}`);
    return 1;
  }
}

/** Pipes standard input and output to the node until either side ends. */
async function dial(instance: string, client: string, logger: ReturnType<typeof stderrLogger>): Promise<number> {
  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => ac.abort());
  let conn;
  try {
    conn = await dialNode({ instance, client, sshConn: process.env.SSH_CONNECTION ?? '', logger, signal: ac.signal });
  } catch (e) {
    logger((e as Error).message);
    return 1;
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      resolve();
    };
    ac.signal.addEventListener('abort', end, { once: true });
    process.stdin.on('end', end).on('error', end);
    conn.on('end', end).on('close', end).on('error', end);
    process.stdout.on('error', end);
    process.stdin.pipe(conn);
    conn.pipe(process.stdout);
  });
  conn.destroy();
  return 0;
}

async function main(argv: string[]): Promise<number> {
  // Nothing this process starts gets them (self.ts).
  dropForeignRuntimeVars();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'node':
      return nodeCommand(rest);
    case 'version':
      process.stdout.write(`${CORE_BIN} ${VERSION}\n`);
      return 0;
  }
  process.stderr.write(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    stderrLogger(`${CORE_BIN}: `)((e as Error).stack ?? String(e));
    process.exit(1);
  },
);
