// Polls of the file explorer (the tree's directories, an editor's file)
// that do not pile up: the next one is planned when the last one ends, so
// a machine slow to answer is never asked twice at once, and after a
// failure the wait doubles (up to MAX_BACKOFF_MS) until one succeeds.
// Nothing runs while the page is hidden.

/** The longest wait between polls after failures. */
export const MAX_BACKOFF_MS = 60_000;

/** Runs poll every ms (more after failures, a rejected promise) while the
 * page is visible, one run at a time; returns the function that stops it. */
export function startPolling(ms: number, poll: () => Promise<unknown>): () => void {
  let stopped = false;
  let wait = ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (document.visibilityState === 'visible') {
      try {
        await poll();
        wait = ms;
      } catch {
        wait = Math.min(wait * 2, Math.max(ms, MAX_BACKOFF_MS));
      }
    }
    if (!stopped) timer = setTimeout(tick, wait);
  };
  timer = setTimeout(tick, ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
