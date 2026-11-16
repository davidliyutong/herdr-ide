// Closing the main window (also quitting) while its page has panes with
// unsaved changes: the page asks the user itself, listing the files with
// where each is and a way to show each, and answers. The window stays
// until then. The page's answer never waives an objection to unloading:
// once the page answered Close it withdraws its own, and any other frame's
// (a VS Code window's) still gets the native question
// (will-prevent-unload). A page that does not take the question within
// ACK_MS (one that hangs), or a second close or quit while the page asks
// (a page that does not answer), goes to that native question at once.
// A system shutdown never waits.

/** How long the page has to say it shows the question. */
export const ACK_MS = 3000;

/** What the page answers: it shows the question, the window may close
 * (saved, or Don't Save), or it stays (Cancel, Show). */
export type CloseAnswer = 'asking' | 'close' | 'stay';

export function isCloseAnswer(v: unknown): v is CloseAnswer {
  return v === 'asking' || v === 'close' || v === 'stay';
}

/** The page's count of panes with unsaved changes, when it is one:
 * an integer from 0 to 10000. */
export function parseUnsaved(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10000 ? v : undefined;
}

export interface CloseGuardHost {
  /** Asks the page (channels.closeRequest), with the window in front. */
  ask(): void;
  /** Closes the window again (unless it is gone). */
  close(): void;
  /** The close was cancelled: a quit that waited on it does not go on. */
  cancelled(): void;
  setTimer(fn: () => void, ms: number): () => void;
}

export interface CloseGuard {
  /** The page's count of panes with unsaved changes. */
  setUnsaved(n: number): void;
  /** The window's close event: true lets it close now (on to the page's
   * objection to unloading, if any); false prevents it while the page
   * asks. A shutdown is never held. */
  onClose(shutdown?: boolean): boolean;
  /** The page's answer to the question. */
  answer(a: CloseAnswer): void;
  /** The page is gone or another one loaded: nothing it said holds, and a
   * quit waiting on its answer does not go on. */
  reset(): void;
}

export function closeGuard(host: CloseGuardHost): CloseGuard {
  let unsaved = 0;
  let asking = false;
  let acked = false;
  // The next close goes through: the page answered Close, or it did not
  // take the question (the native question decides).
  let through = false;
  let stopTimer: (() => void) | undefined;
  const stop = () => {
    stopTimer?.();
    stopTimer = undefined;
  };
  return {
    setUnsaved(n) {
      unsaved = n;
    },
    onClose(shutdown = false) {
      if (shutdown || unsaved === 0) return true;
      if (through) {
        through = false;
        return true;
      }
      if (asking) {
        // Closed again while the page asks: the native question, which the
        // page cannot hold.
        asking = false;
        stop();
        return true;
      }
      asking = true;
      acked = false;
      host.ask();
      stopTimer = host.setTimer(() => {
        stopTimer = undefined;
        if (!asking || acked) return;
        asking = false;
        through = true;
        host.close();
      }, ACK_MS);
      return false;
    },
    answer(a) {
      if (!asking) return;
      if (a === 'asking') {
        acked = true;
        stop();
        return;
      }
      asking = false;
      stop();
      if (a === 'close') {
        through = true;
        host.close();
      } else host.cancelled();
    },
    reset() {
      stop();
      if (asking) host.cancelled();
      unsaved = 0;
      asking = acked = through = false;
    },
  };
}
