// The monospace fonts installed on the computer that shows the page, for the
// font picker of the settings. Chromium (also the desktop app) lists the
// computer's fonts with the Local Font Access API, after the user allows it
// (the desktop app allows it for its own pages); other browsers, or a user
// who refused, get the well-known monospace families found installed by
// measuring them. A family is listed when it is really fixed-pitch: drawn
// by itself (not a fallback), its narrow and wide letters, space, digits and
// punctuation equally wide, and its letters letters (not a symbol font's
// pictures at their code points); names that do not print are left out.

/** Families terminals commonly use, looked for when the computer's fonts
 * cannot be listed. */
const known = [
  'Andale Mono',
  'Anonymous Pro',
  'Berkeley Mono',
  'Cascadia Code',
  'Cascadia Mono',
  'Consolas',
  'Courier New',
  'DejaVu Sans Mono',
  'Droid Sans Mono',
  'Fira Code',
  'Fira Mono',
  'Hack',
  'IBM Plex Mono',
  'Inconsolata',
  'Input Mono',
  'Iosevka',
  'JetBrains Mono',
  'Liberation Mono',
  'Lucida Console',
  'Maple Mono',
  'Menlo',
  'Monaco',
  'Monaspace Neon',
  'Noto Sans Mono',
  'PT Mono',
  'Roboto Mono',
  'SF Mono',
  'Sarasa Mono SC',
  'Source Code Pro',
  'Ubuntu Mono',
  'Victor Mono',
];

/** Common Chinese / CJK fonts, looked for when Local Font Access is unavailable. */
const knownCjk = [
  'Alibaba PuHuiTi',
  'DengXian',
  'FangSong',
  'HarmonyOS Sans SC',
  'Heiti SC',
  'Hiragino Sans GB',
  'KaiTi',
  'Kaiti SC',
  'LXGW WenKai',
  'LXGW WenKai Mono',
  'LXGW WenKai Screen',
  'Maple Mono CN',
  'Maple Mono NF CN',
  'Microsoft JhengHei',
  'Microsoft YaHei',
  'MiSans',
  'NSimSun',
  'Noto Sans CJK SC',
  'Noto Sans Mono CJK SC',
  'Noto Sans SC',
  'Noto Serif CJK SC',
  'Noto Serif SC',
  'PingFang SC',
  'PingFang TC',
  'STFangsong',
  'STHeiti',
  'STKaiti',
  'STSong',
  'Sarasa Gothic SC',
  'Sarasa Mono SC',
  'Sarasa UI SC',
  'SimHei',
  'SimSun',
  'Songti SC',
  'Source Han Sans CN',
  'Source Han Sans SC',
  'Source Han Serif CN',
  'Source Han Serif SC',
  'WenQuanYi Micro Hei',
  'WenQuanYi Zen Hei',
];

const KNOWN_CJK_LOWER = new Set(knownCjk.map((f) => f.toLowerCase()));

/** Common UI sans-serif / text fonts, looked for when Local Font Access is unavailable. */
const knownUi = [
  'Arial',
  'Avenir Next',
  'Cantarell',
  'DejaVu Sans',
  'DM Sans',
  'Geist',
  'Georgia',
  'Helvetica Neue',
  'IBM Plex Sans',
  'Inter',
  'Liberation Sans',
  'Noto Sans',
  'Plus Jakarta Sans',
  'Roboto',
  'SF Pro',
  'SF Pro Text',
  'Segoe UI',
  'Source Sans 3',
  'Ubuntu',
  'Verdana',
];

let ctx: CanvasRenderingContext2D | null | undefined;

function canvas(): CanvasRenderingContext2D | null {
  if (ctx === undefined) ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  return ctx;
}

const width = (c: CanvasRenderingContext2D, font: string, text: string) => {
  c.font = font;
  return c.measureText(text).width;
};

const quote = (family: string) => `"${family.replace(/["\\]/g, '')}"`;

/** A text's advance and how far its ink reaches above and below the
 * baseline, in pixels (canvas TextMetrics). */
export interface TextBox {
  width: number;
  ascent: number;
  descent: number;
}

/** Measures text in a CSS font ("40px \"Menlo\", serif"). */
export type Measure = (font: string, text: string) => TextBox;

const canvasMeasure: Measure = (font, text) => {
  const c = canvas();
  if (!c) return { width: 0, ascent: 0, descent: 0 };
  c.font = font;
  const m = c.measureText(text);
  return { width: m.width, ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent };
};

/** The size fonts are measured at, in pixels. */
const SIZE = 40;

/** Characters a fixed-pitch font draws equally wide: narrow and wide
 * letters, the space, a digit, punctuation. */
const ADVANCES = ['i', 'm', 'W', ' ', '0', '.', '_', '@'];

/** Whether a family is fixed-pitch and draws Latin letters itself:
 * - the family draws the text itself: with a serif or a monospace fallback
 *   behind it the text is equally wide (a family not installed, or one
 *   without these characters, falls back);
 * - every character of ADVANCES is equally wide (ten of each, within a
 *   pixel at 40 px: Ayuthaya's space is narrower than its letters);
 * - its letters are letters: x sits on the baseline, p reaches below it,
 *   capitals are taller than the x (symbol fonts such as Wingdings put
 *   pictures at those code points, alike in width and height). */
export function fixedPitch(family: string, measure: Measure = canvasMeasure): boolean {
  const font = (fallback: string) => `${SIZE}px ${quote(family)}, ${fallback}`;
  const sample = 'imW x0Hp_.@';
  if (Math.abs(measure(font('serif'), sample).width - measure(font('monospace'), sample).width) > 0.5) return false;
  const widths = ADVANCES.map((ch) => measure(font('serif'), ch.repeat(10)).width);
  if (!(widths[0] > 0) || Math.max(...widths) - Math.min(...widths) > 1) return false;
  const x = measure(font('serif'), 'x');
  const p = measure(font('serif'), 'p');
  const H = measure(font('serif'), 'H');
  return (
    x.ascent >= 0.25 * SIZE &&
    Math.abs(x.descent) <= 0.1 * SIZE &&
    p.descent >= 0.08 * SIZE &&
    p.descent >= x.descent + 0.06 * SIZE &&
    H.ascent >= 1.2 * x.ascent
  );
}

/** Whether a family draws Latin text letters itself (proportional or
 * fixed-pitch, excluding symbol fonts and uninstalled fallbacks). */
export function isTextFont(family: string, measure: Measure = canvasMeasure): boolean {
  const font = (fallback: string) => `${SIZE}px ${quote(family)}, ${fallback}`;
  const sample = 'imW x0Hp_.@';
  if (Math.abs(measure(font('serif'), sample).width - measure(font('monospace'), sample).width) > 0.5) return false;
  const x = measure(font('serif'), 'x');
  const p = measure(font('serif'), 'p');
  const H = measure(font('serif'), 'H');
  return (
    x.width > 0 &&
    x.ascent >= 0.25 * SIZE &&
    Math.abs(x.descent) <= 0.1 * SIZE &&
    p.descent >= 0.08 * SIZE &&
    p.descent >= x.descent + 0.06 * SIZE &&
    H.ascent >= 1.2 * x.ascent
  );
}

const sameBox = (a: TextBox, b: TextBox) =>
  Math.abs(a.width - b.width) <= 0.5 && Math.abs(a.ascent - b.ascent) <= 0.5 && Math.abs(a.descent - b.descent) <= 0.5;

const CJK_SAMPLE = '永中文字国語';

/** Whether a family draws CJK glyphs itself rather than falling back to
 * generic system fonts. */
export function hasCjkGlyphs(family: string, measure: Measure = canvasMeasure): boolean {
  const font = (fallback: string) => `${SIZE}px ${quote(family)}, ${fallback}`;
  const sSerif = measure(font('serif'), CJK_SAMPLE);
  const sSans = measure(font('sans-serif'), CJK_SAMPLE);
  const sMono = measure(font('monospace'), CJK_SAMPLE);
  if (!(sSerif.width > 0)) return false;
  // If generic fallbacks alter the metrics, this family does not own the glyphs.
  if (!sameBox(sSerif, sSans) || !sameBox(sSerif, sMono)) return false;
  const bSerif = measure(`${SIZE}px serif`, CJK_SAMPLE);
  const bSans = measure(`${SIZE}px sans-serif`, CJK_SAMPLE);
  const bMono = measure(`${SIZE}px monospace`, CJK_SAMPLE);
  // Distinct system fallbacks collapsed to one box => the family itself drew them.
  if (!sameBox(bSerif, bSans) || !sameBox(bSerif, bMono)) return true;
  // Minimal systems where all generics share one CJK fallback: accept if the
  // metrics differ from that fallback or it is a recognized CJK family name.
  return !sameBox(sSerif, bSerif) || KNOWN_CJK_LOWER.has(family.trim().toLowerCase());
}

/** Whether a CJK family appears installed when measuring CJK glyphs against
 * generic system fallbacks. */
export function isCjkInstalled(family: string, measure: Measure = canvasMeasure): boolean {
  const font = (fallback: string) => `${SIZE}px ${quote(family)}, ${fallback}`;
  return (['serif', 'sans-serif', 'monospace'] as const).some(
    (generic) => !sameBox(measure(font(generic), CJK_SAMPLE), measure(`${SIZE}px ${generic}`, CJK_SAMPLE)),
  );
}

/** Whether a family's narrow and wide letters are equally wide (fixedPitch
 * with the page's canvas). */
export function isMonospace(family: string): boolean {
  return fixedPitch(family);
}

/** Whether a family is installed: text in it differs from the generic
 * families it would otherwise fall back to. */
export function isInstalled(family: string): boolean {
  const c = canvas();
  if (!c) return false;
  const text = 'mmmmmmmmmmlli0O@#';
  return ['monospace', 'serif', 'sans-serif'].some(
    (generic) => width(c, `32px ${quote(family)}, ${generic}`, text) !== width(c, `32px ${generic}`, text),
  );
}

interface LocalFont {
  family: string;
}

type QueryLocalFonts = () => Promise<LocalFont[]>;

export interface FontList {
  families: string[];
  /** The computer's fonts were listed (not only the well-known ones). */
  complete: boolean;
}

/** Whether a family's name prints: it starts with a letter or digit and
 * holds no control, format, private-use or unassigned character and no "?"
 * or U+FFFD (what a name that did not decode turns into, as "???®™??-"). */
export function printableName(family: string): boolean {
  const f = family.trim();
  return f.length > 0 && f.length <= 100 && /^[\p{L}\p{N}]/u.test(f) && !/[?\uFFFD\p{C}]/u.test(f);
}

/** The printable names of a list, each once (without regard to case or
 * surrounding spaces, the first spelling kept). */
export function uniqueNames(families: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of families) {
    const f = raw.trim();
    const key = f.toLowerCase();
    if (!printableName(f) || seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** The fixed-pitch families of a list with printable names, each once,
 * sorted alphabetically (the picker puts the bundled font first). */
export function pickMonospace(families: readonly string[], mono: (family: string) => boolean = isMonospace): string[] {
  return uniqueNames(families)
    .filter((f) => mono(f))
    .sort((a, b) => a.localeCompare(b));
}

/** The CJK-capable families of a list with printable names, each once,
 * sorted alphabetically. */
export function pickCjk(families: readonly string[], check: (family: string) => boolean = hasCjkGlyphs): string[] {
  return uniqueNames(families)
    .filter((f) => check(f))
    .sort((a, b) => a.localeCompare(b));
}

/** The Latin text families of a list with printable names, each once, sorted
 * alphabetically (for the UI font picker). */
export function pickUiFonts(families: readonly string[], check: (family: string) => boolean = isTextFont): string[] {
  return uniqueNames(families)
    .filter((f) => check(f))
    .sort((a, b) => a.localeCompare(b));
}

/** Loads the families by name, so that they are measured with their own
 * glyphs. */
async function loadFamilies(families: readonly string[]) {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (!fonts?.load) return;
  await Promise.all(families.map((f) => fonts.load(`${SIZE}px ${quote(f)}`).catch(() => [])));
}

let queried: Promise<{ families: string[]; complete: boolean }> | undefined;

/** Queries Local Font Access once (cached on success; retries next time if refused). */
function queryAllFamilies(): Promise<{ families: string[]; complete: boolean }> {
  queried ??= (async () => {
    const query = (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
    if (query) {
      try {
        const families = uniqueNames((await query()).map((f) => f.family));
        if (families.length > 0) {
          await loadFamilies(families);
          return { families, complete: true };
        }
      } catch {
        // Refused or unavailable: callers fall back to well-known lists.
      }
    }
    queried = undefined;
    return { families: [], complete: false };
  })();
  return queried;
}

let listedMono: Promise<FontList> | undefined;
let listedCjk: Promise<FontList> | undefined;
let listedUi: Promise<FontList> | undefined;

/** The monospace families installed, sorted; asks for the Local Font Access
 * permission the first time (call it from a click). */
export function monospaceFonts(): Promise<FontList> {
  listedMono ??= (async () => {
    const all = await queryAllFamilies();
    let families = all.families;
    if (!all.complete) {
      families = uniqueNames(known.filter(isInstalled));
      await loadFamilies(families);
      listedMono = undefined;
    }
    return { families: pickMonospace(families), complete: all.complete };
  })();
  return listedMono;
}

/** The CJK-capable families installed, sorted. */
export function cjkFonts(): Promise<FontList> {
  listedCjk ??= (async () => {
    const all = await queryAllFamilies();
    if (all.complete) return { families: pickCjk(all.families), complete: true };
    const families = uniqueNames(knownCjk.filter((f) => isCjkInstalled(f)));
    await loadFamilies(families);
    listedCjk = undefined;
    return { families: pickCjk(families), complete: false };
  })();
  return listedCjk;
}

/** The UI text families installed, sorted. */
export function uiFonts(): Promise<FontList> {
  listedUi ??= (async () => {
    const all = await queryAllFamilies();
    if (all.complete) return { families: pickUiFonts(all.families), complete: true };
    const families = uniqueNames(knownUi.filter(isInstalled));
    await loadFamilies(families);
    listedUi = undefined;
    return { families: pickUiFonts(families), complete: false };
  })();
  return listedUi;
}
