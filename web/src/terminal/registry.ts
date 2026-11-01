// Pane handles for the rest of the UI: focusing a pane and typing or pasting
// into it. Panes are drawn by surface/SurfaceView; input goes to herdr as
// semantic input events.

import { sendInput } from '../surface/session';
import { pasteText } from '../surface/input';

export interface PaneHandle {
  focus(): void;
  /** Types text as if committed by an input method. */
  input(text: string): void;
  /** Pastes text; herdr brackets it if the pane's program asked for that. */
  paste(text: string): void;
}

let focusSurface: (() => void) | undefined;

/** Set by the surface view: moves keyboard focus to it. */
export function setSurfaceFocus(fn: (() => void) | undefined) {
  focusSurface = fn;
}

export function getTerm(m: string, pane: string): PaneHandle {
  return {
    focus: () => focusSurface?.(),
    input: (text) => text && sendInput(m, pane, [{ t: 'text', text }]),
    paste: (text) => text && sendInput(m, pane, [{ t: 'paste', text: pasteText(text) }]),
  };
}
