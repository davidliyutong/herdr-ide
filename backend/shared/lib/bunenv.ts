// What makes a compiled Bun executable run other code, be another program
// or say more than it should: its runtime flags (BUN_OPTIONS, which it
// honours as bun does), its debugger (BUN_INSPECT*), BUN_BE_BUN, which
// turns it into the bun command, and its configuration (BUN_CONFIG_*:
// BUN_CONFIG_VERBOSE_FETCH=curl prints every fetch with its headers, a
// provider's bearer token among them, into the node's log). The machine
// side is started without them (the core's ssh command, its local spawn,
// the command line's `node`) and drops them itself (machine/self.ts).
export const FOREIGN_RUNTIME_VARS = [
  'BUN_OPTIONS',
  'BUN_BE_BUN',
  'BUN_INSPECT',
  'BUN_INSPECT_CONNECT_TO',
  'BUN_INSPECT_NOTIFY',
  'BUN_INSPECT_PRELOAD',
] as const;

/** The prefix of the runtime's configuration variables. */
export const FOREIGN_RUNTIME_PREFIX = 'BUN_CONFIG_';

/** Whether k is one of them. */
export const isForeignRuntimeVar = (k: string): boolean =>
  (FOREIGN_RUNTIME_VARS as readonly string[]).includes(k) || k.startsWith(FOREIGN_RUNTIME_PREFIX);

/** env without them. */
export function withoutForeignRuntimeVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) if (isForeignRuntimeVar(k)) delete out[k];
  return out;
}

/** POSIX shell that unsets them all in the shell that runs it. */
export const UNSET_FOREIGN_RUNTIME_VARS = `unset ${FOREIGN_RUNTIME_VARS.join(' ')}; for v in $(env | sed -n 's/^\\(${FOREIGN_RUNTIME_PREFIX}[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$v"; done`;
