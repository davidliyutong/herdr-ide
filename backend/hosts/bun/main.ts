// The command line: one executable, the hub (`serve`, the default) and
// the machine side's commands (`node`, `node dial`, `node stop`, `mcp`, the
// vault's MCP server, which every build serves, also when started by the
// name of its link in a data directory's bin, #machine/vault.ts). The
// executable is the machine build itself, on every platform: its `node`
// runs here. Each subcommand is imported dynamically so starting one
// command (e.g. `desktop` or `node`) does not evaluate the modules of the
// others.
//
// The Reflect polyfill comes first: @simplewebauthn/server's tsyringe (via
// @peculiar/x509) needs it at evaluation, and its own side-effect import is
// evaluated after tsyringe once the vault's modules sit behind a dynamic
// import in the compiled executable.
import 'reflect-metadata';
import { posix } from 'node:path';
import { HUB_BIN, SLUG } from '#shared/lib/brand.ts';
import { isForeignRuntimeVar } from '#shared/lib/bunenv.ts';
import { stderrLogger } from '#shared/lib/log.ts';

const USAGE = `usage: ${HUB_BIN} [serve] [flags] | fetch-assets [flags] DIR | node serve|dial|stop [flags] | mcp [flags] | version`;
const MCP_LINK_NAME = `${SLUG}-mcp`;

function isMcpLink(argv0: string): boolean {
  const b = posix.basename(argv0);
  return b === MCP_LINK_NAME || b.startsWith(`${MCP_LINK_NAME}-`);
}

function dropForeignRuntimeVars(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of Object.keys(env)) if (isForeignRuntimeVar(k)) delete env[k];
}

async function main(argv: string[]): Promise<void> {
  // Nothing this process starts gets them (machine/self.ts).
  dropForeignRuntimeVars();
  // Started by the stable link <data dir>/bin/<slug>-mcp (or a platform's
  // link beside it): the vault's MCP server. process.argv0 is the name the
  // executable was started by; argv[0] of a compiled executable is "bun".
  if (isMcpLink(process.argv0)) {
    const { mcpCommand } = await import('#hosts/machine/mcp.ts');
    process.exit(await mcpCommand(process.argv0, argv));
  }
  let cmd = 'serve';
  if (argv.length > 0 && !argv[0].startsWith('-')) [cmd, ...argv] = argv;
  switch (cmd) {
    case 'serve': {
      const { serve } = await import('./serve.ts');
      return serve(argv);
    }
    case 'desktop': {
      const { desktopServe } = await import('./desktop.ts');
      return desktopServe();
    }
    case 'version': {
      const { VERSION } = await import('#shared/proto/agentproto/index.ts');
      console.log(HUB_BIN, VERSION);
      return;
    }
    case 'mcp': {
      const { mcpCommand } = await import('#hosts/machine/mcp.ts');
      process.exit(await mcpCommand(process.argv0, argv));
    }
    case 'chat-host': {
      const { chatHostCommand } = await import('#hosts/machine/chathost.ts');
      process.exit(await chatHostCommand(argv));
    }
    case 'term-env': {
      const { termEnvCommand } = await import('#hosts/machine/termenv.ts');
      process.exit(await termEnvCommand(argv));
    }
    case 'fetch-assets': {
      const { fetchAssets } = await import('#features/vscode/fetchassets.ts');
      process.exit(await fetchAssets(argv, { logger: stderrLogger(`${HUB_BIN}: `) }));
    }
    case 'node': {
      const { nodeCommand } = await import('#hosts/machine/cli.ts');
      process.exit(await nodeCommand(argv));
    }
  }
  stderrLogger()(USAGE);
  process.exit(2);
}

void main(process.argv.slice(2)).catch((e) => {
  stderrLogger(`${HUB_BIN}: `)((e as Error).stack ?? String(e));
  process.exit(1);
});
