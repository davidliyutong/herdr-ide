// Path and URL detection in pane output, also over rows a long path was
// wrapped on. Cmd/Ctrl+click (or the pane's context menu) opens what is
// found (openLink.ts), resolving relative paths against the terminal's
// working directory.

import { t } from '../i18n';
import { safeWebUrl } from '../lib/webUrl';

export interface LinkContext {
  m: string;
  /** The terminal's pane, which what it opens goes beside. */
  pane?: string;
  cwd?: string;
  home?: string;
}

// URLs stop before whitespace, quotes/angle brackets/backticks, CJK
// punctuation/quotes/brackets and CJK ideographs/kana/hangul so prose like
// “https://example.com/a。” or https://example.com/a，查看 never swallows
// surrounding Chinese text or punctuation.
const urlRe =
  /https?:\/\/[^\s"'<>`\u2018-\u201f\u2013\u2014\u2026\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]+/g;

// Location suffix on a path:
//  - :17, :17:5, :17-20, :17:5-20, :17:5-20:10
//  - :L17, :L17-L20, :L17-20, :L17C5-L20C10
//  - #L17, #L17-L20, #L17-20, #L17C5-L20C10
//  - (17), (17,5), (17, 5), (17-20), (17,5-20,10)
const LOC_SRC =
  '(?:' +
  ':(?:L(\\d+)(?:C(\\d+))?(?:-L?(\\d+)(?:C(\\d+))?)?|(\\d+)(?::(\\d+))?(?:-(\\d+)(?::(\\d+))?)?)' +
  '|' +
  '#L(\\d+)(?:C(\\d+))?(?:-L?(\\d+)(?:C(\\d+))?)?' +
  '|' +
  '\\((\\d+)(?:,\\s*(\\d+))?(?:-(\\d+)(?:,\\s*(\\d+))?)?\\)' +
  ')';

const locSuffixRe = new RegExp(`${LOC_SRC}$`);

const BARE_EXTS =
  'png|jpe?g|gif|webp|avif|svg|bmp|ico|mp4|webm|mov|m4v|mkv|mp3|wav|ogg|flac|m4a|pdf|' +
  'md|mdx|markdown|txt|log|json|jsonc|ya?ml|toml|csv|tsv|ini|cfg|conf|xml|html?|css|scss|less|sql|' +
  'py|ts|tsx|js|jsx|mjs|cjs|go|rs|c|cc|cpp|h|hpp|java|kts?|scala|swift|rb|php|lua|zig|vue|svelte|sh|bash|zsh|ipynb|diff|patch|' +
  'MD|MDX|PNG|JPE?G|GIF|PDF|TXT|YA?ML|JSON';

// Paths use ASCII path characters so adjacent CJK characters and Chinese
// punctuation (。, ，, ；, ：, ”, ’, ）, 】, 》, 、, …) are never swallowed.
const pathRe = new RegExp(
  `(?:~|\\.{1,2})?(?:\\/[\\w.@+\\-~%]+)+\\/?(?:${LOC_SRC})?` +
    `|(?:[\\w.@+\\-~%]+\\/)+[\\w.@+\\-~%]+(?:${LOC_SRC})?` +
    `|[\\w@+\\-~%][\\w.@+\\-~%]*\\.(?:${BARE_EXTS})(?:${LOC_SRC})?`,
  'g',
);

export const mediaExt = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|mp4|webm|mov|m4v|mkv|mp3|wav|ogg|flac|m4a|aac|pdf)$/i;

export interface ResolvedPath {
  path: string;
  line?: number;
  col?: number;
  endLine?: number;
  endCol?: number;
}

/** Parses an optional location suffix (:line, :line:col, :line-endLine,
 * :line:col-endLine:endCol, :L17-L20, #L17-L20, (17,5)) from the end of a path. */
function parseLocation(raw: string): { path: string; line?: number; col?: number; endLine?: number; endCol?: number } {
  const m = locSuffixRe.exec(raw);
  if (!m) return { path: raw };
  const path = raw.slice(0, m.index);
  let line: number | undefined;
  let col: number | undefined;
  let endLine: number | undefined;
  let endCol: number | undefined;

  if (m[1] !== undefined) {
    // :L<line>[C<col>][-L?<endLine>[C<endCol>]]
    line = Number(m[1]);
    col = m[2] !== undefined ? Number(m[2]) : undefined;
    if (m[3] !== undefined) {
      const e = Number(m[3]);
      if (e >= line) {
        endLine = e;
        endCol = m[4] !== undefined ? Number(m[4]) : undefined;
      }
    }
  } else if (m[5] !== undefined) {
    // :<line>[:<col>][-<end>[:<endCol>]]
    line = Number(m[5]);
    col = m[6] !== undefined ? Number(m[6]) : undefined;
    if (m[7] !== undefined) {
      if (m[8] !== undefined) {
        // :line:col-endLine:endCol (or :line-endLine:endCol)
        const eLine = Number(m[7]);
        if (eLine >= line) {
          endLine = eLine;
          endCol = Number(m[8]);
        }
      } else if (col !== undefined) {
        // :line:col-endCol on the same line
        const eCol = Number(m[7]);
        if (eCol >= col) {
          endLine = line;
          endCol = eCol;
        }
      } else {
        // :line-endLine
        const eLine = Number(m[7]);
        if (eLine >= line) endLine = eLine;
      }
    }
  } else if (m[9] !== undefined) {
    // #L<line>[C<col>][-L?<endLine>[C<endCol>]]
    line = Number(m[9]);
    col = m[10] !== undefined ? Number(m[10]) : undefined;
    if (m[11] !== undefined) {
      const e = Number(m[11]);
      if (e >= line) {
        endLine = e;
        endCol = m[12] !== undefined ? Number(m[12]) : undefined;
      }
    }
  } else if (m[13] !== undefined) {
    // (<line>[, <col>][-<endLine>[, <endCol>]])
    line = Number(m[13]);
    col = m[14] !== undefined ? Number(m[14]) : undefined;
    if (m[15] !== undefined) {
      const eLine = Number(m[15]);
      if (eLine >= line) {
        endLine = eLine;
        endCol = m[16] !== undefined ? Number(m[16]) : undefined;
      }
    }
  }

  return {
    path,
    line,
    col,
    ...(endLine !== undefined ? { endLine } : {}),
    ...(endCol !== undefined ? { endCol } : {}),
  };
}

export function resolvePath(raw: string, ctx: LinkContext): ResolvedPath {
  const parsed = parseLocation(raw);
  let p = parsed.path;
  if (p.startsWith('~/') && ctx.home) p = ctx.home + p.slice(1);
  else if (!p.startsWith('/') && ctx.cwd) p = ctx.cwd.replace(/\/$/, '') + '/' + p;
  // Normalize ./ and ../ segments.
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return {
    path: '/' + out.join('/'),
    line: parsed.line,
    col: parsed.col,
    ...(parsed.endLine !== undefined ? { endLine: parsed.endLine } : {}),
    ...(parsed.endCol !== undefined ? { endCol: parsed.endCol } : {}),
  };
}

/** Trims trailing sentence punctuation and unbalanced closing brackets from a URL. */
function trimUrlEnd(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if ('.,;:!?'.includes(ch)) {
      end--;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      const open = ch === ')' ? '(' : ch === ']' ? '[' : '{';
      let opens = 0;
      let closes = 0;
      for (let i = 0; i < end; i++) {
        if (url[i] === open) opens++;
        else if (url[i] === ch) closes++;
      }
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/** Strips trailing sentence periods from a matched path unless it ends with
 * an explicit `.` / `..` path segment (e.g. `foo/..`). */
function trimPathEnd(raw: string): string {
  if (locSuffixRe.test(raw)) return raw;
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '.') {
    const sub = raw.slice(0, end);
    if (sub === '.' || sub === '..' || sub.endsWith('/.') || sub.endsWith('/..')) break;
    end--;
  }
  return raw.slice(0, end);
}

export interface FoundLink {
  /** UTF-16 offsets in the searched text. */
  start: number;
  end: number;
  text: string;
  kind: 'url' | 'path';
}

/** URLs and paths in a line of text; overlapping matches keep the first. */
export function findLinks(text: string): FoundLink[] {
  const out: FoundLink[] = [];
  const add = (start: number, end: number, kind: FoundLink['kind']) => {
    if (end <= start) return;
    if (out.some((l) => start < l.end && end > l.start)) return;
    out.push({ start, end, text: text.slice(start, end), kind });
  };
  for (const m of text.matchAll(urlRe)) {
    const cleaned = trimUrlEnd(m[0]);
    if (cleaned.length > 'http://'.length) add(m.index!, m.index! + cleaned.length, 'url');
  }
  for (const m of text.matchAll(pathRe)) {
    const cleaned = trimPathEnd(m[0]);
    if (cleaned.length < 2 || /^\/+$/.test(cleaned)) continue;
    add(m.index!, m.index! + cleaned.length, 'path');
  }
  return out;
}

/** A row of a pane as Grid.rowText returns it: the column of each UTF-16
 * index of the text, then the column after the row. */
export interface RowText {
  text: string;
  colOf: number[];
  /** Soft-wrapped onto the next row by the terminal emulator. */
  wrap?: boolean;
  /** UTF-16 offset after the last written cell (distinguishes explicit spaces
   * from unwritten trailing padding on soft-wrapped rows). */
  writtenEnd?: number;
}

/** The cells [from, to) of row y. */
export interface Cells {
  y: number;
  from: number;
  to: number;
}

export interface WrappedLink {
  kind: FoundLink['kind'];
  text: string;
  /** Per row, in order. */
  cells: Cells[];
}

/** Rows a link may extend over above and below the row searched. */
const WRAP_ROWS = 20;

/** Box-drawing vertical borders / quote gutters TUIs place around wrapped rows. */
const LEFT_BORDER_RE = /^[ \t]*([│┃║▏▎▍▌┆┇┊┋])[ \t]*/;
const RIGHT_BORDER_RE = /[ \t]*([│┃║▕┆┇┊┋])[ \t]*$/;
const PATH_TAIL_RE = /[^\s"'`<>()[\]{}]+$/;
const PATH_HEAD_RE = /^[^\s"'`<>()[\]{}]+/;
const PATH_CHAR_END_RE = /[\w.@+\-~%/:?#&=]$/;
const PATH_CHAR_START_RE = /^[\w.@+\-~%/:?#&=]/;
const BREAK_END_RE = /[\/\-_.:?#&=]$/;
const EXT_OR_LOC_HEAD_RE = /^(?:[\w@+\-~%]*\.[a-zA-Z0-9]{1,8}(?:$|[:#(])|:\d+(?::\d+)?(?:-L?\d+)?|#L\d+)/;
const SLASH_PATH_RE = /^(?:https?:\/\/|\/|~\/|\.\.?\/|[^/\s]+\/)/;

/** Whether a row's text reaches its last column (or was soft-wrapped). */
export function reachesEnd(r: RowText): boolean {
  if (r.wrap) return r.text.trim().length > 0;
  const n = r.text.replace(/\s+$/, '').length;
  return n > 0 && r.colOf[n] === r.colOf[r.colOf.length - 1];
}

interface RowContent {
  /** Index of the first inner character (after indentation and optional box gutter). */
  innerStart: number;
  /** Index after the last non-space inner character (before optional right box border). */
  innerEnd: number;
  /** Index after the end used when joining a soft-wrapped row (preserves explicit space). */
  wrapEnd: number;
  /** Column immediately after innerEnd. */
  endCol: number;
  /** Right boundary column of the row's content area (before any right box border). */
  contentRight: number;
  hasLeftBorder: boolean;
  hasRightBorder: boolean;
}

function rowContent(r: RowText): RowContent {
  const t = r.text;
  const totalCols = r.colOf[r.colOf.length - 1] ?? 0;
  const lb = LEFT_BORDER_RE.exec(t);
  const hasLeftBorder = !!lb;
  const innerStart = lb ? lb[0].length : t.length - t.trimStart().length;

  let hasRightBorder = false;
  let contentRight = totalCols;
  let innerEnd = t.trimEnd().length;
  const rb = RIGHT_BORDER_RE.exec(t);
  if (rb) {
    const borderIdx = t.lastIndexOf(rb[1]);
    if (borderIdx >= innerStart) {
      hasRightBorder = true;
      contentRight = r.colOf[borderIdx] ?? totalCols;
      innerEnd = t.slice(0, borderIdx).trimEnd().length;
    }
  }
  const endCol = r.colOf[innerEnd] ?? 0;
  let wrapEnd = innerEnd;
  if (r.wrap && !hasRightBorder) {
    if (r.writtenEnd !== undefined) wrapEnd = Math.min(t.length, Math.max(innerEnd, r.writtenEnd));
    else if (endCol < totalCols - 2) wrapEnd = t.length;
  }
  return { innerStart, innerEnd, wrapEnd, endCol, contentRight, hasLeftBorder, hasRightBorder };
}

/** Whether a URL or path on row `prev` may continue onto `next` on narrow screens. */
function continuesLink(prev: RowText, next: RowText): boolean {
  const p = rowContent(prev);
  const n = rowContent(next);
  if (p.innerEnd <= p.innerStart || n.innerEnd <= n.innerStart) return false;
  // Terminal soft-wrap: always continue, preserving any explicit trailing space.
  if (prev.wrap) return true;
  // Exact reach to the terminal edge (or 1-space inner padding before a right box border).
  const gap = p.contentRight - p.endCol;
  if (gap <= 0 || (p.hasRightBorder && gap <= 1)) return true;

  const prevSlice = prev.text.slice(p.innerStart, p.innerEnd);
  const nextSlice = next.text.slice(n.innerStart, n.innerEnd);
  const tail = PATH_TAIL_RE.exec(prevSlice)?.[0];
  const head = PATH_HEAD_RE.exec(nextSlice)?.[0];
  if (!tail || !head) return false;
  if (!PATH_CHAR_END_RE.test(tail) || !PATH_CHAR_START_RE.test(head)) return false;

  // Path/URL broken at a slash on a narrow line because the next segment did not fit.
  const firstSegLen = (head.match(/^[^/]+/)?.[0] ?? head).length;
  if (tail.endsWith('/') && SLASH_PATH_RE.test(tail) && p.endCol + firstSegLen > p.contentRight) return true;

  // TUI/padded narrow wrap (indented block or bordered box with symmetric right
  // padding up to 3 cols) mid-path or mid-URL: only join when indented/bordered
  // and the continuation clearly belongs to a path/URL so unpadded short lines
  // or prose wrapped after a complete filename are not glued.
  const paddedBlock = p.hasRightBorder || (p.innerStart >= 2 && n.innerStart >= 2);
  if (paddedBlock && gap <= Math.min(4, Math.max(2, p.innerStart + 1))) {
    if (BREAK_END_RE.test(tail) && (tail.includes('/') || tail.includes('://'))) return true;
    if (head.includes('/')) return true;
    if ((tail.includes('/') || tail.includes('://')) && EXT_OR_LOC_HEAD_RE.test(head)) return true;
  }
  return false;
}

/** URLs and paths on row y of a pane whose rows are top to bottom
 * (exclusive), with the cells they cover. A row whose text wraps onto the
 * next row (terminal soft-wrap, edge-reaching wrap, box-bordered wrap, or a
 * narrow TUI wrap of a path/URL) goes on in the next row after that row's
 * indentation and optional box gutter. */
export function linksAround(y: number, top: number, bottom: number, row: (y: number) => RowText): WrappedLink[] {
  const rows = new Map<number, RowText>();
  const at = (r: number) => {
    let v = rows.get(r);
    if (!v) rows.set(r, (v = row(r)));
    return v;
  };
  let a = y;
  while (a > top && y - a < WRAP_ROWS && continuesLink(at(a - 1), at(a))) a--;
  let b = y;
  while (b + 1 < bottom && b - y < WRAP_ROWS && continuesLink(at(b), at(b + 1))) b++;
  let text = '';
  const cellOf: Cells[] = [];
  for (let r = a; r <= b; r++) {
    const rt = at(r);
    const { text: t, colOf } = rt;
    const c = rowContent(rt);
    const start = r === a || (at(r - 1).wrap && !c.hasLeftBorder) ? 0 : c.innerStart;
    const end = r < b ? (rt.wrap ? c.wrapEnd : c.innerEnd) : c.hasRightBorder ? c.innerEnd : t.length;
    for (let i = start; i < end; i++) cellOf.push({ y: r, from: colOf[i], to: colOf[i + 1] });
    text += t.slice(start, end);
  }
  const out: WrappedLink[] = [];
  for (const l of findLinks(text)) {
    const cells: Cells[] = [];
    for (let i = l.start; i < l.end; i++) {
      const c = cellOf[i];
      const last = cells[cells.length - 1];
      if (last?.y === c.y) last.to = Math.max(last.to, c.to);
      else cells.push({ ...c });
    }
    if (cells.some((c) => c.y === y)) out.push({ kind: l.kind, text: l.text, cells });
  }
  return out;
}

const LEAD_WRAP = /^[\s"'`([{<\u201c\u2018\uff08\u3010\u300a\u300c\u300e\u3008\u3014\uff5b]*$/;
const TRAIL_WRAP =
  /^[\s"'`)\]}>.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001\u201d\u2019\uff09\u3011\u300b\u300d\u300f\u3009\u3015\uff5d\u2026\u2014\u2013]*$/;

/** The URL or path a selection holds, when it holds nothing else but quotes
 * or punctuation (ASCII or CJK) around it. Line breaks and the indentation
 * after them are dropped, as for a path wrapped over several rows. */
export function selectedLink(text: string): Pick<FoundLink, 'kind' | 'text'> | undefined {
  const s = text.replace(/[ \t]*\r?\n[ \t]*/g, '').trim();
  const l = findLinks(s).find((l) => LEAD_WRAP.test(s.slice(0, l.start)) && TRAIL_WRAP.test(s.slice(l.end)));
  return l && { kind: l.kind, text: l.text };
}

/** Tooltip for a link. */
export function linkTitle(l: { kind: FoundLink['kind']; text: string }): string {
  if (l.kind === 'url') return t('link.openUrl', { url: l.text });
  const base = parseLocation(l.text).path;
  return t(mediaExt.test(base) ? 'link.preview' : 'link.open');
}

/** Whether a link target may be opened: an absolute http(s) URL or mailto,
 * never on the page's own origin (see safeWebUrl). */
export function safeUrl(url: string): boolean {
  return safeWebUrl(url) !== undefined;
}
