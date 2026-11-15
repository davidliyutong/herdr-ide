// Programs writing the clipboard (OSC 52) and the setting that decides what
// happens (terminal.programClipboard): "auto" copies at once right after
// the user's own input to a terminal, else asks with a toast; "ask" always
// asks; "off" ignores them. Output is not trusted, so a copy without such
// input never reaches the clipboard on its own.

import { useStore, type ToastAction } from '../state/store';
import { getPrefs } from '../prefs';
import { t } from '../i18n';

/** A program's clipboard write is copied without asking when it arrives
 * this soon after the user's input: the program answers the user's own
 * selection or command, even over a slow link. */
export const CLIP_AUTO_MS = 10_000;

/** How long a program's copy stays available to the menu's Copy. */
export const PROGRAM_CLIP_MS = 120_000;

/** When this page last sent a terminal a key, text, paste or button press. */
let lastInput = 0;

/** The text a program of machine `m` copied in answer to the user (a copy
 * that passed the automatic gate, also one the browser refused): the
 * program, not the page, holds that selection (Claude Code, Codex, tmux), so
 * the menu's Copy and ⌘C copy this text. The next key or button press in a
 * terminal ends it, as it ends the program's selection, and so does
 * PROGRAM_CLIP_MS. */
let programClip: { text: string; m: string; at: number } | undefined;

/** Records the user's input to a terminal (keys, text, pastes, button presses). */
export function userInput() {
  lastInput = Date.now();
  programClip = undefined;
}

/** The program's copy for the menu's Copy and ⌘C on machine m. */
export function programClipboard(m: string): string | undefined {
  const c = programClip;
  return c && c.m === m && Date.now() - c.at <= PROGRAM_CLIP_MS ? c.text : undefined;
}

export function forgetProgramClipboard() {
  programClip = undefined;
}

let clipToast: number | undefined;

/** Shows a clipboard toast in place of the previous one: programs that copy
 * on every selection leave one toast, not a pile. */
function showClipToast(msg: string, action?: ToastAction, ttl?: number) {
  const prev = clipToast;
  if (prev !== undefined) useStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== prev) }));
  clipToast = useStore.getState().toast(msg, action, ttl);
}

function clipPreview(text: string): string {
  return (text.length > 60 ? `${text.slice(0, 60)}…` : text).replace(/\s+/g, ' ');
}

/** Says that the program's copy went on the clipboard (⌘C, menu Copy). */
export function programClipboardCopied(text: string) {
  showClipToast(t('surface.copied', { n: text.length, text: clipPreview(text) }), undefined, 2000);
}

/** A program of machine m wrote the clipboard. Returns whether the page
 * takes it (it is copied now or offered in a toast). */
export function programCopied(m: string, text: string): boolean {
  const mode = getPrefs().programClipboard;
  if (!text || mode === 'off') return false;
  const preview = clipPreview(text);
  const ask = () =>
    showClipToast(t('surface.clipboard', { n: text.length, text: preview }), {
      label: t('surface.copy'),
      ttl: 5000,
      run: () => void navigator.clipboard?.writeText(text).catch(() => {}),
    });
  if (mode !== 'auto' || Date.now() - lastInput > CLIP_AUTO_MS) {
    ask();
    return true;
  }
  programClip = { text, m, at: Date.now() };
  if (!navigator.clipboard?.writeText) {
    ask();
    return true;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => showClipToast(t('surface.copied', { n: text.length, text: preview }), undefined, 2000), ask);
  return true;
}
