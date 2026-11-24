// Project Search's panel in the right sidebar, as VS Code's search view: a
// query with Match Case, Match Whole Word and Use Regular Expression, the
// files to include and to exclude (shown with the details' toggle), the
// folder searched (the focused pane's, as the file explorer follows it,
// or one typed in), and the results by file, each line with its matches
// marked. Typing searches after a pause (Enter at once), a new search
// cancels the one in flight. A click on a line, or Enter, opens the file
// there; the arrows move between rows, ← and → collapse and expand files.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CaseSensitive, ChevronsDownUp, ChevronsUpDown, Ellipsis, LocateFixed, Regex, RefreshCw, WholeWord, X } from 'lucide-react';
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import { current } from '../../actions';
import { t } from '../../i18n';
import { useSize } from '../../lib/sizes';
import { revealTop, useScrollView, visibleRange } from '../../lib/windowed';
import { TreeRow } from '../../components/tree/TreeRow';
import { FileIcon } from '../../fileIcons';
import { followedDir, recentDirectory } from '../files/FilesPanel';
import { joinPath, matchesOf, resultRows, shortDir, splitPath, stepRow, type Row } from './model';
import { cancelSearch, openMatch, runSearch, setSearch, useSearch } from './state';
import './search.css';

/** How long typing pauses before the search runs. */
export const DEBOUNCE_MS = 300;

/** The workspace shown (its id), of the machine shown. */
const placeOf = (): string => {
  const m = useStore.getState().machineId;
  return m ? `${m}\u0000${current()?.ws?.id ?? ''}` : '';
};

/** The folder the panel follows: the focused terminal's or VS Code pane's,
 * kept while another pane (an editor) has the focus, else the one focused
 * last, the workspace's, the home directory (as the Git panel's). */
function useFollowed(home: string | undefined): string | undefined {
  // Both stores: the focused pane is in the layout, the shown machine in the UI's.
  const paneDir = useTerms(followedDir);
  const paneDir2 = useStore(followedDir);
  const dir = paneDir ?? paneDir2;
  const place = useTerms(placeOf);
  const [last, setLast] = useState<{ place: string; dir: string }>();
  useEffect(() => {
    if (dir) setLast({ place, dir });
  }, [dir, place]);
  return dir ?? (last?.place === place ? last.dir : undefined) ?? recentDirectory() ?? home;
}

export function SearchPanel() {
  const m = useStore((s) => s.machineId) ?? undefined;
  const home = useStore((s) => (s.machineId ? s.machines[s.machineId]?.info?.home : undefined));
  const followed = useFollowed(home);
  const s = useSearch();
  const scoped = s.scope && s.scope.m === m ? s.scope.dir : undefined;
  const dir = scoped ?? followed;
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const view = useScrollView();
  const ROW_HEIGHT = useSize('row');

  // The query field has the keyboard when the panel shows.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // A search after a pause in typing (or a change of folder or option).
  useEffect(() => {
    if (!m || !dir) return;
    const timer = setTimeout(() => void runSearch(m, dir), s.query ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [m, dir, s.query, s.regex, s.caseSensitive, s.wholeWord, s.include, s.exclude]);

  const result = s.result && s.result.m === m ? s.result.data : undefined;
  const rows = useMemo(() => resultRows(result, s.collapsed), [result, s.collapsed]);

  // Keep the cursor's row in view.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !s.cursor || !el.clientHeight) return;
    const i = rows.findIndex((r) => r.id === s.cursor);
    if (i >= 0) el.scrollTop = revealTop(el.scrollTop, el.clientHeight, i * ROW_HEIGHT, (i + 1) * ROW_HEIGHT);
  }, [s.cursor, rows, ROW_HEIGHT]);

  if (!m) return <div className="search-empty muted small">{t('search.noMachine')}</div>;

  const now = () => {
    if (dir) void runSearch(m, dir, true);
  };
  const toggleFile = (path: string, open?: boolean) => {
    const collapsed = { ...useSearch.getState().collapsed };
    if (open ?? collapsed[path]) delete collapsed[path];
    else collapsed[path] = true;
    setSearch({ collapsed });
  };
  const allCollapsed = !!result?.files.length && result.files.every((f) => s.collapsed[f.path]);
  const collapseAll = () =>
    setSearch({ collapsed: allCollapsed ? {} : Object.fromEntries((result?.files ?? []).map((f) => [f.path, true])) });

  const open = (row: Row) => {
    if (!result) return;
    const path = joinPath(result.dir, row.file.path);
    if (row.kind === 'match') void openMatch(m, path, row.match.line, row.match.col);
    else void openMatch(m, path);
  };

  const onListKey = (ev: React.KeyboardEvent) => {
    const cur = rows.find((r) => r.id === s.cursor);
    const handled = () => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    switch (ev.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        handled();
        if (ev.key === 'ArrowUp' && rows[0]?.id === s.cursor) return input.current?.focus();
        setSearch({ cursor: stepRow(rows, s.cursor, ev.key === 'ArrowDown' ? 1 : -1) });
        return;
      }
      case 'Home':
      case 'End':
        handled();
        setSearch({ cursor: rows[ev.key === 'Home' ? 0 : rows.length - 1]?.id });
        return;
      case 'ArrowLeft':
        if (!cur) return;
        handled();
        if (cur.kind === 'file' && cur.open) toggleFile(cur.file.path, false);
        else if (cur.kind === 'match') setSearch({ cursor: `f:${cur.file.path}` });
        return;
      case 'ArrowRight':
        if (cur?.kind !== 'file') return;
        handled();
        if (!cur.open) toggleFile(cur.file.path, true);
        return;
      case 'Enter':
      case ' ':
        if (!cur) return;
        handled();
        if (cur.kind === 'file' && ev.key === ' ') toggleFile(cur.file.path);
        else open(cur);
        return;
      case 'Escape':
        handled();
        input.current?.focus();
        return;
    }
  };

  const [first, last] = visibleRange(rows.length, ROW_HEIGHT, view.top, view.height || rows.length * ROW_HEIGHT);
  const drawRow = (row: Row, index: number) => {
    const style = { top: index * ROW_HEIGHT, height: ROW_HEIGHT };
    const cursor = row.id === s.cursor;
    const pick = () => setSearch({ cursor: row.id });
    if (row.kind === 'file') {
      const { name, folder } = splitPath(row.file.path);
      return (
        <TreeRow
          key={row.id}
          className="search-row search-file"
          style={style}
          depth={0}
          expanded={row.open}
          onToggle={() => toggleFile(row.file.path)}
          icon={<FileIcon name={name} kind="file" />}
          label={name}
          description={folder || undefined}
          decoration={{ badge: String(matchesOf(row.file)) }}
          title={row.file.path}
          cursor={cursor}
          selected={cursor}
          onClick={() => {
            pick();
            toggleFile(row.file.path);
          }}
        />
      );
    }
    return (
      <TreeRow
        key={row.id}
        className="search-row search-match"
        style={style}
        depth={1}
        label={row.match.preview}
        highlight={row.match.ranges}
        title={t('search.line', { line: row.match.line })}
        cursor={cursor}
        selected={cursor}
        onClick={() => {
          pick();
          open(row);
        }}
      />
    );
  };

  const toggle = (key: 'caseSensitive' | 'wholeWord' | 'regex', label: Parameters<typeof t>[0], Icon: typeof Regex) => (
    <button
      className={`icon ${s[key] ? 'on' : ''}`}
      title={t(label)}
      aria-label={t(label)}
      aria-pressed={s[key]}
      onClick={() => setSearch({ [key]: !s[key] })}
    >
      <Icon />
    </button>
  );

  const matches = result?.matchCount ?? 0;
  const files = result?.files.length ?? 0;
  return (
    <div className="search-panel">
      <div className="search-toolbar">
        <span className="spacer" />
        {s.busy ? (
          <button className="icon" title={t('search.cancel')} aria-label={t('search.cancel')} onClick={cancelSearch}>
            <X />
          </button>
        ) : (
          <button className="icon" title={t('search.refresh')} aria-label={t('search.refresh')} disabled={!s.query} onClick={now}>
            <RefreshCw />
          </button>
        )}
        <button
          className="icon"
          title={t(allCollapsed ? 'search.expandAll' : 'search.collapseAll')}
          aria-label={t(allCollapsed ? 'search.expandAll' : 'search.collapseAll')}
          disabled={!files}
          onClick={collapseAll}
        >
          {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
        </button>
      </div>
      <div className={`search-field ${s.error ? 'error' : ''}`}>
        <input
          ref={input}
          className="search-input"
          type="text"
          placeholder={t('search.query')}
          aria-label={t('search.query')}
          value={s.query}
          spellCheck={false}
          onChange={(e) => setSearch({ query: e.target.value.replace(/[\r\n]/g, '') })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              now();
            } else if (e.key === 'ArrowDown' && rows.length) {
              e.preventDefault();
              if (!s.cursor) setSearch({ cursor: rows[0].id });
              list.current?.focus();
            } else if (e.key === 'Escape' && s.query) {
              e.preventDefault();
              e.stopPropagation();
              setSearch({ query: '' });
            }
          }}
        />
        {toggle('caseSensitive', 'search.matchCase', CaseSensitive)}
        {toggle('wholeWord', 'search.wholeWord', WholeWord)}
        {toggle('regex', 'search.regex', Regex)}
      </div>
      <div className="search-scope">
        <input
          className="search-input search-dir"
          type="text"
          aria-label={t('search.scope')}
          title={t('search.scope')}
          value={dir ? shortDir(dir, home) : ''}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value;
            const abs = home && (v === '~' || v.startsWith('~/')) ? home + v.slice(1) : v;
            setSearch({ scope: { m, dir: abs } });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              now();
            }
          }}
        />
        <button
          className={`icon ${scoped === undefined ? 'on' : ''}`}
          title={t('search.follow')}
          aria-label={t('search.follow')}
          aria-pressed={scoped === undefined}
          onClick={() => setSearch({ scope: undefined })}
        >
          <LocateFixed />
        </button>
        <button
          className={`icon ${s.details ? 'on' : ''}`}
          title={t('search.details')}
          aria-label={t('search.details')}
          aria-expanded={s.details}
          onClick={() => setSearch({ details: !s.details })}
        >
          <Ellipsis />
        </button>
      </div>
      {s.details && (
        <div className="search-details">
          <input
            className="search-input"
            type="text"
            placeholder={t('search.include')}
            aria-label={t('search.includeLabel')}
            title={t('search.includeLabel')}
            value={s.include}
            spellCheck={false}
            onChange={(e) => setSearch({ include: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && now()}
          />
          <input
            className="search-input"
            type="text"
            placeholder={t('search.exclude')}
            aria-label={t('search.excludeLabel')}
            title={t('search.excludeLabel')}
            value={s.exclude}
            spellCheck={false}
            onChange={(e) => setSearch({ exclude: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && now()}
          />
        </div>
      )}
      <div className="search-status small" aria-live="polite">
        {s.error ? (
          <div className="search-error">{s.error}</div>
        ) : s.busy && !result ? (
          <div className="muted">{t('search.searching')}</div>
        ) : !s.query ? (
          <div className="muted">{t('search.hint')}</div>
        ) : result ? (
          <>
            <div className="muted">
              {matches ? (matches === 1 ? t('search.summary.one') : t('search.summary', { matches, files })) : t('search.noResults')}
              {s.busy && ` · ${t('search.searching')}`}
            </div>
            {result.truncated && result.reason && <div className="search-warning">{t(truncatedKey(result.reason), { n: matches })}</div>}
            <div className="search-engine muted">{t(result.engine === 'rg' ? 'search.engine.rg' : 'search.engine.builtin')}</div>
          </>
        ) : null}
      </div>
      <div
        ref={(el) => {
          list.current = el;
          view.ref(el);
        }}
        className="tree search-results"
        role="tree"
        tabIndex={0}
        aria-label={t('search.results')}
        onKeyDown={onListKey}
        onScroll={view.onScroll}
        onFocus={() => {
          if (!s.cursor && rows.length) setSearch({ cursor: rows[0].id });
        }}
      >
        <div className="search-rows" style={{ height: rows.length * ROW_HEIGHT }}>
          {rows.slice(first, last).map((r, i) => drawRow(r, first + i))}
        </div>
      </div>
    </div>
  );
}

/** The message of a search that stopped early, by its reason. */
function truncatedKey(reason: string): Parameters<typeof t>[0] {
  switch (reason) {
    case 'timeout':
      return 'search.truncated.timeout';
    case 'max_files':
      return 'search.truncated.max_files';
    default:
      return 'search.truncated.max_results';
  }
}
