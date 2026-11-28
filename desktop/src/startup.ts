// Coordinates parallel desktop startup: the main process spawns the hub
// executable and creates the hidden BrowserWindow at the same time so Chromium
// renderer boot overlaps hub boot, while guaranteeing the window is shown only
// once both the hub is ready and the window painted, and never flashed if the
// hub fails to start.
import type { Binding } from './menu';

export interface StartupGate {
  readonly serving: boolean;
  /** Marks the hub as ready; reveals the window if it already painted. */
  hubReady(): void;
  /** Marks the window as ready-to-show; reveals it if the hub is ready. */
  windowReady(): void;
  /** Prevents any future reveal (quit or startup error). */
  abort(): void;
}

/** Coordinates hub readiness and BrowserWindow ready-to-show so show() runs at
 * most once, only after both signals arrive and neither quit nor failure
 * aborted startup. */
export function startupGate(show: () => void): StartupGate {
  let serving = false;
  let painted = false;
  let shown = false;
  let aborted = false;
  const maybeShow = () => {
    if (aborted || shown || !serving || !painted) return;
    shown = true;
    show();
  };
  return {
    get serving() {
      return serving;
    },
    hubReady() {
      if (aborted) return;
      serving = true;
      maybeShow();
    },
    windowReady() {
      if (aborted) return;
      painted = true;
      maybeShow();
    },
    abort() {
      aborted = true;
    },
  };
}

/** Whether two keybinding lists are identical in order and fields, so
 * applyBindings skips rebuilding the native application menu on boot when the
 * hub reports the built-in defaults already applied. */
export function sameBindings(a: readonly Binding[], b: readonly Binding[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.key !== y.key || x.command !== y.command || x.when !== y.when) return false;
  }
  return true;
}
