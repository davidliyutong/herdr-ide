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
