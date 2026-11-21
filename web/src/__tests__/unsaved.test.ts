// Panes with unsaved changes (editors) ask before they close: Save saves
// them first, Don't Save closes, Cancel and a failed save keep them.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useDialog } from '../dialog';
import { confirmUnsaved } from '../unsaved';
import { anyUnsaved, setUnsaved } from '../state/panes';

/** Answers the dialog shown next. */
async function answer(how: 'save' | 'alt' | 'cancel') {
  await vi.waitFor(() => expect(useDialog.getState().current).toBeDefined());
  const req = useDialog.getState().current!;
  if (req.kind !== 'confirm') throw new Error(req.kind);
  useDialog.setState({ current: undefined });
  req.resolve(how === 'save', undefined, how === 'alt');
}

describe('unsaved changes', () => {
  afterEach(() => {
    setUnsaved('m', 'view:a', undefined);
    setUnsaved('m', 'view:b', undefined);
  });

  it('goes on at once without any', async () => {
    expect(await confirmUnsaved('m', ['view:a', 't1'])).toBe(true);
    expect(useDialog.getState().current).toBeUndefined();
  });

  it('saves, discards or keeps them by the answer', async () => {
    const save = vi.fn(async () => true);
    setUnsaved('m', 'view:a', { name: 'a.go', save });
    expect(anyUnsaved()).toBe(true);

    let p = confirmUnsaved('m', ['view:a']);
    await answer('cancel');
    expect(await p).toBe(false);
    expect(save).not.toHaveBeenCalled();

    p = confirmUnsaved('m', ['view:a']);
    expect((useDialog.getState().current as { message: string }).message).toContain('a.go');
    await answer('alt');
    expect(await p).toBe(true);
    expect(save).not.toHaveBeenCalled();

    p = confirmUnsaved('m', ['view:a']);
    await answer('save');
    expect(await p).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps the panes when a save fails, and names every file', async () => {
    setUnsaved('m', 'view:a', { name: 'a.go', save: async () => true });
    setUnsaved('m', 'view:b', { name: 'b.go', save: async () => false });
    const p = confirmUnsaved('m', ['view:a', 'view:b', 'view:c']);
    const msg = (useDialog.getState().current as { message: string }).message;
    expect(msg).toContain('a.go');
    expect(msg).toContain('b.go');
    await answer('save');
    expect(await p).toBe(false);
    // Another machine's panes are not asked about.
    expect(await confirmUnsaved('other', ['view:a'])).toBe(true);
  });
});
