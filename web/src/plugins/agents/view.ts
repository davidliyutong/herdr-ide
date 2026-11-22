// How the agents plugin shows a terminal's pane: as the agent's
// conversation (the leaf's render: native) or as the terminal, decided from
// the leaf, the terminal's record and what the page read of the session
// (transcript.ts), the same way as the pane is rendered (covers) and while
// the surface is mounted. When there is nothing to show, the terminal is
// shown.

import { actions, current } from '../../actions';
import { AGENT_KINDS, agentKind, hasNativeView, isSessionId, startArgv } from '../../conversation/kinds';
import { hasMessage, type MessageKey } from '../../i18n';
import { agentSession, agentStatus, type AgentStatus } from '../../lib/machine';
import type { Cover } from '../../state/covers';
import { useStore } from '../../state/store';
import { terms, useTerms } from '../../state/terms';
import * as L from '../../term/layout';
import type { TerminalRecord } from '../../term/protocol';
import { feedStatus, nativeKind, type FeedStatus } from './transcript';

// Which agent with a native view a terminal runs: transcript.ts has it,
// whose sending checks it too.
export { nativeKind };

/** The surface's id, the owner of its covers. */
export const SURFACE = 'agents';

/** What the surface draws: nothing (off: the terminal, as without the
 * plugin), a strip over the terminal's top saying why there is no
 * conversation to show (strip), the conversation over all of the terminal
 * (native; loading until its first page is read), or over the upper part
 * while the agent waits for the user in its terminal (peek), unless what
 * the terminal shows is all under that part (waitingView). */
export type Mode = 'off' | 'strip' | 'loading' | 'native' | 'peek';

/** Why the strip is shown: no session found yet, the conversation not
 * read yet while the agent waits, and the feed's states. */
export type StripReason = 'session' | 'loading' | 'not_found' | 'compressed' | 'error' | 'bad';

export interface AgentView {
  mode: Mode;
  /** The agent's kind, when it has a native view. */
  kind?: string;
  session?: string;
  status?: AgentStatus;
  reason?: StripReason;
}

/** The session a terminal's pane shows: the one the machine found for its
 * agent, else the one its leaf remembers. */
export function shownSession(record: TerminalRecord | undefined, leaf: L.TerminalLeaf): string | undefined {
  return agentSession(record)?.id ?? (isSessionId(leaf.session) ? leaf.session : undefined);
}

/** How a terminal's pane is shown, from its leaf, its record and the state
 * of the session's feed. */
export function agentView(
  leaf: L.TerminalLeaf,
  record: TerminalRecord | undefined,
  status: (kind: string, session: string) => FeedStatus | undefined,
): AgentView {
  const kind = nativeKind(record);
  if (leaf.render !== 'native' || !kind) return { mode: 'off', kind };
  const s = agentStatus(record);
  const session = shownSession(record, leaf);
  if (!session) return { mode: 'strip', kind, status: s, reason: 'session' };
  const base = { kind, session, status: s };
  const state = status(kind, session)?.state ?? 'loading';
  const blocked = s === 'blocked';
  if (state === 'ok') return { ...base, mode: blocked ? 'peek' : 'native' };
  // Waiting for the user, the terminal is shown until there is a
  // conversation to show above it.
  if (state === 'loading') return blocked ? { ...base, mode: 'strip', reason: 'loading' } : { ...base, mode: 'loading' };
  return { ...base, mode: 'strip', reason: state };
}

/** What a view covers of its terminal whatever the terminal shows: all of
 * it under the conversation. The upper part while the agent waits (peek)
 * is the surface's to say as it reads the terminal's screen
 * (waitingView), and none when it shows the terminal whole. */
export function coverOf(v: AgentView): Cover | undefined {
  return v.mode === 'native' || v.mode === 'loading' ? 'all' : undefined;
}

/** The rows of a terminal's screen that a box over its top covers. */
export interface RowsUnder {
  /** The rows before it are under the box, at least in part. */
  covered: number;
  /** The rows from it on are shown whole below the box. */
  shown: number;
}

/** The rows of a terminal's screen a box over its top covers, from the
 * number of rows, the height of the terminal's area and the distance of
 * the box's lower edge from the area's top (CSS pixels); undefined when
 * either is not known. The terminal's grid is the rows that fit its area,
 * so a row is more than height/(rows+1) and at most height/rows high: the
 * one row the edge may cross counts in neither part. */
export function rowsUnder(rows: number, height: number, edge: number): RowsUnder | undefined {
  if (!(rows >= 1) || !(height > 0) || !Number.isFinite(edge)) return undefined;
  const before = (pitch: number) => Math.min(rows, Math.max(0, Math.ceil(edge / pitch)));
  return { covered: before(height / rows), shown: before(height / (rows + 1)) };
}

/** How a terminal whose agent waits for the user is shown while there is a
 * conversation to show: under the conversation's upper part (peek), or
 * whole with a strip saying what the agent waits for, because all it shows
 * is under that part and none of it below (under: a dialog drawn at the
 * top of a cleared screen, as Codex draws its first ones), or because its
 * screen cannot be read (unread). */
export type WaitingView = 'peek' | 'under' | 'unread';

/** How a waiting agent's terminal is shown (WaitingView), from its screen
 * (its rows as text; undefined: not read), the height of its area and the
 * distance of the upper part's lower edge from the area's top (CSS pixels,
 * rowsUnder; NaN: not known). */
export function waitingView(screen: string | undefined, height: number, edge: number): WaitingView {
  if (typeof screen !== 'string') return 'unread';
  const lines = screen.split('\n');
  const rows = rowsUnder(lines.length, height, edge);
  if (!rows) return 'unread';
  const text = (from: number, to: number) => lines.slice(from, to).some((l) => l.trim() !== '');
  return text(0, rows.covered) && !text(rows.shown, lines.length) ? 'under' : 'peek';
}

/** The record of a terminal on the page. */
const recordOf = (m: string, terminal: string) => useTerms.getState().machines[m]?.terminals[terminal];

/** What the surface covers of a terminal as its pane is rendered for leaf
 * (TerminalSurfaceDef.covers): read from the page's state, changing
 * nothing; while the agent waits, nothing (coverOf), which the surface
 * raises to the upper part as it draws it. */
export function covers(m: string, terminal: string, leaf: L.TerminalLeaf): Cover | undefined {
  return coverOf(agentView(leaf, recordOf(m, terminal), (kind, session) => feedStatus(m, kind, session)));
}

/** The leaf of a terminal in its machine's layout. */
function terminalLeaf(m: string, terminal: string): L.TerminalLeaf | undefined {
  const layout = terms.layout(m);
  const leaf = layout ? L.findLeaf(layout, terminal) : null;
  return leaf && L.isTerminalLeaf(leaf) ? leaf : undefined;
}

/** Shows a terminal's pane as its agent's conversation (native) or as the
 * terminal, for every client of the machine (the layout's leaf). Nothing on
 * a read-only page. Returns whether the layout changed. */
export function setNative(m: string, terminal: string, native: boolean): boolean {
  if (useStore.getState().readOnly || !terminalLeaf(m, terminal)) return false;
  return terms.mutate(m, (l) => L.setTerminalFields(l, terminal, { render: native ? 'native' : null }));
}

/** Flips how a terminal's pane is shown (setNative). */
export function toggleView(m: string, terminal: string): boolean {
  const leaf = terminalLeaf(m, terminal);
  return !!leaf && setNative(m, terminal, leaf.render !== 'native');
}

/** The focused pane's terminal when it runs an agent with a native view and
 * the page may change how it is shown. */
export function toggleTarget(): { m: string; terminal: string } | undefined {
  if (useStore.getState().readOnly) return undefined;
  const c = actions.focusedContext();
  if (!c?.terminal || !nativeKind(terms.terminal(c.m, c.terminal))) return undefined;
  return { m: c.m, terminal: c.terminal };
}

/** The new-tab menu's title of an agent of a kind. */
const tabTitle = (kind: string): string => `agents.newTab.${kind}`;

/** The kinds a new agent tab starts: those with a native view that the UI
 * starts, in the registry's order. */
export function agentTabKinds(): string[] {
  return AGENT_KINDS.filter((k) => hasNativeView(k.id) && !!startArgv(k.id) && hasMessage(tabTitle(k.id))).map((k) => k.id);
}

/** The title of a kind's item in the new-tab menu. */
export function agentTabTitle(kind: string): MessageKey {
  const key = tabTitle(kind);
  return hasMessage(key) ? key : 'agents.title';
}

/** A new session's id: a lower-case UUID (version 4), also where the page
 * is no secure context and has no crypto.randomUUID. */
export function newSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Starts an agent of a kind in a new tab of a workspace of machine m (the
 * selected one), shown as its conversation; an agent that takes a session
 * id at its start gets a new one, which its leaf remembers from the first
 * second. */
export async function startAgentTab(m: string, workspace: string | undefined, kind: string): Promise<void> {
  const k = agentKind(kind);
  if (!k || !hasNativeView(kind)) return;
  const session = k.newSession?.length ? newSessionId() : undefined;
  const argv = startArgv(kind, session);
  if (!argv) return;
  const fields: Record<string, unknown> = { render: 'native' };
  if (session && isSessionId(session) && argv.includes(session)) fields.session = session;
  await actions.startAgent(m, argv, { workspace, fields });
}

/** The machine and workspace a new agent tab opens in: the shown ones. */
export function agentTabPlace(): { m: string; workspace?: string } | undefined {
  if (useStore.getState().readOnly) return undefined;
  const c = current();
  return c?.layout ? { m: c.m, workspace: c.ws?.id } : undefined;
}
