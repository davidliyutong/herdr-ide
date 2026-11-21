// Keys an input method takes while it composes (Enter that commits the
// letters typed as they are, Escape that drops them, the arrows among its
// candidates) are its own: a field's Enter must not save, and a shortcut
// must not run, on the key that only ended a composition. Browsers report
// such a keydown as composing, or with the key code 229.

type Composing = Pick<KeyboardEvent, 'isComposing' | 'keyCode'>;

/** Whether a keydown belongs to an input method. */
export const imeKey = (e: Composing) => e.isComposing || e.keyCode === 229;

/** Whether the page's own text fields are where the key went. Terminals
 * (vt/pane.ts) and editors with their own input handling see every key. */
function plainField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return false;
  return !target.closest('.term-host, .monaco-editor');
}

/** Keeps an input method's keys in the page's text fields from every
 * handler of the page; what the browser does with them stays. Returns a
 * function that ends it. */
export function guardImeKeys(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (imeKey(e) && plainField(e.target)) e.stopImmediatePropagation();
  };
  target.addEventListener('keydown', onKey, true);
  return () => target.removeEventListener('keydown', onKey, true);
}
