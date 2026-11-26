// The design tokens' sizes (spec/tokens.json `size`) in CSS pixels at the
// UI font size in use, for code that lays out by number (virtual lists),
// where CSS uses the same sizes in rem (--h-row and the others).
import tokens from '../../../spec/tokens.json';
import { usePrefs } from '../prefs';

type SizeName = keyof typeof tokens.size;

/** A size at a UI font size, rounded to whole pixels. */
export function sizePx(name: SizeName, uiFontSize: number): number {
  return Math.round((tokens.size[name] * uiFontSize) / tokens.font.root);
}

/** A size at the UI font size in use; it changes with the setting. */
export function useSize(name: SizeName): number {
  const fs = usePrefs((s) => s.prefs.uiFontSize) || tokens.font.root;
  return sizePx(name, fs);
}
