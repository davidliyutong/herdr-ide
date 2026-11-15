// The desktop app's menu (desktop/src/menu.ts) sends the page the command of
// an item chosen. Its keys reach the menu only when the page leaves them:
// the page matches every key it sees itself (keymap.ts), as in browsers,
// with the desktop app's bindings, and cancels those it runs. In a browser
// there is no bridge and none of this is active.

import { applies, keyContext, runCommand, type KeyContext } from './keymap';
import { useKeys } from './keybindings';
import { desktopShell } from './shell';

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

/** Runs the menu's commands; returns a function that stops it. */
export function initDesktop(): () => void {
  return desktopShell?.onCommand(runMenuCommand) ?? (() => {});
}
