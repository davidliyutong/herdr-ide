// The variable vault's requests (Op.Vault): an MCP server on a machine asks
// the core for variables through the agent, which only relays the stream.
// The core decides from the machine the stream came from, never from what
// the request says about itself.

/** Vault tools (VaultRequest.tool). */
export const VaultTool = {
  /** The variables: names, descriptions, flags. */
  List: 'list',
  /** One variable's value (refused for inject-only ones). */
  Get: 'get',
  /** Values to put into a command's environment. */
  Env: 'env',
} as const;

/** What an MCP server asks for. client, terminal and cwd are shown to the
 * user who approves, not trusted; the process chain is never read from the
 * request but from the stream's header, where the agent put what it saw. */
export interface VaultRequest {
  tool: string;
  names?: string[];
  client?: string;
  terminal?: string;
  cwd?: string;
}

/** How many processes of the chain behind a request the agent reports. */
export const MAX_VAULT_PROCESSES = 8;

/** A process of the chain behind a vault request: its pid and the kernel's
 * short name (which a program can set itself). */
export interface VaultProcess {
  pid: number;
  name?: string;
}

export interface VaultVariable {
  name: string;
  description?: string;
  inject_only?: boolean;
  /** Reading it from this machine asks the user first. */
  approval?: boolean;
}

/** Answers a VaultRequest. code is one of vault_locked, not_found,
 * inject_only, denied, busy, corrupt, log_failed, plugin_disabled,
 * unavailable, bad_request. */
export interface VaultResponse {
  ok: boolean;
  code?: string;
  error?: string;
  variables?: VaultVariable[];
  values?: Record<string, string>;
  run?: VaultRun;
}

/** Bounds run_with_env's command: default and longest timeout in seconds,
 * output in bytes. */
export interface VaultRun {
  timeout: number;
  max_timeout: number;
  max_output: number;
}
