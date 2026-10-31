// The terminal font ships with the UI (fonts/README.md), so every browser
// renders panes with the same glyphs and cell metrics whatever is installed.
// xterm.js measures the cell when its font family changes and caches each
// glyph the first time it draws it, so a terminal must not use the font
// before its faces are loaded: it starts with the fallback stack and switches
// once they are (TermController).

import regular from './fonts/JetBrainsMono-Regular.woff2';
import italic from './fonts/JetBrainsMono-Italic.woff2';
import medium from './fonts/JetBrainsMono-Medium.woff2';
import mediumItalic from './fonts/JetBrainsMono-MediumItalic.woff2';
import bold from './fonts/JetBrainsMono-Bold.woff2';
import boldItalic from './fonts/JetBrainsMono-BoldItalic.woff2';

const family = 'JetBrains Mono';

/** Fonts for what the bundled one lacks (CJK, some symbols), and for the
 *  time before it is loaded. */
const fallback = '"SF Mono", Menlo, Monaco, "Cascadia Code", "Fira Code", "Noto Sans Mono CJK SC", "PingFang SC", monospace';

/** Weight of regular text; bold text uses 700. */
export type TermFontWeight = 400 | 500;

const files: Record<string, string> = {
  '400 normal': regular,
  '400 italic': italic,
  '500 normal': medium,
  '500 italic': mediumItalic,
  '700 normal': bold,
  '700 italic': boldItalic,
};

const faces = new Map<string, FontFace>();
const loaded = new Set<TermFontWeight>();

function face(key: string): FontFace | undefined {
  if (typeof FontFace === 'undefined' || !document.fonts) return undefined;
  let f = faces.get(key);
  if (!f) {
    const [weight, style] = key.split(' ');
    f = new FontFace(family, `url("${files[key]}") format("woff2")`, { weight, style });
    document.fonts.add(f);
    faces.set(key, f);
  }
  return f;
}

/** True once the faces terminals of this weight draw with are loaded. */
export function termFontLoaded(weight: TermFontWeight): boolean {
  return loaded.has(weight);
}

/** The font stack for terminals of this weight: the bundled font once
 *  loaded, else only the fallbacks. */
export function termFontFamily(weight: TermFontWeight): string {
  return loaded.has(weight) ? `"${family}", ${fallback}` : fallback;
}

const pending = new Map<TermFontWeight, Promise<boolean>>();

/** Loads the regular and bold faces, upright and italic, for this weight.
 *  Resolves to false when one cannot be loaded (fallbacks stay in use). */
export function loadTermFont(weight: TermFontWeight): Promise<boolean> {
  let p = pending.get(weight);
  if (!p) {
    const keys = [weight, 700].flatMap((w) => [`${w} normal`, `${w} italic`]);
    const fs = keys.map(face);
    p = fs.includes(undefined)
      ? Promise.resolve(false)
      : Promise.all(fs.map((f) => f!.load())).then(
          () => {
            loaded.add(weight);
            return true;
          },
          () => false,
        );
    pending.set(weight, p);
  }
  return p;
}

/** Calls apply once the faces of this weight are loaded, never if they
 *  cannot be; returns a function that cancels. */
export function whenTermFont(weight: TermFontWeight, apply: () => void): () => void {
  let live = true;
  void loadTermFont(weight).then((ok) => {
    if (live && ok) apply();
  });
  return () => {
    live = false;
  };
}
