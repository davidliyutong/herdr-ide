// The core's machines as /ws and GET /api/machines report them, the agent
// states of their terminals, and helpers shared by the views that show them.

import { displayName, statusOf, type TerminalRecord } from '../term/protocol';

/** What a coding agent in a terminal is doing (docs/features/25-agent-detection.md). */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentInfo {
  version: string;
  os: string;
  arch: string;
  hostname: string;
  home: string;
  user: string;
}

export type MachineStatus = 'connecting' | 'ready' | 'auth_required' | 'error' | 'disabled';

/** The core's connection to a machine's terminal core (docs/features/22). */
export interface MachineHC {
  state: 'starting' | 'ready' | 'error';
  code?: string;
  version?: string;
}

export interface MachineState {
  id: string;
  label: string;
  kind: 'local' | 'ssh';
  target?: string;
  enabled: boolean;
  status: MachineStatus;
  /** Why a machine in error is never connected: invalid_target for a
   * stored ssh target the core refuses (machines.ValidTarget). */
  code?: string;
  error?: string;
  platform?: string;
  info?: AgentInfo;
  hc?: MachineHC;
  updated_at: number;
}

/** The code of a machine whose stored ssh target the core refuses. */
export const INVALID_TARGET = 'invalid_target';

/** Printable ASCII a target may hold besides letters and digits. */
const targetPunct = new Set('#%+,-./:=@[]^_~');

/** Whether an ssh target is one the core takes (machines.ValidTarget; the
 * vectors of design/testdata/machines/targets.json): at most 255 bytes of
 * UTF-8, not starting with "-", of ASCII letters, digits and
 * # % + , - . / : = @ [ ] ^ _ ~ and Unicode letters, marks and numbers. */
export function validTarget(t: string): boolean {
  if (!t || t.startsWith('-') || new TextEncoder().encode(t).length > 255) return false;
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) {
      if (!/[A-Za-z0-9]/.test(ch) && !targetPunct.has(ch)) return false;
    } else if (!/^[\p{L}\p{M}\p{N}]$/u.test(ch)) return false;
  }
  return true;
}

/** An agent's status change in a terminal of a machine's terminal core. */
export interface AgentStatusEvent {
  terminal: string;
  agent_status: AgentStatus;
  agent?: string | null;
  display_agent?: string | null;
  title?: string | null;
}

// Status priority for aggregation and attention ordering.
export const statusRank: Record<AgentStatus, number> = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };

const statuses = new Set<string>(Object.keys(statusRank));

/** The agent detected in a terminal, if any. */
export function agentOf(r: TerminalRecord | undefined): string | undefined {
  return typeof r?.agent === 'string' && r.agent ? r.agent : undefined;
}

/** What a terminal's agent is doing: the detected state, else what the
 * program reported itself (OSC 7501). */
export function agentStatus(r: TerminalRecord | undefined): AgentStatus | undefined {
  if (!r) return undefined;
  const s = typeof r.agent_status === 'string' ? r.agent_status : statusOf(r);
  return s && statuses.has(s) ? (s as AgentStatus) : s === 'error' ? 'blocked' : undefined;
}

/** The name the user gave a terminal's pane (its "name" label). */
export function paneName(r: TerminalRecord | undefined): string {
  const labels = r?.labels as Record<string, unknown> | undefined;
  return typeof labels?.name === 'string' ? labels.name : '';
}

/** A terminal's title for lists: the pane's name, the terminal's name, its
 * title, its program. */
export function terminalTitle(r: TerminalRecord | undefined, address: string): string {
  return r ? paneName(r) || displayName(r) : address;
}

export function shortPath(p: string | undefined, home?: string): string {
  if (!p) return '';
  if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length);
  return p;
}

/** The highest-ranking status of several. */
export function aggregate(list: Array<AgentStatus | undefined>): AgentStatus | undefined {
  let best: AgentStatus | undefined;
  for (const s of list) if (s && (!best || statusRank[s] > statusRank[best])) best = s;
  return best;
}
