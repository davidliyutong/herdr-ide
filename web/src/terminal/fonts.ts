// The terminal font ships with the UI (fonts/README.md), so every browser
// renders panes with the same glyphs and cell metrics whatever is installed.
// The renderer's glyph atlas (vt/atlas.ts) measures the cell from the font
// stack and caches each glyph the first time it draws it, so a terminal must
// not use the font before its faces are loaded: it starts with the fallback
// stack and switches once they are (whenTermFont, TerminalView).

import regular from './fonts/JetBrainsMono-Regular.woff2';
import italic from './fonts/JetBrainsMono-Italic.woff2';
import medium from './fonts/JetBrainsMono-Medium.woff2';
import mediumItalic from './fonts/JetBrainsMono-MediumItalic.woff2';
import bold from './fonts/JetBrainsMono-Bold.woff2';
import boldItalic from './fonts/JetBrainsMono-BoldItalic.woff2';

const family = 'JetBrains Mono';

/** Monospace fallbacks for Latin glyphs before the bundled font is loaded. */
const latinFallback = '"SF Mono", Menlo, Monaco, "Cascadia Code", "Fira Code"';
/** Fallback fonts for CJK glyphs when no custom CJK font is chosen. */
const cjkFallback = '"Noto Sans Mono CJK SC", "PingFang SC", monospace';
/** Fonts for what the bundled one lacks (CJK, some symbols), and for the
 *  time before it is loaded. */
const fallback = `${latinFallback}, ${cjkFallback}`;

/** Default UI sans-serif fallbacks. */
const uiSystemFallback = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Noto Sans CJK SC', sans-serif";
/** Latin-only UI fonts placed ahead of a custom CJK font when no custom
 *  English/Latin UI font is set: on macOS `-apple-system` cascades CJK
 *  internally to PingFang SC before reaching CSS fallbacks after it. */
const uiLatinDefault = "'SF Pro Text', 'SF Pro', 'Segoe UI', 'Helvetica Neue', Arial, 'Liberation Sans', 'Noto Sans'";

/** Weight of regular text; bold text uses 700. */
export type TermFontWeight = 400 | 500;

/** Quotes a single font family name for CSS unless it is already a CSS
 *  font-family list or quoted string. */
export function quoteFontFamily(raw: string): string {
  const own = raw.trim();
  if (!own) return '';
  return /[,"']/.test(own) ? own : `"${own}"`;
}

/** Matches Han ideographs, Kana, Hangul, Bopomofo, CJK punctuation/symbols,
 *  and fullwidth forms so canvas rendering routes CJK glyphs directly to a
 *  configured CJK font even if the primary Latin font ships its own CJK
 *  glyphs. */
const CJK_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303F\u3200-\u33FF\uFE30-\uFE4F\uFF00-\uFFEF]/u;

/** Whether text contains any CJK glyph that should use the CJK font. */
export function isCjkText(text: string): boolean {
  return CJK_RE.test(text);
}

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

/** The font stack for terminals of this weight: the English/Latin font family
 *  (terminal.fontFamily), then the bundled font once loaded, then Latin
 *  fallbacks, then the custom CJK font (terminal.cjkFontFamily) when set,
 *  then system CJK fallbacks. A family is quoted unless it is a list already. */
export function termFontFamily(weight: TermFontWeight, custom = '', cjk = ''): string {
  const own = quoteFontFamily(custom);
  const cjkOwn = quoteFontFamily(cjk);
  const head = [own, loaded.has(weight) ? `"${family}"` : ''].filter(Boolean);
  if (!cjkOwn) return [...head, fallback].join(', ');
  return [...head, latinFallback, cjkOwn, cjkFallback].join(', ');
}

/** The font stack for CJK glyphs in canvas terminals when a custom CJK font
 *  is configured: puts the CJK font first so it always handles CJK glyphs
 *  even when the primary Latin font also contains CJK glyphs, falling back to
 *  the normal terminal stack for anything it lacks. Undefined when no custom
 *  CJK font is set. */
export function termCjkFontFamily(weight: TermFontWeight, custom = '', cjk = ''): string | undefined {
  const cjkOwn = quoteFontFamily(cjk);
  if (!cjkOwn) return undefined;
  return `${cjkOwn}, ${termFontFamily(weight, custom, '')}`;
}

/** CSS `--mono` stack when either terminal font setting is customized; empty
 *  string when both are default so the stylesheet default applies. */
export function monoCssFontFamily(custom = '', cjk = ''): string {
  const own = quoteFontFamily(custom);
  const cjkOwn = quoteFontFamily(cjk);
  if (!own && !cjkOwn) return '';
  return [own, `'${family}'`, "'SF Mono'", 'Menlo', 'Monaco', cjkOwn, "'Noto Sans Mono CJK SC'", "'PingFang SC'", 'monospace']
    .filter(Boolean)
    .join(', ');
}

/** CSS root UI `font-family` stack with separate English/Latin and Chinese/CJK
 *  customization; empty string when both are default so the stylesheet default
 *  applies. */
export function uiCssFontFamily(latin = '', cjk = ''): string {
  const own = quoteFontFamily(latin);
  const cjkOwn = quoteFontFamily(cjk);
  if (!own && !cjkOwn) return '';
  if (!cjkOwn) return `${own}, ${uiSystemFallback}`;
  if (own) return `${own}, ${cjkOwn}, ${uiSystemFallback}`;
  return `${uiLatinDefault}, ${cjkOwn}, ${uiSystemFallback}`;
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
