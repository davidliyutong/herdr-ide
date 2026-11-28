// Markdown that is still arriving, drawn a block at a time: the text is
// cut at blank lines outside fenced code, display formulas, multi-line HTML
// comments and <details> blocks, so that blocks before the last one (which
// no longer change) are drawn once, and each increment draws only the last.
// Once the text is whole it is drawn as one (a list's items or a link's
// definition may span blocks).

import { codeSpans, spanEnd } from './math';

const FENCE = /^ {0,3}(`{3,}|~{3,})([^\r]*)\r?$/;
const DETAILS_OPEN = /<details(?:\s[^>]*)?>/gi;
const DETAILS_CLOSE = /<\/details\s*>/gi;

/** Updates the unclosed HTML comment state across a line, ignoring `<!--`
 * inside inline code spans when outside an already-open comment. */
function trackComment(line: string, inComment: boolean): boolean {
  let pos = 0;
  let open = inComment;
  let spans: readonly [number, number][] | undefined;
  while (pos < line.length) {
    if (open) {
      const end = line.indexOf('-->', pos);
      if (end < 0) return true;
      open = false;
      pos = end + 3;
    } else {
      const start = line.indexOf('<!--', pos);
      if (start < 0) return false;
      spans ??= codeSpans(line);
      const end = spanEnd(spans, start);
      if (end >= 0) {
        pos = end;
        continue;
      }
      open = true;
      pos = start + 4;
    }
  }
  return open;
}

/** Strips inline code spans and inline HTML comments from a line so tags
 * written inside them do not affect `<details>` nesting. */
function proseOf(line: string): string {
  const spans = codeSpans(line);
  let out = '';
  let pos = 0;
  while (pos < line.length) {
    const end = spanEnd(spans, pos);
    if (end >= 0) {
      pos = end;
      continue;
    }
    if (line.startsWith('<!--', pos)) {
      const close = line.indexOf('-->', pos + 4);
      if (close < 0) break;
      pos = close + 3;
      continue;
    }
    const nextTick = line.indexOf('`', pos + 1);
    const nextComment = line.indexOf('<!--', pos + 1);
    let next = line.length;
    if (nextTick >= 0 && nextTick < next) next = nextTick;
    if (nextComment >= 0 && nextComment < next) next = nextComment;
    out += line.slice(pos, next);
    pos = next;
  }
  return out;
}

/** Counts net <details> nesting delta on a line outside inline code and HTML comments. */
function detailsDelta(line: string): number {
  const cleaned = proseOf(line);
  const opens = cleaned.match(DETAILS_OPEN)?.length ?? 0;
  const closes = cleaned.match(DETAILS_CLOSE)?.length ?? 0;
  return opens - closes;
}

/** The text's blocks: its parts between blank lines, keeping fenced code
 * blocks, display formulas between lines of `$$`, multi-line HTML comments
 * and `<details>` blocks whole. */
export function streamBlocks(md: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence: string | undefined;
  let math = false;
  let comment = false;
  let details = 0;
  for (const line of md.split('\n')) {
    if (fence !== undefined) {
      cur.push(line);
      const f = FENCE.exec(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = undefined;
      continue;
    }
    if (math) {
      cur.push(line);
      if (line.trim() === '$$') math = false;
      continue;
    }
    if (comment) {
      cur.push(line);
      comment = trackComment(line, true);
      continue;
    }
    const f = FENCE.exec(line);
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      cur.push(line);
      continue;
    }
    if (line.trim() === '$$') {
      math = true;
      cur.push(line);
      continue;
    }
    const nextComment = trackComment(line, false);
    if (nextComment) {
      comment = true;
      cur.push(line);
      continue;
    }
    const nextDetails = Math.max(0, details + detailsDelta(line));
    if (details > 0 || nextDetails > 0) {
      details = nextDetails;
      cur.push(line);
      continue;
    }
    if (line.trim() === '') {
      if (cur.length) out.push(cur.join('\n'));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}
