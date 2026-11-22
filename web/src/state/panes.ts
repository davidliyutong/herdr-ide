// The panes on screen, for commands that act on one: focusing it, typing or
// pasting into a terminal (Send to Agent), opening find in it. Panes go by
// their key in the layout (term/layout.ts paneKey): a terminal's address,
// code:<id>, preview:<id>. What a plugin draws over a terminal's pane (a
// surface, plugins/api.ts terminalSurfaces) may take the pane's focus
// (useSurfaceFocus): while it is registered, the pane is focused through it
// (withView), and the terminal itself is still the one typed and pasted
// into (paneHandle, withPane).
import { useLayoutEffect, useRef } from 'react';

/** What every pane on screen offers. */
export interface ViewHandle {
  focus(): void;
}

/** A terminal on screen. */
export interface PaneHandle extends ViewHandle {
  /** Types text as an input method commits it. */
  type(text: string): void;
  /** Pastes text; bracketed when the program asked for that. */
  paste(text: string): void;
  /** Opens find, with the selected text as the query. */
  openFind(): void;
  /** The rows on screen as text (tests and the debug handle). */
  screenText(): string;
}

const panes = new Map<string, ViewHandle>();
const surfaces = new Map<string, ViewHandle>();
/** Callers waiting for a pane to be on screen: for any view of it, or for
 * its terminal. */
type Waiter = { fn: (h: ViewHandle) => void; terminal: boolean };
const waiting = new Map<string, Waiter[]>();

const key = (m: string, pane: string) => `${m}\n${pane}`;
const isTerminal = (h: ViewHandle | undefined): h is PaneHandle => !!h && 'paste' in h;

/** Calls the waiters of k that take (h), leaving the others waiting. */
function release(k: string, take: (w: Waiter) => ViewHandle | undefined) {
  const list = waiting.get(k);
  if (!list) return;
  const called: Array<[Waiter, ViewHandle]> = [];
  const rest = list.filter((w) => {
    const h = take(w);
    if (h) called.push([w, h]);
    return !h;
  });
  if (rest.length) waiting.set(k, rest);
  else waiting.delete(k);
  for (const [w, h] of called) w.fn(h);
}

/** A pane on screen registers itself; returns a function that removes it. */
export function registerPane(m: string, pane: string, h: ViewHandle | PaneHandle): () => void {
  const k = key(m, pane);
  panes.set(k, h);
  // Every waiter is done: one for the terminal gets nothing from a pane
  // of another kind (withPane).
  release(k, (w) => (w.terminal ? h : undefined));
  // One for any view of a terminal's pane gets what draws over it, also
  // when that registers in the same commit after the terminal (a surface's
  // passive effect runs after those of the terminal before it): once the
  // commit's effects ran, which React runs together.
  if (isTerminal(h) && !surfaces.has(k)) queueMicrotask(() => release(k, (w) => (w.terminal ? undefined : viewOf(k))));
  else release(k, () => surfaces.get(k) ?? h);
  return () => {
    if (panes.get(k) === h) panes.delete(k);
  };
}

/** What focuses a pane: what draws over it when something does, else the pane. */
const viewOf = (k: string): ViewHandle | undefined => surfaces.get(k) ?? panes.get(k);

/** What a plugin draws over a terminal's pane registers itself as what
 * focuses the pane; returns a function that removes it. Surfaces register
 * with useSurfaceFocus. */
export function registerSurface(m: string, pane: string, h: ViewHandle): () => void {
  const k = key(m, pane);
  surfaces.set(k, h);
  release(k, (w) => (w.terminal ? undefined : h));
  return () => {
    if (surfaces.get(k) === h) surfaces.delete(k);
  };
}

/** A surface (plugins/api.ts TerminalSurfaceDef) takes its terminal's
 * pane's focus while it is mounted and handle is given: registered in a
 * layout effect, before the terminal mounted in the same commit registers
 * in its passive one, so a caller waiting for the pane (withView: a new
 * pane focused) gets the surface rather than the terminal under it. The
 * handle may change from render to render; undefined: the surface does not
 * take the focus. */
export function useSurfaceFocus(m: string, terminal: string, handle: ViewHandle | undefined): void {
  const current = useRef(handle);
  current.current = handle;
  const takes = !!handle;
  useLayoutEffect(() => {
    if (!takes) return;
    return registerSurface(m, terminal, { focus: () => current.current?.focus() });
  }, [m, terminal, takes]);
}

/** What draws over a terminal's pane and takes its focus, if anything does. */
export function surfaceHandle(m: string, terminal: string): ViewHandle | undefined {
  return surfaces.get(key(m, terminal));
}

/** The terminal of an address on screen. */
export function paneHandle(m: string, terminal: string): PaneHandle | undefined {
  const h = panes.get(key(m, terminal));
  return isTerminal(h) ? h : undefined;
}

function dropWaiter(k: string, fn: (h: ViewHandle) => void) {
  const rest = (waiting.get(k) ?? []).filter((w) => w.fn !== fn);
  if (rest.length) waiting.set(k, rest);
  else waiting.delete(k);
}

function wait(k: string, w: Waiter, ms: number) {
  waiting.set(k, [...(waiting.get(k) ?? []), w]);
  setTimeout(() => dropWaiter(k, w.fn), ms);
}

/** Runs fn with a pane once it is on screen (a new pane mounts on the next
 * render): what draws over it when something does, else the pane itself;
 * gives up after ms. */
export function withView(m: string, pane: string, fn: (h: ViewHandle) => void, ms = 5000) {
  const k = key(m, pane);
  const h = surfaces.get(k) ?? panes.get(k);
  if (h) return fn(h);
  wait(k, { fn, terminal: false }, ms);
}

/** Runs fn with a terminal once it is on screen; gives up after ms. */
export function withPane(m: string, terminal: string, fn: (h: PaneHandle) => void, ms = 5000) {
  const k = key(m, terminal);
  const h = panes.get(k);
  if (h) {
    if (isTerminal(h)) fn(h);
    return;
  }
  wait(k, { fn: (x) => isTerminal(x) && fn(x), terminal: true }, ms);
}

/** A pane with changes that are not saved (an editor): its file's name, and
 * how to save them (true once saved). */
export interface UnsavedGuard {
  name: string;
  save(): Promise<boolean>;
}

const guards = new Map<string, UnsavedGuard>();
const unsavedListeners = new Set<() => void>();

/** Marks a pane as having unsaved changes (guard) or none (undefined). */
export function setUnsaved(m: string, pane: string, guard: UnsavedGuard | undefined) {
  const had = guards.has(key(m, pane));
  if (guard) guards.set(key(m, pane), guard);
  else guards.delete(key(m, pane));
  if (had !== !!guard) for (const fn of unsavedListeners) fn();
}

/** Calls fn when a pane gains or loses unsaved changes; returns a
 * function that stops it. */
export function onUnsavedChange(fn: () => void): () => void {
  unsavedListeners.add(fn);
  return () => unsavedListeners.delete(fn);
}

/** Every pane of the page with unsaved changes: its machine and key. */
export function allUnsaved(): (UnsavedGuard & { m: string; pane: string })[] {
  return [...guards].map(([k, g]) => {
    const [m, pane] = k.split('\n');
    return { ...g, m, pane };
  });
}

/** The panes of m among panes with unsaved changes. */
export function unsavedPanes(m: string, panes: readonly string[]): UnsavedGuard[] {
  return panes.flatMap((p) => guards.get(key(m, p)) ?? []);
}

/** Whether any pane on the page has unsaved changes. */
export const anyUnsaved = () => guards.size > 0;
