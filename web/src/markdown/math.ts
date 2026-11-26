// Math delimiter normalization for Markdown (used by Agent Native View /
// compact Markdown, or any caller opting into mathDelimiters): converts
// LaTeX \[…\] / \(…\) and single-line $$…$$ paragraphs into remark-math's
// dollar delimiters outside fenced code blocks and inline code spans.

// A line that is one formula between $$ and $$ (indented less than a code
// block), and a fence of a code block.
const ONE_LINE_MATH = /^( {0,3})\$\$(.+)\$\$[ \t\r]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// What opens a line's containers: a block quote's marker, a list item's,
// indentation; one at a time.
const CONTAINER = /^(?:[ \t]*>[ \t]?|[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)|[ \t]+)/;
// A fence of a code block once its containers are left out.
const INNER_FENCE = /^(`{3,}|~{3,})([^\r]*)\r?$/;

/** The start of a line that opens its containers (CONTAINER). */
function containerPrefix(line: string): string {
  let n = 0;
  for (let m = CONTAINER.exec(line); m && m[0]; m = CONTAINER.exec(line.slice(n))) n += m[0].length;
  return line.slice(0, n);
}

/** What the lines that go on in the containers of a line with that prefix
 * start with: the quote markers kept, a list item's marker as spaces. */
function continuation(prefix: string): string {
  let out = '';
  let rest = prefix;
  for (let m = CONTAINER.exec(rest); m && m[0]; m = CONTAINER.exec(rest)) {
    out += m[0].includes('>') || !/[^ \t]/.test(m[0]) ? m[0] : ' '.repeat(m[0].length);
    rest = rest.slice(m[0].length);
  }
  return out;
}

/** The code spans of a line, [start, end) each: runs of backticks closed by
 * a run as long on the same line. */
function codeSpans(line: string): [number, number][] {
  const out: [number, number][] = [];
  if (!line.includes('`')) return out;
  // The lengths of runs that have no closing run further on.
  const unclosed = new Set<number>();
  for (let i = line.indexOf('`'); i >= 0;) {
    let end = i;
    while (line[end] === '`') end++;
    let slashes = 0;
    while (i - slashes > 0 && line[i - slashes - 1] === '\\') slashes++;
    if (slashes % 2 === 1) {
      // An escaped backtick is none; the rest of the run may open a span.
      i = line[i + 1] === '`' ? i + 1 : line.indexOf('`', i + 1);
      continue;
    }
    const run = end - i;
    let close = -1;
    if (!unclosed.has(run))
      for (let j = line.indexOf('`', end); j >= 0;) {
        let k = j;
        while (line[k] === '`') k++;
        if (k - j === run) {
          close = k;
          break;
        }
        j = line.indexOf('`', k);
      }
    if (close < 0) {
      unclosed.add(run);
      i = line.indexOf('`', end);
      continue;
    }
    out.push([i, close]);
    i = line.indexOf('`', close);
  }
  return out;
}

/** The end of the code span (of spans in order) that has position i; -1
 * when none has it. */
function spanEnd(spans: readonly [number, number][], i: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = spans[mid];
    if (i < start) hi = mid - 1;
    else if (i >= end) lo = mid + 1;
    else return end;
  }
  return -1;
}

/** Where the first delimiter of a backslash and ch (\[, \], \(, \)) is in
 * a line at or after from, outside its code spans and not after a
 * backslash of its own (\\[ is a backslash, then a bracket); -1 for none. */
function delimiter(line: string, ch: string, from: number, code: readonly [number, number][]): number {
  for (let i = from; ;) {
    const j = line.indexOf('\\' + ch, i);
    if (j < 0) return -1;
    const end = spanEnd(code, j);
    if (end >= 0) {
      i = end;
      continue;
    }
    let slashes = 0;
    while (j - slashes > 0 && line[j - slashes - 1] === '\\') slashes++;
    if (slashes % 2 === 0) return j;
    i = j + 2;
  }
}

/** A line with each formula between \( and \) on it as an inline formula
 * between dollars: $$ when the line has a dollar already, which a single
 * one could pair with. One that goes on to another line stays as it is. */
function inlineLatex(line: string): string {
  if (!line.includes('\\(')) return line;
  const code = codeSpans(line);
  const d = line.includes('$') ? '$$' : '$';
  let out = '';
  let done = 0;
  for (let from = 0; ;) {
    const open = delimiter(line, '(', from, code);
    if (open < 0) break;
    const close = delimiter(line, ')', open + 2, code);
    // None further on the line closes this one or a later one.
    if (close < 0) break;
    const tex = line.slice(open + 2, close).trim();
    if (tex && !tex.includes('$') && !tex.endsWith('\\')) {
      out += `${line.slice(done, open)}${d}${tex}${d}`;
      done = close + 2;
    }
    from = close + 2;
  }
  return done ? out + line.slice(done) : line;
}

/** Whether a line is blank but for its containers' markers. */
const blankIn = (line: string) => line.slice(containerPrefix(line).length).trim() === '';

/** An agent's Markdown with the LaTeX delimiters of formulas as the
 * renderer knows them (dollars): a formula between \[ and \] (on one line
 * or over several of a paragraph) as a formula block, $$ on lines of their
 * own in the containers of the line it starts on (the indentation of a
 * list item, the markers of a quote), the text around it before and after
 * the block; one between \( and \) on one line as an inline formula. Only
 * whole pairs are taken (a message still arriving may have an \[ whose
 * \] is to come), outside fenced code blocks and code spans; an escaped
 * backslash before a bracket (\\[) is no delimiter. */
export function latexMath(md: string): string {
  if (!md.includes('\\[') && !md.includes('\\(')) return md;
  const lines = md.split('\n');
  const out: string[] = [];
  let fence: string | undefined;
  // A display formula of this paragraph found no end: none after it does.
  let unclosed = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const inner = line.slice(containerPrefix(line).length);
    const f = INNER_FENCE.exec(inner);
    if (fence !== undefined) {
      // A closing fence: the same character, at least as many, nothing after.
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = undefined;
      out.push(line);
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = f[1];
      unclosed = false;
      out.push(line);
      continue;
    }
    if (blankIn(line)) {
      unclosed = false;
      out.push(line);
      continue;
    }
    // The display formulas that start on the line, one after another; an
    // empty one stays as written.
    for (let from = 0; ;) {
      const code = codeSpans(line);
      const open = unclosed ? -1 : delimiter(line, '[', from, code);
      if (open < 0) break;
      // Its end: on the line, or on a later one of the paragraph.
      let end = -1;
      let at = delimiter(line, ']', open + 2, code);
      if (at >= 0) end = i;
      for (let j = i + 1; at < 0 && j < lines.length; j++) {
        const l = lines[j];
        if (blankIn(l) || INNER_FENCE.test(l.slice(containerPrefix(l).length))) break;
        at = delimiter(l, ']', 0, codeSpans(l));
        if (at >= 0) end = j;
      }
      if (end < 0) {
        unclosed = true;
        break;
      }
      if (end === i && !line.slice(open + 2, at).trim()) {
        from = at + 2;
        continue;
      }
      if (end > i && !line.slice(open + 2).trim() && lines.slice(i + 1, end).every(blankIn) && blankIn(lines[end].slice(0, at))) break;
      const prefix = containerPrefix(line);
      const cont = continuation(prefix);
      const before = line.slice(0, open);
      if (before.slice(prefix.length).trim()) out.push(inlineLatex(before.trimEnd()), `${cont}$$`);
      else out.push(`${prefix}$$`);
      let after: string;
      if (end === i) {
        const tex = line.slice(open + 2, at).trim();
        if (tex) out.push(`${cont}${tex}`);
        after = line.slice(at + 2);
      } else {
        const first = line.slice(open + 2).trim();
        if (first) out.push(`${cont}${first}`);
        for (let j = i + 1; j < end; j++) out.push(lines[j]);
        const last = lines[end].slice(0, at);
        if (!blankIn(last)) out.push(last.trimEnd());
        after = lines[end].slice(at + 2);
        i = end;
      }
      out.push(`${cont}$$`);
      line = after.trim() ? `${cont}${after.trimStart()}` : '';
      if (!line) break;
      from = 0;
    }
    if (line) out.push(inlineLatex(line));
  }
  return out.join('\n');
}

/** An agent's Markdown with its formulas as the renderer shows them: the
 * LaTeX delimiters as dollars (latexMath), and each paragraph that is one
 * formula written on one line between $$ and $$ (as the agents write
 * display formulas) put as a formula block, $$ on lines of their own,
 * which the renderer shows as display math; a formula within a line of
 * text stays inline, and the lines of fenced code blocks stay as they
 * are. */
export function displayMath(source: string): string {
  const md = latexMath(source);
  if (!md.includes('$$')) return md;
  const lines = md.split('\n');
  let fence: string | undefined;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence !== undefined) {
      // A closing fence: the same character, at least as many, nothing after.
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = undefined;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const m = ONE_LINE_MATH.exec(line);
    if (!m) continue;
    const tex = m[2].trim();
    if (!tex || tex.includes('$$') || tex.endsWith('\\')) continue;
    if ((i > 0 && lines[i - 1].trim() !== '') || (i < lines.length - 1 && lines[i + 1].trim() !== '')) continue;
    lines[i] = `${m[1]}$$\n${m[1]}${tex}\n${m[1]}$$`;
    changed = true;
  }
  return changed ? lines.join('\n') : md;
}
