// The explorer's settings (its page in Settings › Plugins), which the web
// UI reads.
import { bool, defineModule, enumOf, stringList } from '#kernel/config/settings/index.ts';

/** The names hidden by default, as VS Code's files.exclude: version control
 * folders and the systems' folder files. */
export const DEFAULT_EXCLUDE = ['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db'];

/** At most this many patterns, of at most MAX_PATTERN bytes. */
const MAX_PATTERNS = 100;
const MAX_PATTERN = 200;

const section = 'files';

export const settings = defineModule({
  sections: [{ id: section, order: 66, plugin: 'files' }],
  settings: {
    /** Names starting with a dot are shown, in browsers that did not choose
     * with the panel's eye button. */
    'files.showHidden': bool({ default: false, section, order: 10 }),
    /** Patterns of names the tree never shows. */
    'files.exclude': stringList({
      default: DEFAULT_EXCLUDE,
      options: [...DEFAULT_EXCLUDE, 'node_modules', '__pycache__', '*.pyc', '.venv'],
      section,
      order: 20,
      check: excludeProblem,
    }),
    /** How a folder's entries are ordered. */
    'files.sortOrder': enumOf(['default', 'mixed', 'filesFirst', 'type', 'modified'], { default: 'default', section, order: 30 }),
    /** The root follows the focused pane, in browsers that did not choose
     * with the panel's crosshair. */
    'files.followFocus': bool({ default: true, section, order: 40 }),
    /** Move to Trash asks first. */
    'files.confirmTrash': bool({ default: false, section, order: 50 }),
  },
});

/** Why patterns are not names to exclude, or undefined: at most 100, each
 * of 1 to 200 bytes, without "/" but after a leading "**" (VS Code's form,
 * which matches a name in any folder too), in the syntax of Go's
 * path.Match (wellFormed). */
export function excludeProblem(patterns: string[]): string | undefined {
  if (patterns.length > MAX_PATTERNS) return `at most ${MAX_PATTERNS} patterns`;
  for (const p of patterns) {
    const name = p.startsWith('**/') ? p.slice(3) : p;
    if (name === '' || Buffer.byteLength(p) > MAX_PATTERN) return `a pattern is 1 to ${MAX_PATTERN} bytes`;
    if (name.includes('/')) return 'patterns match names, without /';
    if (!wellFormed(name)) return `not a pattern: ${p}`;
  }
  return undefined;
}

/** Whether p is a pattern of Go's path.Match: terms *, ?, \c and character
 * classes [^…] of characters c, \c and ranges lo-hi, at least one, closed
 * by ]. */
export function wellFormed(p: string): boolean {
  const cs = [...p];
  // A class member: c or \c, never a bare - or ], followed by more pattern.
  const member = (i: number): number => {
    if (i >= cs.length || cs[i] === '-' || cs[i] === ']') return -1;
    if (cs[i] === '\\') i++;
    return i + 1 < cs.length ? i + 1 : -1;
  };
  for (let i = 0; i < cs.length; i++) {
    if (cs[i] === '\\') {
      if (++i >= cs.length) return false;
    } else if (cs[i] === '[') {
      i++;
      if (cs[i] === '^') i++;
      for (let ranges = 0; ; ranges++) {
        if (cs[i] === ']' && ranges > 0) break;
        i = member(i);
        if (i < 0) return false;
        if (cs[i] === '-') {
          i = member(i + 1);
          if (i < 0) return false;
        }
      }
    }
  }
  return true;
}
