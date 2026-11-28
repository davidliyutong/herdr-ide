// The Git panel in the right sidebar, as VS Code's Source Control view:
// the repository of the focused pane's directory (a picker when
// repositories are nested), its branch with ahead/behind and fetch, pull
// and push, a commit message box (Cmd/Ctrl+Enter commits; amend), the
// groups Merge Changes, Staged Changes, Changes (and Untracked Changes
// when shown apart) as collapsible sections, as a list or a tree of
// folders, whose rows behave as the file explorer's (selection, keys,
// context menu, file icons, the Git marks' colors); the stashes; the
// history of every commit is docked at the bottom (History.tsx), as VS
// Code's Source Control Graph.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronsDownUp,
  CloudUpload,
  Ellipsis,
  FileText,
  FolderGit2,
  GitBranch,
  GitGraph,
  List,
  ListTree,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import { openMenu, type MenuEntry } from '../../contextMenu';
import { confirmDialog } from '../../dialog';
import { isMac } from '../../keys';
import { t, type MessageKey } from '../../i18n';
import { setSetting, useSettings } from '../../settings';
import { useSize } from '../../lib/sizes';
import { useScrollView, visibleRange } from '../../lib/windowed';
import {
  Section,
  TreeRow,
  TypeAhead,
  clickSelection,
  navigationKey,
  selectAll,
  selectOnly,
  selectRange,
  selectToggle,
  useSectionOpen,
  type NavRow,
} from '../../components/tree';
import { FileIcon } from '../../fileIcons';
import { Picker } from '../../components/Picker';
import { confirmSync, fetchFrom, pickBranch, pullFrom, pushTo } from './pickers';
import { followedDir, recentDirectory } from '../files/FilesPanel';
import { current, paneDirectory } from '../../actions';
import { recentSpots } from '../../paneHistory';
import * as L from '../../term/layout';
import { gitApi, type StatusFile } from './api';
import { folderOf, leafName, letterColor, letterMark } from './shared';
import { baseName, createBranch, discard, join, openGraph, openStatusDiff, short, stashPush } from './ops';
import { fileEntries } from './fileMenu';
import { openFiles as openEditors } from '../files/ops';
import { History } from './History';
import { changed, forgetRepos, repoKey, runGit, useGit, useRepo, useReposOf, type RepoState } from './state';
import { lastShown, panelMemory, pickedRepo, useKept } from './memory';
import { Remotes } from './Remotes';
import { Stashes } from './Stashes';
import './git.css';

export type Group = 'merge' | 'staged' | 'changes' | 'untracked';
export const GROUPS: readonly Group[] = ['merge', 'staged', 'changes', 'untracked'];

export interface GroupedFile {
  file: StatusFile;
  /** The letter shown (the side the group is about). */
  letter: string;
}

/** The settings of the panel (backend/features/git). */
export const CHANGES_VIEW = 'git.changesView';
export const UNTRACKED_CHANGES = 'git.untrackedChanges';
export const AUTO_FETCH = 'git.autoFetch';

/** The status's files in VS Code's groups: conflicts, the index's changes,
 * the working tree's changes (untracked files among them, or apart when
 * separate). */
export function groupFiles(files: StatusFile[], separate = false): Record<Group, GroupedFile[]> {
  const out: Record<Group, GroupedFile[]> = { merge: [], staged: [], changes: [], untracked: [] };
  for (const f of files) {
    if (f.kind === 'ignored') continue;
    if (f.kind === 'unmerged') out.merge.push({ file: f, letter: '!' });
    else if (f.kind === 'untracked') out[separate ? 'untracked' : 'changes'].push({ file: f, letter: 'U' });
    else {
      if (f.x !== '.') out.staged.push({ file: f, letter: f.x });
      if (f.y !== '.') out.changes.push({ file: f, letter: f.y });
    }
  }
  for (const g of Object.values(out)) g.sort((a, b) => a.file.path.localeCompare(b.file.path));
  return out;
}

/** A row of a group: a folder of the tree, or a file. */
export type ChangeRow =
  | {
      kind: 'dir';
      id: string;
      group: Group;
      /** The folder's path from the top level; label is what the row
       * shows (folders with a single folder inside joined: a/b). */
      path: string;
      label: string;
      depth: number;
      parent?: string;
      expanded: boolean;
      /** Every file of the group inside it. */
      files: GroupedFile[];
    }
  | { kind: 'file'; id: string; group: Group; g: GroupedFile; depth: number; parent?: string };

/** A row's id: its group and path (a folder's apart from a file's). */
export const rowId = (group: Group, path: string, dir = false) => `${group}\u0000${dir ? 'd' : 'f'}:${path}`;

/** The rows of a group: its files as a list, or as a tree with folders
 * before files and those with a single folder inside joined (as VS Code
 * compacts them); a collapsed folder (its id in collapsed) hides what is
 * inside. */
export function groupRows(group: Group, files: GroupedFile[], tree: boolean, collapsed: ReadonlySet<string> = new Set()): ChangeRow[] {
  if (!tree) return files.map((g) => ({ kind: 'file', id: rowId(group, g.file.path), group, g, depth: 0 }));
  type Node = { dirs: Map<string, Node>; files: GroupedFile[]; all: GroupedFile[] };
  const node = (): Node => ({ dirs: new Map(), files: [], all: [] });
  const top = node();
  for (const g of files) {
    const parts = g.file.path.replace(/\/$/, '').split('/');
    let n = top;
    for (const p of parts.slice(0, -1)) {
      let next = n.dirs.get(p);
      if (!next) n.dirs.set(p, (next = node()));
      next.all.push(g);
      n = next;
    }
    n.files.push(g);
  }
  const out: ChangeRow[] = [];
  const walk = (n: Node, depth: number, prefix: string, parent?: string) => {
    for (const [name, d] of [...n.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name;
      let at = d;
      while (at.files.length === 0 && at.dirs.size === 1) {
        const [[k, v]] = [...at.dirs];
        label += '/' + k;
        at = v;
      }
      const path = prefix + label;
      const id = rowId(group, path, true);
      const expanded = !collapsed.has(id);
      out.push({ kind: 'dir', id, group, path, label, depth, parent, expanded, files: at.all });
      if (expanded) walk(at, depth + 1, path + '/', id);
    }
    for (const g of n.files) out.push({ kind: 'file', id: rowId(group, g.file.path), group, g, depth, parent });
  };
  walk(top, 0, '');
  return out;
}

/** The files rows stand for (a folder: those inside), each once. */
export function rowFiles(rows: readonly ChangeRow[]): GroupedFile[] {
  const seen = new Set<string>();
  const out: GroupedFile[] = [];
  for (const r of rows) {
    for (const g of r.kind === 'dir' ? r.files : [r.g]) {
      if (seen.has(g.file.path)) continue;
      seen.add(g.file.path);
      out.push(g);
    }
  }
  return out;
}

/** The machine and workspace shown (as files/FilesPanel followedDir
 * reads them): what the panel follows belongs to them. */
function placeOf(): string {
  const m = useStore.getState().machineId;
  return m ? `${m}\u0000${current()?.ws?.id ?? ''}` : '';
}

/** The repositories of the directory the panel follows: the answer for
 * it, else (while it is asked, or after a failure that says nothing about
 * it) what the panel last showed in this workspace of this machine
 * (memory.ts lastShown), so a terminal's cd inside the repository changes
 * nothing and another workspace or machine never shows this one's. */
function useShownRepos(m: string | undefined, place: string, dir: string | undefined): { roots?: string[]; error?: string } {
  const found = useReposOf(m, dir);
  const known = found.roots !== undefined && !found.error;
  useEffect(() => {
    if (place && known) lastShown.set(place, found.roots!);
  }, [place, known, found.roots]);
  if (known) return found;
  const last = place ? lastShown.get(place) : undefined;
  return last ? { roots: last } : found;
}

/** Directory a pane targets for Git: a Git diff/graph pane's repository,
 * else the pane's directory (terminal, VS Code, file editor, preview). */
function gitPaneDir(m: string, leaf: L.Leaf): string | undefined {
  if (L.isPluginLeaf(leaf) && leaf.view.plugin === 'git' && typeof leaf.view.repo === 'string' && leaf.view.repo) {
    return leaf.view.repo;
  }
  const dir = paneDirectory(m, leaf);
  if (dir) return dir;
  if (L.isPluginLeaf(leaf) && leaf.view.plugin === 'files' && leaf.view.kind === 'editor' && typeof leaf.view.path === 'string') {
    const p = leaf.view.path;
    const i = p.lastIndexOf('/');
    return i > 0 ? p.slice(0, i) : p ? '/' : undefined;
  }
  return undefined;
}

/** Focused directory for Git tracking: terminals and VS Code panes (from
 * FilesPanel's followedDir), plus file editors, previews, and Git
 * diff/graph panes. */
export function gitFollowedDir(): string | undefined {
  const dir = followedDir();
  if (dir) return dir;
  const c = current();
  if (!c?.tab || !c.focused) return undefined;
  const leaf = L.leafOf(c.tab.root, c.focused);
  return leaf ? gitPaneDir(c.m, leaf) : undefined;
}

/** Directory of the pane focused last in this workspace that has one
 * (terminal, VS Code, editor, preview, or Git pane). */
export function gitRecentDir(): string | undefined {
  const c = current();
  if (c?.ws) {
    for (const s of recentSpots()) {
      if (s.m !== c.m) continue;
      const leaf = c.ws.tabs.map((tab) => L.leafOf(tab.root, s.pane)).find(Boolean);
      if (leaf) {
        const dir = gitPaneDir(c.m, leaf);
        if (dir) return dir;
      }
    }
  }
  return recentDirectory();
}

export function GitPanel() {
  const m = useStore((s) => s.machineId);
  const home = useStore((s) => (s.machineId ? s.machines[s.machineId]?.info?.home : undefined));
  const paneDir = useTerms(gitFollowedDir);
  const paneDir2 = useStore(gitFollowedDir);
  const dir = paneDir ?? paneDir2;
  // The workspace selected is in the layout (the machine shown, m, in the
  // UI's store).
  const place = useTerms(placeOf);
  // The directory followed last in this workspace of this machine, kept
  // while another pane (a browser, a panel) has the focus; never another
  // machine's or workspace's.
  const [lastDir, setLastDir] = useState<{ place: string; dir: string }>();
  useEffect(() => {
    if (dir) setLastDir({ place, dir });
  }, [dir, place]);
  const kept = lastDir?.place === place ? lastDir.dir : undefined;
  const shownDir = dir ?? kept ?? gitRecentDir() ?? home;
  const { roots, error } = useShownRepos(m ?? undefined, place, shownDir);
  const reposMap = useGit((s) => s.repos);
  const allRoots = useMemo(() => {
    if (!m || !roots?.length) return roots;
    const seen = new Set(roots);
    const out = [...roots];
    for (const r of roots) {
      for (const n of reposMap[repoKey(m, r)]?.info?.nested ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          out.push(n);
        }
      }
    }
    return out;
  }, [m, roots, reposMap]);
  const pickKey = m && allRoots?.length ? `${m}\u0000${allRoots[0]}` : '';
  const [, pickedAgain] = useState(0);
  const picked = pickedRepo.get(pickKey);
  const setPicked = (r: string) => {
    pickedRepo.set(pickKey, r);
    pickedAgain((n) => n + 1);
  };
  const root = allRoots && allRoots.length ? (picked && allRoots.includes(picked) ? picked : allRoots[0]) : undefined;
  const st = useRepo(m ?? undefined, root);

  if (!m) return <div className="git-empty muted small">{t('git.noMachine')}</div>;
  if (allRoots === undefined) return <div className="git-empty muted small">{t('git.loading')}</div>;
  if (!root)
    return (
      <div className="git-empty muted small">
        {error ?? t('git.noRepo')}
        {shownDir && <div className="git-dir ellipsis">{shownDir}</div>}
        <button className="btn git-look-again" onClick={forgetRepos}>
          <RefreshCw /> {t('git.refresh')}
        </button>
      </div>
    );
  return (
    <div className="git-panel">
      {allRoots.length > 1 && (
        <Picker
          className="git-repo-pick"
          aria-label={t('git.repository')}
          label={t('git.repository')}
          items={allRoots.map((r) => ({ value: r, label: baseName(r), description: r, icon: <FolderGit2 /> }))}
          value={root}
          keepOrder
          onChange={setPicked}
        />
      )}
      {/* Its own state (the amend box, the history, the stashes) per repository. */}
      <RepoView
        key={`${m}\u0000${root}`}
        m={m}
        root={root}
        st={st}
        allRoots={allRoots}
        onOpenRepo={allRoots.length > 1 ? setPicked : undefined}
      />
    </div>
  );
}

const GROUP_TITLE: Record<Group, MessageKey> = {
  merge: 'git.group.merge',
  staged: 'git.group.staged',
  changes: 'git.group.changes',
  untracked: 'git.group.untracked',
};

/** The paths a file's unstaging names: a rename's old path too (else its
 * deletion stays staged). */
export const unstagePaths = (f: StatusFile) => (f.orig ? [f.path, f.orig] : [f.path]);

/** What a group's Stage All and Unstage All send: the whole index or
 * working tree when the group is all of it (no paths to list, however
 * many; only tracked files while untracked ones are shown apart), else
 * the group's paths. */
export function groupAction(group: Group, files: GroupedFile[], whole: boolean, separate = false): Record<string, unknown> {
  if (group === 'staged') return { all: true };
  if (whole && group === 'changes') return separate ? { all: true, tracked: true } : { all: true };
  return { paths: files.map((g) => g.file.path) };
}

function RepoView({
  m,
  root,
  st,
  allRoots,
  onOpenRepo,
}: {
  m: string;
  root: string;
  st?: RepoState;
  allRoots?: readonly string[];
  onOpenRepo?(repo: string): void;
}) {
  const readOnly = useStore((s) => s.readOnly);
  const rowH = useSize('row');
  // The list or the tree: the setting, which the toolbar's button sets
  // (in read-only mode, where settings stay as they are, for this view).
  const viewSetting = useSettings((s) => s.values[CHANGES_VIEW]?.value);
  // What the view shows of the repository is kept while the panel is away
  // (memory.ts): collapsed folders, the selection, the commit box.
  const [viewHere, setViewHere] = useKept(m, root, 'view');
  const tree = (viewHere ?? viewSetting) === 'tree';
  const separate = useSettings((s) => s.values[UNTRACKED_CHANGES]?.value) === 'separate';
  const [collapsed, setCollapsed] = useKept(m, root, 'collapsed');
  const [sel, setSel] = useKept(m, root, 'selection');
  const [message, setDraft] = useKept(m, root, 'draft');
  const [amend, setAmend] = useKept(m, root, 'amend');
  const box = useRef<HTMLTextAreaElement>(null);
  const [boxHeight] = useState(() => panelMemory(m, root).draftHeight);
  useLayoutEffect(() => {
    // The box's height as dragged, kept when the view goes.
    const el = box.current;
    return () => {
      if (el) panelMemory(m, root).draftHeight = el.style.height || undefined;
    };
  }, [m, root, readOnly]);
  const status = st?.status;
  const info = st?.info;
  const groups = useMemo(() => groupFiles(status?.files ?? [], separate), [status, separate]);
  // The status has the branch and HEAD (none when detached/unborn); the info
  // only until the first status.
  const branch = status ? status.branch : info?.branch;
  const head = status ? status.head : info?.head;
  const busy = st?.busy;
  const view = useScrollView();
  const [anchoredTop, setAnchoredTop] = useState<number>();
  const scrollView = useMemo(
    () => (anchoredTop !== undefined ? { top: anchoredTop, height: view.height } : view),
    [anchoredTop, view.top, view.height],
  );
  const list = useRef<HTMLDivElement | null>(null);
  // The list's scroll position, kept (memory.ts) and given back once.
  const scrolled = useRef(false);
  const setList = useCallback(
    (el: HTMLDivElement | null) => {
      list.current = el;
      if (el && !scrolled.current) {
        scrolled.current = true;
        el.scrollTop = panelMemory(m, root).scroll;
      }
      view.ref(el);
    },
    [m, root, view.ref],
  );
  // The groups shown and whether each is open (only open groups' rows
  // take the keyboard).
  const open: Record<Group, boolean> = {
    merge: useSectionOpen('git.merge')[0],
    staged: useSectionOpen('git.staged')[0],
    changes: useSectionOpen('git.changes')[0],
    untracked: useSectionOpen('git.untracked')[0],
  };

  // Scroll anchoring & focus preservation across status updates (staging,
  // unstaging, discarding, background polls): when a section above changes
  // height while scrolled down, adjust scrollTop by the anchor section's shift
  // before paint so the rows under the user's cursor stay put.
  const anchorGroupRef = useRef<Group | undefined>(undefined);
  const restoreFocusRef = useRef(false);
  const prevStatusRef = useRef(status);
  const prevLayoutRef = useRef<Partial<Record<Group, { top: number; height: number }>>>({});
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const cur: Partial<Record<Group, { top: number; height: number }>> = {};
    for (const g of GROUPS) {
      const sec = el.querySelector<HTMLElement>(`.git-section-${g}`);
      if (sec) cur[g] = { top: sec.offsetTop, height: sec.offsetHeight };
    }
    if (prevStatusRef.current !== status) {
      prevStatusRef.current = status;
      const prev = prevLayoutRef.current;
      const stTop = el.scrollTop;
      const acted = anchorGroupRef.current;
      anchorGroupRef.current = undefined;
      if (stTop > 0) {
        let anchor: Group | undefined = acted && prev[acted] && cur[acted] ? acted : undefined;
        if (!anchor) {
          for (const g of GROUPS) {
            const p = prev[g];
            if (p && cur[g] && p.top + p.height > stTop) {
              anchor = g;
              break;
            }
          }
        }
        if (anchor) {
          const delta = cur[anchor]!.top - prev[anchor]!.top;
          if (delta !== 0) {
            el.scrollTop = Math.max(0, stTop + delta);
            const actual = el.scrollTop;
            panelMemory(m, root).scroll = actual;
            setAnchoredTop(actual);
          }
        }
      }
      if (restoreFocusRef.current) {
        restoreFocusRef.current = false;
        if (!document.activeElement || document.activeElement === document.body) {
          el.focus({ preventScroll: true });
        }
      }
    }
    prevLayoutRef.current = cur;
  }, [m, root, status, tree, separate, collapsed, open.merge, open.staged, open.changes, open.untracked, rowH, view.top, view.height]);

  // Checking Amend prefills HEAD's full commit message when the draft is empty
  // (never clobbering user-typed text) and restores the prior draft if Amend is
  // unchecked before the user edits the prefilled message.
  const prefillReq = useRef(0);
  const prefillAbort = useRef<AbortController | undefined>(undefined);
  const cancelPrefill = useCallback(() => {
    prefillReq.current++;
    prefillAbort.current?.abort();
    prefillAbort.current = undefined;
  }, []);
  useEffect(() => () => cancelPrefill(), [cancelPrefill]);
  const prefillAmend = useCallback(
    (targetHead: string, expectedDraft: string, prior: string) => {
      cancelPrefill();
      const req = ++prefillReq.current;
      const ac = new AbortController();
      prefillAbort.current = ac;
      void gitApi
        .show(m, root, targetHead, { noFiles: true, signal: ac.signal })
        .then((shown) => {
          if (prefillReq.current !== req || ac.signal.aborted) return;
          const mem = panelMemory(m, root);
          if (!mem.amend || mem.draft !== expectedDraft) return;
          const msg = shown.commit?.message;
          if (!msg) return;
          mem.amendPrefill = { head: targetHead, filled: msg, prior };
          setDraft(msg);
        })
        .catch(() => undefined);
    },
    [m, root, setDraft, cancelPrefill],
  );
  const toggleAmend = (checked: boolean) => {
    cancelPrefill();
    const mem = panelMemory(m, root);
    if (checked) {
      setAmend(true);
      if (message.trim() === '') {
        // Keep a pending prefill marker so the effect loads HEAD's message now
        // (and again if RepoView unmounts while git show is still in flight).
        mem.amendPrefill = { head: '', filled: message, prior: message };
      } else {
        mem.amendPrefill = undefined;
      }
    } else {
      setAmend(false);
      const prefill = mem.amendPrefill;
      mem.amendPrefill = undefined;
      if (prefill && message === prefill.filled) setDraft(prefill.prior);
    }
  };
  useEffect(() => {
    if (!amend || !head) return;
    const mem = panelMemory(m, root);
    const prefill = mem.amendPrefill;
    if (!prefill || prefill.head === head || mem.draft !== prefill.filled) return;
    prefillAmend(head, mem.draft, prefill.prior);
  }, [m, root, amend, head, prefillAmend]);
  const typeahead = useMemo(() => new TypeAhead(), []);

  const shown = (g: Group) => g === 'changes' || (g === 'untracked' ? separate && groups.untracked.length > 0 : groups[g].length > 0);
  const rows = useMemo(() => {
    const out = {} as Record<Group, ChangeRow[]>;
    for (const g of GROUPS) out[g] = groupRows(g, groups[g], tree, collapsed);
    return out;
  }, [groups, tree, collapsed]);
  const navigable = GROUPS.filter((g) => shown(g) && open[g]).flatMap((g) => rows[g]);
  const byId = new Map(navigable.map((r) => [r.id, r]));
  const selected = new Set(sel.selection);

  const commit = async () => {
    if (readOnly || busy) return;
    if (!message.trim() && !amend) {
      useStore.getState().toast(t('git.commit.noMessage'));
      return;
    }
    if (!groups.staged.length && !amend) {
      if (!groups.changes.length && !groups.untracked.length) {
        useStore.getState().toast(t('git.commit.nothing'));
        return;
      }
      const ok = await confirmDialog({
        title: t('git.commit.stageAllTitle'),
        message: t('git.commit.stageAll'),
        confirm: t('git.commit.stageAllConfirm'),
      });
      if (!ok || !(await runGit(m, root, 'stage', { all: true }))) return;
    }
    const wasAmend = amend;
    const priorPrefill = panelMemory(m, root).amendPrefill;
    if (wasAmend) {
      cancelPrefill();
      panelMemory(m, root).amendPrefill = undefined;
    }
    if (await runGit(m, root, 'commit', { message, amend: wasAmend })) {
      cancelPrefill();
      panelMemory(m, root).amendPrefill = undefined;
      setDraft('');
      setAmend(false);
    } else if (wasAmend && priorPrefill && panelMemory(m, root).amend && panelMemory(m, root).draft === priorPrefill.filled) {
      panelMemory(m, root).amendPrefill = priorPrefill;
    }
  };

  const sync = async () => {
    if (!status?.upstream || !(await confirmSync('sync', status.upstream))) return;
    if (status.behind && !(await runGit(m, root, 'pull', {}))) return;
    if (status.ahead || status.behind) await runGit(m, root, 'push', {});
  };
  /** Pull from the upstream, else from a remote's branch chosen. */
  const pull = async (anchor: Element, rebase = false) => {
    if (!status?.upstream) return pullFrom(m, root, anchor, info, { branch, rebase });
    if (await confirmSync('pull', status.upstream)) await runGit(m, root, 'pull', rebase ? { rebase } : {});
  };
  /** Push to the upstream, else publish the branch (to a remote chosen
   * when there are several). */
  const push = async (anchor: Element, force = false) => {
    if (!status?.upstream) return branch ? pushTo(m, root, anchor, info, branch) : undefined;
    if (await confirmSync('push', status.upstream)) await runGit(m, root, 'push', force ? { forceWithLease: true } : {});
  };

  // Fetches every remote now and then while the panel shows the
  // repository and the page is visible (git.autoFetch, minutes); quietly:
  // what fails is seen when the user fetches.
  const autoFetch = Number(useSettings((s) => s.values[AUTO_FETCH]?.value) ?? 0);
  const hasRemotes = !!info?.remotes.length;
  useEffect(() => {
    if (!(autoFetch > 0) || readOnly || !hasRemotes) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible' || useGit.getState().repos[repoKey(m, root)]?.busy) return;
      void gitApi.run(m, root, 'fetch', { all: true, prune: true }).then(
        () => changed(m, root),
        () => undefined,
      );
    }, autoFetch * 60_000);
    return () => clearInterval(timer);
  }, [m, root, autoFetch, readOnly, hasRemotes]);

  const toggleChangesView = () => {
    const next = tree ? 'list' : 'tree';
    if (readOnly) return setViewHere(next);
    setViewHere(undefined);
    void setSetting(CHANGES_VIEW, next).then((err) => err && setViewHere(next));
  };

  const moreMenu = (e: React.MouseEvent) => {
    const remotes = info?.remotes ?? [];
    const anchor = e.currentTarget;
    const items: MenuEntry[] = [
      { label: t('git.fetch'), disabled: !remotes.length, run: () => void runGit(m, root, 'fetch', { all: true, prune: true }) },
      { label: t('git.fetchFrom'), disabled: !remotes.length, run: () => void fetchFrom(m, root, anchor, info) },
      'sep',
      { label: t('git.pull'), disabled: !status?.upstream, run: () => void pull(anchor) },
      { label: t('git.pullRebase'), disabled: !status?.upstream, run: () => void pull(anchor, true) },
      { label: t('git.pullFrom'), disabled: !remotes.length, run: () => void pullFrom(m, root, anchor, info, { branch }) },
      'sep',
      { label: t('git.push'), disabled: !status?.upstream, run: () => void push(anchor) },
      {
        label: t('git.pushTo'),
        disabled: !remotes.length || !branch,
        run: () => void pushTo(m, root, anchor, info, branch!, true),
      },
      {
        label: t('git.forcePush'),
        disabled: !status?.upstream,
        danger: true,
        run: () => void push(anchor, true),
      },
      'sep',
      { label: t('git.branch.create'), run: () => void createBranch(m, root) },
      { label: t('git.stash.push'), run: () => void stashPush(m, root) },
      'sep',
      { label: t(tree ? 'git.viewList' : 'git.viewTree'), run: toggleChangesView },
      { label: t('git.openGraph'), run: () => void openGraph(m, root) },
    ];
    openMenu(e, items);
  };

  // ---- the changes' rows: selection, keys, actions ----

  /** The rows an action on row acts on: the selected rows of its group
   * when it is one of them, else row alone. */
  const targetsOf = (row: ChangeRow): ChangeRow[] =>
    selected.has(row.id) ? [row, ...navigable.filter((r) => r.id !== row.id && r.group === row.group && selected.has(r.id))] : [row];

  const prepareListAction = (group: Group, keepFocus: boolean) => {
    anchorGroupRef.current = group;
    if (keepFocus && list.current && document.activeElement instanceof Node && list.current.contains(document.activeElement)) {
      restoreFocusRef.current = true;
    }
  };
  const stage = (files: GroupedFile[], group: Group) => {
    prepareListAction(group, true);
    void runGit(m, root, 'stage', { paths: files.map((g) => g.file.path) });
  };
  const unstage = (files: GroupedFile[], group: Group) => {
    prepareListAction(group, true);
    void runGit(m, root, 'unstage', { paths: files.flatMap((g) => unstagePaths(g.file)) });
  };
  const discardFiles = (files: GroupedFile[], group: Group) => {
    void discard(
      m,
      root,
      files.map((g) => g.file),
      { onConfirmed: () => prepareListAction(group, true) },
    );
  };
  /** Opens the diffs of files: one reuses Source Control's diff pane,
   * several open each in its own. back: the keyboard stays in the list. */
  const openDiffs = async (files: GroupedFile[], group: Group, back = false) => {
    const own = files.length > 1;
    for (const g of files) await openStatusDiff(m, root, g.file, group === 'staged', { own });
    if (back) list.current?.focus();
  };
  /** Opens files in the explorer's editors (deleted ones have none). */
  const openFiles = (files: GroupedFile[]) =>
    void openEditors(
      m,
      files.filter((g) => g.letter !== 'D').map((g) => join(root, g.file.path)),
    );

  const toggleDir = (id: string, expand?: boolean) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (expand ?? next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const collapseAll = () => {
    const all = new Set<string>();
    for (const g of GROUPS) for (const r of groupRows(g, groups[g], true)) if (r.kind === 'dir') all.add(r.id);
    setCollapsed(all);
  };

  const onRowClick = (ev: React.MouseEvent, row: ChangeRow) => {
    list.current?.focus();
    const how = clickSelection(ev);
    if (how === 'toggle') return setSel((s) => selectToggle(s, row.id));
    if (how === 'range')
      return setSel((s) =>
        selectRange(
          s,
          navigable.map((r) => r.id),
          row.id,
        ),
      );
    setSel(selectOnly(row.id));
    if (row.kind === 'dir') toggleDir(row.id);
    // The diff, as VS Code's preview: the keyboard stays here (submodules
    // and untracked nested repos are directories, not diffable text files).
    else if (!row.g.file.submodule && !row.g.file.path.endsWith('/')) void openDiffs([row.g], row.group, true);
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.target !== ev.currentTarget) return;
    const handled = () => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    const page = view.height ? Math.max(1, Math.floor(view.height / rowH) - 1) : undefined;
    const nav = navigationKey(ev, navRows(navigable), sel.cursor, { page, multi: true, typeahead });
    if (nav) {
      handled();
      if (nav.kind === 'move') {
        setSel((s) =>
          nav.extend
            ? selectRange(
                s,
                navigable.map((r) => r.id),
                nav.to,
              )
            : selectOnly(nav.to),
        );
        reveal(nav.to);
      } else if (nav.kind === 'expand' || nav.kind === 'collapse') toggleDir(nav.id, nav.kind === 'expand');
      else if (nav.kind === 'selectAll')
        setSel((s) =>
          selectAll(
            s,
            navigable.map((r) => r.id),
          ),
        );
      return;
    }
    const row = sel.cursor ? byId.get(sel.cursor) : undefined;
    if (!row) return;
    if (ev.key === 'Enter') {
      handled();
      // Folders open and close; a single submodule/nested repo opens that
      // repository; otherwise regular files selected open their diffs.
      const targets = targetsOf(row);
      if (targets.length === 1 && row.kind === 'file' && isDirFile(row.g.file)) {
        const subRoot = entryPathOf(row.g.file.path);
        if (onOpenRepo && allRoots?.includes(subRoot)) onOpenRepo(subRoot);
        return;
      }
      const files = targets.filter((r) => r.kind === 'file' && !isDirFile(r.g.file));
      if (!files.length) return row.kind === 'dir' ? toggleDir(row.id) : undefined;
      void openDiffs(rowFiles(files), row.group);
    } else if (ev.key === ' ' && row.kind === 'file' && !isDirFile(row.g.file)) {
      handled();
      void openDiffs([row.g], row.group, true);
    } else if (ev.key === 'Escape' && sel.selection.length > 1) {
      handled();
      setSel(selectOnly(row.id));
    }
  };

  /** Scrolls the list so that a row shows. */
  const reveal = (id: string) => {
    const el = list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  };

  const isDirFile = (f: StatusFile) => !!(f.submodule || f.path.endsWith('/'));
  const entryPathOf = (p: string) => join(root, p.replace(/\/+$/, ''));

  const rowMenu = (ev: React.MouseEvent, row: ChangeRow) => {
    if (!selected.has(row.id)) setSel(selectOnly(row.id));
    const targets = targetsOf(row);
    const files = rowFiles(targets);
    const group = row.group;
    // Open Changes: the files selected (a folder or submodule opens or closes).
    const own = rowFiles(targets.filter((r) => r.kind === 'file' && !isDirFile(r.g.file)));
    const git: MenuEntry[] = [];
    if (targets.length === 1 && row.kind === 'file' && isDirFile(row.g.file) && onOpenRepo) {
      const subRoot = entryPathOf(row.g.file.path);
      if (allRoots?.includes(subRoot)) git.push({ label: t('git.openRepo'), run: () => onOpenRepo(subRoot) });
    }
    if (own.length) git.push({ label: t('git.openDiff'), hint: '↵', run: () => void openDiffs(own, group) });
    if (group === 'staged') git.push({ label: t('git.unstage'), disabled: readOnly, run: () => unstage(files, group) });
    else git.push({ label: t('git.stage'), disabled: readOnly, run: () => stage(files, group) });
    if (group === 'changes' || group === 'untracked')
      git.push({ label: t('git.discard'), danger: true, disabled: readOnly, run: () => discardFiles(files, group) });
    // The explorer's file entries for the rows: files, submodules, and the tree's folders.
    const paths = targets.map((r) => entryPathOf(r.kind === 'dir' ? r.path : r.g.file.path));
    const dirs = new Set(
      targets.flatMap((r) => (r.kind === 'dir' || isDirFile(r.g.file) ? [entryPathOf(r.kind === 'dir' ? r.path : r.g.file.path)] : [])),
    );
    const gone = new Set(targets.flatMap((r) => (r.kind === 'file' && r.g.letter === 'D' ? [entryPathOf(r.g.file.path)] : [])));
    openMenu(ev, [...git, 'sep', ...fileEntries(m, { paths, root, dirs, gone, el: list.current })]);
  };

  const drawRow = (row: ChangeRow, top: number): ReactNode => {
    const style = { top, height: rowH };
    const common = {
      style,
      depth: row.depth,
      selected: selected.has(row.id),
      cursor: sel.cursor === row.id,
      'data-id': row.id,
      onClick: (ev: React.MouseEvent) => onRowClick(ev, row),
      onContextMenu: (ev: React.MouseEvent) => rowMenu(ev, row),
    };
    const group = row.group;
    const act = (files: () => GroupedFile[]) => (
      <>
        {!readOnly && (group === 'changes' || group === 'untracked') && (
          <button className="icon" title={t('git.discard')} aria-label={t('git.discard')} onClick={() => discardFiles(files(), group)}>
            <Undo2 />
          </button>
        )}
        {!readOnly &&
          (group === 'staged' ? (
            <button className="icon" title={t('git.unstage')} aria-label={t('git.unstage')} onClick={() => unstage(files(), group)}>
              <Minus />
            </button>
          ) : (
            <button className="icon" title={t('git.stage')} aria-label={t('git.stage')} onClick={() => stage(files(), group)}>
              <Plus />
            </button>
          ))}
      </>
    );
    if (row.kind === 'dir') {
      return (
        <TreeRow
          key={row.id}
          {...common}
          className="git-row git-dir-row"
          expanded={row.expanded}
          onToggle={() => toggleDir(row.id)}
          icon={<FileIcon name={leafName(row.label)} kind="dir" open={row.expanded} />}
          label={row.label}
          title={row.path}
          actions={act(() => rowFiles(targetsOf(row)))}
        />
      );
    }
    const f = row.g.file;
    const deleted = row.g.letter === 'D';
    const isDirEntry = isDirFile(f);
    const subRoot = isDirEntry ? entryPathOf(f.path) : '';
    const canOpenRepo = isDirEntry && !!onOpenRepo && !!allRoots?.includes(subRoot);
    const mark = letterMark(row.g.letter);
    const folder = folderOf(f.path);
    return (
      <TreeRow
        key={row.id}
        {...common}
        className={`git-row${deleted ? ' deleted' : ''}`}
        icon={<FileIcon name={leafName(f.path)} kind={isDirEntry ? 'dir' : 'file'} />}
        label={leafName(f.path)}
        description={!tree && folder ? folder : undefined}
        decoration={{ badge: row.g.letter, color: letterColor(row.g.letter), tooltip: t(`git.mark.${mark}` as MessageKey) }}
        title={f.orig ? `${f.orig} → ${f.path}` : f.path}
        onDoubleClick={() => {
          if (canOpenRepo) onOpenRepo(subRoot);
          else if (!isDirEntry) void openDiffs([row.g], group);
        }}
        actions={
          <>
            {!deleted && canOpenRepo && (
              <button className="icon" title={t('git.openRepo')} aria-label={t('git.openRepo')} onClick={() => onOpenRepo(subRoot)}>
                <FolderGit2 />
              </button>
            )}
            {!deleted && !isDirEntry && (
              <button
                className="icon"
                title={t('git.openFile')}
                aria-label={t('git.openFile')}
                onClick={() => openFiles(rowFiles(targetsOf(row)))}
              >
                <FileText />
              </button>
            )}
            {act(() => rowFiles(targetsOf(row)))}
          </>
        }
      />
    );
  };

  const groupActions = (group: Group): ReactNode => {
    const files = groups[group];
    if (readOnly || !files.length) return undefined;
    const whole = group === 'changes' && !groups.merge.length;
    return (
      <>
        {(group === 'changes' || group === 'untracked') && (
          <button
            className="icon sm"
            title={t('git.discardAll')}
            aria-label={t('git.discardAll')}
            onClick={() => discardFiles(files, group)}
          >
            <Undo2 />
          </button>
        )}
        {group === 'staged' ? (
          <button
            className="icon sm"
            title={t('git.unstageAll')}
            aria-label={t('git.unstageAll')}
            onClick={() => {
              prepareListAction(group, true);
              void runGit(m, root, 'unstage', groupAction(group, files, true));
            }}
          >
            <Minus />
          </button>
        ) : (
          <button
            className="icon sm"
            title={t('git.stageAll')}
            aria-label={t('git.stageAll')}
            onClick={() => {
              prepareListAction(group, true);
              void runGit(m, root, 'stage', groupAction(group, files, whole, separate));
            }}
          >
            <Plus />
          </button>
        )}
      </>
    );
  };

  const commitKey = isMac ? '⌘↵' : 'Ctrl+Enter';

  return (
    <>
      <div className="git-toolbar">
        <span className="git-title ellipsis" title={root}>
          {baseName(root)}
        </span>
        <span className="spacer" />
        {tree && (
          <button className="icon" title={t('git.collapseAll')} aria-label={t('git.collapseAll')} onClick={collapseAll}>
            <ChevronsDownUp />
          </button>
        )}
        <button
          className="icon"
          title={t(tree ? 'git.viewList' : 'git.viewTree')}
          aria-label={t(tree ? 'git.viewList' : 'git.viewTree')}
          onClick={toggleChangesView}
        >
          {tree ? <List /> : <ListTree />}
        </button>
        <button className="icon" title={t('git.openGraph')} aria-label={t('git.openGraph')} onClick={() => void openGraph(m, root)}>
          <GitGraph />
        </button>
        <button
          className="icon"
          title={t('git.refresh')}
          aria-label={t('git.refresh')}
          onClick={() => (forgetRepos(), void changed(m, root, { all: true }))}
        >
          <RefreshCw />
        </button>
        <button className="icon" title={t('git.more')} aria-label={t('git.more')} onClick={moreMenu}>
          <Ellipsis />
        </button>
        {busy && (
          <div
            className="git-busy"
            role="status"
            aria-label={t('git.running', { action: busy })}
            title={t('git.running', { action: busy })}
          />
        )}
      </div>
      <div className="git-branch">
        <GitBranch />
        <button
          className="git-branch-pick ellipsis"
          title={readOnly ? (branch ?? status?.head) : t('git.pick.title', { branch: branch ?? short(status?.head ?? '') })}
          disabled={readOnly}
          onClick={(e) => void pickBranch(m, root, e.currentTarget, { current: branch, remotes: info?.remotes ?? [] })}
        >
          {branch ?? (status?.head ? t('git.detached', { commit: short(status.head) }) : t('git.noCommits'))}
        </button>
        {status?.upstream ? (
          <button
            className="git-sync"
            disabled={readOnly || !!busy}
            title={t('git.syncTitle', { upstream: status.upstream })}
            onClick={() => void sync()}
          >
            <ArrowUpDown />
            <span>
              {status.behind}↓ {status.ahead}↑
            </span>
          </button>
        ) : (
          branch &&
          !!info?.remotes.length && (
            <button
              className="git-sync"
              disabled={readOnly || !!busy}
              title={t('git.publish')}
              onClick={(e) => void pushTo(m, root, e.currentTarget, info, branch)}
            >
              <CloudUpload />
              <span>{t('git.publish')}</span>
            </button>
          )
        )}
        {!!info?.remotes.length && (
          <>
            <button
              className="icon"
              title={t('git.pull')}
              aria-label={t('git.pull')}
              disabled={readOnly || !!busy || (!status?.upstream && !branch)}
              onClick={(e) => void pull(e.currentTarget)}
            >
              <ArrowDown />
            </button>
            <button
              className="icon"
              title={t('git.push')}
              aria-label={t('git.push')}
              disabled={readOnly || !!busy || (!status?.upstream && !branch)}
              onClick={(e) => void push(e.currentTarget)}
            >
              <ArrowUp />
            </button>
          </>
        )}
      </div>
      {status?.state && <StateBanner m={m} root={root} state={status.state} />}
      {st?.error && <div className="git-error small">{st.error}</div>}
      {!readOnly && (
        <div className="git-commit">
          <textarea
            ref={box}
            className="git-message"
            style={boxHeight ? { height: boxHeight } : undefined}
            rows={Math.min(8, Math.max(2, message.split('\n').length))}
            spellCheck={false}
            value={message}
            placeholder={t('git.commit.placeholder', { branch: branch ?? 'HEAD', key: commitKey })}
            onChange={(e) => {
              cancelPrefill();
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.stopPropagation();
                void commit();
              }
            }}
          />
          <div className="git-commit-row">
            <label className="git-amend small">
              <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} /> {t('git.commit.amend')}
            </label>
            <span className="spacer" />
            <button className="primary" disabled={!!busy} onClick={() => void commit()}>
              <Check /> {t(amend ? 'git.commit.amendButton' : 'git.commit.button')}
            </button>
          </div>
        </div>
      )}
      <div
        ref={setList}
        className="git-groups tree"
        role="tree"
        tabIndex={0}
        aria-label={t('git.changes')}
        aria-multiselectable
        onKeyDown={onKey}
        onScroll={(e) => {
          setAnchoredTop(undefined);
          panelMemory(m, root).scroll = e.currentTarget.scrollTop;
          view.onScroll(e);
        }}
      >
        {status?.truncated && <div className="git-error small">{t('git.truncated')}</div>}
        {GROUPS.filter(shown).map((g) => (
          <ChangeSection
            key={g}
            group={g}
            count={groups[g].length}
            rows={rows[g]}
            actions={groupActions(g)}
            view={scrollView}
            rowH={rowH}
            drawRow={drawRow}
          />
        ))}
        <Stashes m={m} root={root} version={st?.refs ?? 0} />
        <Remotes m={m} root={root} info={info} branch={branch} upstream={status?.upstream} />
      </div>
      <History key={`${m}\u0000${root}`} m={m} root={root} version={st?.refs ?? 0} branch={branch} head={status?.head} />
    </>
  );
}

/** The keyboard's view of the rows. */
function navRows(rows: readonly ChangeRow[]): NavRow[] {
  return rows.map((r) => ({
    id: r.id,
    parent: r.parent,
    expanded: r.kind === 'dir' ? r.expanded : undefined,
    label: r.kind === 'dir' ? r.label : leafName(r.g.file.path),
  }));
}

/** A group of changes: a collapsible section whose rows are drawn only
 * while in view of the list (view: its scroll position and height). */
function ChangeSection(p: {
  group: Group;
  count: number;
  rows: ChangeRow[];
  actions?: ReactNode;
  view: { top: number; height: number };
  rowH: number;
  drawRow(row: ChangeRow, top: number): ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  // Where the rows start in the list, measured once drawn (sections above
  // open and close).
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const o = body.current?.offsetTop ?? 0;
    if (o !== offset) setOffset(o);
  });
  const n = p.rows.length;
  const [first, end] = visibleRange(n, p.rowH, p.view.top - offset, p.view.height || n * p.rowH);
  const last = Math.max(first, end);
  return (
    <Section id={`git.${p.group}`} className={`git-section-${p.group}`} title={t(GROUP_TITLE[p.group])} count={p.count} actions={p.actions}>
      <div ref={body} className="git-rows" style={{ height: n * p.rowH }}>
        {p.rows.slice(first, last).map((r, i) => p.drawRow(r, (first + i) * p.rowH))}
      </div>
    </Section>
  );
}

function StateBanner({ m, root, state }: { m: string; root: string; state: string }) {
  const readOnly = useStore((s) => s.readOnly);
  return (
    <div className="git-state small" role="status">
      <span>{t(`git.state.${state}` as 'git.state.merge')}</span>
      <span className="spacer" />
      {!readOnly && (
        <>
          <button className="btn" onClick={() => void runGit(m, root, 'abort', { op: state })}>
            {t('git.abort')}
          </button>
          <button className="btn" onClick={() => void runGit(m, root, 'continue', { op: state })}>
            {t('git.continue')}
          </button>
        </>
      )}
    </div>
  );
}
