// The mcp command of the command line (hosts/bun/main.ts), as the Go build
// has it (internal/vaultmcp Main), with the same flags and exit statuses:
//
//	<slug> mcp [--instance NAME] [--socket PATH]
//
// and the same command without arguments when the executable is started by
// the stable command's name or a platform's link (<data dir>/bin/<slug>-mcp,
// #machine/vault.ts isMcpLink): the vault's MCP server on stdio, asking the
// agent of that data directory (or of the instance) through its vault.sock.
// It ends when its standard input closes or on SIGTERM, SIGINT or SIGHUP,
// the commands it runs killed first. Status 2: a wrong command line; 1: no
// home directory, or a line longer than the server takes.
import { parseArgs } from 'node:util';
import { CORE_BIN, validInstance } from '#shared/lib/brand.ts';
import { userHomeDir } from '#shared/host/hostdirs.ts';
import { parentOf } from '#machine/sys/proc.ts';
import { mcpSocketPath } from '#machine/vault.ts';
import { dialSocket, serveMcp } from '#features/vault/machine/mcp.ts';

const USAGE = `usage: ${CORE_BIN} mcp [--instance NAME] [--socket PATH]

The variable vault's MCP server (stdio), for coding agents' CLIs.

  --instance NAME  state instance whose agent to ask (see --instance of serve)
  --socket PATH    the agent's vault socket (default vault.sock in the data
                   directory's runtime directory)
`;

/** The name of the program that started this one (the CLI of a coding
 * agent: claude, codex, node…), as the kernel names it; "" when unknown. */
export function parentName(): string {
  return parentOf(process.ppid)?.name ?? '';
}

/** `mcp …`: argv after `mcp` (or after argv0 when started by a link's
 * name); the exit status. */
export async function mcpCommand(argv0: string, argv: string[]): Promise<number> {
  let flags;
  try {
    flags = parseArgs({
      args: argv,
      options: { instance: { type: 'string', default: '' }, socket: { type: 'string', default: '' } },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const instance = flags.instance ?? '';
  if (!validInstance(instance)) {
    process.stderr.write('--instance must be lowercase letters, digits and dashes\n');
    return 2;
  }
  let path = flags.socket ?? '';
  if (path === '') {
    try {
      path = mcpSocketPath(argv0, userHomeDir(), instance);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
  }
  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => ac.abort());
  try {
    await serveMcp(
      { dial: dialSocket(path), client: parentName(), terminal: process.env.HC_TERMINAL_ID ?? '' },
      process.stdin,
      process.stdout,
      ac.signal,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
}
