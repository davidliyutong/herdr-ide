// The file explorer's panel in the right sidebar: a tree of the shown
// machine's files rooted at the focused terminal's directory (or a
// directory chosen in the breadcrumb), as VS Code's explorer is: expand and
// collapse, a filter, hidden files on or off, the keyboard (arrows, Enter,
// Space, F2, Delete), a context menu, drags that move files and drops from
// the computer that upload them. A click shows a file in Quick Look, a
// double click (or Enter) opens it in the editor pane.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronsDownUp, Ellipsis, Eye, EyeOff, FilePlus, FolderPlus, LocateFixed, RefreshCw } from 'lucide-react';
import { current, paneDirectory } from '../../actions';
import { recentSpots } from '../../paneHistory';
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
import { revealTop, useScrollView, visibleRange } from '../../lib/windowed';
import { TreeRow } from '../../components/tree/TreeRow';
import { TypeAhead, clickSelection, navigationKey, stepId } from '../../components/tree/selection';
import { FileIcon } from '../../fileIcons';
import { decorationsOf, useDecorationVersion, useShownDirs } from './decorations';
import {
  baseName,
  collapseAll,
  crumbs,
  navRows,
  parentOf,
  poll,
  refresh,
  rowIds,
  select,
  selectAllRows,
  setEdit,
  setExpanded,
  setFilter,
  setFollow,
  setHidden,
  showRoot,
  shownDirs,
  shownError,
  treeRows,
  useTree,
  setClipboard,
  type Row,
  type TreeState,
} from './tree';
import {
  copyInto,
  create,
  dirOf,
  dropFiles,
  loadRevealable,
  menuFor,
  moveInto,
  openFiles,
  openPath,
  panelMenu,
  paste,
  quickLook,
  remove,
  rename,
  trash,
} from './ops';
import { canDownload } from '../../download';
import { downloadUrl } from '../../lib/files';
import { startPolling } from './poller';
import './files.css';

/** How often the shown directories are checked for changes. */
export const POLL_MS = 2000;
/** The drag type of paths dragged inside the tree. */
const DRAG_TYPE = `application/x-${APP_SLUG}-files`;

/** The DownloadURL of rows dragged out of the page ("type:name:url", as
 * Chromium takes it): one file as itself, anything else as the zip the
 * core makes, named as the core names it. */
export function dragOutUrl(m: string, paths: string[], isDir: (p: string) => boolean): string | undefined {
  if (!paths.length) return undefined;
  let name: string;
  if (paths.length === 1) name = baseName(paths[0]) + (isDir(paths[0]) ? '.zip' : '');
  else {
    let dir = parentOf(paths[0]);
    for (const p of paths) while (dir !== '/' && !p.startsWith(dir + '/')) dir = parentOf(dir);
    name = dir === '/' ? 'download.zip' : baseName(dir) + '.zip';
  }
  // A colon would end the name early.
  return `application/octet-stream:${name.replace(/:/g, '_')}:${location.origin}${downloadUrl(m, paths)}`;
}

/** The directory the tree follows: the focused terminal's (a VS Code
 * pane's folder), the workspace's without a focused pane; undefined while
 * another pane (a preview, an editor) has the focus, which keeps the tree
 * where it is in that workspace (another workspace or machine takes
 * recentDirectory instead). */
export function followedDir(): string | undefined {
  const c = current();
  if (!c) return undefined;
  const leaf = c.tab && c.focused ? L.leafOf(c.tab.root, c.focused) : null;
  if (!leaf) return c.ws?.cwd || undefined;
  if (L.isTerminalLeaf(leaf) || L.isCodeLeaf(leaf)) return paneDirectory(c.m, leaf) ?? (c.ws?.cwd || undefined);
  return undefined;
}

/** The directory of the terminal or VS Code pane of the workspace shown
 * that had the focus last (the focus history, paneHistory.ts), for a
 * panel drawn while a pane without one has the focus: a panel opened as a
 * pane, in a tab of its own, follows the pane the user was in. */
export function recentDirectory(): string | undefined {
  const c = current();
  if (!c?.ws) return undefined;
  for (const s of recentSpots()) {
    if (s.m !== c.m) continue;
    const leaf = c.ws.tabs.map((tab) => L.leafOf(tab.root, s.pane)).find(Boolean);
    if (leaf && (L.isTerminalLeaf(leaf) || L.isCodeLeaf(leaf))) {
      const dir = paneDirectory(c.m, leaf);
      if (dir) return dir;
    }
  }
  return c.ws.cwd || undefined;
}

/** The workspace shown (its id), of the machine shown. */
const shownWorkspace = (): string | undefined => current()?.ws?.id;

/** Where the tree is rooted for machine m and workspace ws, from where it
 * is (st) and the directory followed. In the workspace the root was taken
 * for, it follows the focused terminal or VS Code pane and stays where it
 * is while another pane has the focus; another workspace or machine takes
 * the directory of its terminal or VS Code pane focused last
 * (recentDirectory), else its own, so the tree never shows another
 * workspace's or machine's directory. Without following, the root stays
 * where the user put it on its machine, and another machine starts at its
 * workspace's directory (recentDirectory). */
export function rootFor(
  st: Pick<TreeState, 'm' | 'ws' | 'root' | 'follow'>,
  m: string,
  ws: string | undefined,
  followed: string | undefined,
  home: string | undefined,
): string {
  const sameMachine = st.m === m;
  const samePlace = sameMachine && st.ws === ws;
  const here = st.follow ? (followed ?? (samePlace ? st.root : undefined)) : sameMachine ? st.root : undefined;
  return here ?? recentDirectory() ?? home ?? '/';
}

export function FilesPanel() {
  const m = useStore((s) => s.machineId);
  const home = useStore((s) => (s.machineId ? s.machines[s.machineId]?.info?.home : undefined));
  const readOnly = useStore((s) => s.readOnly);
  // Both stores: the focused pane is in the layout, the shown machine in the UI's.
  const paneDir = useTerms(followedDir);
  const paneDir2 = useStore(followedDir);
  const followed = paneDir ?? paneDir2;
  const ws1 = useTerms(shownWorkspace);
  const ws2 = useStore(shownWorkspace);
  const ws = ws1 ?? ws2;
  const s = useTree();
  useDecorationVersion((d) => d.v);
  const treeRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<string>();
  const view = useScrollView();
  const typeahead = useMemo(() => new TypeAhead(), []);

  // The directories shown, for decoration providers.
  const shownKey = s.m === m && s.root ? shownDirs(s).sort().join('\n') : '';
  useEffect(() => {
    useShownDirs.setState({ m: shownKey ? m : undefined, dirs: shownKey ? shownKey.split('\n') : [] });
  }, [m, shownKey]);
  useEffect(() => () => useShownDirs.setState({ m: undefined, dirs: [] }), []);

  // The root (rootFor), taken before the panel is painted: another
  // machine's tree is never drawn, nor asked about, under this one's.
  useLayoutEffect(() => {
    if (m) showRoot(m, rootFor(useTree.getState(), m, ws, followed, home), ws);
  }, [m, ws, followed, s.follow, home]);

  // While the panel is shown and the page visible, the shown directories
  // are checked for changes, one poll at a time.
  useEffect(() => startPolling(POLL_MS, poll), []);
  // Whether its menus offer Reveal in Finder.
  useEffect(() => loadRevealable(m ?? undefined), [m]);

  // Rows are --h-row high, which scales with the UI font size.
  const ROW_HEIGHT = useSize('row');
  const rows = useMemo(() => treeRows(s), [s.root, s.dirs, s.expanded, s.hidden, s.filter, s.edit, s.exclude, s.sort]);
  const kinds = useMemo(() => new Map(rows.map((r) => [r.path, r.dir])), [rows]);
  const isDir = (p: string) => kinds.get(p) ?? p === s.root;

  // Keep the cursor's row in view.
  useEffect(() => {
    const el = treeRef.current;
    if (!el || !s.cursor || !el.clientHeight) return;
    const i = rows.findIndex((r) => r.path === s.cursor);
    if (i >= 0) el.scrollTop = revealTop(el.scrollTop, el.clientHeight, i * ROW_HEIGHT, (i + 1) * ROW_HEIGHT);
  }, [s.cursor, rows, ROW_HEIGHT]);

  // The path's end stays in view: a narrow panel scrolls its start away
  // (as VS Code's breadcrumbs do) rather than squeezing every name.
  const crumbsRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [s.root]);

  if (!m || !s.root || s.m !== m) return <div className="files-empty muted small">{t('files.noMachine')}</div>;
  const root = s.root;
  const rootDir = s.dirs[root];
  const rootError = shownError(rootDir);

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
    // Arrows, pages, Home, End, ← → on folders, ⌘/Ctrl+A, type-ahead.
    const height = view.height || treeRef.current?.clientHeight;
    const page = height ? Math.floor(height / ROW_HEIGHT) - 1 : undefined;
    const nav = navigationKey(ev, navRows(rows), cur, { page, multi: true, typeahead });
    if (nav) {
      handled();
      if (nav.kind === 'move') select(nav.to, nav.extend ? 'range' : 'only', rows);
      else if (nav.kind === 'expand' || nav.kind === 'collapse') setExpanded(nav.id, nav.kind === 'expand');
      else if (nav.kind === 'selectAll') selectAllRows(rows);
      return;
    }
    switch (true) {
      case ev.key === 'Enter': {
        handled();
        // On a selection of several, its files open; else the cursor's row.
        const files = st.selection.filter((p) => kinds.get(p) === false);
        if (row && st.selection.length > 1 && st.selection.includes(row.path)) void openFiles(m, files);
        else if (row) void openPath(m, row.path, row.dir);
        return;
      }
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
    // Only rows shown: a selection the tree does not show is not acted on.
    const sel = (st.selection.length ? st.selection : cur ? [cur] : []).filter((p) => kinds.has(p));
    if (ev.key === 'F2' && row) {
      handled();
      setEdit({ kind: 'rename', path: row.path });
    } else if ((ev.key === 'Delete' || (isMac && ev.key === 'Backspace' && ev.metaKey)) && sel.length) {
      handled();
      if (ev.shiftKey) void remove(m, sel);
      else void trash(m, sel);
    } else if (mod && !ev.shiftKey && !ev.altKey && (ev.key === 'c' || ev.key === 'x') && sel.length) {
      handled();
      setClipboard({ m, paths: sel, cut: ev.key === 'x' });
    } else if (mod && !ev.shiftKey && !ev.altKey && ev.key === 'v' && st.clipboard) {
      handled();
      void paste(m, row ? dirOf(row.path, row.dir) : root);
    }
  };

  const onRowClick = (ev: React.MouseEvent, row: Row) => {
    treeRef.current?.focus();
    const how = clickSelection(ev);
    if (how !== 'only') return select(row.path, how, rows);
    select(row.path);
    if (row.dir) setExpanded(row.path, !row.expanded);
    // A click shows the file in the preview editor; a double click keeps it
    // open (onDoubleClick), in the same pane.
    else void quickLook(m, row.path, treeRef.current);
  };

  // ---- drags ----
  const dropDir = (row?: Row) => (row ? dirOf(row.path, row.dir) : root);
  const onDragStart = (ev: React.DragEvent, row: Row) => {
    const paths = targets(row.path);
    const out = canDownload(m) ? dragOutUrl(m, paths, isDir) : undefined;
    if (readOnly && !out) return ev.preventDefault();
    // Rows move or copy inside the tree; dropped on the computer (where
    // the browser takes DownloadURL: Chromium's), they download.
    if (!readOnly) ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ m, paths }));
    if (out) ev.dataTransfer.setData('DownloadURL', out);
    ev.dataTransfer.effectAllowed = readOnly ? 'copy' : 'copyMove';
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

  // ---- rows, windowed: only those in view are drawn (all of them
  // until the tree is measured) ----
  const [first, last] = visibleRange(rows.length, ROW_HEIGHT, view.top, view.height || rows.length * ROW_HEIGHT);
  const decorations = new Map<string, ReturnType<typeof decorationsOf>>();
  const decorationOf = (row: Row) => {
    const dir = parentOf(row.path);
    if (!decorations.has(dir)) decorations.set(dir, decorationsOf(m, dir));
    return decorations.get(dir)![row.name];
  };
  const selected = new Set(s.selection);
  // The filter's text in each name, marked.
  const needle = s.filter.trim().toLowerCase();
  const matched = (name: string): Array<[number, number]> | undefined => {
    const at = needle ? name.toLowerCase().indexOf(needle) : -1;
    return at < 0 ? undefined : [[at, at + needle.length]];
  };
  const cut = new Set(s.clipboard?.cut && s.clipboard.m === m ? s.clipboard.paths : []);

  const drawRow = (row: Row, index: number) => {
    const style = { top: index * ROW_HEIGHT, height: ROW_HEIGHT };
    if (row.creating) {
      return (
        <TreeRow
          key={`new:${row.path}`}
          className="files-row editing"
          style={style}
          role="none"
          depth={row.depth}
          expanded={undefined}
          icon={<FileIcon name="" kind={row.creating === 'folder' ? 'dir' : 'file'} />}
          label=""
          editor={
            <InlineEdit
              value=""
              className="files-edit"
              onDone={(name) => {
                setEdit(undefined);
                treeRef.current?.focus();
                if (name) void create(m, row.path, name, row.creating!);
              }}
            />
          }
        />
      );
    }
    const deco = decorationOf(row);
    const renaming = s.edit?.kind === 'rename' && s.edit.path === row.path;
    return (
      <TreeRow
        key={row.path}
        className="files-row"
        style={style}
        depth={row.depth}
        expanded={row.dir ? row.expanded : undefined}
        icon={<FileIcon name={row.name} kind={row.dir ? 'dir' : 'file'} open={row.dir && row.expanded} link={row.link} />}
        label={row.name}
        highlight={matched(row.name)}
        decoration={deco}
        selected={selected.has(row.path)}
        cursor={s.cursor === row.path}
        dropTarget={drop === row.path && row.dir}
        dimmed={cut.has(row.path)}
        data-path={row.path}
        title={deco?.tooltip ? `${row.path}\n${deco.tooltip}` : row.path}
        draggable={!renaming && (!readOnly || canDownload(m))}
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
        editor={
          renaming ? (
            <InlineEdit
              value={row.name}
              className="files-edit"
              onDone={(name) => {
                setEdit(undefined);
                treeRef.current?.focus();
                if (name) void rename(m, row.path, name);
              }}
            />
          ) : undefined
        }
      />
    );
  };

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <nav ref={crumbsRef} className="files-crumbs" title={root} aria-label={t('files.breadcrumb')}>
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
        <button className="icon" title={t('files.refresh')} aria-label={t('files.refresh')} onClick={refresh}>
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
        <button
          className="icon"
          title={t('files.more')}
          aria-label={t('files.more')}
          aria-haspopup="menu"
          onClick={(ev) => {
            const r = ev.currentTarget.getBoundingClientRect();
            openMenu({ clientX: r.left, clientY: r.bottom, preventDefault: () => {}, stopPropagation: () => {} }, panelMenu(m, isDir));
          }}
        >
          <Ellipsis />
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
              const p = stepId(rowIds(rows), undefined, 1);
              if (p) select(p);
            }
          }
        }}
      />
      <div
        ref={(el) => {
          treeRef.current = el;
          view.ref(el);
        }}
        className={`tree files-tree ${drop === root ? 'drop' : ''}`}
        role="tree"
        tabIndex={0}
        aria-label={t('files.title')}
        aria-multiselectable
        onKeyDown={onKey}
        onScroll={view.onScroll}
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
        {rootError && <div className="files-note error small">{rootError}</div>}
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
