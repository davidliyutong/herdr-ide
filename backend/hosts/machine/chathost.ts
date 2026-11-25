// The chat-host command of the command line (hosts/bun/main.ts), as the Go
// machine build has it (cmd/<slug> chat-host), with the same flags and exit
// statuses:
//
//	<slug> chat-host --base DIR --run DIR
//
// The process of a machine that runs coding agents headless for the chat
// feature (features/chat/machine/host): it serves the socket of the
// instance's run directory --run, keeps its journal in the instance's data
// directory --base, logs to its log file there and to standard error, and
// ends on SIGHUP, SIGTERM or SIGINT (the terminal core's stop), when told
// to, or when it has nothing left to do; one that has not ended 30 s after it
// began to stop exits with status 1, its agents killed. Status 2 is a wrong
// command line, 1 a host that did not serve (another serves the socket, the
// directories are not the user's alone, a newer host's journal). The agent
// starts it as a hidden terminal of the instance's terminal core
// (features/chat/machine.ts).
import { parseArgs } from 'node:util';
import { CORE_BIN, SLUG } from '#shared/lib/brand.ts';
import { chatSpec } from '#shared/agents/kinds.ts';
import { VERSION } from '#shared/proto/agentproto/index.ts';
import { RunningError, serveHost } from '#features/chat/machine/host/host.ts';
import { LogFile, teeLogger } from '#features/chat/machine/host/log.ts';
import { chatAdapters } from './features.ts';

const USAGE = `usage: ${CORE_BIN} chat-host --base DIR --run DIR\n`;

/** The signals the terminal core ends a terminal's program with. */
const SIGNALS = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const;

/** `chat-host …`: argv after `chat-host`; the exit status. */
export async function chatHostCommand(argv: string[]): Promise<number> {
  let base = '';
  let run = '';
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { base: { type: 'string', default: '' }, run: { type: 'string', default: '' } },
      strict: true,
      allowPositionals: true,
    });
    base = values.base ?? '';
    run = values.run ?? '';
    if (positionals.length > 0) throw new Error('arguments after the flags');
  } catch {
    base = '';
  }
  if (base === '' || run === '') {
    process.stderr.write(USAGE);
    return 2;
  }
  let log: LogFile | null = null;
  let logErr: Error | null = null;
  try {
    log = await LogFile.open(base);
  } catch (e) {
    logErr = e as Error;
  }
  const logger = teeLogger(`${CORE_BIN} chat-host: `, (t) => process.stderr.write(t), ...(log ? [(t: string) => log.write(t)] : []));
  if (logErr) logger(`no log file: ${logErr.message}`);
  let code = 0;
  try {
    await serveHost({
      base,
      run,
      logger,
      adapters: chatAdapters({ base }),
      spec: chatSpec,
      client: { name: SLUG, version: VERSION },
      signals: (on) => {
        const handlers = SIGNALS.map((sig) => [sig, () => on(sig)] as const);
        for (const [sig, h] of handlers) process.on(sig, h);
        return () => {
          for (const [sig, h] of handlers) process.off(sig, h);
        };
      },
      exit: (c) => process.exit(c),
    });
  } catch (e) {
    if (e instanceof RunningError) logger(`another chat host serves ${run}`);
    else logger(`exit: ${(e as Error).message}`);
    code = 1;
  }
  await log?.close();
  return code;
}
