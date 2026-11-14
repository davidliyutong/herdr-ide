// The desktop app's bridge (shell.ts) and its direct shortcuts: the shell
// takes single-stroke bindings of the keybindings (Cmd+T…) before the page
// and every frame in it, and asks the page to run their command; in a
// browser there is no bridge and none of this is active. The shell reads the
// bindings from the core; the page tells it when they change.

import { runCommand } from './keymap';
import { useKeys } from './keybindings';
import { desktopShell } from './shell';

export { desktopShell, type DesktopShell } from './shell';

/** Runs a command of a shortcut the shell took. Nothing runs while a dialog
 * is open (settings, confirmations, the palette…) except bindings meant for
 * everywhere: the key belongs to the dialog. Closing a tab asks first unless
 * its panes only have shells waiting at their prompt (actions.closeTab). */
export function runShortcut(command: string) {
  const k = useKeys.getState();
  const when = k.effective.find((b) => b.command === command)?.when ?? k.commands.find((c) => c.id === command)?.when;
  if (document.querySelector('.modal-backdrop, .palette-backdrop') && when !== 'always' && when !== 'dialog') return;
  runCommand(command);
}

/** Runs the shell's shortcuts and tells it when the bindings change;
 * returns a function that stops it. */
export function initDesktop(): () => void {
  if (!desktopShell) return () => {};
  const shell = desktopShell;
  const off = shell.onShortcut(runShortcut);
  const offKeys = useKeys.subscribe((s, prev) => {
    if (s.effective !== prev.effective) shell.shortcutsChanged();
  });
  return () => {
    off();
    offKeys();
  };
}
