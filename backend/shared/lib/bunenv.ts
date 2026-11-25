// What makes a compiled Bun executable run other code or be another
// program: its runtime flags (BUN_OPTIONS, which it honours as bun does),
// its debugger (BUN_INSPECT*) and BUN_BE_BUN, which turns it into the bun
// command. The machine executable is started without them (the core's ssh
// command, its local spawn) and drops them itself (machine/self.ts).
export const FOREIGN_RUNTIME_VARS = [
  'BUN_OPTIONS',
  'BUN_BE_BUN',
  'BUN_INSPECT',
  'BUN_INSPECT_CONNECT_TO',
  'BUN_INSPECT_NOTIFY',
  'BUN_INSPECT_PRELOAD',
] as const;

/** env without FOREIGN_RUNTIME_VARS. */
export function withoutForeignRuntimeVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of FOREIGN_RUNTIME_VARS) delete out[k];
  return out;
}
