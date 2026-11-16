// Changes not saved in panes that edit files (the file explorer's editor, a
// Git diff's working tree): closing such a pane, its tab or its workspace
// asks first, and leaving the page warns. A pane's component unmounts while
// its pane stays in the layout (another tab, workspace or machine shown,
// another pane zoomed, its plugin turned off): its unsaved text is kept
// (keepEdit), still asked about, until the pane comes back and takes it,
// the pane leaves its machine's layout, or it is saved.
import { useEffect, useRef } from 'react';
import { setUnsaved, unsavedPanes, anyUnsaved } from './state/panes';
import { useTerms } from './state/terms';
import { useStore } from './state/store';
import * as L from './term/layout';
import { saveChangesDialog } from './dialog';
import { t } from './i18n';

/** Text with unsaved changes whose pane's component is not mounted. */
export interface KeptEdit {
  /** The file's name, for the question before closing. */
  name: string;
  /** Saves the text without the component; true once saved. */
  save(): Promise<boolean>;
  /** Frees what it holds (Monaco's models). */
  dispose(): void;
}

const kept = new Map<string, KeptEdit>();
const keyOf = (m: string, pane: string) => `${m}\n${pane}`;

/** Keeps a pane's unsaved edit when its component unmounts: it stays
 * unsaved (closing asks, its save saves it) until takeEdit or dropEdit. */
export function keepEdit<T extends KeptEdit>(m: string, pane: string, edit: T) {
  const k = keyOf(m, pane);
  const old = kept.get(k);
  if (old && old !== edit) old.dispose();
  kept.set(k, edit);
  setUnsaved(m, pane, {
    name: edit.name,
    save: async () => {
      const ok = await edit.save();
      // Saved: the file has the text, the pane loads it when it comes back.
      if (ok && kept.get(k) === edit) dropEdit(m, pane);
      return ok;
    },
  });
  followLayouts();
}

/** A pane's kept edit, if any. */
export function keptEdit<T extends KeptEdit>(m: string, pane: string): T | undefined {
  return kept.get(keyOf(m, pane)) as T | undefined;
}

/** The pane's component takes its kept edit back when accept finds it its
 * own (the same file); one it does not accept is dropped. The edit stays
 * registered as unsaved until the component registers itself. */
export function takeEdit<T extends KeptEdit>(m: string, pane: string, accept: (e: T) => boolean): T | undefined {
  const e = keptEdit<T>(m, pane);
  if (!e) return undefined;
  if (!accept(e)) {
    dropEdit(m, pane);
    return undefined;
  }
  kept.delete(keyOf(m, pane));
  return e;
}

/** Frees a pane's kept edit and its unsaved mark. */
export function dropEdit(m: string, pane: string) {
  const k = keyOf(m, pane);
  const e = kept.get(k);
  if (!e) return;
  kept.delete(k);
  setUnsaved(m, pane, undefined);
  e.dispose();
}

let unfollow: (() => void) | undefined;

/** Follows the layouts while edits are kept. */
function followLayouts() {
  unfollow ??= useTerms.subscribe((s) => dropGoneEdits(s.machines));
}

/** Drops the kept edits of panes their machine's layout no longer has
 * (closed, their tab or workspace closed) and of machines removed; a
 * machine whose layout is not read (away) keeps them. */
export function dropGoneEdits(machines = useTerms.getState().machines) {
  const known = useStore.getState().machines;
  for (const k of [...kept.keys()]) {
    const [m, pane] = k.split('\n');
    const layout = machines[m]?.layout;
    const removed = !known[m] && Object.keys(known).length > 0;
    if (removed || (layout && !layout.workspaces.some((ws) => ws.tabs.some((tb) => L.tabPanes(tb).includes(pane))))) {
      dropEdit(m, pane);
    }
  }
  if (!kept.size && unfollow) {
    unfollow();
    unfollow = undefined;
  }
}

/** Registers a pane's unsaved changes while dirty; save resolves true once
 * saved. A pane whose edit is kept stays registered when it unmounts. */
export function useUnsaved(m: string, pane: string, dirty: boolean, name: string, save: () => Promise<boolean>) {
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (dirty) setUnsaved(m, pane, { name, save: () => saveRef.current() });
    else if (!keptEdit(m, pane)) setUnsaved(m, pane, undefined);
    return () => {
      if (!keptEdit(m, pane)) setUnsaved(m, pane, undefined);
    };
  }, [m, pane, dirty, name]);
}

/** Before panes close: true to go on (nothing unsaved, saved, or Don't
 * Save), false to keep them (Cancel, or a save that failed). */
export async function confirmUnsaved(m: string, panes: readonly string[]): Promise<boolean> {
  const dirty = unsavedPanes(m, panes);
  if (!dirty.length) return true;
  const answer = await saveChangesDialog({
    title: t('unsaved.title'),
    message:
      dirty.length === 1
        ? t('unsaved.one', { name: dirty[0].name })
        : t('unsaved.many', { n: dirty.length, names: dirty.map((d) => d.name).join(', ') }),
  });
  if (answer === 'cancel') return false;
  if (answer === 'discard') return true;
  for (const d of dirty) if (!(await d.save())) return false;
  return true;
}

/** Leaving or reloading the page with unsaved changes asks the browser's question. */
export function warnOnUnload(): () => void {
  const onUnload = (ev: BeforeUnloadEvent) => {
    if (!anyUnsaved()) return;
    ev.preventDefault();
    ev.returnValue = '';
  };
  window.addEventListener('beforeunload', onUnload);
  return () => window.removeEventListener('beforeunload', onUnload);
}
