// The Git panel's history, docked at the bottom of the panel as VS Code's
// Source Control Graph: a header that stays at the bottom while the
// history is collapsed and, expanded, a list that grows upward from it
// (its height dragged by the header's top edge, kept per browser). The
// list is every commit of the repository's branches, newest first, with
// the graph's lanes and the branches and tags at each commit, loaded a
// page at a time as it scrolls; only the rows in view are drawn. A click
// shows a commit's files under it (a file opens its diff), the context
// menu copies the hash or opens the graph pane there.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GitGraph, Tag as TagIcon } from 'lucide-react';
import { openMenu } from '../../contextMenu';
import { t } from '../../i18n';
import { useSize } from '../../lib/sizes';
import { gitApi, errorText, type Change, type Commit, type Ref } from './api';
import { appendCommits, layoutGraph, newPaging, type Paging } from './graph';
import { GraphCell, laneColor } from './GraphCell';
import { badgesOf, type Badge } from './GraphPane';
import { folderOf, leafName, letterColor } from './GitPanel';
import { FileIcon } from '../../fileIcons';
import { copy, openDiff, openGraph, short } from './ops';

/** The commits of a page. */
export const PAGE = 200;
/** The most commits the first page reads again (the machine's largest page). */
const MAX_RELOAD = 1000;
/** A lane's width in pixels. */
const LANE = 12;
const HEIGHT_KEY = 'git.historyHeight';
const OPEN_KEY = 'git.historyOpen';

function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* per browser only */
  }
}

/** How long ago a time was, short (5m, 3h, 2d, 4w, 2y). */
export function ago(secs: number, now = Date.now() / 1000): string {
  const d = Math.max(0, now - secs);
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  if (d < 86400 * 14) return `${Math.round(d / 86400)}d`;
  if (d < 86400 * 365) return `${Math.round(d / (86400 * 7))}w`;
  return `${Math.round(d / (86400 * 365))}y`;
}

type Line =
  | { kind: 'commit'; i: number }
  | { kind: 'file'; i: number; f: Change; hash: string; multi: boolean }
  | { kind: 'note'; i: number; text: string };

/** version is the repository's refs version (state.ts): the list is read
 * again when it moves. */
export function History({ m, root, version, branch, head }: { m: string; root: string; version: number; branch?: string; head?: string }) {
  const rowH = useSize('row');
  const [open, setOpen] = useState(() => stored(OPEN_KEY, true));
  const [height, setHeight] = useState(() => stored<number | undefined>(HEIGHT_KEY, undefined));
  const [commits, setCommits] = useState<Commit[]>([]);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<string>();
  const [files, setFiles] = useState<{ hash: string; files?: Change[]; error?: string }>();
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  const list = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  // The list's paging, replaced when the first page is read again: an
  // answer for an earlier one is dropped.
  const page = useRef<Paging>(newPaging());

  // The first page (as many commits as were loaded, up to MAX_RELOAD),
  // again whenever the refs changed.
  useEffect(() => {
    if (!open) return;
    const pg = newPaging();
    const limit = Math.min(MAX_RELOAD, Math.max(PAGE, page.current.next));
    page.current = pg;
    gitApi
      .log(m, root, { limit })
      .then((l) => {
        if (page.current !== pg) return;
        pg.next = l.commits.length;
        pg.ready = true;
        setCommits(l.commits);
        setRefs(l.refs ?? []);
        setMore(l.more);
        setError(undefined);
      })
      .catch((e) => page.current === pg && setError(errorText(e)));
  }, [m, root, version, open]);

  const loadMore = async () => {
    const pg = page.current;
    if (!more || !pg.ready || pg.loading || pg.failed) return;
    pg.loading = true;
    try {
      const l = await gitApi.log(m, root, { skip: pg.next, limit: PAGE });
      if (page.current !== pg) return;
      pg.next += l.commits.length;
      setCommits((c) => appendCommits(c, l.commits));
      setMore(l.more && l.commits.length > 0);
    } catch (e) {
      if (page.current !== pg) return;
      // Not asked again until the list is read again.
      pg.failed = true;
      setError(errorText(e));
    } finally {
      pg.loading = false;
    }
  };

  // A commit's files, under it (a commit never changes).
  useEffect(() => {
    if (!expanded) return setFiles(undefined);
    let gone = false;
    setFiles({ hash: expanded });
    gitApi
      .show(m, root, expanded)
      .then((s) => !gone && setFiles({ hash: expanded, files: s.files }))
      .catch((e) => !gone && setFiles({ hash: expanded, error: errorText(e) }));
    return () => {
      gone = true;
    };
  }, [m, root, expanded]);

  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const badges = useMemo(() => badgesOf(refs, branch, head, true), [refs, branch, head]);
  const lines = useMemo(() => {
    const out: Line[] = [];
    commits.forEach((c, i) => {
      out.push({ kind: 'commit', i });
      if (c.hash !== expanded) return;
      if (files?.error) out.push({ kind: 'note', i, text: files.error });
      else if (!files?.files) out.push({ kind: 'note', i, text: t('git.loading') });
      else for (const f of files.files) out.push({ kind: 'file', i, f, hash: c.hash, multi: c.parents.length > 1 });
    });
    return out;
  }, [commits, expanded, files]);

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const update = () => setScroll({ top: el.scrollTop, height: el.clientHeight });
    update();
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [open]);
  useEffect(() => {
    if (more && scroll.top + scroll.height > lines.length * rowH - 20 * rowH) void loadMore();
  });

  const toggle = () => {
    setOpen(!open);
    store(OPEN_KEY, !open);
  };

  // The header's top edge sets the height; far down, it collapses.
  const resize = (ev: React.PointerEvent) => {
    if (ev.button !== 0 || !open) return;
    ev.preventDefault();
    const panel = section.current?.parentElement;
    const start = ev.clientY;
    const startH = list.current?.parentElement?.clientHeight ?? 0;
    const max = (panel?.clientHeight ?? 600) - 4 * rowH;
    let h = startH;
    document.body.classList.add('resizing-row');
    const move = (e: PointerEvent) => {
      h = Math.max(2 * rowH, Math.min(max, startH - (e.clientY - start)));
      setHeight(h);
    };
    const up = () => {
      document.body.classList.remove('resizing-row');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      store(HEIGHT_KEY, h);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const first = Math.max(0, Math.floor(scroll.top / rowH) - 10);
  const last = Math.min(lines.length, Math.ceil((scroll.top + (scroll.height || 600)) / rowH) + 10);
  // The lanes as wide as the rows drawn need, not the whole history.
  let lanes = 1;
  for (let k = first; k < last; k++) {
    const l = lines[k];
    if (l.kind === 'commit') lanes = Math.max(lanes, graph.rows[l.i]?.width ?? 1);
  }

  const commitRow = (c: Commit, i: number, top: number) => {
    const row = graph.rows[i];
    const b = badges.get(c.hash) ?? [];
    const isOpen = c.hash === expanded;
    return (
      <div
        key={c.hash}
        className={`git-history-row ${isOpen ? 'open' : ''}`}
        style={{ top, height: rowH }}
        title={`${short(c.hash)} · ${c.author} · ${new Date(c.date * 1000).toLocaleString()}\n${c.subject}`}
        onClick={() => setExpanded(isOpen ? undefined : c.hash)}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e, [
            { label: t('git.graph.copyHash'), run: () => copy(c.hash) },
            { label: t('git.openGraph'), run: () => void openGraph(m, root) },
          ]);
        }}
      >
        <GraphCell row={row} width={lanes} height={rowH} lane={LANE} kind={c.hash === head ? 'head' : 'commit'} />
        <span className="git-history-subject ellipsis">{c.subject}</span>
        {b.slice(0, 2).map((x) => (
          <RefBadge key={x.kind + x.name} b={x} color={laneColor(row?.color ?? 0)} />
        ))}
        {b.length > 2 && <span className="tag">+{b.length - 2}</span>}
        <span className="git-history-meta">{ago(c.date)}</span>
      </div>
    );
  };

  const fileRow = (l: Extract<Line, { kind: 'file' }>, top: number) => {
    const f = l.f;
    return (
      <div
        key={`${l.hash}:${f.path}`}
        className="git-history-file"
        style={{ top, height: rowH }}
        title={f.orig ? `${f.orig} → ${f.path}` : f.path}
        onClick={() =>
          void openDiff(m, { repo: root, path: f.path, orig: f.orig, mode: 'commit', rev: l.hash, parent: l.multi ? 1 : undefined })
        }
      >
        <GraphCell row={graph.rows[l.i]} width={lanes} height={rowH} lane={LANE} through />
        <FileIcon name={leafName(f.path)} kind="file" />
        <span className={`ellipsis${f.status === 'D' ? ' git-deleted' : ''}`} style={{ color: letterColor(f.status) }}>
          {leafName(f.path)}
        </span>
        <span className="git-path ellipsis muted">{folderOf(f.path)}</span>
        <span className="spacer" />
        {!f.binary && (
          <span className="git-stat">
            <span className="add">+{f.added}</span> <span className="del">−{f.deleted}</span>
          </span>
        )}
        <span className="git-letter" style={{ color: letterColor(f.status) }}>
          {f.status}
        </span>
      </div>
    );
  };

  return (
    <section ref={section} className={`git-history ${open ? 'open' : ''}`} aria-label={t('git.group.recent')}>
      <div className="section-head git-history-head" onClick={toggle}>
        <div className="git-history-resizer" onPointerDown={resize} onClick={(e) => e.stopPropagation()} />
        {open ? <ChevronDown /> : <ChevronRight />}
        <span className="ellipsis">{t('git.group.recent')}</span>
        <span className="section-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon sm" title={t('git.openGraph')} aria-label={t('git.openGraph')} onClick={() => void openGraph(m, root)}>
            <GitGraph />
          </button>
        </span>
      </div>
      {open && (
        <div className="git-history-body" style={height ? { height } : undefined}>
          {error && <div className="callout error">{error}</div>}
          <div
            className="git-history-list"
            ref={list}
            onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
          >
            <div style={{ position: 'relative', height: lines.length * rowH }}>
              {lines.slice(first, last).map((l, k) => {
                const top = (first + k) * rowH;
                if (l.kind === 'commit') return commitRow(commits[l.i], l.i, top);
                if (l.kind === 'file') return fileRow(l, top);
                return (
                  <div key={`note:${first + k}`} className="git-history-file muted" style={{ top, height: rowH }}>
                    <GraphCell row={graph.rows[l.i]} width={lanes} height={rowH} lane={LANE} through />
                    {l.text}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** A branch or tag at a commit, in its lane's color. */
function RefBadge({ b, color }: { b: Badge; color: string }) {
  return (
    <span className={`git-ref ${b.kind} ${b.current ? 'current' : ''}`} style={{ '--ref': color } as React.CSSProperties} title={b.name}>
      {b.kind === 'tag' && <TagIcon />}
      <span className="ellipsis">{b.name}</span>
    </span>
  );
}
