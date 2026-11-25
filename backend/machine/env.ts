// The environment of the programs the agent starts (the terminal core,
// whose terminals inherit it, and the helpers it runs), without the
// variables of a terminal or multiplexer the agent itself was started in,
// nor the session markers of a coding agent it was started from: those
// programs belong to no terminal, no multiplexer and no agent's session. A
// shell in their terminals that saw TMUX or HERDR_PANE_ID would take itself
// for a nested session, or hand an agent's status to the herdr pane the
// hub was started from; Claude Code that saw CLAUDE_CODE_CHILD_SESSION
// would take itself for a child session and save no transcript.
import { ENV_PREFIX } from '#shared/lib/brand.ts';

/** The variables by which Claude Code and Codex mark the programs of one of
 * their sessions. They are named one by one, not by prefix: users configure
 * these agents through other variables of the same prefixes
 * (CLAUDE_CONFIG_DIR, ANTHROPIC_*, CODEX_HOME, OPENAI_*), which the programs
 * in the terminals need. */
export const AGENT_SESSION_VARS: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_PLUGIN_DATA',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_TOOL_CALL_ID',
  'CODEX_COMPANION_SESSION_ID',
  'CODEX_COMPANION_TRANSCRIPT_PATH',
]);

/** Whether a variable of the agent's environment is passed on: not the
 * terminal core's (HC_*), herdr's (HERDR_*; the product's own, ENV_PREFIX,
 * are kept), tmux's, GNU screen's, zellij's or a coding agent's session
 * markers. */
export function inheritedVar(k: string): boolean {
  if (k === 'TMUX' || k === 'TMUX_PANE' || k === 'STY' || k === 'ZELLIJ') return false;
  if (AGENT_SESSION_VARS.has(k)) return false;
  if (k.startsWith('HC_') || k.startsWith('ZELLIJ_')) return false;
  return !k.startsWith('HERDR_') || k.startsWith(ENV_PREFIX);
}

/** The agent's environment for the programs it starts. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && inheritedVar(k)) out[k] = v;
  return out;
}

/** What a helper gets on top of the terminal core's environment: of the
 * agent's (cleanEnv's), only what names the user, the user's home, shell,
 * PATH, locale, temporary directory and XDG directories. A helper outlives
 * the ssh session and the terminal the agent may have been started from;
 * nothing else of the agent's environment (its credentials, its session's
 * variables) reaches it. */
export function hiddenEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (hiddenVar(k)) out[k] = v;
  return out;
}

function hiddenVar(k: string): boolean {
  switch (k) {
    case 'HOME':
    case 'USER':
    case 'LOGNAME':
    case 'SHELL':
    case 'PATH':
    case 'LANG':
    case 'TMPDIR':
      return true;
  }
  return k.startsWith('LC_') || k.startsWith('XDG_');
}
