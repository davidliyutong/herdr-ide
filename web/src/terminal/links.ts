// Path and URL detection in pane output, also over rows a long path was
// wrapped on. Cmd/Ctrl+click (or the pane's context menu) opens media in
// Quick Look and code files in VS Code, resolving relative paths against the
// pane's working directory.

import { actions } from '../actions';
import { t } from '../i18n';

export interface LinkContext {
  m: string;
  cwd?: string;
  home?: string;
}

// URLs, then paths with at least one slash or a known file extension,
// optionally followed by :line[:col].
const urlRe = /https?:\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]}]/g;
const pathRe =
  /(?:~|\.{1,2})?(?:\/[\w.@+\-~%]+)+\/?(?::\d+(?::\d+)?)?|(?:[\w.@+\-~%]+\/)+[\w.@+\-~%]+(?::\d+(?::\d+)?)?|[\w@+\-~%][\w.@+\-~%]*\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico|mp4|webm|mov|m4v|mkv|mp3|wav|ogg|flac|m4a|pdf|md|txt|log|json|ya?ml|toml|csv|py|ts|tsx|js|jsx|go|rs|c|cc|cpp|h|hpp|java|sh|ipynb)(?::\d+(?::\d+)?)?/g;

export const mediaExt = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|mp4|webm|mov|m4v|mkv|mp3|wav|ogg|flac|m4a|aac|pdf)$/i;

export function resolvePath(raw: string, ctx: LinkContext): { path: string; line?: number; col?: number } {
  let p = raw;
  let line: number | undefined;
  let col: number | undefined;
  const m = /:(\d+)(?::(\d+))?$/.exec(p);
  if (m) {
    line = Number(m[1]);
    col = m[2] ? Number(m[2]) : undefined;
    p = p.slice(0, m.index);
  }
  if (p.startsWith('~/') && ctx.home) p = ctx.home + p.slice(1);
  else if (!p.startsWith('/') && ctx.cwd) p = ctx.cwd.replace(/\/$/, '') + '/' + p;
  // Normalize ./ and ../ segments.
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return { path: '/' + out.join('/'), line, col };
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
    if (out.some((l) => start < l.end && end > l.start)) return;
    out.push({ start, end, text: text.slice(start, end), kind });
  };
  for (const m of text.matchAll(urlRe)) add(m.index!, m.index! + m[0].length, 'url');
  for (const m of text.matchAll(pathRe)) {
    if (m[0].length < 2 || /^\/+$/.test(m[0])) continue;
    add(m.index!, m.index! + m[0].length, 'path');
  }
  return out;
}

/** A row of a pane as Grid.rowText returns it: the column of each UTF-16
 * index of the text, then the column after the row. */
export interface RowText {
  text: string;
  colOf: number[];
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

/** Whether a row's text reaches its last column. */
function reachesEnd(r: RowText): boolean {
  const n = r.text.replace(/\s+$/, '').length;
  return n > 0 && r.colOf[n] === r.colOf[r.colOf.length - 1];
}

/** URLs and paths on row y of a pane whose rows are top to bottom
 * (exclusive), with the cells they cover. A row whose text reaches the last
 * column goes on in the next row after that row's indentation: the
 * terminal, or a program that wraps its own text (Claude Code, Codex), split
 * a long path or URL there. */
export function linksAround(y: number, top: number, bottom: number, row: (y: number) => RowText): WrappedLink[] {
  const rows = new Map<number, RowText>();
  const at = (r: number) => {
    let v = rows.get(r);
    if (!v) rows.set(r, (v = row(r)));
    return v;
  };
  let a = y;
  while (a > top && y - a < WRAP_ROWS && reachesEnd(at(a - 1))) a--;
  let b = y;
  while (b + 1 < bottom && b - y < WRAP_ROWS && reachesEnd(at(b))) b++;
  let text = '';
  const cellOf: Cells[] = [];
  for (let r = a; r <= b; r++) {
    const { text: t, colOf } = at(r);
    const start = r === a ? 0 : t.length - t.trimStart().length;
    for (let i = start; i < t.length; i++) cellOf.push({ y: r, from: colOf[i], to: colOf[i + 1] });
    text += t.slice(start);
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

/** The URL or path a selection holds, when it holds nothing else but quotes
 * or punctuation around it. Line breaks and the indentation after them are
 * dropped, as for a path wrapped over several rows. */
export function selectedLink(text: string): Pick<FoundLink, 'kind' | 'text'> | undefined {
  const s = text.replace(/[ \t]*\r?\n[ \t]*/g, '').trim();
  const l = findLinks(s).find((l) => /^["'`([{<]*$/.test(s.slice(0, l.start)) && /^["'`)\]}>.,;:!?]*$/.test(s.slice(l.end)));
  return l && { kind: l.kind, text: l.text };
}

/** Tooltip for a link. */
export function linkTitle(l: { kind: FoundLink['kind']; text: string }): string {
  if (l.kind === 'url') return t('link.openUrl', { url: l.text });
  return t(mediaExt.test(l.text) ? 'link.preview' : 'link.open');
}

/** Whether a link target may be opened: http(s) and mailto only. */
export function safeUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Opens a URL in a new tab, or a path in Quick Look or VS Code. */
export function openLink(l: { kind: FoundLink['kind']; text: string }, ctx: LinkContext) {
  if (l.kind === 'url') {
    // Targets come from pane output (OSC 8): web links only.
    if (safeUrl(l.text)) window.open(l.text, '_blank', 'noopener');
    return;
  }
  const r = resolvePath(l.text, ctx);
  actions.openPath(ctx.m, r.path, r.line, r.col);
}
