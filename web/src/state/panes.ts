// The terminals on screen, for commands that act on one: focusing it,
// typing or pasting into it (Send to Agent), opening find in it.

export interface PaneHandle {
  focus(): void;
  /** Types text as an input method commits it. */
  type(text: string): void;
  /** Pastes text; bracketed when the program asked for that. */
  paste(text: string): void;
  /** Opens find, with the selected text as the query. */
  openFind(): void;
  /** The rows on screen as text (tests and the debug handle). */
  screenText(): string;
}

const panes = new Map<string, PaneHandle>();
const waiting = new Map<string, Array<(h: PaneHandle) => void>>();

const key = (m: string, terminal: string) => `${m}\n${terminal}`;

/** A pane on screen registers itself; returns a function that removes it. */
export function registerPane(m: string, terminal: string, h: PaneHandle): () => void {
  const k = key(m, terminal);
  panes.set(k, h);
  const w = waiting.get(k);
  waiting.delete(k);
  for (const fn of w ?? []) fn(h);
  return () => {
    if (panes.get(k) === h) panes.delete(k);
  };
}

export function paneHandle(m: string, terminal: string): PaneHandle | undefined {
  return panes.get(key(m, terminal));
}

/** Runs fn with the pane once it is on screen (a new terminal mounts on the
 * next render); gives up after ms. */
export function withPane(m: string, terminal: string, fn: (h: PaneHandle) => void, ms = 5000) {
  const h = paneHandle(m, terminal);
  if (h) return fn(h);
  const k = key(m, terminal);
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
