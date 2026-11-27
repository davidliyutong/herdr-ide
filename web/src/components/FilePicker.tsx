// Reusable local-state file browser widget for attaching workspace files to a
// chat message (FilePickerProps in conversation/source.ts). Uses listDir,
// TreeRow, FileIcon and fuzzy match with self-contained React state so it
// never touches the Files sidebar panel's singleton useTree store.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Eye, EyeOff, FolderRoot, Search, X } from 'lucide-react';
import type { FilePickerEntry, FilePickerProps, FileSuggestion } from '../conversation/source';
import { FileIcon } from '../fileIcons';
import { t } from '../i18n';
import { formatSize, listDir as defaultListDir } from '../lib/files';
import { match, type MatchRange } from '../lib/match';
import { TreeRow } from './tree/TreeRow';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function normalizeDir(p: string): string {
  const s = p.replace(/\/+$/, '');
  return s || '/';
}

function joinPosix(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function parentPosix(p: string): string {
  const clean = normalizeDir(p);
  const i = clean.lastIndexOf('/');
  return i > 0 ? clean.slice(0, i) : '/';
}

function relativePosix(root: string, p: string): string {
  const cleanRoot = normalizeDir(root);
  if (p === cleanRoot) return '.';
  const pre = cleanRoot === '/' ? '/' : `${cleanRoot}/`;
  return p.startsWith(pre) ? p.slice(pre.length) : p;
}

function crumbsPosix(root: string, cur: string): Array<[string, string]> {
  const cleanRoot = normalizeDir(root);
  const cleanCur = normalizeDir(cur);
  const out: Array<[string, string]> = [];
  if (cleanCur === cleanRoot || cleanCur.startsWith(cleanRoot === '/' ? '/' : `${cleanRoot}/`)) {
    const rootName = cleanRoot === '/' ? '/' : cleanRoot.slice(cleanRoot.lastIndexOf('/') + 1);
    out.push([cleanRoot, rootName]);
    const rest = cleanCur.slice(cleanRoot === '/' ? 1 : cleanRoot.length + 1);
    for (const part of rest.split('/')) {
      if (!part) continue;
      out.push([joinPosix(out[out.length - 1][0], part), part]);
    }
    return out;
  }
  out.push(['/', '/']);
  for (const part of cleanCur.slice(1).split('/')) {
    if (!part) continue;
    out.push([joinPosix(out[out.length - 1][0], part), part]);
  }
  return out;
}

function sortPickerEntries(entries: readonly FilePickerEntry[]): FilePickerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

interface DirCache {
  entries?: FilePickerEntry[];
  loading?: boolean;
  error?: string;
}

interface FlatRow {
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
  expanded: boolean;
  size?: number;
  ranges?: MatchRange[];
}

export function FilePicker({ m, rootDir, selected = [], onSelect, onClose, listDir = defaultListDir }: FilePickerProps) {
  const baseRoot = normalizeDir(rootDir);
  const [dir, setDir] = useState(baseRoot);
  const [dirs, setDirs] = useState<Record<string, DirCache>>({});
  const [expanded, setExpanded] = useState<Record<string, true>>({});
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const [checked, setChecked] = useState<Map<string, FileSuggestion>>(() => {
    const map = new Map<string, FileSuggestion>();
    for (const path of selected) {
      if (path.startsWith('/')) map.set(path, { path, label: relativePosix(baseRoot, path) });
    }
    return map;
  });
  const filterRef = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  const listDirRef = useRef(listDir);
  listDirRef.current = listDir;
  /** Directories already loaded or currently loading for the active machine;
   * checked synchronously outside setDirs so listDir is never fired twice. */
  const requestedRef = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    live.current = true;
    const ac = new AbortController();
    abortRef.current = ac;
    requestedRef.current.clear();
    setDirs({});
    return () => {
      live.current = false;
      ac.abort();
      if (abortRef.current === ac) abortRef.current = undefined;
    };
  }, [m]);

  const loadDir = useCallback(
    (target: string) => {
      const clean = normalizeDir(target);
      if (requestedRef.current.has(clean)) return;
      requestedRef.current.add(clean);
      setDirs((prev) => ({ ...prev, [clean]: { loading: true } }));
      const ac = abortRef.current;
      const req = listDirRef.current === defaultListDir ? defaultListDir(m, clean, ac?.signal) : listDirRef.current(m, clean);
      req.then(
        (res) => {
          if (!live.current || ac?.signal.aborted) return;
          const entries = Array.isArray(res?.entries) ? sortPickerEntries(res.entries) : [];
          setDirs((prev) => ({ ...prev, [clean]: { entries } }));
        },
        (e: unknown) => {
          requestedRef.current.delete(clean);
          if (!live.current || ac?.signal.aborted) return;
          const msg = e instanceof Error ? e.message : String(e);
          setDirs((prev) => ({ ...prev, [clean]: { error: msg } }));
        },
      );
    },
    [m],
  );

  useEffect(() => {
    loadDir(dir);
  }, [dir, loadDir]);

  useEffect(() => {
    filterRef.current?.focus({ preventScroll: true });
  }, []);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const toggleExpand = useCallback(
    (path: string) => {
      const opening = !expandedRef.current[path];
      setExpanded((prev) => {
        if (prev[path]) {
          const next = { ...prev };
          delete next[path];
          return next;
        }
        return { ...prev, [path]: true };
      });
      if (opening) loadDir(path);
    },
    [loadDir],
  );

  const toggleCheck = useCallback(
    (path: string) => {
      setChecked((prev) => {
        const next = new Map(prev);
        if (next.has(path)) next.delete(path);
        else next.set(path, { path, label: relativePosix(baseRoot, path) });
        return next;
      });
    },
    [baseRoot],
  );

  const navigate = (target: string) => {
    const clean = normalizeDir(target);
    setDir(clean);
    setExpanded({});
    setFilter('');
  };

  const rows = useMemo((): FlatRow[] => {
    const q = filter.trim();
    const out: FlatRow[] = [];
    const walk = (curDir: string, depth: number): FlatRow[] => {
      const cache = dirs[curDir];
      if (!cache?.entries) return [];
      const list: FlatRow[] = [];
      for (const e of cache.entries) {
        if (!e || typeof e.name !== 'string' || !e.name) continue;
        if (!showHidden && e.name.startsWith('.')) continue;
        const path = e.path && e.path.startsWith('/') ? normalizeDir(e.path) : joinPosix(curDir, e.name);
        const isOpen = !!expanded[path];
        if (e.is_dir) {
          const kids = isOpen ? walk(path, depth + 1) : [];
          const hit = q ? match(q, e.name) : { ranges: [] as MatchRange[] };
          if (!q || hit || kids.length > 0) {
            list.push({
              path,
              name: e.name,
              depth,
              isDir: true,
              expanded: isOpen,
              ranges: hit && q ? hit.ranges : undefined,
            });
            list.push(...kids);
          }
        } else {
          const hit = q ? match(q, e.name) : { ranges: [] as MatchRange[] };
          if (!q || hit) {
            list.push({
              path,
              name: e.name,
              depth,
              isDir: false,
              expanded: false,
              size: e.size,
              ranges: hit && q ? hit.ranges : undefined,
            });
          }
        }
      }
      return list;
    };
    out.push(...walk(dir, 0));
    return out;
  }, [dir, dirs, expanded, showHidden, filter]);

  const rootCache = dirs[dir];
  const crumbs = useMemo(() => crumbsPosix(baseRoot, dir), [baseRoot, dir]);
  const visibleFiles = useMemo(() => rows.filter((r) => !r.isDir), [rows]);
  const allVisibleChecked = visibleFiles.length > 0 && visibleFiles.every((r) => checked.has(r.path));
  const selectAllVisible = () =>
    setChecked((prev) => {
      const next = new Map(prev);
      for (const f of visibleFiles) next.set(f.path, { path: f.path, label: relativePosix(baseRoot, f.path) });
      return next;
    });
  const clearChecked = () => setChecked(new Map());
  const confirm = () => {
    onSelect([...checked.values()]);
    onClose();
  };

  return (
    <div
      className="file-picker"
      role="dialog"
      aria-label={t('conversation.filePicker.title')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (filter) setFilter('');
          else onClose();
        }
      }}
    >
      <div className="file-picker-head">
        <button
          type="button"
          className="ghost sm icon"
          aria-label={t('conversation.filePicker.up')}
          title={t('conversation.filePicker.up')}
          disabled={dir === '/'}
          onClick={() => navigate(parentPosix(dir))}
        >
          <ArrowUp aria-hidden />
        </button>
        {dir !== baseRoot && (
          <button
            type="button"
            className="ghost sm icon"
            aria-label={t('conversation.filePicker.home')}
            title={t('conversation.filePicker.home')}
            onClick={() => navigate(baseRoot)}
          >
            <FolderRoot aria-hidden />
          </button>
        )}
        <nav className="file-picker-crumbs" aria-label={dir}>
          {crumbs.map(([crumbPath, name], i) => (
            <span key={crumbPath} className="file-picker-crumb-wrap">
              {i > 0 && <span className="file-picker-sep">/</span>}
              <button
                type="button"
                className="file-picker-crumb ellipsis"
                title={crumbPath}
                aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                onClick={() => navigate(crumbPath)}
              >
                {name}
              </button>
            </span>
          ))}
        </nav>
        <button
          type="button"
          className={`ghost sm icon${showHidden ? ' active' : ''}`}
          aria-label={t('conversation.filePicker.hidden')}
          aria-pressed={showHidden}
          title={t('conversation.filePicker.hidden')}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />}
        </button>
        <button type="button" className="ghost sm icon" aria-label={t('conversation.filePicker.cancel')} onClick={onClose}>
          <X aria-hidden />
        </button>
      </div>
      <div className="file-picker-search">
        <Search className="file-picker-search-ic" aria-hidden />
        <input
          ref={filterRef}
          type="text"
          className="file-picker-filter"
          value={filter}
          placeholder={t('conversation.filePicker.filter')}
          aria-label={t('conversation.filePicker.filter')}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button type="button" className="ghost sm icon" aria-label={t('conversation.dismiss')} onClick={() => setFilter('')}>
            <X aria-hidden />
          </button>
        )}
      </div>
      <div className="file-picker-list" role="tree" aria-multiselectable="true" aria-label={dir}>
        {rootCache?.loading && <div className="file-picker-note muted">{t('conversation.filePicker.loading')}</div>}
        {rootCache?.error && (
          <div className="file-picker-note error">{t('conversation.filePicker.loadFailed', { dir, error: rootCache.error })}</div>
        )}
        {rootCache?.entries && rootCache.entries.length === 0 && (
          <div className="file-picker-note muted">{t('conversation.filePicker.empty')}</div>
        )}
        {rootCache?.entries && rootCache.entries.length > 0 && rows.length === 0 && (
          <div className="file-picker-note muted">{t('conversation.filePicker.noMatch')}</div>
        )}
        {rows.map((r) => {
          const isChecked = checked.has(r.path);
          return (
            <TreeRow
              key={r.path}
              depth={r.depth}
              expanded={r.isDir ? r.expanded : undefined}
              onToggle={r.isDir ? () => toggleExpand(r.path) : undefined}
              selected={isChecked}
              className="file-picker-row"
              data-path={r.path}
              icon={
                <>
                  {!r.isDir && (
                    <input
                      type="checkbox"
                      className="file-picker-check"
                      checked={isChecked}
                      aria-label={r.name}
                      tabIndex={-1}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleCheck(r.path)}
                    />
                  )}
                  <FileIcon name={r.name} kind={r.isDir ? 'dir' : 'file'} open={r.expanded} />
                </>
              }
              label={r.name}
              highlight={r.ranges}
              description={!r.isDir && typeof r.size === 'number' ? formatSize(r.size) : undefined}
              title={r.path}
              onClick={() => (r.isDir ? toggleExpand(r.path) : toggleCheck(r.path))}
              onDoubleClick={() => r.isDir && navigate(r.path)}
            />
          );
        })}
      </div>
      <div className="file-picker-foot">
        <span className="muted small file-picker-count">
          {checked.size > 0 ? t('conversation.filePicker.selected', { n: checked.size }) : ''}
        </span>
        {visibleFiles.length > 0 && !allVisibleChecked && (
          <button type="button" className="ghost sm file-picker-select-all" onClick={selectAllVisible}>
            {t('conversation.filePicker.selectAll')}
          </button>
        )}
        {checked.size > 0 && (
          <button type="button" className="ghost sm file-picker-clear" onClick={clearChecked}>
            {t('conversation.filePicker.deselectAll')}
          </button>
        )}
        <button type="button" className="ghost sm" onClick={onClose}>
          {t('conversation.filePicker.cancel')}
        </button>
        <button type="button" className="primary sm" disabled={checked.size === 0} onClick={confirm}>
          {t('conversation.filePicker.attach')}
        </button>
      </div>
    </div>
  );
}
