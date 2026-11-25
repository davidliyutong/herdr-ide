// Go's string functions where JavaScript's differ, for code that must
// read text as the Go program read it while both exist (the detector's
// rules, the transcripts' events): which characters are space, and lower
// case one character at a time.

/** Go's unicode.IsSpace: the ASCII spaces, NEL, NBSP and the Unicode
 * White_Space characters (JavaScript's trim also takes U+FEFF and not
 * U+0085). */
const SPACE = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const TRIM = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g');
const TRIM_END = new RegExp(`${SPACE}+$`);

/** Go's strings.TrimSpace. */
export const trimSpace = (s: string): string => s.replace(TRIM, '');

/** Go's strings.TrimRightFunc(s, unicode.IsSpace). */
export const trimSpaceEnd = (s: string): string => s.replace(TRIM_END, '');

/** Go's strings.ToLower: each character's simple lower case, never the
 * context of the ones around it (JavaScript lowers a final sigma to ς and
 * İ to two characters). */
export function toLower(s: string): string {
  // ASCII, the common case, lowers the same.
  if (!/[^\x00-\x7f]/.test(s)) return s.toLowerCase();
  let out = '';
  for (const ch of s) {
    if (ch === 'İ') {
      out += 'i';
      continue;
    }
    const l = ch.toLowerCase();
    // A character whose lower case is more than one keeps itself.
    out += [...l].length === 1 ? l : ch;
  }
  return out;
}
