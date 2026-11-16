// The save chord of the editor panes (the file explorer's and the Git diff's).
//
// Monaco's addCommand registers a keybinding in a service all editors share,
// where the editor created last wins for every one of them, so each editor
// listens to its own key events instead. Keys pressed in the pane outside
// Monaco (its toolbar, a banner) are caught on the pane's root element; the
// chord is never bound app-wide, Ctrl+S keeps reaching terminals.

import { isMac } from '../keys';

/** The save chord as the DOM reports it: Cmd+S on macOS, Ctrl+S elsewhere. */
export function isSaveChord(ev: KeyboardEvent, mac = isMac): boolean {
  const mod = mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey;
  return mod && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === 's';
}

/**
 * Handlers that run `save` on the chord, one pair per pane. A save that is
 * running is not started again, nor by a held key.
 */
export function saveHandlers(save: () => Promise<unknown> | void) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await save();
    } finally {
      busy = false;
    }
  };
  return {
    /** For editor.onKeyDown: `chord` is KeyMod.CtrlCmd | KeyCode.KeyS. */
    editor(
      e: { equals(k: number): boolean; browserEvent: { repeat: boolean }; preventDefault(): void; stopPropagation(): void },
      chord: number,
    ) {
      if (!e.equals(chord)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.browserEvent.repeat) void run();
    },
    /** For the pane's root element: keys Monaco did not take. */
    root(ev: { nativeEvent: KeyboardEvent; defaultPrevented: boolean; target: EventTarget; preventDefault(): void }) {
      const k = ev.nativeEvent;
      if (ev.defaultPrevented || !isSaveChord(k)) return;
      if (ev.target instanceof Element && ev.target.closest('.monaco-editor')) return;
      ev.preventDefault();
      if (!k.repeat) void run();
    },
  };
}
