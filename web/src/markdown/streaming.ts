// Markdown that is still arriving, drawn a block at a time: the text is
// cut at blank lines outside fenced code, display formulas, multi-line HTML
// comments and <details> blocks, so that blocks before the last one (which
// no longer change) are drawn once, and each increment draws only the last.
// Once the text is whole it is drawn as one (a list's items or a link's
// definition may span blocks).

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DETAILS_OPEN = /<details(?:\s[^>]*)?>/gi;
const DETAILS_CLOSE = /<\/details\s*>/gi;

/** Updates the unclosed HTML comment state across a line. */
function trackComment(line: string, inComment: boolean): boolean {
  let pos = 0;
  let open = inComment;
  while (pos < line.length) {
    if (open) {
      const end = line.indexOf('-->', pos);
      if (end < 0) return true;
      open = false;
      pos = end + 3;
    } else {
      const start = line.indexOf('<!--', pos);
      if (start < 0) return false;
      open = true;
      pos = start + 4;
    }
  }
  return open;
}

/** Counts net <details> nesting delta on a line outside HTML comments. */
function detailsDelta(line: string): number {
  const cleaned = line.replace(/<!--[\s\S]*?-->/g, '');
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
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = undefined;
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
    if (f) {
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
