// The desktop app's menu (desktop/src/menu.ts) sends the page the command of
// an item chosen. Its keys reach the menu only when the page leaves them:
// the page matches every key it sees itself (keymap.ts), as in browsers,
// with the desktop app's bindings, and cancels those it runs. In a browser
// there is no bridge and none of this is active.

import { applies, commandEnabled, keyContext, runCommand, type KeyContext } from './keymap';
import { useKeys } from './keybindings';
import { desktopShell } from './shell';
import { useStore } from './state/store';
import { useTerms } from './state/terms';
import { useDialog } from './dialog';
import { useSettings } from './settings';

export { desktopShell, type DesktopShell } from './shell';

/** Where the keyboard is: a dialog, VS Code's panel or the main UI. */
function menuContext(): KeyContext {
  if (keyContext() === 'dialog') return 'dialog';
  return document.activeElement?.classList.contains('code-frame') ? 'vscode' : 'terminal';
}

/** Runs a command of the menu: while a dialog or the palette is open only
 * commands for dialogs or everywhere run, and while VS Code has the
 * keyboard only those for VS Code or everywhere (a key VS Code left goes no
 * further). Closing a tab asks first unless its panes only have shells
 * waiting at their prompt (actions.closeTab). */
export function runMenuCommand(command: string) {
  const when = useKeys.getState().commands.find((c) => c.id === command)?.when ?? 'terminal';
  const ctx = menuContext();
  if (ctx !== 'terminal' && !applies(when, ctx)) return;
  runCommand(command);
}

/** The commands the menu shows disabled: those that cannot run now, and
 * while a dialog or the palette is open those for the main UI. */
export function disabledCommands(): string[] {
  const s = useStore.getState();
  const dialog = !!(s.settings || s.palette || s.addMachine || s.auth || useDialog.getState().current);
  return useKeys
    .getState()
    .commands.filter((c) => (dialog && !applies(c.when, 'dialog')) || !commandEnabled(c.id))
    .map((c) => c.id);
}

/** Runs the menu's commands and keeps its items' enabled states current;
 * returns a function that stops it. */
export function initDesktop(): () => void {
  const shell = desktopShell;
  if (!shell) return () => {};
  const off = shell.onCommand(runMenuCommand);
  let last = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const list = disabledCommands();
      const key = list.join(' ');
      if (key === last) return;
      last = key;
      shell.setDisabledCommands(list);
    }, 50);
  };
  // The zoom's items depend on the zoom (settings).
  const subs = [
    useStore.subscribe(update),
    useTerms.subscribe(update),
    useDialog.subscribe(update),
    useKeys.subscribe(update),
    useSettings.subscribe(update),
  ];
  update();
  return () => {
    off();
    clearTimeout(timer);
    for (const u of subs) u();
  };
}
