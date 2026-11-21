// Files of editor panes that are gone from their machines (deleted, or
// moved away), for the mark on the panes' titles (the editor's useGone,
// PaneViewDef.useGone): struck through in their headers and tabs, as VS
// Code marks the editors of deleted files. The paths the titles drawn name
// (the tabs of the workspace shown, the panes' headers) are checked
// together, one request per machine, every CHECK_MS while the page is
// visible and any is drawn; an editor pane tells what its own checks and
// saves see at once, and so do the explorer's changes (recheckGone). A
// path whose state is not known (a stat that failed) keeps its mark.

import { useEffect } from 'react';
import { create } from 'zustand';
import { filesApi } from './api';
import { startPolling } from './poller';

/** How often the paths of the titles drawn are checked. */
export const GONE_CHECK_MS = 5000;
/** The paths of one machine checked in one request (the core's limit). */
const MAX_PATHS = 200;

const key = (m: string, path: string) => `${m}\n${path}`;

/** The paths gone, by machine and path (key). */
export const useGoneFiles = create<{ gone: Record<string, true> }>(() => ({ gone: {} }));

/** How many titles name each path. */
const watched = new Map<string, number>();
let stopPolling: (() => void) | undefined;

/** Records whether path is on machine m now. */
export function noteFile(m: string, path: string, exists: boolean) {
  const k = key(m, path);
  const { gone } = useGoneFiles.getState();
  if (!exists === !!gone[k]) return;
  const next = { ...gone };
  if (exists) delete next[k];
  else next[k] = true;
  useGoneFiles.setState({ gone: next });
}

/** Checks every path watched now (the explorer changed files). */
export async function recheckGone(): Promise<void> {
  const byMachine = new Map<string, string[]>();
  for (const k of watched.keys()) {
    // A machine's id has no newline; a path may.
    const at = k.indexOf('\n');
    const m = k.slice(0, at);
    byMachine.set(m, [...(byMachine.get(m) ?? []), k.slice(at + 1)]);
  }
  const asked = [...byMachine].flatMap(([m, paths]) => {
    const out: Array<Promise<void>> = [];
    for (let i = 0; i < paths.length; i += MAX_PATHS) {
      out.push(
        filesApi.stat(m, paths.slice(i, i + MAX_PATHS)).then((entries) => {
          for (const e of entries) if (!e.error && watched.has(key(m, e.path))) noteFile(m, e.path, e.exists);
        }),
      );
    }
    return out;
  });
  const failed = (await Promise.allSettled(asked)).find((r) => r.status === 'rejected');
  // A machine that did not answer: the next check waits longer (poller.ts).
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

/** Follows path of machine m while the returned function is not called. */
export function watchFile(m: string, path: string): () => void {
  const k = key(m, path);
  watched.set(k, (watched.get(k) ?? 0) + 1);
  stopPolling ??= startPolling(GONE_CHECK_MS, recheckGone);
  return () => {
    const n = (watched.get(k) ?? 1) - 1;
    if (n > 0) return void watched.set(k, n);
    watched.delete(k);
    const { gone } = useGoneFiles.getState();
    if (gone[k]) {
      const next = { ...gone };
      delete next[k];
      useGoneFiles.setState({ gone: next });
    }
    if (!watched.size) {
      stopPolling?.();
      stopPolling = undefined;
    }
  };
}

/** Whether the file at path of machine m is gone, following it while the
 * calling component is drawn. A React hook. */
export function useFileGone(m: string, path: string): boolean {
  useEffect(() => (m && path ? watchFile(m, path) : undefined), [m, path]);
  return useGoneFiles((s) => !!path && !!s.gone[key(m, path)]);
}
