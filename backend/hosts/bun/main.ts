// The command line: one executable, the hub (`serve`, the default) and
// the machine side's commands (`node`, `node dial`, `node stop`, `mcp`, the
// vault's MCP server, which every build serves, also when started by the
// name of its link in a data directory's bin, #machine/vault.ts). The
// executable is the machine build itself, on every platform: its `node`
// runs here.
import { HUB_BIN } from '#shared/lib/brand.ts';
import { stderrLogger } from '#shared/lib/log.ts';
import { VERSION } from '#shared/proto/agentproto/index.ts';
import { fetchAssets } from '#features/vscode/fetchassets.ts';
import { nodeCommand } from '#hosts/machine/cli.ts';
import { mcpCommand } from '#hosts/machine/mcp.ts';
import { chatHostCommand } from '#hosts/machine/chathost.ts';
import { dropForeignRuntimeVars } from '#machine/self.ts';
import { isMcpLink } from '#machine/vault.ts';
import { serve } from './serve.ts';

const USAGE = `usage: ${HUB_BIN} [serve] [flags] | fetch-assets [flags] DIR | node serve|dial|stop [flags] | mcp [flags] | version`;

async function main(argv: string[]): Promise<void> {
  // Nothing this process starts gets them (machine/self.ts).
  dropForeignRuntimeVars();
  // Started by the stable link <data dir>/bin/<slug>-mcp (or a platform's
  // link beside it): the vault's MCP server. process.argv0 is the name the
  // executable was started by; argv[0] of a compiled executable is "bun".
  if (isMcpLink(process.argv0)) process.exit(await mcpCommand(process.argv0, argv));
  let cmd = 'serve';
  if (argv.length > 0 && !argv[0].startsWith('-')) [cmd, ...argv] = argv;
  switch (cmd) {
    case 'serve':
      return serve(argv);
    case 'version':
      console.log(HUB_BIN, VERSION);
      return;
    case 'mcp':
      process.exit(await mcpCommand(process.argv0, argv));
    case 'chat-host':
      process.exit(await chatHostCommand(argv));
    case 'fetch-assets':
      process.exit(await fetchAssets(argv, { logger: stderrLogger(`${HUB_BIN}: `) }));
    case 'node':
      process.exit(await nodeCommand(argv));
  }
  stderrLogger()(USAGE);
  process.exit(2);
}

void main(process.argv.slice(2)).catch((e) => {
  stderrLogger(`${HUB_BIN}: `)((e as Error).stack ?? String(e));
  process.exit(1);
});
