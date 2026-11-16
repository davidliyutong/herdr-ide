// The Git graph pane ({view: {plugin: 'git', kind: 'graph', repo}}), as
// the Git Graph extension of VS Code: the history of all branches (or one)
// with its lanes (graph.ts), the working tree's changes on top and the
// stashes, badges for HEAD, branches, remote branches and tags, a search
// that dims the other commits, and pages loaded as the list scrolls. A
// click shows a commit's details under it (its message and files; a file
// opens its diff), a Cmd/Ctrl-click on a second commit compares the two,
// and context menus on commits, badges and stashes act on them.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, GitBranch, RefreshCw, Search, Tag as TagIcon, X } from 'lucide-react';
import { useStore } from '../../state/store';
import { useSize } from '../../lib/sizes';
import { openMenu, type MenuEntry } from '../../contextMenu';
import { t, type MessageKey } from '../../i18n';
import { FileIcon } from '../../fileIcons';
import type { PaneViewProps } from '../api';
import { gitApi, errorText, type Commit, type Ref, type Shown, type Stash, type StatusFile } from './api';
import { appendCommits, layoutGraph, newPaging, type GraphCommit, type Paging } from './graph';
import { GraphCell, LANE_COLORS, laneColor } from './GraphCell';
import {
  checkoutRemote,
  copy,
  createBranch,
  createTag,
  deleteBranch,
  deleteTag,
  openDiff,
  openStatusDiff,
  renameBranch,
  reset,
  short,
  stashDrop,
  stashParams,
} from './ops';
import { folderOf, leafName, letterColor, letterMark } from './GitPanel';
import { changed, runGit, useRepo } from './state';
import { pushTag, pushTo, remoteOf } from './pickers';
import './git.css';

export const LANE_W = 14;
export const DETAIL_H = 300;
/** The commits of a page. */
export const PAGE = 300;
/** The ref of the working tree's row and its hash in the graph. */
export const UNCOMMITTED = '*';

export type Row =
  | { kind: 'uncommitted'; hash: string; parents: string[]; files: StatusFile[] }
  | { kind: 'commit'; hash: string; parents: string[]; c: Commit }
  | { kind: 'stash'; hash: string; parents: string[]; s: Stash };

/** The graph's rows: the working tree's changes (when there are some) on
 * HEAD, the commits, and the stashes whose base is shown, each above the
 * first commit older than it and never below its base. */
export function graphRows(commits: Commit[], stashes: Stash[], head: string | undefined, changes: StatusFile[]): Row[] {
  const rows: Row[] = commits.map((c) => ({ kind: 'commit', hash: c.hash, parents: c.parents, c }));
  const index = new Map(commits.map((c, i) => [c.hash, i]));
  const placed = [...stashes]
    .filter((s) => index.has(s.base))
    .map((s) => {
      const base = index.get(s.base)!;
      let at = commits.findIndex((c) => c.date < s.date);
      if (at < 0 || at > base) at = base;
      return { at, s };
    })
    .sort((a, b) => b.at - a.at || a.s.index - b.s.index);
  for (const { at, s } of placed) rows.splice(at, 0, { kind: 'stash', hash: s.hash, parents: [s.base], s });
  const shown = changes.filter((f) => f.kind !== 'ignored');
  if (shown.length && head && index.has(head)) rows.unshift({ kind: 'uncommitted', hash: UNCOMMITTED, parents: [head], files: shown });
  return rows;
}

/** A badge of a ref. */
export interface Badge {
  kind: 'head' | 'branch' | 'remote' | 'tag';
  /** Short name (main, origin/main, v1). */
  name: string;
  /** The current branch. */
  current?: boolean;
}

/** The badges of each commit: branches (the current one first), remote
 * branches (when shown) and tags. */
export function badgesOf(refs: Ref[], branch: string | undefined, head: string | undefined, remotes: boolean): Map<string, Badge[]> {
  const out = new Map<string, Badge[]>();
  const add = (h: string, b: Badge) => {
    const l = out.get(h) ?? [];
    l.push(b);
    out.set(h, l);
  };
  if (head && !branch) add(head, { kind: 'head', name: 'HEAD', current: true });
  for (const r of refs) {
    if (r.name.startsWith('refs/heads/')) {
      const name = r.name.slice(11);
      add(r.hash, { kind: 'branch', name, current: name === branch });
    } else if (r.name.startsWith('refs/remotes/')) {
      if (remotes) add(r.hash, { kind: 'remote', name: r.name.slice(13) });
    } else if (r.name.startsWith('refs/tags/')) add(r.hash, { kind: 'tag', name: r.name.slice(10) });
  }
  const order = { head: 0, branch: 1, remote: 2, tag: 3 };
  for (const l of out.values()) l.sort((a, b) => Number(!!b.current) - Number(!!a.current) || order[a.kind] - order[b.kind]);
  return out;
}

/** Whether a row matches a search (subject, author, e-mail, hash). */
export function matches(r: Row, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  if (r.kind === 'commit') {
    const c = r.c;
    return (
      c.subject.toLowerCase().includes(s) || c.author.toLowerCase().includes(s) || c.email.toLowerCase().includes(s) || c.hash.startsWith(s)
    );
  }
  if (r.kind === 'stash') return r.s.message.toLowerCase().includes(s) || r.hash.startsWith(s);
  return false;
}

const fmtDate = (secs: number) => {
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

interface Loaded {
  commits: Commit[];
  more: boolean;
  refs: Ref[];
  stashes: Stash[];
  head?: string;
  branch?: string;
}

export function GraphPane({ m, view }: PaneViewProps) {
  // Rows are --h-row high, which scales with the UI font size.
  const ROW_H = useSize('row');
  const repo = String(view.repo ?? '');
  const st = useRepo(m, repo);
  const readOnly = useStore((s) => s.readOnly);
  const [data, setData] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('');
  const [remotes, setRemotes] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [compare, setCompare] = useState<string>();
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const [loadingMore, setLoadingMore] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // The log follows the refs (HEAD, branches, tags, stashes), not the
  // working tree: the uncommitted row comes from the status.
  const version = st?.refs ?? 0;

  // The first page when the repository, the filter or the remotes' switch
  // change, and when the refs did (then as many commits as were loaded, at
  // most 1000). Each read replaces the paging: answers for an earlier one
  // (another filter's, an older list's) are dropped.
  const page = useRef<Paging>(newPaging());
  const scope = useRef('');
  useEffect(() => {
    const sc = `${m}\u0000${repo}\u0000${filter}\u0000${remotes}`;
    const limit = scope.current === sc ? Math.min(1000, Math.max(PAGE, page.current.next)) : PAGE;
    scope.current = sc;
    const pg = newPaging();
    page.current = pg;
    setLoadingMore(false);
    gitApi
      .log(m, repo, { limit, branches: filter ? [filter] : undefined, remotes })
      .then((l) => {
        if (page.current !== pg) return;
        pg.next = l.commits.length;
        pg.ready = true;
        setData({ commits: l.commits, more: l.more, refs: l.refs ?? [], stashes: l.stashes ?? [], head: l.head, branch: l.branch });
        setError(undefined);
      })
      .catch((e) => page.current === pg && setError(errorText(e)));
  }, [m, repo, filter, remotes, version]);

  const loadMore = async () => {
    const pg = page.current;
    if (!data?.more || !pg.ready || pg.loading || pg.failed) return;
    pg.loading = true;
    setLoadingMore(true);
    try {
      const l = await gitApi.log(m, repo, { skip: pg.next, limit: PAGE, branches: filter ? [filter] : undefined, remotes });
      if (page.current !== pg) return;
      pg.next += l.commits.length;
      setData((d) => d && { ...d, commits: appendCommits(d.commits, l.commits), more: l.more && l.commits.length > 0 });
    } catch (e) {
      if (page.current !== pg) return;
      // Not asked again until the list is read again.
      pg.failed = true;
      setError(errorText(e));
    } finally {
      pg.loading = false;
      if (page.current === pg) setLoadingMore(false);
    }
  };

  const rows = useMemo(
    () => (data ? graphRows(data.commits, filter ? [] : data.stashes, data.head, filter ? [] : (st?.status?.files ?? [])) : []),
    [data, filter, st?.status],
  );
  const graph = useMemo(() => layoutGraph(rows as GraphCommit[], LANE_COLORS), [rows]);
  const badges = useMemo(() => badgesOf(data?.refs ?? [], data?.branch, data?.head, remotes), [data, remotes]);
  const hits = useMemo(() => (query ? rows.flatMap((r, i) => (matches(r, query) ? [i] : [])) : []), [rows, query]);
  const [hit, setHit] = useState(0);

  // Layout: rows of ROW_H, the selected row's details under it.
  const selIndex = selected ? rows.findIndex((r) => r.hash === selected) : -1;
  const top = (i: number) => i * ROW_H + (selIndex >= 0 && i > selIndex ? DETAIL_H : 0);
  const total = rows.length * ROW_H + (selIndex >= 0 ? DETAIL_H : 0);
  const graphW = Math.min(graph.width, 24) * LANE_W + 4;

  const scrollTo = (i: number) => {
    const el = listRef.current;
    if (!el) return;
    const y = top(i);
    if (y < el.scrollTop || y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, y - el.clientHeight / 3);
  };
  useEffect(() => {
    if (hits.length) scrollTo(hits[Math.min(hit, hits.length - 1)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits, hit]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Near the end: the next page.
  useEffect(() => {
    if (data?.more && scroll.top + scroll.height > total - 20 * ROW_H) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroll, total, data?.more]);

  const first = Math.max(0, Math.floor((scroll.top - (selIndex >= 0 && scroll.top > top(selIndex) ? DETAIL_H : 0)) / ROW_H) - 10);
  const visible: number[] = [];
  for (let i = first; i < rows.length && top(i) < scroll.top + scroll.height + 10 * ROW_H; i++) visible.push(i);

  const branchNames = useMemo(() => {
    const local: string[] = [];
    const remote: string[] = [];
    for (const r of data?.refs ?? []) {
      if (r.name.startsWith('refs/heads/')) local.push(r.name.slice(11));
      else if (r.name.startsWith('refs/remotes/')) remote.push(r.name.slice(13));
    }
    return { local, remote };
  }, [data]);

  const run = (action: string, params: Record<string, unknown> = {}) => void runGit(m, repo, action, params);
  const current = data?.branch;
  const remoteNames = st?.info?.remotes ?? [];
  /** Push to the only remote, or To… one chosen (several). */
  const pushLabel = (key: 'git.graph.pushBranch' | 'git.graph.pushTag') =>
    remoteNames.length === 1 ? t(key, { remote: remoteNames[0] }) : t('git.pushTo');

  const commitMenu = (e: React.MouseEvent, c: Commit) => {
    e.preventDefault();
    const merge = c.parents.length > 1;
    const items: MenuEntry[] = [
      { label: t('git.graph.checkout'), disabled: readOnly, run: () => run('checkout', { rev: c.hash }) },
      { label: t('git.branch.createHere'), disabled: readOnly, run: () => void createBranch(m, repo, c.hash) },
      { label: t('git.tag.createHere'), disabled: readOnly, run: () => void createTag(m, repo, c.hash) },
      'sep',
      {
        label: t('git.graph.merge', { branch: current ?? 'HEAD' }),
        disabled: readOnly || c.hash === data?.head,
        run: () => run('merge', { ref: c.hash }),
      },
      {
        label: t('git.graph.cherryPick'),
        disabled: readOnly,
        run: () => run('cherryPick', { rev: c.hash, parent: merge ? 1 : undefined }),
      },
      { label: t('git.graph.revert'), disabled: readOnly, run: () => run('revert', { rev: c.hash, parent: merge ? 1 : undefined }) },
      {
        label: t('git.graph.reset', { branch: current ?? 'HEAD' }),
        disabled: readOnly,
        submenu: (['soft', 'mixed', 'hard'] as const).map((mode) => ({
          label: t(`git.reset.${mode}` as 'git.reset.soft'),
          danger: mode === 'hard',
          run: () => void reset(m, repo, c.hash, mode, current),
        })),
      },
      'sep',
      {
        label: t('git.graph.compareHead'),
        disabled: c.hash === data?.head || !data?.head,
        run: () => (setSelected(c.hash), setCompare(data!.head)),
      },
      { label: t('git.graph.copyHash'), run: () => copy(c.hash) },
      { label: t('git.graph.copySubject'), run: () => copy(c.subject) },
    ];
    openMenu(e, items);
  };

  const badgeMenu = (e: React.MouseEvent, b: Badge) => {
    e.preventDefault();
    e.stopPropagation();
    let items: MenuEntry[] = [];
    const at = { x: e.clientX, y: e.clientY };
    if (b.kind === 'branch') {
      items = [
        {
          label: t('git.graph.checkoutBranch', { branch: b.name }),
          disabled: readOnly || b.current,
          run: () => run('checkout', { name: b.name }),
        },
        {
          label: t('git.graph.mergeInto', { branch: b.name, current: current ?? 'HEAD' }),
          disabled: readOnly || b.current,
          run: () => run('merge', { ref: b.name }),
        },
        {
          label: t('git.graph.rebaseOnto', { branch: b.name, current: current ?? 'HEAD' }),
          disabled: readOnly || b.current || !current,
          run: () => run('rebase', { onto: b.name }),
        },
        'sep',
        { label: t('git.branch.rename'), disabled: readOnly, run: () => void renameBranch(m, repo, b.name) },
        { label: t('git.branch.delete'), danger: true, disabled: readOnly || b.current, run: () => void deleteBranch(m, repo, b.name) },
        'sep',
        {
          label: pushLabel('git.graph.pushBranch'),
          disabled: readOnly || !remoteNames.length,
          run: () => void pushTo(m, repo, at, st?.info, b.name),
        },
        { label: t('git.graph.copyName'), run: () => copy(b.name) },
      ];
    } else if (b.kind === 'remote') {
      const remote = remoteOf(b.name, remoteNames);
      items = [
        {
          label: t('git.graph.checkoutRemote', { branch: b.name }),
          disabled: readOnly,
          run: () => void checkoutRemote(m, repo, b.name, remote),
        },
        {
          label: t('git.graph.mergeInto', { branch: b.name, current: current ?? 'HEAD' }),
          disabled: readOnly,
          run: () => run('merge', { ref: b.name }),
        },
        'sep',
        { label: t('git.graph.fetchRemote', { remote }), disabled: readOnly, run: () => run('fetch', { remote, prune: true }) },
        {
          label: t('git.branch.deleteRemoteItem'),
          danger: true,
          disabled: readOnly,
          run: () => void deleteBranch(m, repo, b.name.slice(remote.length + 1), remote),
        },
        { label: t('git.graph.copyName'), run: () => copy(b.name) },
      ];
    } else if (b.kind === 'tag') {
      items = [
        { label: t('git.tag.delete'), danger: true, disabled: readOnly, run: () => void deleteTag(m, repo, b.name) },
        {
          label: pushLabel('git.graph.pushTag'),
          disabled: readOnly || !remoteNames.length,
          run: () => void pushTag(m, repo, at, st?.info, b.name),
        },
        { label: t('git.graph.copyName'), run: () => copy(b.name) },
      ];
    } else return;
    openMenu(e, items);
  };

  const stashMenu = (e: React.MouseEvent, s: Stash) => {
    e.preventDefault();
    openMenu(e, [
      { label: t('git.stash.apply'), disabled: readOnly, run: () => run('stashApply', stashParams(s)) },
      { label: t('git.stash.pop'), disabled: readOnly, run: () => run('stashPop', stashParams(s)) },
      { label: t('git.stash.drop'), danger: true, disabled: readOnly, run: () => void stashDrop(m, repo, s) },
      { label: t('git.graph.copyHash'), run: () => copy(s.hash) },
    ]);
  };

  const click = (e: React.MouseEvent, r: Row) => {
    if ((e.metaKey || e.ctrlKey) && selected && selected !== r.hash && r.kind !== 'uncommitted' && selected !== UNCOMMITTED) {
      setCompare(r.hash);
      return;
    }
    setCompare(undefined);
    setSelected(selected === r.hash ? undefined : r.hash);
  };

  return (
    <div className="git-graph">
      <div className="git-graph-bar">
        <GitBranch className="muted" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('git.graph.branches')}>
          <option value="">{t('git.graph.allBranches')}</option>
          {branchNames.local.map((b) => (
            <option key={'l' + b} value={b}>
              {b}
            </option>
          ))}
          {remotes &&
            branchNames.remote.map((b) => (
              <option key={'r' + b} value={b}>
                {b}
              </option>
            ))}
        </select>
        <label className="small git-check">
          <input type="checkbox" checked={remotes} onChange={(e) => setRemotes(e.target.checked)} /> {t('git.graph.showRemotes')}
        </label>
        <span className="spacer" />
        <span className="git-search">
          <Search />
          <input
            value={query}
            placeholder={t('git.graph.search')}
            aria-label={t('git.graph.search')}
            onChange={(e) => (setQuery(e.target.value), setHit(0))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && hits.length) setHit((h) => (h + (e.shiftKey ? hits.length - 1 : 1)) % hits.length);
              if (e.key === 'Escape') setQuery('');
            }}
          />
          {query && (
            <>
              <span className="muted small">{hits.length ? `${Math.min(hit, hits.length - 1) + 1}/${hits.length}` : '0'}</span>
              <button
                className="icon"
                title={t('git.graph.previousMatch')}
                aria-label={t('git.graph.previousMatch')}
                onClick={() => hits.length && setHit((h) => (h + hits.length - 1) % hits.length)}
              >
                <ChevronUp />
              </button>
              <button
                className="icon"
                title={t('git.graph.nextMatch')}
                aria-label={t('git.graph.nextMatch')}
                onClick={() => hits.length && setHit((h) => (h + 1) % hits.length)}
              >
                <ChevronDown />
              </button>
            </>
          )}
        </span>
        <button
          className="icon"
          title={t('git.refresh')}
          aria-label={t('git.refresh')}
          onClick={() => void changed(m, repo, { all: true })}
        >
          <RefreshCw />
        </button>
      </div>
      {error && <div className="git-error small">{error}</div>}
      {!data && !error && <div className="git-note muted">{t('git.loading')}</div>}
      {data && !rows.length && <div className="git-note muted">{t('git.noCommits')}</div>}
      <div
        className="git-graph-list"
        ref={listRef}
        onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      >
        <div style={{ height: total, position: 'relative' }}>
          {visible.map((i) => {
            const r = rows[i];
            const dim = !!query && !matches(r, query);
            const sel = r.hash === selected || r.hash === compare;
            const kind =
              r.kind === 'uncommitted' ? 'uncommitted' : r.kind === 'stash' ? 'stash' : r.hash === data?.head ? 'head' : 'commit';
            return [
              <div
                key={r.hash}
                className={`git-graph-row${sel ? ' sel' : ''}${dim ? ' dim' : ''}${hits[hit] === i && query ? ' hit' : ''}`}
                style={{ top: top(i), height: ROW_H }}
                onClick={(e) => click(e, r)}
                onContextMenu={(e) => (r.kind === 'commit' ? commitMenu(e, r.c) : r.kind === 'stash' ? stashMenu(e, r.s) : undefined)}
              >
                <span className="git-graph-lanes" style={{ width: graphW }}>
                  <GraphCell row={graph.rows[i]} width={graph.width} height={ROW_H} lane={LANE_W} kind={kind} />
                </span>
                <span className="git-graph-desc ellipsis">
                  {r.kind === 'commit' &&
                    (badges.get(r.hash) ?? []).map((b) => (
                      <span
                        key={b.kind + b.name}
                        className={`git-badge ${b.kind}${b.current ? ' current' : ''}`}
                        style={{ borderColor: laneColor(graph.rows[i].color) }}
                        onContextMenu={(e) => badgeMenu(e, b)}
                        onDoubleClick={(e) => (e.stopPropagation(), b.kind === 'branch' && !readOnly && run('checkout', { name: b.name }))}
                        title={b.name}
                      >
                        {b.kind === 'tag' ? <TagIcon /> : null}
                        {b.name}
                      </span>
                    ))}
                  {r.kind === 'stash' && <span className="git-badge stash">{`stash@{${r.s.index}}`}</span>}
                  <span className={r.kind === 'uncommitted' ? 'muted' : ''}>
                    {r.kind === 'commit'
                      ? r.c.subject
                      : r.kind === 'stash'
                        ? r.s.message
                        : t('git.graph.uncommitted', { n: r.files.length })}
                  </span>
                </span>
                <span className="git-graph-date muted">
                  {r.kind === 'commit' ? fmtDate(r.c.date) : r.kind === 'stash' ? fmtDate(r.s.date) : ''}
                </span>
                <span className="git-graph-author ellipsis muted">{r.kind === 'commit' ? r.c.author : ''}</span>
                <span className="git-graph-hash muted">{r.kind === 'uncommitted' ? '' : short(r.hash)}</span>
              </div>,
              i === selIndex ? (
                <div key={'detail'} className="git-graph-detail" style={{ top: top(i) + ROW_H, height: DETAIL_H }}>
                  <span className="git-graph-lanes" style={{ width: graphW }}>
                    <GraphCell row={graph.rows[i]} width={graph.width} height={DETAIL_H} lane={LANE_W} through />
                  </span>
                  <Detail
                    m={m}
                    repo={repo}
                    row={r}
                    compare={compare}
                    onClose={() => (setSelected(undefined), setCompare(undefined))}
                    onSelect={(h) => (setSelected(h), setCompare(undefined))}
                  />
                </div>
              ) : null,
            ];
          })}
        </div>
        {loadingMore && <div className="git-note muted">{t('git.loading')}</div>}
      </div>
    </div>
  );
}

/** A commit's details, a compare's files or the working tree's changes. */
function Detail({
  m,
  repo,
  row,
  compare,
  onClose,
  onSelect,
}: {
  m: string;
  repo: string;
  row: Row;
  compare?: string;
  onClose(): void;
  onSelect(h: string): void;
}) {
  const [shown, setShown] = useState<Shown>();
  const [error, setError] = useState<string>();
  const [parent, setParent] = useState(1);
  const rev = row.hash;
  useEffect(() => setParent(1), [rev]);
  useEffect(() => {
    if (row.kind === 'uncommitted') return;
    let gone = false;
    setShown(undefined);
    setError(undefined);
    gitApi
      .show(m, repo, compare ? compare : rev, compare ? { rev2: rev } : { parent })
      .then((s) => !gone && setShown(s))
      .catch((e) => !gone && setError(errorText(e)));
    return () => {
      gone = true;
    };
  }, [m, repo, rev, compare, parent, row.kind]);

  if (row.kind === 'uncommitted') {
    return (
      <div className="git-detail">
        <div className="git-detail-head">
          <b>{t('git.graph.uncommitted', { n: row.files.length })}</b>
          <span className="spacer" />
          <button className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="git-detail-files">
          {row.files.map((f) => {
            const staged = f.x !== '.' && f.x !== '?' && f.kind !== 'unmerged';
            const letter = f.kind === 'untracked' ? 'U' : f.kind === 'unmerged' ? '!' : f.y !== '.' ? f.y : f.x;
            return (
              <FileLine
                key={f.path}
                path={f.path}
                letter={letter}
                title={f.orig ? `${f.orig} → ${f.path}` : f.path}
                onClick={() => void openStatusDiff(m, repo, f, staged && f.y === '.')}
              />
            );
          })}
        </div>
      </div>
    );
  }
  const c = shown?.commit;
  return (
    <div className="git-detail">
      <div className="git-detail-head">
        {compare ? (
          <b>{t('git.graph.comparing', { a: short(compare), b: short(rev) })}</b>
        ) : (
          <b className="ellipsis">{c?.subject ?? short(rev)}</b>
        )}
        <span className="spacer" />
        <button className="icon" title={t('dialog.cancel')} aria-label={t('dialog.cancel')} onClick={onClose}>
          <X />
        </button>
      </div>
      {error && <div className="git-error small">{error}</div>}
      <div className="git-detail-body">
        {c && !compare && (
          <div className="git-detail-meta small">
            <div>
              <span className="muted">{t('git.graph.commit')}</span> <code>{c.hash}</code>
            </div>
            <div>
              <span className="muted">{t('git.graph.parents')}</span>{' '}
              {c.parents.map((p, i) => (
                <button
                  key={p}
                  className={`link${c.parents.length > 1 && parent === i + 1 ? ' on' : ''}`}
                  onClick={() => (c.parents.length > 1 ? setParent(i + 1) : onSelect(p))}
                  title={c.parents.length > 1 ? t('git.graph.diffAgainst') : undefined}
                >
                  {short(p)}
                </button>
              ))}
            </div>
            <div>
              <span className="muted">{t('git.graph.author')}</span> {c.author} &lt;{c.email}&gt; · {fmtDate(c.date)}
            </div>
            {(c.committer !== c.author || c.commitDate !== c.date) && (
              <div>
                <span className="muted">{t('git.graph.committer')}</span> {c.committer} &lt;{c.committerEmail}&gt; · {fmtDate(c.commitDate)}
              </div>
            )}
            <pre className="git-detail-message">{c.message}</pre>
          </div>
        )}
        <div className="git-detail-files">
          {!shown && !error && <div className="muted small">{t('git.loading')}</div>}
          {shown?.files.map((f) => (
            <FileLine
              key={f.path}
              path={f.path}
              letter={f.status}
              title={f.orig ? `${f.orig} → ${f.path}` : f.path}
              onClick={() =>
                void openDiff(
                  m,
                  compare
                    ? { repo, path: f.path, orig: f.orig, mode: 'compare', rev: compare, rev2: rev }
                    : { repo, path: f.path, orig: f.orig, mode: 'commit', rev, parent: c && c.parents.length > 1 ? parent : undefined },
                )
              }
            >
              {f.binary ? (
                <span className="muted small">{t('git.graph.binary')}</span>
              ) : (
                <span className="small git-stat">
                  <span className="add">+{f.added}</span> <span className="del">−{f.deleted}</span>
                </span>
              )}
            </FileLine>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A file of a commit or of the working tree's changes: its icon, name
 * (in its letter's color) and folder, what the caller adds (lines added
 * and deleted) and its letter. */
export function FileLine({
  path,
  letter,
  title,
  onClick,
  children,
}: {
  path: string;
  letter: string;
  title?: string;
  onClick?(): void;
  children?: ReactNode;
}) {
  const color = letterColor(letter);
  const folder = folderOf(path);
  return (
    <div className={`git-file${letter === 'D' ? ' deleted' : ''}`} title={title ?? path} onClick={onClick}>
      <FileIcon name={leafName(path)} kind={path.endsWith('/') ? 'dir' : 'file'} />
      <span className="git-name ellipsis" style={{ color }}>
        {leafName(path)}
      </span>
      {folder && <span className="git-path ellipsis muted">{folder}</span>}
      <span className="spacer" />
      {children}
      <span className="git-letter" style={{ color }} aria-label={t(`git.mark.${letterMark(letter)}` as MessageKey)}>
        {letter}
      </span>
    </div>
  );
}
