// The file explorer's panel in the right sidebar: a tree of the shown
// machine's files rooted at the focused terminal's directory (or a
// directory chosen in the breadcrumb), as VS Code's explorer is: expand and
// collapse, a filter, hidden files on or off, the keyboard (arrows, Enter,
// Space, F2, Delete), a context menu, drags that move files and drops from
// the computer that upload them. A click shows a file in Quick Look, a
// double click (or Enter) opens it in the editor pane.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Eye,
  EyeOff,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  LocateFixed,
  RefreshCw,
} from 'lucide-react';
import { current, paneDirectory } from '../../actions';
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import * as L from '../../term/layout';
import { openMenu } from '../../contextMenu';
import { carriesFiles } from '../../drop';
import { InlineEdit } from '../../components/InlineEdit';
import { APP_SLUG } from '../../brand';
import { t } from '../../i18n';
import { isMac } from '../../keys';
import { useSize } from '../../lib/sizes';
import { decorationsOf, useDecorationVersion, useShownDirs } from './decorations';
import {
  collapseAll,
  crumbs,
  parentOf,
  poll,
  reloadDirs,
  select,
  setEdit,
  setExpanded,
  setFilter,
  setFollow,
  setHidden,
  showRoot,
  stepRow,
  treeRows,
  useTree,
  within,
  setClipboard,
  type Row,
} from './tree';
import { copyInto, create, dirOf, dropFiles, menuFor, moveInto, openPath, paste, quickLook, remove, rename, trash } from './ops';
import './files.css';

/** How often the shown directories are checked for changes. */
export const POLL_MS = 2000;
/** The drag type of paths dragged inside the tree. */
const DRAG_TYPE = `application/x-${APP_SLUG}-files`;

/** The directory the tree follows: the focused terminal's (a VS Code
 * pane's folder), the workspace's without a focused pane; undefined while
 * another pane (a preview, an editor) has the focus, which keeps the tree
 * where it is. */

export function followedDir(): string | undefined {
  const c = current();
  if (!c) return undefined;
  const leaf = c.tab && c.focused ? L.leafOf(c.tab.root, c.focused) : null;
  if (!leaf) return c.ws?.cwd || undefined;
  if (L.isTerminalLeaf(leaf) || L.isCodeLeaf(leaf)) return paneDirectory(c.m, leaf) ?? (c.ws?.cwd || undefined);
  return undefined;
}

export function FilesPanel() {
  const m = useStore((s) => s.machineId);
  const home = useStore((s) => (s.machineId ? s.machines[s.machineId]?.info?.home : undefined));
  const readOnly = useStore((s) => s.readOnly);
  // Both stores: the focused pane is in the layout, the shown machine in the UI's.
  const paneDir = useTerms(followedDir);
  const paneDir2 = useStore(followedDir);
  const followed = paneDir ?? paneDir2;
  const s = useTree();
  useDecorationVersion((d) => d.v);
  const treeRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<string>();
  const [scroll, setScroll] = useState({ top: 0, height: 0 });

  // The directories shown, for decoration providers.
  const shownKey = s.m === m && s.root ? [s.root, ...Object.keys(s.expanded).filter((d) => within(d, s.root!))].sort().join('\n') : '';
  useEffect(() => {
    useShownDirs.setState({ m: shownKey ? m : undefined, dirs: shownKey ? shownKey.split('\n') : [] });
  }, [m, shownKey]);
  useEffect(() => () => useShownDirs.setState({ m: undefined, dirs: [] }), []);

  // The root: the followed directory, else where the tree is, else home.
  useEffect(() => {
    if (!m) return;
    const st = useTree.getState();
    const here = st.m === m ? st.root : undefined;
    const root = (st.follow ? followed : undefined) ?? here ?? home ?? '/';
    showRoot(m, root);
  }, [m, followed, s.follow, home]);

  // While the panel is shown and the page visible, the shown directories
  // are checked for changes.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const el = treeRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setScroll((v) => ({ ...v, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Rows are --h-row high, which scales with the UI font size.
  const ROW_HEIGHT = useSize('row');
  const rows = useMemo(() => treeRows(s), [s.root, s.dirs, s.expanded, s.hidden, s.filter, s.edit]);
  const kinds = useMemo(() => new Map(rows.map((r) => [r.path, r.dir])), [rows]);
  const isDir = (p: string) => kinds.get(p) ?? p === s.root;

  // Keep the cursor's row in view.
  useEffect(() => {
    const el = treeRef.current;
    if (!el || !s.cursor || !el.clientHeight) return;
    const i = rows.findIndex((r) => r.path === s.cursor);
    if (i < 0) return;
    const top = i * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  }, [s.cursor, rows, ROW_HEIGHT]);

  if (!m || !s.root) return <div className="files-empty muted small">{t('files.noMachine')}</div>;
  const root = s.root;
  const rootDir = s.dirs[root];

  const targets = (path?: string): string[] => {
    if (!path) return [];
    const sel = useTree.getState().selection;
    return sel.includes(path) ? [path, ...sel.filter((p) => p !== path)] : [path];
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.target !== ev.currentTarget) return;
    const st = useTree.getState();
    const cur = st.cursor;
    const row = rows.find((r) => r.path === cur);
    const mod = isMac ? ev.metaKey : ev.ctrlKey;
    const handled = () => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    const moveTo = (p: string | undefined) => p && select(p, ev.shiftKey ? 'range' : 'only', rows);
    switch (true) {
      case ev.key === 'ArrowDown':
        handled();
        return moveTo(stepRow(rows, cur, 1));
      case ev.key === 'ArrowUp':
        handled();
        return moveTo(stepRow(rows, cur, -1));
      case ev.key === 'Home':
        handled();
        return moveTo(stepRow(rows, undefined, 1));
      case ev.key === 'End':
        handled();
        return moveTo(stepRow(rows, undefined, -1));
      case ev.key === 'ArrowRight':
        handled();
        if (!row?.dir) return;
        if (!row.expanded) return setExpanded(row.path, true);
        return moveTo(stepRow(rows, cur, 1));
      case ev.key === 'ArrowLeft': {
        handled();
        if (!row) return;
        if (row.dir && row.expanded) return setExpanded(row.path, false);
        const up = parentOf(row.path);
        if (up !== root && within(up, root)) select(up);
        return;
      }
      case ev.key === 'Enter':
        handled();
        if (row) void openPath(m, row.path, row.dir);
        return;
      case ev.key === ' ':
        handled();
        if (row && !row.dir) void quickLook(m, row.path, treeRef.current);
        return;
      case ev.key === 'Escape':
        if (st.clipboard) setClipboard(undefined);
        else if (st.filter) setFilter('');
        else return;
        return handled();
    }
    if (readOnly) return;
    const sel = st.selection.length ? st.selection : cur ? [cur] : [];
    if (ev.key === 'F2' && cur) {
      handled();
      setEdit({ kind: 'rename', path: cur });
    } else if ((ev.key === 'Delete' || (isMac && ev.key === 'Backspace' && ev.metaKey)) && sel.length) {
      handled();
      if (ev.shiftKey) void remove(m, sel);
      else void trash(m, sel);
    } else if (mod && !ev.shiftKey && !ev.altKey && (ev.key === 'c' || ev.key === 'x') && sel.length) {
      handled();
      setClipboard({ m, paths: sel, cut: ev.key === 'x' });
    } else if (mod && !ev.shiftKey && !ev.altKey && ev.key === 'v' && st.clipboard) {
      handled();
      void paste(m, cur ? dirOf(cur, isDir(cur)) : root);
    }
  };

  const onRowClick = (ev: React.MouseEvent, row: Row) => {
    const mod = isMac ? ev.metaKey : ev.ctrlKey;
    treeRef.current?.focus();
    if (ev.shiftKey) return select(row.path, 'range', rows);
    if (mod) return select(row.path, 'toggle');
    select(row.path);
    if (row.dir) setExpanded(row.path, !row.expanded);
    // A click shows the file in the preview editor; a double click keeps it
    // open (onDoubleClick), in the same pane.
    else void quickLook(m, row.path, treeRef.current);
  };

  // ---- drags ----
  const dropDir = (row?: Row) => (row ? dirOf(row.path, row.dir) : root);
  const onDragStart = (ev: React.DragEvent, row: Row) => {
    if (readOnly) return ev.preventDefault();
    const paths = targets(row.path);
    ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ m, paths }));
    ev.dataTransfer.effectAllowed = 'copyMove';
  };
  const accepts = (dt: DataTransfer) => !readOnly && (Array.from(dt.types).includes(DRAG_TYPE) || carriesFiles(dt));
  const onDragOver = (ev: React.DragEvent, row?: Row) => {
    if (!accepts(ev.dataTransfer)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const internal = Array.from(ev.dataTransfer.types).includes(DRAG_TYPE);
    ev.dataTransfer.dropEffect = internal && !ev.altKey ? 'move' : 'copy';
    setDrop(dropDir(row));
  };
  const onDrop = (ev: React.DragEvent, row?: Row) => {
    if (!accepts(ev.dataTransfer)) return;
    ev.preventDefault();
    ev.stopPropagation();
    setDrop(undefined);
    const dir = dropDir(row);
    const raw = ev.dataTransfer.getData(DRAG_TYPE);
    if (raw) {
      try {
        const d = JSON.parse(raw) as { m: string; paths: string[] };
        if (d.m !== m) return;
        if (ev.altKey) void copyInto(m, d.paths, dir);
        else void moveInto(m, d.paths, dir);
      } catch {
        /* not ours */
      }
      return;
    }
    void dropFiles(m, dir, ev.dataTransfer.items);
  };

  // ---- rows, windowed: only those in view are drawn ----
  const height = scroll.height || rows.length * ROW_HEIGHT;
  const first = Math.max(0, Math.floor(scroll.top / ROW_HEIGHT) - 10);
  const last = Math.min(rows.length, Math.ceil((scroll.top + height) / ROW_HEIGHT) + 10);
  const decorations = new Map<string, ReturnType<typeof decorationsOf>>();
  const decorationOf = (row: Row) => {
    const dir = parentOf(row.path);
    if (!decorations.has(dir)) decorations.set(dir, decorationsOf(m, dir));
    return decorations.get(dir)![row.name];
  };
  const selected = new Set(s.selection);
  const cut = new Set(s.clipboard?.cut && s.clipboard.m === m ? s.clipboard.paths : []);

  const drawRow = (row: Row, index: number) => {
    const style = { top: index * ROW_HEIGHT, height: ROW_HEIGHT, paddingLeft: 6 + row.depth * 12 };
    if (row.creating) {
      return (
        <div key={`new:${row.path}`} className="files-row editing" style={style} role="none">
          <span className="files-twisty" />
          {row.creating === 'folder' ? <Folder className="files-icon" /> : <FileIcon className="files-icon" />}
          <InlineEdit
            value=""
            className="files-edit"
            onDone={(name) => {
              setEdit(undefined);
              treeRef.current?.focus();
              if (name) void create(m, row.path, name, row.creating!);
            }}
          />
        </div>
      );
    }
    const deco = decorationOf(row);
    const renaming = s.edit?.kind === 'rename' && s.edit.path === row.path;
    const Icon = row.dir ? (row.expanded ? FolderOpen : Folder) : FileIcon;
    return (
      <div
        key={row.path}
        className={[
          'files-row',
          selected.has(row.path) && 'selected',
          s.cursor === row.path && 'cursor',
          drop === row.path && row.dir && 'drop',
          cut.has(row.path) && 'cut',
        ]
          .filter(Boolean)
          .join(' ')}
        style={style}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={row.dir ? row.expanded : undefined}
        aria-selected={selected.has(row.path)}
        data-path={row.path}
        title={deco?.tooltip ? `${row.path}\n${deco.tooltip}` : row.path}
        draggable={!readOnly && !renaming}
        onClick={(ev) => onRowClick(ev, row)}
        onDoubleClick={() => {
          if (!row.dir) void openPath(m, row.path, false);
        }}
        onContextMenu={(ev) => {
          if (!useTree.getState().selection.includes(row.path)) select(row.path);
          openMenu(ev, menuFor(m, targets(row.path), isDir, treeRef.current));
        }}
        onDragStart={(ev) => onDragStart(ev, row)}
        onDragOver={(ev) => onDragOver(ev, row)}
        onDrop={(ev) => onDrop(ev, row)}
      >
        <span className="files-twisty">{row.dir && (row.expanded ? <ChevronDown /> : <ChevronRight />)}</span>
        <Icon className="files-icon" />
        {renaming ? (
          <InlineEdit
            value={row.name}
            className="files-edit"
            onDone={(name) => {
              setEdit(undefined);
              treeRef.current?.focus();
              if (name) void rename(m, row.path, name);
            }}
          />
        ) : (
          <span className="files-name ellipsis" style={deco?.color ? { color: deco.color } : undefined}>
            {row.name}
          </span>
        )}
        {row.link && <Link2 className="files-link" aria-label={t('files.link')} />}
        {deco?.badge && (
          <span className="files-badge" style={deco.color ? { color: deco.color } : undefined}>
            {deco.badge}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <nav className="files-crumbs ellipsis" aria-label={t('files.breadcrumb')}>
          {crumbs(root, home).map(([p, name], i, all) => (
            <span key={p} className="files-crumb">
              <button
                className="link"
                title={p}
                onClick={() => {
                  setFollow(false);
                  showRoot(m, p);
                }}
                onDragOver={(ev) => onDragOver(ev, { path: p, name, depth: 0, dir: true, expanded: false })}
                onDrop={(ev) => onDrop(ev, { path: p, name, depth: 0, dir: true, expanded: false })}
              >
                {name}
              </button>
              {i < all.length - 1 && name !== '/' && <span className="muted">/</span>}
            </span>
          ))}
        </nav>
        <span className="spacer" />
        {!readOnly && (
          <>
            <button
              className="icon"
              title={t('files.newFile')}
              aria-label={t('files.newFile')}
              onClick={() => setEdit({ kind: 'file', path: newDir() })}
            >
              <FilePlus />
            </button>
            <button
              className="icon"
              title={t('files.newFolder')}
              aria-label={t('files.newFolder')}
              onClick={() => setEdit({ kind: 'folder', path: newDir() })}
            >
              <FolderPlus />
            </button>
          </>
        )}
        <button className="icon" title={t('files.refresh')} aria-label={t('files.refresh')} onClick={() => reloadDirs(Object.keys(s.dirs))}>
          <RefreshCw />
        </button>
        <button className="icon" title={t('files.collapseAll')} aria-label={t('files.collapseAll')} onClick={collapseAll}>
          <ChevronsDownUp />
        </button>
        <button
          className={`icon ${s.hidden ? 'on' : ''}`}
          title={t(s.hidden ? 'files.hideHidden' : 'files.showHidden')}
          aria-label={t('files.showHidden')}
          aria-pressed={s.hidden}
          onClick={() => setHidden(!s.hidden)}
        >
          {s.hidden ? <Eye /> : <EyeOff />}
        </button>
        <button
          className={`icon ${s.follow ? 'on' : ''}`}
          title={t('files.follow')}
          aria-label={t('files.follow')}
          aria-pressed={s.follow}
          onClick={() => setFollow(!s.follow)}
        >
          <LocateFixed />
        </button>
      </div>
      <input
        className="files-filter"
        type="search"
        placeholder={t('files.filter')}
        aria-label={t('files.filter')}
        value={s.filter}
        spellCheck={false}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setFilter('');
          else if (e.key === 'ArrowDown' || e.key === 'Enter') {
            e.preventDefault();
            treeRef.current?.focus();
            const st = useTree.getState();
            if (!st.cursor || !rows.some((r) => r.path === st.cursor)) {
              const p = stepRow(rows, undefined, 1);
              if (p) select(p);
            }
          }
        }}
      />
      <div
        ref={treeRef}
        className={`files-tree ${drop === root ? 'drop' : ''}`}
        role="tree"
        tabIndex={0}
        aria-label={t('files.title')}
        aria-multiselectable
        onKeyDown={onKey}
        onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
        onContextMenu={(ev) => {
          if (ev.defaultPrevented) return;
          openMenu(ev, menuFor(m, [], isDir, treeRef.current));
        }}
        onDragOver={(ev) => onDragOver(ev)}
        onDragLeave={(ev) => {
          if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setDrop(undefined);
        }}
        onDrop={(ev) => onDrop(ev)}
      >
        <div className="files-rows" style={{ height: rows.length * ROW_HEIGHT }}>
          {rows.slice(first, last).map((r, i) => drawRow(r, first + i))}
        </div>
        {rootDir?.error && <div className="files-note error small">{rootDir.error}</div>}
        {rootDir?.entries && !rows.length && (
          <div className="files-note muted small">{t(s.filter ? 'files.noMatch' : 'files.emptyDir')}</div>
        )}
      </div>
    </div>
  );

  /** Where the toolbar's new file or folder goes: the selected directory,
   * the selected file's, else the root. */
  function newDir(): string {
    const cur = useTree.getState().cursor;
    return cur && kinds.has(cur) ? dirOf(cur, isDir(cur)) : root;
  }
}
