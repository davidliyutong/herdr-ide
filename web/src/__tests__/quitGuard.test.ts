// @vitest-environment jsdom
// Closing the desktop app with unsaved changes: the page keeps the shell
// told how many panes have them, and when asked lists the files with
// where each is; Show keeps the app and shows the pane, Save All closes
// once every file is saved, Don't Save closes, Cancel stays.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useDialog, type UnsavedAnswer } from '../dialog';
import { followDesktopClose } from '../quitGuard';
import { setLeaving, warnOnUnload } from '../unsaved';
import { setUnsaved } from '../state/panes';
import { useStore } from '../state/store';
import { terms } from '../state/terms';
import * as L from '../term/layout';
import { actions } from '../actions';
import type { DesktopShell } from '../shell';

function fakeShell() {
  const counts: number[] = [];
  const answers: string[] = [];
  let request: (() => void) | undefined;
  const shell: DesktopShell = {
    onCommand: () => () => {},
    pathForFile: () => '',
    onOpenFolders: () => () => {},
    setDisabledCommands: () => {},
    setUnsaved: (n) => counts.push(n),
    onCloseRequest: (fn) => {
      request = fn;
      return () => (request = undefined);
    },
    answerClose: (a) => answers.push(a),
  };
  return { shell, counts, answers, ask: () => request?.() };
}

/** The question shown, answered with v. */
async function reply(v: UnsavedAnswer) {
  await vi.waitFor(() => expect(useDialog.getState().current?.kind).toBe('unsaved'));
  const req = useDialog.getState().current!;
  if (req.kind !== 'unsaved') throw new Error(req.kind);
  useDialog.setState({ current: undefined });
  req.resolve(v);
  return req.files;
}

describe('closing the desktop app with unsaved changes', () => {
  afterEach(() => {
    setUnsaved('m', 'view:a', undefined);
    setUnsaved('m', 'view:b', undefined);
    setLeaving(false);
    vi.restoreAllMocks();
  });

  it('keeps the shell told how many panes have unsaved changes', () => {
    const f = fakeShell();
    const off = followDesktopClose(f.shell);
    setUnsaved('m', 'view:a', { name: 'a.go', save: async () => true });
    setUnsaved('m', 'view:a', { name: 'a.go', save: async () => true }); // no change
    setUnsaved('m', 'view:b', { name: 'b.go', save: async () => true });
    setUnsaved('m', 'view:a', undefined);
    off();
    setUnsaved('m', 'view:b', undefined);
    expect(f.counts).toEqual([0, 1, 2, 1]);
  });

  it('lists the files with where each is, and answers by the choice', async () => {
    useStore.setState((s) => ({ machines: { ...s.machines, m: { ...s.machines.m, id: 'm', label: 'box' } as never } }));
    let layout = L.createWorkspace(L.emptyLayout, 'w', 'site', '/srv/site');
    layout = L.openPane(layout, { view: { id: 'a', plugin: 'files', kind: 'editor', path: '/srv/site/a.go' } });
    vi.spyOn(terms, 'layout').mockImplementation((m) => (m === 'm' ? layout : undefined));
    const saveA = vi.fn(async () => true);
    const saveB = vi.fn(async () => false);
    setUnsaved('m', 'view:a', { name: 'a.go', save: saveA });
    setUnsaved('m', 'view:b', { name: 'b.go', save: saveB });
    const f = fakeShell();
    const off = followDesktopClose(f.shell);

    // Cancel: stays.
    f.ask();
    const files = await reply('cancel');
    expect(files).toEqual([
      { name: 'a.go', place: 'box · site · 1' },
      { name: 'b.go', place: 'box' },
    ]);
    await vi.waitFor(() => expect(f.answers).toEqual(['asking', 'stay']));

    // Don't Save: closes, nothing saved.
    f.answers.length = 0;
    f.ask();
    await reply('discard');
    await vi.waitFor(() => expect(f.answers).toEqual(['asking', 'close']));
    expect(saveA).not.toHaveBeenCalled();

    // Save All with a save that fails: stays.
    f.answers.length = 0;
    f.ask();
    await reply('save');
    await vi.waitFor(() => expect(f.answers).toEqual(['asking', 'stay']));
    expect(saveA).toHaveBeenCalledTimes(1);
    expect(saveB).toHaveBeenCalledTimes(1);

    // Show: stays and shows that pane.
    const focus = vi.spyOn(actions, 'focusPane').mockImplementation(() => {});
    f.answers.length = 0;
    f.ask();
    await reply({ show: 0 });
    await vi.waitFor(() => expect(f.answers).toEqual(['asking', 'stay']));
    expect(focus).toHaveBeenCalledWith('m', 'view:a');
    off();
  });

  it('closes once every file is saved, and at once with none left', async () => {
    const save = vi.fn(async () => true);
    setUnsaved('m', 'view:a', { name: 'a.go', save });
    const f = fakeShell();
    const off = followDesktopClose(f.shell);
    f.ask();
    await reply('save');
    await vi.waitFor(() => expect(f.answers).toEqual(['asking', 'close']));
    expect(save).toHaveBeenCalledTimes(1);
    setUnsaved('m', 'view:a', undefined);
    f.answers.length = 0;
    f.ask();
    await vi.waitFor(() => expect(f.answers).toEqual(['asking', 'close']));
    expect(useDialog.getState().current).toBeUndefined();
    off();
  });

  it("withdraws only the page's own objection to unloading, once the user let it close", async () => {
    const objects = () => {
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    const offUnload = warnOnUnload();
    setUnsaved('m', 'view:a', { name: 'a.go', save: async () => true });
    const f = fakeShell();
    const off = followDesktopClose(f.shell);
    expect(objects()).toBe(true);
    f.ask();
    await reply('discard');
    await vi.waitFor(() => expect(f.answers).toEqual(['asking', 'close']));
    expect(objects()).toBe(false);
    // Asked again (the close did not happen: another frame's objection was
    // kept): the page objects again until the user lets it go.
    f.answers.length = 0;
    f.ask();
    expect(objects()).toBe(true);
    await reply('cancel');
    await vi.waitFor(() => expect(f.answers).toEqual(['asking', 'stay']));
    expect(objects()).toBe(true);
    off();
    offUnload();
  });

  it('answers stay when a save throws', async () => {
    setUnsaved('m', 'view:a', {
      name: 'a.go',
      save: async () => {
        throw new Error('offline');
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeShell();
    const off = followDesktopClose(f.shell);
    f.ask();
    await reply('save');
    await vi.waitFor(() => expect(f.answers).toEqual(['asking', 'stay']));
    off();
  });

  it('does nothing without a desktop shell', () => {
    expect(followDesktopClose(undefined)).toBeTypeOf('function');
  });
});
