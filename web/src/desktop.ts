// The desktop app's menu (desktop/src/menu.ts) sends the page the command of
// an item chosen. Its keys reach the menu only when the page leaves them:
// the page matches every key it sees itself (keymap.ts), as in browsers,
// with the desktop app's bindings, and cancels those it runs. In a browser
// there is no bridge and none of this is active.

import { applies, commandEnabled, keyContext, runCommand, type KeyContext } from './keymap';
import { useKeys } from './keybindings';
import { desktopShell, type DesktopShell } from './shell';
import { useStore } from './state/store';
import { terms, useTerms } from './state/terms';
import { focusedFrame, useFrames } from './codeFrames';
import * as L from './term/layout';
import { useDialog } from './dialog';
import { useSettings } from './settings';
import { currentZoom } from './zoom';

/** Where the keyboard is: a dialog, a VS Code pane or the main UI. */
function menuContext(): KeyContext {
  if (keyContext() === 'dialog') return 'dialog';
  return document.activeElement?.classList.contains('code-frame') ? 'vscode' : 'terminal';
}

/** Runs a command of the menu: while a dialog or the palette is open only
 * commands for dialogs or everywhere run; while a VS Code pane has the
 * keyboard the main UI's commands act on that pane (keymap.ts applies), so
 * cmd+w, which VS Code leaves, closes it. Closing a tab asks first unless
 * its panes only have shells waiting at their prompt (actions.closeTab). */
export function runMenuCommand(command: string) {
  const when = useKeys.getState().commands.find((c) => c.id === command)?.when ?? 'terminal';
  const ctx = menuContext();
  if (ctx !== 'terminal' && !applies(when, ctx)) return;
  // The pane whose VS Code has the keyboard is the focused one, also when
  // its focus event has not reached the layout yet.
  const frame = focusedFrame();
  const fr = frame ? useFrames.getState().frames[frame] : undefined;
  if (fr) terms.mutate(fr.m, (l) => L.focusPane(l, L.codeKey(fr.id)));
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

/** Applies the desktop shell's integrated title bar attributes and CSS
 * geometry variables to :root (no-op in browsers and on platforms with a
 * native window frame). Called before the first paint and whenever zoom
 * changes. */
export function applyTitlebar(shell: DesktopShell | undefined = desktopShell) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const tb = shell?.titlebar;
  if (!tb) {
    delete root.dataset.titlebar;
    delete root.dataset.fullscreen;
    root.style.removeProperty('--titlebar-inset-px');
    root.style.removeProperty('--titlebar-min-h-px');
    root.style.removeProperty('--titlebar-top-px');
    root.style.removeProperty('--desktop-zoom');
    return;
  }
  root.dataset.titlebar = tb.kind;
  root.style.setProperty('--titlebar-inset-px', `${tb.inset}px`);
  root.style.setProperty('--titlebar-min-h-px', `${tb.minHeight}px`);
  root.style.setProperty('--titlebar-top-px', `${tb.topSpace}px`);
  root.style.setProperty('--desktop-zoom', String(currentZoom() / 100));
}

/** Runs the menu's commands and keeps its items' enabled states current;
 * returns a function that stops it. */
export function initDesktop(shell: DesktopShell | undefined = desktopShell): () => void {
  applyTitlebar(shell);
  if (!shell) return () => {};
  const off = shell.onCommand(runMenuCommand);
  const offFullScreen = shell.titlebar?.onFullScreen((full) => {
    if (full) document.documentElement.dataset.fullscreen = 'true';
    else delete document.documentElement.dataset.fullscreen;
  });
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
  // The zoom's items and the integrated title bar's CSS inset depend on settings.
  const subs = [
    useStore.subscribe(update),
    useTerms.subscribe(update),
    useDialog.subscribe(update),
    useKeys.subscribe(update),
    useSettings.subscribe(() => {
      applyTitlebar(shell);
      update();
    }),
  ];
  update();
  return () => {
    off();
    offFullScreen?.();
    clearTimeout(timer);
    for (const u of subs) u();
  };
}
