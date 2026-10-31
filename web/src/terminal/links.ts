// Path and URL detection in pane output. Cmd/Ctrl+click opens media in Quick
// Look and code files in VS Code, resolving relative paths against the pane's
// working directory.

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

/** Tooltip for a link. */
export function linkTitle(l: { kind: FoundLink['kind']; text: string }): string {
  if (l.kind === 'url') return t('link.openUrl', { url: l.text });
  return t(mediaExt.test(l.text) ? 'link.preview' : 'link.open');
}

/** Opens a URL in a new tab, or a path in Quick Look or VS Code. */
export function openLink(l: { kind: FoundLink['kind']; text: string }, ctx: LinkContext) {
  if (l.kind === 'url') {
    window.open(l.text, '_blank', 'noopener');
    return;
  }
  const r = resolvePath(l.text, ctx);
  actions.openPath(ctx.m, r.path, r.line, r.col);
}
