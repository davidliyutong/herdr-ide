// Closing the desktop app (its main window, or quitting) while panes have
// unsaved changes: the shell asks the page, which lists the files with
// where each is (machine, workspace, tab), so the one left unsaved can be
// found: Show keeps the app open and shows that pane; Save All saves every
// file and closes once all are saved; Don't Save closes; Cancel stays.
// The page keeps the shell told how many panes have unsaved changes; with
// none, the window closes without asking. Browsers have their own question
// (unsaved.ts warnOnUnload).

import { desktopShell, type DesktopShell } from './shell';
import { allUnsaved, onUnsavedChange } from './state/panes';
import { quitDialog } from './dialog';
import { actions, terminalPlace } from './actions';
import { useStore } from './state/store';
import { setLeaving } from './unsaved';

/** Where a pane is, as the question says it: its machine, workspace and tab. */
function placeOf(m: string, pane: string): string {
  const machine = useStore.getState().machines[m]?.label ?? m;
  return [machine, terminalPlace(m, pane)].filter(Boolean).join(' · ');
}

/** Answers the shell's question before the window closes: always, a
 * failure as stay. Once the user let it close, the page withdraws its own
 * objection to unloading; another frame's (a VS Code window's) still gets
 * the shell's native question. */
export async function answerClose(shell: Pick<DesktopShell, 'answerClose'>) {
  setLeaving(false);
  shell.answerClose('asking');
  let answer: 'close' | 'stay' = 'stay';
  let show: { m: string; pane: string } | undefined;
  try {
    answer = await decide((f) => (show = f));
  } catch (e) {
    console.warn(e);
  }
  if (answer === 'close') setLeaving(true);
  shell.answerClose(answer);
  if (show) actions.focusPane(show.m, show.pane);
}

/** What the user chose: close (saved, or Don't Save) or stay (Cancel, a
 * failed save, Show, which calls show with the pane). */
async function decide(show: (f: { m: string; pane: string }) => void): Promise<'close' | 'stay'> {
  const files = allUnsaved();
  if (!files.length) return 'close';
  const answer = await quitDialog(files.map((f) => ({ name: f.name, place: placeOf(f.m, f.pane) })));
  if (answer === 'discard') return 'close';
  if (answer === 'save') {
    for (const f of files) if (!(await f.save())) return 'stay';
    return 'close';
  }
  if (typeof answer === 'object' && files[answer.show]) show(files[answer.show]);
  return 'stay';
}

/** Follows the desktop shell's close requests and keeps it told how many
 * panes have unsaved changes; returns a function that stops it. */
export function followDesktopClose(shell: DesktopShell | undefined = desktopShell): () => void {
  if (!shell?.onCloseRequest || !shell.setUnsaved || !shell.answerClose) return () => {};
  let told = -1;
  const tell = () => {
    const n = allUnsaved().length;
    if (n !== told) shell.setUnsaved((told = n));
  };
  tell();
  const offChange = onUnsavedChange(tell);
  const offRequest = shell.onCloseRequest(() => void answerClose(shell));
  return () => {
    offChange();
    offRequest();
  };
}
