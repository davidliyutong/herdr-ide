// The monospace fonts installed on the computer that shows the page, for the
// font picker of the settings. Chromium (also the desktop app) lists the
// computer's fonts with the Local Font Access API, after the user allows it
// (the desktop app allows it for its own pages); other browsers, or a user
// who refused, get the well-known monospace families found installed by
// measuring them. A family is monospace when its narrow and wide letters
// are equally wide.

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

/** Whether a family's narrow and wide letters are equally wide. */
export function isMonospace(family: string): boolean {
  const c = canvas();
  if (!c) return false;
  const f = `32px ${quote(family)}, serif`;
  const narrow = width(c, f, 'iiiiiiiiii');
  return Math.abs(narrow - width(c, f, 'MMMMMMMMMM')) < 1 && Math.abs(narrow - width(c, f, 'WWWWWWWWWW')) < 1;
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

/** The monospace families of a list, each once, sorted; families whose
 * names did not decode (symbol fonts listed as "???") are left out. */
export function pickMonospace(families: string[], mono: (family: string) => boolean = isMonospace): string[] {
  const named = (f: string) => /^[\p{L}\p{N}]/u.test(f) && !/[?\uFFFD]/.test(f);
  return [...new Set(families)].filter((f) => named(f) && mono(f)).sort((a, b) => a.localeCompare(b));
}

let listed: Promise<FontList> | undefined;

/** The monospace families installed, sorted; asks for the Local Font Access
 * permission the first time (call it from a click). */
export function monospaceFonts(): Promise<FontList> {
  listed ??= (async () => {
    const query = (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
    let families: string[] = [];
    let complete = false;
    if (query) {
      try {
        families = [...new Set((await query()).map((f) => f.family))];
        complete = families.length > 0;
      } catch {
        // Refused or unavailable: the well-known families below.
      }
    }
    if (!complete) families = known.filter(isInstalled);
    const out = pickMonospace(families);
    // A refusal is asked again next time the picker opens.
    if (!complete) listed = undefined;
    return { families: out, complete };
  })();
  return listed;
}
