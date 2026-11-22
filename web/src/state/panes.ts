// The panes on screen, for commands that act on one: focusing it, typing or
// pasting into a terminal (Send to Agent), opening find in it. Panes go by
// their key in the layout (term/layout.ts paneKey): a terminal's address,
// code:<id>, preview:<id>.

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
const waiting = new Map<string, Array<(h: ViewHandle) => void>>();

const key = (m: string, pane: string) => `${m}\n${pane}`;
const isTerminal = (h: ViewHandle | undefined): h is PaneHandle => !!h && 'paste' in h;

/** A pane on screen registers itself; returns a function that removes it. */
export function registerPane(m: string, pane: string, h: ViewHandle | PaneHandle): () => void {
  const k = key(m, pane);
  panes.set(k, h);
  const w = waiting.get(k);
  waiting.delete(k);
  for (const fn of w ?? []) fn(h);
  return () => {
    if (panes.get(k) === h) panes.delete(k);
  };
}

/** The terminal of an address on screen. */
export function paneHandle(m: string, terminal: string): PaneHandle | undefined {
  const h = panes.get(key(m, terminal));
  return isTerminal(h) ? h : undefined;
}

/** Runs fn with a pane once it is on screen (a new pane mounts on the next
 * render); gives up after ms. */
export function withView(m: string, pane: string, fn: (h: ViewHandle) => void, ms = 5000) {
  const h = panes.get(key(m, pane));
  if (h) return fn(h);
  const k = key(m, pane);
  const list = waiting.get(k) ?? [];
  list.push(fn);
  waiting.set(k, list);
  setTimeout(() => {
    const l = waiting.get(k);
    if (!l) return;
    const rest = l.filter((x) => x !== fn);
    if (rest.length) waiting.set(k, rest);
    else waiting.delete(k);
  }, ms);
}

/** Runs fn with a terminal once it is on screen; gives up after ms. */
export function withPane(m: string, terminal: string, fn: (h: PaneHandle) => void, ms = 5000) {
  withView(m, terminal, (h) => isTerminal(h) && fn(h), ms);
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
