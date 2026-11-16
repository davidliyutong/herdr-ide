// The Git panel in the right sidebar, as VS Code's Source Control view:
// the repository of the focused pane's directory (a picker when
// repositories are nested), its branch with ahead/behind and fetch, pull
// and push, a commit message box (Cmd/Ctrl+Enter commits; amend), the
// groups Merge Changes, Staged Changes and Changes as a list or a tree
// with their actions and the stashes; the history of every commit is
// docked at the bottom (History.tsx), as VS Code's Source Control Graph.

import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  Ellipsis,
  FileText,
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
import { t } from '../../i18n';
import { followedDir } from '../files/FilesPanel';
import { gitApi, type Stash, type StatusFile } from './api';
import { MARK_COLOR, markOf } from './decorations';
import { baseName, createBranch, discard, openFile, openGraph, openStatusDiff, short, stashDrop, stashParams, stashPush } from './ops';
import { History } from './History';
import { changed, forgetRepos, runGit, useRepo, useReposOf, type RepoState } from './state';
import './git.css';

export type Group = 'merge' | 'staged' | 'changes';

export interface GroupedFile {
  file: StatusFile;
  /** The letter shown (the side the group is about). */
  letter: string;
}

/** The status's files in VS Code's groups: conflicts, the index's changes,
 * the working tree's changes (untracked files among them). */
export function groupFiles(files: StatusFile[]): Record<Group, GroupedFile[]> {
  const out: Record<Group, GroupedFile[]> = { merge: [], staged: [], changes: [] };
  for (const f of files) {
    if (f.kind === 'ignored') continue;
    if (f.kind === 'unmerged') out.merge.push({ file: f, letter: '!' });
    else if (f.kind === 'untracked') out.changes.push({ file: f, letter: 'U' });
    else {
      if (f.x !== '.') out.staged.push({ file: f, letter: f.x });
      if (f.y !== '.') out.changes.push({ file: f, letter: f.y });
    }
  }
  for (const g of Object.values(out)) g.sort((a, b) => a.file.path.localeCompare(b.file.path));
  return out;
}

/** The color of a status letter. */
export function letterColor(letter: string): string {
  switch (letter) {
    case '!':
    case 'U':
      return letter === '!' ? MARK_COLOR.conflict : MARK_COLOR.untracked;
    case 'A':
      return MARK_COLOR.added;
    case 'D':
      return MARK_COLOR.deleted;
    default:
      return MARK_COLOR.modified;
  }
}

/** Rows of a group as a tree: folders (with their depth) before files. */
export function treeRows(files: GroupedFile[]): Array<{ dir: string; depth: number } | { f: GroupedFile; depth: number }> {
  type Node = { dirs: Map<string, Node>; files: GroupedFile[] };
  const top: Node = { dirs: new Map(), files: [] };
  for (const g of files) {
    const parts = g.file.path.split('/');
    let n = top;
    for (const p of parts.slice(0, -1)) {
      let next = n.dirs.get(p);
      if (!next) n.dirs.set(p, (next = { dirs: new Map(), files: [] }));
      n = next;
    }
    n.files.push(g);
  }
  const out: Array<{ dir: string; depth: number } | { f: GroupedFile; depth: number }> = [];
  const walk = (n: Node, depth: number, prefix: string) => {
    for (const [name, d] of [...n.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      // A folder with one folder inside shows as one row (a/b).
      let label = name;
      let node = d;
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [[k, v]] = [...node.dirs];
        label += '/' + k;
        node = v;
      }
      out.push({ dir: prefix + label, depth });
      walk(node, depth + 1, prefix + label + '/');
    }
    for (const f of n.files) out.push({ f, depth });
  };
  walk(top, 0, '');
  return out;
}

/** The commit message typed per repository, kept while the panel is
 * hidden. */
const drafts = new Map<string, string>();

export function GitPanel() {
  const m = useStore((s) => s.machineId);
  const home = useStore((s) => (s.machineId ? s.machines[s.machineId]?.info?.home : undefined));
  const paneDir = useTerms(followedDir);
  const paneDir2 = useStore(followedDir);
  const dir = paneDir ?? paneDir2;
  const [lastDir, setLastDir] = useState<string>();
  useEffect(() => {
    if (dir) setLastDir(dir);
  }, [dir]);
  const shownDir = dir ?? lastDir ?? home;
  const { roots, error } = useReposOf(m, shownDir);
  const [picked, setPicked] = useState<string>();
  const root = roots && roots.length ? (picked && roots.includes(picked) ? picked : roots[0]) : undefined;
  const st = useRepo(m ?? undefined, root);

  if (!m) return <div className="git-empty muted small">{t('git.noMachine')}</div>;
  if (roots === undefined) return <div className="git-empty muted small">{t('git.loading')}</div>;
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
      {roots.length > 1 && (
        <select className="git-repo-pick" value={root} onChange={(e) => setPicked(e.target.value)} aria-label={t('git.repository')}>
          {roots.map((r) => (
            <option key={r} value={r}>
              {baseName(r)} — {r}
            </option>
          ))}
        </select>
      )}
      {/* Its own state (the amend box, the history, the stashes) per repository. */}
      <RepoView key={`${m}\u0000${root}`} m={m} root={root} st={st} />
    </div>
  );
}

function RepoView({ m, root, st }: { m: string; root: string; st?: RepoState }) {
  const readOnly = useStore((s) => s.readOnly);
  const [tree, setTree] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState(drafts.get(root) ?? '');
  const [amend, setAmend] = useState(false);
  const status = st?.status;
  const info = st?.info;
  const groups = useMemo(() => groupFiles(status?.files ?? []), [status]);
  // The status has the branch (none when detached); the info only until
  // the first status.
  const branch = status ? status.branch : info?.branch;
  const busy = st?.busy;

  const setDraft = (v: string) => {
    setMessage(v);
    drafts.set(root, v);
  };

  const commit = async () => {
    if (readOnly || busy) return;
    if (!message.trim() && !amend) {
      useStore.getState().toast(t('git.commit.noMessage'));
      return;
    }
    if (!groups.staged.length && !amend) {
      if (!groups.changes.length) {
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
    if (await runGit(m, root, 'commit', { message, amend })) {
      setDraft('');
      setAmend(false);
    }
  };

  const sync = async () => {
    if (!status?.upstream) return;
    if (status.behind && !(await runGit(m, root, 'pull', {}))) return;
    if (status.ahead || status.behind) await runGit(m, root, 'push', {});
  };
  const publish = () => {
    const remote = info?.remotes.includes('origin') ? 'origin' : info?.remotes[0];
    if (remote && branch) void runGit(m, root, 'push', { remote, branch, setUpstream: true });
  };

  const moreMenu = (e: React.MouseEvent) => {
    const remotes = info?.remotes ?? [];
    const items: MenuEntry[] = [
      { label: t('git.fetch'), disabled: !remotes.length, run: () => void runGit(m, root, 'fetch', { all: true, prune: true }) },
      { label: t('git.pull'), disabled: !status?.upstream, run: () => void runGit(m, root, 'pull', {}) },
      { label: t('git.pullRebase'), disabled: !status?.upstream, run: () => void runGit(m, root, 'pull', { rebase: true }) },
      { label: t('git.push'), disabled: !status?.upstream, run: () => void runGit(m, root, 'push', {}) },
      {
        label: t('git.forcePush'),
        disabled: !status?.upstream,
        danger: true,
        run: () => void runGit(m, root, 'push', { forceWithLease: true }),
      },
      'sep',
      { label: t('git.branch.create'), run: () => void createBranch(m, root) },
      { label: t('git.stash.push'), run: () => void stashPush(m, root) },
      'sep',
      { label: t(tree ? 'git.viewList' : 'git.viewTree'), run: () => setTree(!tree) },
      { label: t('git.openGraph'), run: () => void openGraph(m, root) },
    ];
    openMenu(e, items);
  };

  const toggle = (k: string) => setClosed((c) => ({ ...c, [k]: !c[k] }));
  const commitKey = isMac ? '⌘↵' : 'Ctrl+Enter';

  return (
    <>
      <div className="git-toolbar">
        <span className="git-title ellipsis" title={root}>
          {baseName(root)}
        </span>
        <span className="spacer" />
        <button
          className="icon"
          title={t(tree ? 'git.viewList' : 'git.viewTree')}
          aria-label={t(tree ? 'git.viewList' : 'git.viewTree')}
          onClick={() => setTree(!tree)}
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
      </div>
      <div className="git-branch">
        <GitBranch />
        <span className="ellipsis" title={branch ?? status?.head}>
          {branch ?? (status?.head ? t('git.detached', { commit: short(status.head) }) : t('git.noCommits'))}
        </span>
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
            <button className="git-sync" disabled={readOnly || !!busy} title={t('git.publish')} onClick={publish}>
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
              disabled={readOnly || !!busy || !status?.upstream}
              onClick={() => void runGit(m, root, 'pull', {})}
            >
              <ArrowDown />
            </button>
            <button
              className="icon"
              title={t('git.push')}
              aria-label={t('git.push')}
              disabled={readOnly || !!busy || !status?.upstream}
              onClick={() => void runGit(m, root, 'push', {})}
            >
              <ArrowUp />
            </button>
          </>
        )}
      </div>
      {status?.state && <StateBanner m={m} root={root} state={status.state} />}
      {st?.error && <div className="git-error small">{st.error}</div>}
      {busy && <div className="git-busy muted small">{t('git.running', { action: busy })}</div>}
      {!readOnly && (
        <div className="git-commit">
          <textarea
            className="git-message"
            rows={Math.min(8, Math.max(2, message.split('\n').length))}
            spellCheck={false}
            value={message}
            placeholder={t('git.commit.placeholder', { branch: branch ?? 'HEAD', key: commitKey })}
            onChange={(e) => setDraft(e.target.value)}
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
              <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> {t('git.commit.amend')}
            </label>
            <span className="spacer" />
            <button className="primary" disabled={!!busy} onClick={() => void commit()}>
              <Check /> {t(amend ? 'git.commit.amendButton' : 'git.commit.button')}
            </button>
          </div>
        </div>
      )}
      <div className="git-groups">
        {status?.truncated && <div className="git-error small">{t('git.truncated')}</div>}
        {groups.merge.length > 0 && (
          <FileGroup
            m={m}
            root={root}
            group="merge"
            files={groups.merge}
            tree={tree}
            closed={!!closed.merge}
            onToggle={() => toggle('merge')}
          />
        )}
        {groups.staged.length > 0 && (
          <FileGroup
            m={m}
            root={root}
            group="staged"
            files={groups.staged}
            tree={tree}
            closed={!!closed.staged}
            onToggle={() => toggle('staged')}
          />
        )}
        <FileGroup
          m={m}
          root={root}
          group="changes"
          files={groups.changes}
          whole={!groups.merge.length}
          tree={tree}
          closed={!!closed.changes}
          onToggle={() => toggle('changes')}
        />
        <Stashes
          m={m}
          root={root}
          version={st?.refs ?? 0}
          closed={closed.stashes !== false}
          onToggle={() => setClosed((c) => ({ ...c, stashes: c.stashes === false }))}
        />
      </div>
      <History key={`${m}\u0000${root}`} m={m} root={root} version={st?.refs ?? 0} branch={branch} head={status?.head} />
    </>
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

const GROUP_TITLE = { merge: 'git.group.merge', staged: 'git.group.staged', changes: 'git.group.changes' } as const;

/** The paths a file's unstaging names: a rename's old path too (else its
 * deletion stays staged). */
export const unstagePaths = (f: StatusFile) => (f.orig ? [f.path, f.orig] : [f.path]);

/** What a group's Stage All and Unstage All send: the whole index or
 * working tree when the group is all of it (no paths to list, however
 * many), else the group's paths. */
export function groupAction(group: Group, files: GroupedFile[], whole: boolean): Record<string, unknown> {
  if (group === 'staged' || whole) return { all: true };
  return { paths: files.map((g) => g.file.path) };
}

function FileGroup(props: {
  m: string;
  root: string;
  group: Group;
  files: GroupedFile[];
  /** The group holds every change of its side (Changes without conflicts
   * beside it): Stage All stages everything. */
  whole?: boolean;
  tree: boolean;
  closed: boolean;
  onToggle(): void;
}) {
  const { m, root, group, files, tree, closed, onToggle } = props;
  const readOnly = useStore((s) => s.readOnly);
  const staged = group === 'staged';
  const stageAll = () => void runGit(m, root, 'stage', groupAction(group, files, !!props.whole));
  const unstageAll = () => void runGit(m, root, 'unstage', groupAction(group, files, true));
  const rows = tree ? treeRows(files) : files.map((f) => ({ f, depth: 0 }));
  return (
    <section className="git-group" aria-label={t(GROUP_TITLE[group])}>
      <div className="git-group-head" onClick={onToggle}>
        {closed ? <ChevronRight /> : <ChevronDown />}
        <span className="ellipsis">{t(GROUP_TITLE[group])}</span>
        <span className="spacer" />
        {!readOnly && files.length > 0 && (
          <span className="git-actions" onClick={(e) => e.stopPropagation()}>
            {group === 'changes' && (
              <button
                className="icon"
                title={t('git.discardAll')}
                aria-label={t('git.discardAll')}
                onClick={() =>
                  void discard(
                    m,
                    root,
                    files.map((g) => g.file),
                  )
                }
              >
                <Undo2 />
              </button>
            )}
            {staged ? (
              <button className="icon" title={t('git.unstageAll')} aria-label={t('git.unstageAll')} onClick={unstageAll}>
                <Minus />
              </button>
            ) : (
              <button className="icon" title={t('git.stageAll')} aria-label={t('git.stageAll')} onClick={stageAll}>
                <Plus />
              </button>
            )}
          </span>
        )}
        <span className="git-count">{files.length}</span>
      </div>
      {!closed &&
        rows.map((r) =>
          'dir' in r ? (
            <div key={'d:' + r.dir} className="git-row git-dir-row" style={{ paddingLeft: 18 + r.depth * 12 }}>
              <span className="ellipsis muted">{r.dir.slice(r.dir.lastIndexOf('/', r.dir.length - 1) + 1)}</span>
            </div>
          ) : (
            <FileRow key={r.f.file.path + r.f.letter} m={m} root={root} group={group} g={r.f} depth={r.depth} tree={tree} />
          ),
        )}
    </section>
  );
}

function FileRow({
  m,
  root,
  group,
  g,
  depth,
  tree,
}: {
  m: string;
  root: string;
  group: Group;
  g: GroupedFile;
  depth: number;
  tree: boolean;
}) {
  const readOnly = useStore((s) => s.readOnly);
  const f = g.file;
  const staged = group === 'staged';
  const name = baseName(f.path);
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
  const deleted = g.letter === 'D';
  const open = () => void openStatusDiff(m, root, f, staged);
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    openMenu(e, [
      { label: t('git.openDiff'), run: open },
      { label: t('git.openFile'), disabled: deleted, run: () => void openFile(m, root, f.path) },
      'sep',
      staged
        ? { label: t('git.unstage'), disabled: readOnly, run: () => void runGit(m, root, 'unstage', { paths: unstagePaths(f) }) }
        : { label: t('git.stage'), disabled: readOnly, run: () => void runGit(m, root, 'stage', { paths: [f.path] }) },
      ...(group === 'changes'
        ? [{ label: t('git.discard'), danger: true, disabled: readOnly, run: () => void discard(m, root, [f]) }]
        : []),
    ]);
  };
  return (
    <div
      className="git-row"
      style={{ paddingLeft: 18 + depth * 12 }}
      title={f.orig ? `${f.orig} → ${f.path}` : f.path}
      onClick={open}
      onContextMenu={menu}
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && open()}
    >
      <span className={`git-name ellipsis${deleted ? ' deleted' : ''}`} style={{ color: letterColor(g.letter) }}>
        {name}
      </span>
      {!tree && dir && <span className="git-path ellipsis muted">{dir}</span>}
      <span className="spacer" />
      <span className="git-actions" onClick={(e) => e.stopPropagation()}>
        {!deleted && (
          <button className="icon" title={t('git.openFile')} aria-label={t('git.openFile')} onClick={() => void openFile(m, root, f.path)}>
            <FileText />
          </button>
        )}
        {!readOnly && group === 'changes' && (
          <button className="icon" title={t('git.discard')} aria-label={t('git.discard')} onClick={() => void discard(m, root, [f])}>
            <Undo2 />
          </button>
        )}
        {!readOnly &&
          (staged ? (
            <button
              className="icon"
              title={t('git.unstage')}
              aria-label={t('git.unstage')}
              onClick={() => void runGit(m, root, 'unstage', { paths: unstagePaths(f) })}
            >
              <Minus />
            </button>
          ) : (
            <button
              className="icon"
              title={t('git.stage')}
              aria-label={t('git.stage')}
              onClick={() => void runGit(m, root, 'stage', { paths: [f.path] })}
            >
              <Plus />
            </button>
          ))}
      </span>
      <span
        className="git-letter"
        style={{ color: letterColor(g.letter) }}
        aria-label={t(`git.mark.${markOf(f) ?? 'modified'}` as 'git.mark.modified')}
      >
        {g.letter}
      </span>
    </div>
  );
}

/** The stashes, read again when the refs moved (version); none shown when
 * they could not be read (an entry shown must be one the machine has). */
function Stashes({ m, root, version, closed, onToggle }: { m: string; root: string; version: number; closed: boolean; onToggle(): void }) {
  const readOnly = useStore((s) => s.readOnly);
  const [stashes, setStashes] = useState<Stash[]>([]);
  useEffect(() => {
    let gone = false;
    gitApi
      .stashes(m, root)
      .then((s) => !gone && setStashes(s))
      .catch(() => !gone && setStashes([]));
    return () => {
      gone = true;
    };
  }, [m, root, version]);
  if (!stashes.length) return null;
  return (
    <section className="git-group" aria-label={t('git.group.stashes')}>
      <div className="git-group-head" onClick={onToggle}>
        {closed ? <ChevronRight /> : <ChevronDown />}
        <span className="ellipsis">{t('git.group.stashes')}</span>
        <span className="spacer" />
        <span className="git-count">{stashes.length}</span>
      </div>
      {!closed &&
        stashes.map((s) => (
          <div
            key={s.hash}
            className="git-row"
            style={{ paddingLeft: 18 }}
            title={s.message}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e, [
                { label: t('git.stash.apply'), disabled: readOnly, run: () => void runGit(m, root, 'stashApply', stashParams(s)) },
                { label: t('git.stash.pop'), disabled: readOnly, run: () => void runGit(m, root, 'stashPop', stashParams(s)) },
                { label: t('git.stash.drop'), danger: true, disabled: readOnly, run: () => void stashDrop(m, root, s) },
              ]);
            }}
          >
            <Archive className="git-row-icon" />
            <span className="ellipsis">{s.message}</span>
            <span className="spacer" />
            {!readOnly && (
              <span className="git-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon"
                  title={t('git.stash.apply')}
                  aria-label={t('git.stash.apply')}
                  onClick={() => void runGit(m, root, 'stashApply', stashParams(s))}
                >
                  <Check />
                </button>
                <button
                  className="icon"
                  title={t('git.stash.pop')}
                  aria-label={t('git.stash.pop')}
                  onClick={() => void runGit(m, root, 'stashPop', stashParams(s))}
                >
                  <ArrowUp />
                </button>
              </span>
            )}
          </div>
        ))}
    </section>
  );
}
