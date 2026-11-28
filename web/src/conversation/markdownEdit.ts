// Pure Markdown editing helpers for the conversation composer (Composer.tsx):
// list & blockquote continuation on newline, code-fence auto-close, list &
// selection indentation with Tab/Shift+Tab, selection wrapping for paired
// delimiters, and formatting shortcuts (Cmd/Ctrl+B/I/E/K). Every operation is
// pure and returns the next text and selection range, or undefined when the
// key should be left to the browser.

export interface EditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface KeyInput {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

const INDENT = '  ';

/** Bounds [lineStart, lineEnd] of the line containing pos (excluding trailing \n). */
function lineBounds(text: string, pos: number): [number, number] {
  const start = pos <= 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1;
  const nl = text.indexOf('\n', pos);
  return [start, nl < 0 ? text.length : nl];
}

/** Counts opening/closing code fences matching char (backtick or tilde) of at
 * least `len` chars across the whole text. An odd count means a fence is unclosed. */
function isFenceUnclosed(text: string, char: string, len: number): boolean {
  const re = new RegExp(`^[ \\t]*${char === '`' ? '`' : '~'}{${len},}`, 'gm');
  let count = 0;
  while (re.exec(text)) count++;
  return count % 2 === 1;
}

/** Continues Markdown lists, task lists, blockquotes, or closes an opening
 * fenced code block when the user inserts a newline (Shift+Enter / Alt+Enter).
 * Pressing newline on an empty list/quote item clears its marker to break out.
 * Returns undefined when the current line has no Markdown continuation. */
export function continueMarkdownLine(text: string, start: number, end: number): EditResult | undefined {
  const [lineStart] = lineBounds(text, start);
  const before = text.slice(lineStart, start);
  const after = text.slice(end);

  // 1. Opening code fence (e.g. ``` or ```ts or ~~~) with nothing else on the line
  const fence = /^([ \t]*)(`{3,}|~{3,})([^`~\n]*)$/.exec(before);
  if (fence && (!after.length || after[0] === '\n')) {
    const [, indent, marks] = fence;
    if (isFenceUnclosed(text, marks[0], marks.length)) {
      const mid = `\n${indent}`;
      const closing = `\n${indent}${marks}`;
      const next = text.slice(0, start) + mid + closing + after;
      const caret = start + mid.length;
      return { text: next, selectionStart: caret, selectionEnd: caret };
    }
    return undefined;
  }

  // 2. Task list: "- [ ] ", "- [x] ", "* [ ] ", "+ [ ] "
  const task = /^([ \t]*)([-*+])[ \t]+\[([ xX])\][ \t]+(.*)$/.exec(before);
  if (task) {
    const [, indent, bullet, , content] = task;
    if (content === '' && (!after.length || after[0] === '\n')) {
      const next = text.slice(0, lineStart) + after;
      return { text: next, selectionStart: lineStart, selectionEnd: lineStart };
    }
    const ins = `\n${indent}${bullet} [ ] `;
    const caret = start + ins.length;
    return { text: text.slice(0, start) + ins + after, selectionStart: caret, selectionEnd: caret };
  }

  // 3. Unordered list: "- ", "* ", "+ "
  const ul = /^([ \t]*)([-*+])[ \t]+(.*)$/.exec(before);
  if (ul) {
    const [, indent, bullet, content] = ul;
    if (content === '' && (!after.length || after[0] === '\n')) {
      const next = text.slice(0, lineStart) + after;
      return { text: next, selectionStart: lineStart, selectionEnd: lineStart };
    }
    const ins = `\n${indent}${bullet} `;
    const caret = start + ins.length;
    return { text: text.slice(0, start) + ins + after, selectionStart: caret, selectionEnd: caret };
  }

  // 4. Ordered list: "1. ", "1) "
  const ol = /^([ \t]*)(\d+)([.)])[ \t]+(.*)$/.exec(before);
  if (ol) {
    const [, indent, num, punct, content] = ol;
    if (content === '' && (!after.length || after[0] === '\n')) {
      const next = text.slice(0, lineStart) + after;
      return { text: next, selectionStart: lineStart, selectionEnd: lineStart };
    }
    const ins = `\n${indent}${Number(num) + 1}${punct} `;
    const caret = start + ins.length;
    return { text: text.slice(0, start) + ins + after, selectionStart: caret, selectionEnd: caret };
  }

  // 5. Blockquote: "> ", ">> "
  const quote = /^([ \t]*)(>+)[ \t]?(.*)$/.exec(before);
  if (quote) {
    const [, indent, marks, content] = quote;
    if (content === '' && (!after.length || after[0] === '\n')) {
      const next = text.slice(0, lineStart) + after;
      return { text: next, selectionStart: lineStart, selectionEnd: lineStart };
    }
    const ins = `\n${indent}${marks} `;
    const caret = start + ins.length;
    return { text: text.slice(0, start) + ins + after, selectionStart: caret, selectionEnd: caret };
  }

  return undefined;
}

const LIST_OR_QUOTE_LINE = /^[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+|>+)/;

/** Indents or outdents selected lines (by 2 spaces) on Tab / Shift+Tab.
 * For a single-line caret with no selection, only intercepts when the line is
 * a list/blockquote (or outdenting an indented line) so plain single-line
 * inputs preserve normal Tab focus movement. */
export function indentMarkdownLines(text: string, start: number, end: number, outdent: boolean): EditResult | undefined {
  const multi = text.slice(start, end).includes('\n');
  const [firstStart] = lineBounds(text, start);
  // If selection ends right at column 0 of a subsequent line, exclude that trailing line.
  const effEnd = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const [, lastEnd] = lineBounds(text, effEnd);
  const block = text.slice(firstStart, lastEnd);

  if (!multi) {
    const isList = LIST_OR_QUOTE_LINE.test(block);
    const hasIndent = /^(?: {1,2}|\t)/.test(block);
    if (!isList && !(outdent && hasIndent)) return undefined;
  }

  const lines = block.split('\n');
  let deltaFirst = 0;
  let deltaTotal = 0;
  const nextLines = lines.map((line, i) => {
    if (!outdent) {
      if (i === 0) deltaFirst = INDENT.length;
      deltaTotal += INDENT.length;
      return INDENT + line;
    }
    let removed = 0;
    if (line.startsWith('\t')) removed = 1;
    else if (line.startsWith(INDENT)) removed = INDENT.length;
    else if (line.startsWith(' ')) removed = 1;
    if (i === 0) deltaFirst = -removed;
    deltaTotal -= removed;
    return line.slice(removed);
  });

  if (deltaTotal === 0) return undefined;
  const next = text.slice(0, firstStart) + nextLines.join('\n') + text.slice(lastEnd);
  const nextStart = Math.max(firstStart, start + deltaFirst);
  const nextEnd = Math.max(nextStart, end + deltaTotal);
  return { text: next, selectionStart: nextStart, selectionEnd: nextEnd };
}

/** Wraps the selected range (or inserts paired delimiters at the caret when
 * allowEmpty is true, toggling them off if the selection is already wrapped). */
export function wrapMarkdownSelection(
  text: string,
  start: number,
  end: number,
  open: string,
  close = open,
  allowEmpty = false,
): EditResult | undefined {
  const selected = text.slice(start, end);
  if (!selected && !allowEmpty) return undefined;

  // Toggle off if already wrapped right outside the selection.
  if (start >= open.length && text.slice(start - open.length, start) === open && text.slice(end, end + close.length) === close) {
    const next = text.slice(0, start - open.length) + selected + text.slice(end + close.length);
    return {
      text: next,
      selectionStart: start - open.length,
      selectionEnd: end - open.length,
    };
  }

  const next = text.slice(0, start) + open + selected + close + text.slice(end);
  return {
    text: next,
    selectionStart: start + open.length,
    selectionEnd: end + open.length,
  };
}

/** Inserts or wraps a Markdown link: `[selected](url)` with `url` selected so
 * the user can immediately type or paste the destination. */
export function insertMarkdownLink(text: string, start: number, end: number): EditResult {
  const selected = text.slice(start, end);
  const label = selected || 'text';
  const placeholder = 'url';
  const ins = `[${label}](${placeholder})`;
  const next = text.slice(0, start) + ins + text.slice(end);
  if (!selected) {
    // Select 'text' first when nothing was highlighted.
    return { text: next, selectionStart: start + 1, selectionEnd: start + 1 + label.length };
  }
  const urlStart = start + label.length + 3;
  return { text: next, selectionStart: urlStart, selectionEnd: urlStart + placeholder.length };
}

const WRAP_PAIRS: Record<string, [string, string]> = {
  '`': ['`', '`'],
  '*': ['*', '*'],
  '(': ['(', ')'],
  '[': ['[', ']'],
};

/** Dispatches Markdown editing keybindings for Composer's textarea:
 * - Cmd/Ctrl+B (bold), Cmd/Ctrl+I (italic), Cmd/Ctrl+E (inline code), Cmd/Ctrl+K (link)
 * - Paired delimiter wrap when text is selected (` * ( [)
 * - Tab / Shift+Tab list & multi-line indentation
 * - Shift+Enter / Alt+Enter list/quote continuation & code-fence auto-close */
export function handleMarkdownKey(text: string, start: number, end: number, ev: KeyInput): EditResult | undefined {
  const mod = !!(ev.metaKey || ev.ctrlKey) && !ev.altKey;
  if (mod && !ev.shiftKey) {
    const k = ev.key.toLowerCase();
    if (k === 'b') return wrapMarkdownSelection(text, start, end, '**', '**', true);
    if (k === 'i') return wrapMarkdownSelection(text, start, end, '*', '*', true);
    if (k === 'e') return wrapMarkdownSelection(text, start, end, '`', '`', true);
    if (k === 'k') return insertMarkdownLink(text, start, end);
    return undefined;
  }

  if (ev.key === 'Tab' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    return indentMarkdownLines(text, start, end, !!ev.shiftKey);
  }

  if (ev.key === 'Enter' && (ev.shiftKey || ev.altKey) && !ev.ctrlKey && !ev.metaKey) {
    return continueMarkdownLine(text, start, end);
  }

  // Paired delimiter wrap on non-empty selection.
  if (start !== end && !ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key in WRAP_PAIRS) {
    const [open, close] = WRAP_PAIRS[ev.key];
    return wrapMarkdownSelection(text, start, end, open, close, false);
  }

  return undefined;
}
