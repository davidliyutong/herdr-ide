// Path and URL detection in pane output. Cmd/Ctrl+click opens media in Quick
// Look and code files in VS Code, resolving relative paths against the pane's
// working directory.

import type { ILink, ILinkProvider, IBufferLine, Terminal } from '@xterm/xterm';
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

/** Text of a buffer line plus a map from string index to cell column. */
function lineText(line: IBufferLine, cols: number): { text: string; colOf: number[] } {
  let text = '';
  const colOf: number[] = [];
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // trailing half of a wide char
    const chars = cell.getChars() || ' ';
    for (let i = 0; i < chars.length; i++) colOf.push(x);
    text += chars;
  }
  colOf.push(cols);
  return { text, colOf };
}

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

export function pathLinkProvider(term: Terminal, ctx: () => LinkContext): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      const { text, colOf } = lineText(line, term.cols);
      const links: ILink[] = [];
      const taken: Array<[number, number]> = [];
      const add = (start: number, end: number, activate: (ev: MouseEvent) => void, tooltip: string) => {
        if (taken.some(([a, b]) => start < b && end > a)) return;
        taken.push([start, end]);
        links.push({
          range: { start: { x: colOf[start] + 1, y }, end: { x: colOf[end - 1] + 1, y } },
          text: text.slice(start, end),
          decorations: { underline: true, pointerCursor: true },
          activate: (ev) => {
            if (!(ev.metaKey || ev.ctrlKey)) return;
            activate(ev);
          },
          hover: () => {
            const el = term.element;
            if (el) el.title = tooltip;
          },
          leave: () => {
            const el = term.element;
            if (el) el.title = '';
          },
        });
      };
      for (const m of text.matchAll(urlRe)) {
        const url = m[0];
        add(m.index!, m.index! + url.length, () => window.open(url, '_blank', 'noopener'), t('link.openUrl', { url }));
      }
      for (const m of text.matchAll(pathRe)) {
        const raw = m[0];
        if (raw.length < 2 || /^\/+$/.test(raw)) continue;
        add(
          m.index!,
          m.index! + raw.length,
          () => {
            const c = ctx();
            const r = resolvePath(raw, c);
            actions.openPath(c.m, r.path, r.line, r.col);
          },
          t(mediaExt.test(raw) ? 'link.preview' : 'link.open'),
        );
      }
      callback(links.length ? links : undefined);
    },
  };
}
