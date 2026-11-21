// How a coding agent's CLI on a machine reaches the vault: the MCP server
// is the agent's stable link <data dir>/bin/<slug>-mcp, which the user
// adds to the CLI's configuration (docs/features/30-variable-vault.md).
import { APP_SLUG } from '../../brand';

/** The MCP server's name in the CLIs' configurations. */
export const SERVER_NAME = `${APP_SLUG}-vault`;

export interface MachineDirs {
  home?: string;
  data_dir?: string;
}

/** The command that starts the MCP server on a machine. */
export function mcpCommand(info?: MachineDirs): string {
  const dir = info?.data_dir || (info?.home ? `${info.home}/.${APP_SLUG}` : `~/.${APP_SLUG}`);
  return `${dir}/bin/${APP_SLUG}-mcp`;
}

/** What to run or paste for Claude Code, Codex and other MCP clients. */
export function setupSnippets(info?: MachineDirs): { claude: string; codex: string; json: string } {
  const cmd = mcpCommand(info);
  const quoted = /^[\w./~-]+$/.test(cmd) ? cmd : `'${cmd.replaceAll("'", `'\\''`)}'`;
  return {
    claude: `claude mcp add --scope user ${SERVER_NAME} -- ${quoted}`,
    codex: `[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(cmd)}`,
    json: JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: cmd, args: [] } } }, null, 2),
  };
}
