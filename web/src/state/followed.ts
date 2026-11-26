// The machines this browser followed are followed again when the page opens
// (or the app is reopened): each one as soon as it is connected, so its
// workspaces show without "Show Terminals". A machine removed from the hub
// is no longer remembered. Kept per browser (localStorage) under
// FOLLOWED_KEY.

import { loadPref, savePref, useStore, type UIState } from './store';
import { useTerms, type TermModel } from './terms';

export const FOLLOWED_KEY = 'followedMachines';

/** Remembers the machines model follows and follows them again once
 * connected; returns the function that stops it. */
export function rememberFollowed(model: () => TermModel): () => void {
  const saved = new Set(loadPref<string[]>(FOLLOWED_KEY, []).filter((m) => typeof m === 'string'));
  const save = () => savePref(FOLLOWED_KEY, [...saved]);
  const restore = (s: UIState) => {
    for (const m of saved) if (s.machines[m]?.status === 'ready' && !model().isSubscribed(m)) model().subscribe(m);
  };
  const note = () => {
    const before = saved.size;
    for (const m of model().subscribedMachines()) saved.add(m);
    if (saved.size !== before) save();
  };
  restore(useStore.getState());
  note();
  const offStore = useStore.subscribe((s, prev) => {
    let dropped = false;
    for (const m of prev.order) if (!s.machines[m] && prev.machines[m] && saved.delete(m)) dropped = true;
    if (dropped) save();
    restore(s);
  });
  const offTerms = useTerms.subscribe(note);
  return () => {
    offStore();
    offTerms();
  };
}
