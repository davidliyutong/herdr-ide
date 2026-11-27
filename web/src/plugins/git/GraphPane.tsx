// The Git graph pane ({view: {plugin: 'git', kind: 'graph', repo}}), as
// the Git Graph extension of VS Code: the history of all branches (or one)
// with its lanes (graph.ts), the working tree's changes on top and the
// stashes, badges for HEAD, branches, remote branches and tags, a search
// that dims the other commits, and pages loaded as the list scrolls. A
// click shows a commit's details under it (its message and files; a file
// opens its diff), a Cmd/Ctrl-click on a second commit compares the two,
// and context menus on commits, badges and stashes act on them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, GitBranch, RefreshCw, Search, Tag as TagIcon } from 'lucide-react';
import { loadPref, savePref, useStore } from '../../state/store';
import { useSettings } from '../../settings';
import { Picker, type PickerItem } from '../../components/Picker';
import { useSize } from '../../lib/sizes';
import { useScrollView } from '../../lib/windowed';
import { openMenu, type MenuEntry } from '../../contextMenu';
import { t } from '../../i18n';
import type { PaneViewProps } from '../api';
import { gitApi, errorText, GitError, type Commit, type Ref, type Stash, type StatusFile } from './api';
import { appendCommits, layoutGraph, newPaging, type GraphCommit, type Paging } from './graph';
import { GraphCell, LANE_COLORS, laneColor } from './GraphCell';
import {
  checkoutRemote,
  copy,
  createBranch,
  createTag,
  deleteBranch,
  deleteTag,
  renameBranch,
  reset,
  short,
  stashDrop,
  stashParams,
} from './ops';
import { badgesOf, fmtDate, type Badge } from './shared';
import { changed, runGit, useRepo } from './state';
import { pushTag, pushTo, remoteOf } from './pickers';
import { Detail } from './GraphDetail';
import './git.css';

export const LANE_W = 14;
export const DETAIL_H = 300;
/** The commits of a page (the setting git.graphPageSize's default). */
export const PAGE = 300;
/** The setting: the commits of a page. */
export const GRAPH_PAGE_SIZE = 'git.graphPageSize';

/** The page size the setting gives, within the machine's bounds. */
export function pageSize(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : PAGE;
  return Math.min(1000, Math.max(50, n));
}

/** The most refs the filter holds (the machine's log takes 100). */
export const MAX_FILTER = 100;

/** Where a repository's branch filter is kept, per browser. */
export const filterKey = (m: string, repo: string) => `git.graphFilter:${m}:${repo}`;

/** A ref's full name from a badge: what the branch filter holds (full
 * names, which no branch and tag of one name confuse). */
export function badgeRef(b: Badge): string | undefined {
  switch (b.kind) {
    case 'branch':
      return `refs/heads/${b.name}`;
    case 'remote':
      return `refs/remotes/${b.name}`;
    case 'tag':
      return `refs/tags/${b.name}`;
  }
  return undefined;
}

/** The branch filter's rows: local branches, each remote's branches under
 * its name, tags; values are the refs' full names. */
export function filterItems(refs: readonly Ref[], remotes: readonly string[]): PickerItem[] {
  const local: PickerItem[] = [];
  const remote: PickerItem[] = [];
  const tags: PickerItem[] = [];
  for (const r of refs) {
    if (r.name.startsWith('refs/heads/'))
      local.push({ value: r.name, label: r.name.slice(11), icon: <GitBranch />, group: t('git.pick.branches') });
    else if (r.name.startsWith('refs/remotes/')) {
      const name = r.name.slice(13);
      remote.push({ value: r.name, label: name, icon: <GitBranch />, group: t('git.pick.remote', { remote: remoteOf(name, remotes) }) });
    } else if (r.name.startsWith('refs/tags/'))
      tags.push({ value: r.name, label: r.name.slice(10), icon: <TagIcon />, group: t('git.pick.tags') });
  }
  return [...local, ...remote, ...tags];
}
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
  // The refs shown (none: every branch), kept per repository.
  const [filter, setFilterNow] = useState<string[]>(() => loadPref<string[]>(filterKey(m, repo), []));
  const setFilter = (f: string[]) => {
    // The machine takes the history of at most MAX_FILTER refs at once.
    if (f.length > MAX_FILTER) {
      useStore.getState().toast(t('git.graph.filterMax', { n: MAX_FILTER }));
      f = f.slice(0, MAX_FILTER);
    }
    setFilterNow(f);
    savePref(filterKey(m, repo), f);
  };
  const filterKeyNow = filter.join('\n');
  const pageLimit = pageSize(useSettings((s) => s.values[GRAPH_PAGE_SIZE]?.value));
  const [remotes, setRemotes] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [compare, setCompare] = useState<string>();
  // Drawn for a view 600 high until the list is measured.
  const scroll = useScrollView(600);
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
  const pageAbort = useRef<AbortController | undefined>(undefined);
  const scope = useRef('');
  useEffect(() => {
    pageAbort.current?.abort();
    const ac = new AbortController();
    pageAbort.current = ac;
    const sc = `${m}\u0000${repo}\u0000${filterKeyNow}\u0000${remotes}`;
    const limit = scope.current === sc ? Math.min(1000, Math.max(pageLimit, page.current.next)) : pageLimit;
    scope.current = sc;
    const pg = newPaging();
    page.current = pg;
    setLoadingMore(false);
    gitApi
      .log(m, repo, { limit, branches: filter.length ? filter : undefined, remotes, signal: ac.signal })
      .then((l) => {
        if (page.current !== pg) return;
        pg.next = l.commits.length;
        pg.ready = true;
        setData({ commits: l.commits, more: l.more, refs: l.refs ?? [], stashes: l.stashes ?? [], head: l.head, branch: l.branch });
        setError(undefined);
      })
      .catch((e) => {
        if (page.current !== pg || ac.signal.aborted) return;
        // A ref of the filter is gone (deleted elsewhere): every branch.
        if (filter.length && e instanceof GitError && e.code === 'bad_ref') {
          setFilter([]);
          useStore.getState().toast(t('git.graph.filterGone'));
          return;
        }
        setError(errorText(e));
      });
    return () => ac.abort();
    // The filter is in filterKeyNow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, repo, filterKeyNow, remotes, version, pageLimit]);

  // Refs of the filter deleted since: dropped from it.
  useEffect(() => {
    if (!data || !filter.length) return;
    const known = new Set(data.refs.map((r) => r.name));
    const kept = filter.filter((f) => known.has(f));
    if (kept.length !== filter.length) setFilter(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const loadMore = async () => {
    const pg = page.current;
    if (!data?.more || !pg.ready || pg.loading || pg.failed) return;
    pg.loading = true;
    setLoadingMore(true);
    const signal = pageAbort.current?.signal;
    try {
      const l = await gitApi.log(m, repo, {
        skip: pg.next,
        limit: pageLimit,
        branches: filter.length ? filter : undefined,
        remotes,
        signal,
      });
      if (page.current !== pg) return;
      pg.next += l.commits.length;
      setData((d) => d && { ...d, commits: appendCommits(d.commits, l.commits), more: l.more && l.commits.length > 0 });
    } catch (e) {
      if (page.current !== pg || signal?.aborted) return;
      // Not asked again until the list is read again.
      pg.failed = true;
      setError(errorText(e));
    } finally {
      pg.loading = false;
      if (page.current === pg) setLoadingMore(false);
    }
  };

  const rows = useMemo(
    () =>
      data ? graphRows(data.commits, filter.length ? [] : data.stashes, data.head, filter.length ? [] : (st?.status?.files ?? [])) : [],
    [data, filterKeyNow, st?.status],
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

  const setList = useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el;
      scroll.ref(el);
    },
    [scroll.ref],
  );
  // Near the end: the next page.
  useEffect(() => {
    if (data?.more && scroll.top + scroll.height > total - 20 * ROW_H) void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroll.top, scroll.height, total, data?.more]);

  const first = Math.max(0, Math.floor((scroll.top - (selIndex >= 0 && scroll.top > top(selIndex) ? DETAIL_H : 0)) / ROW_H) - 10);
  const visible: number[] = [];
  for (let i = first; i < rows.length && top(i) < scroll.top + scroll.height + 10 * ROW_H; i++) visible.push(i);

  const remoteList = st?.info?.remotes;
  const refItems = useMemo(() => filterItems(data?.refs ?? [], remoteList ?? []), [data, remoteList]);

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
    const ref = badgeRef(b);
    const inFilter = !!ref && filter.includes(ref);
    const filterEntries: MenuEntry[] = ref
      ? [
          'sep',
          { label: t('git.graph.showOnly'), disabled: filter.length === 1 && inFilter, run: () => setFilter([ref]) },
          inFilter
            ? { label: t('git.graph.removeFromFilter'), run: () => setFilter(filter.filter((f) => f !== ref)) }
            : { label: t('git.graph.addToFilter'), disabled: !filter.length, run: () => setFilter([...filter, ref]) },
        ]
      : [];
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
    openMenu(e, [...items, ...filterEntries]);
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
        <Picker
          multiple
          className="git-graph-filter"
          aria-label={t('git.graph.branches')}
          label={t('git.graph.branches')}
          placeholder={t('git.graph.filterPlaceholder')}
          noneLabel={t('git.graph.allBranches')}
          items={refItems}
          value={filter}
          onChange={setFilter}
        />
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
      <div className="git-graph-list" ref={setList} onScroll={scroll.onScroll}>
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
