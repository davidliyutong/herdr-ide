// Routing of key events in panes. Every key that reaches a pane goes through
// routeKey; the expected bytes per key are pinned in
// src/__tests__/testdata/keys.json (see docs/features/03).

/**
 * Bytes for a keydown that panes encode differently from xterm.js, or
 * undefined to let xterm.js encode it.
 */
export function overrideKey(ev: KeyboardEvent): string | undefined {
  if (ev.type !== 'keydown' || ev.isComposing || ev.keyCode === 229) return;
  // Shift+Enter inserts a newline in Claude Code / Codex prompts, like Alt+Enter.
  if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) return '\x1b\r';
}

/**
 * Custom key handler for xterm.js: true lets xterm.js encode the event, false
 * keeps it from xterm.js. An event taken from xterm.js is either cancelled
 * (consumed by the app keymap or sent here) or left to the browser (Cmd
 * shortcuts). It must be cancelled when consumed: an uncancelled keydown is
 * followed by a keypress, which xterm.js turns into a second character.
 */
export function routeKey(ev: KeyboardEvent, appKey: (ev: KeyboardEvent) => boolean, send: (data: string) => void): boolean {
  if (appKey(ev)) return consume(ev);
  const seq = overrideKey(ev);
  if (seq !== undefined) {
    send(seq);
    return consume(ev);
  }
  // Leave Cmd shortcuts (copy, paste, ...) to the browser.
  if (ev.metaKey) return false;
  return true;
}

function consume(ev: KeyboardEvent): false {
  ev.preventDefault();
  return false;
}
