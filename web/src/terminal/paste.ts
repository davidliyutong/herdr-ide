/** Normalize pasted text the way terminals do and wrap it in bracketed paste
 * markers; herdr re-pastes it according to the pane's own paste mode. */
export function bracketedPaste(text: string): string {
  const body = text.replace(/\r?\n/g, '\r').replace(/\x1b\[20[01]~/g, '');
  return `\x1b[200~${body}\x1b[201~`;
}
