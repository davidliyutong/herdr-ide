// Markdown that is still arriving, drawn a block at a time: the text is
// cut at blank lines outside fenced code and display formulas, so that the
// blocks before the last one, which no longer change, are drawn once, and
// each increment draws only the last. Once the text is whole it is drawn
// as one (a list's items or a link's definition may span blocks).

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The text's blocks: its parts between blank lines, a fenced code block
 * or a display formula between lines of `$$` kept whole. */
export function streamBlocks(md: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence: string | undefined;
  let math = false;
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
