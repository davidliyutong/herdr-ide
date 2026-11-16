// Changes not saved in panes that edit files (the file explorer's editor, a
// Git diff's working tree): closing such a pane, its tab or its workspace
// asks first, and leaving the page warns.
import { useEffect, useRef } from 'react';
import { setUnsaved, unsavedPanes, anyUnsaved } from './state/panes';
import { saveChangesDialog } from './dialog';
import { t } from './i18n';

/** Registers a pane's unsaved changes while dirty; save resolves true once saved. */
export function useUnsaved(m: string, pane: string, dirty: boolean, name: string, save: () => Promise<boolean>) {
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    setUnsaved(m, pane, dirty ? { name, save: () => saveRef.current() } : undefined);
    return () => setUnsaved(m, pane, undefined);
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
