// What the Git panel and graph do: open the diff and graph panes, and the
// changes that ask first (discards, deletions, a hard reset) or ask for
// names.

import { actions } from '../../actions';
import { confirmDialog } from '../../dialog';
import { useStore } from '../../state/store';
import { t, type MessageKey } from '../../i18n';
import { openEditor } from '../files/ops';
import type { Stash, StatusFile } from './api';
import { badRefName, promptDialog } from './prompt';
import { runGit } from './state';
import { dirtyDiffs } from './DiffPane';

export type DiffMode = 'worktree' | 'staged' | 'commit' | 'compare';

/** A diff pane's fields ({view: {plugin: 'git', kind: 'diff', …}}). */
export interface DiffView {
  repo: string;
  path: string;
  mode: DiffMode;
  /** The commit (commit), or the left side (compare). */
  rev?: string;
  /** The right side of a compare. */
  rev2?: string;
  /** The path on the left of a rename. */
  orig?: string;
  /** The parent a commit is shown against (from 1). */
  parent?: number;
  /** Shown untracked: nothing on the left. */
  untracked?: boolean;
}

export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;
export const join = (root: string, rel: string) => `${root.replace(/\/+$/, '')}/${rel}`;
export const short = (h: string) => h.slice(0, 7);

/** Opens a file's diff, reusing the pane that shows the same one; a
 * change of the working tree or the index (Source Control's rows) takes
 * over any such pane without unsaved edits, as VS Code's preview editor
 * does, so going through the changes opens one pane. With own (several
 * files opened at once) only the file's own pane is reused. */
export function openDiff(m: string, d: DiffView, from?: string, o: { own?: boolean } = {}) {
  const same = (v: Record<string, unknown>) =>
    v.repo === d.repo && v.path === d.path && v.mode === d.mode && (v.rev ?? '') === (d.rev ?? '') && (v.rev2 ?? '') === (d.rev2 ?? '');
  const local = (mode: unknown) => mode === 'worktree' || mode === 'staged';
  const reuse = (v: Record<string, unknown>) =>
    same(v) || (!o.own && local(d.mode) && local(v.mode) && !dirtyDiffs.has(`view:${String(v.id)}`));
  // Fields of the other file it showed are dropped.
  const view = { rev: undefined, rev2: undefined, orig: undefined, parent: undefined, untracked: undefined, ...d };
  return actions.openView(m, { plugin: 'git', kind: 'diff', ...view }, { from, reuse });
}

/** Opens the graph of a repository in a tab of its own (one pane per repository). */
export function openGraph(m: string, repo: string) {
  return actions.openView(m, { plugin: 'git', kind: 'graph', repo }, { reuse: (v) => v.repo === repo, tab: true });
}

/** Opens a file of the working tree in the file explorer's editor. */
export function openFile(m: string, repo: string, path: string) {
  return openEditor(m, join(repo, path));
}

/** The diff of a file of the status: of the index (staged) or of the
 * working tree. */
export function openStatusDiff(m: string, repo: string, f: StatusFile, staged: boolean, o: { own?: boolean } = {}) {
  return openDiff(
    m,
    {
      repo,
      path: f.path,
      mode: staged ? 'staged' : 'worktree',
      orig: staged && f.orig ? f.orig : undefined,
      untracked: f.kind === 'untracked' || undefined,
    },
    undefined,
    o,
  );
}

/** Discards the changes of files of the working tree, after asking. */
export async function discard(m: string, repo: string, files: StatusFile[]) {
  if (!files.length) return;
  const untracked = files.filter((f) => f.kind === 'untracked').map((f) => f.path);
  const tracked = files.filter((f) => f.kind !== 'untracked').map((f) => f.path);
  const what = files.length === 1 ? baseName(files[0].path) : t('git.files', { n: files.length });
  const ok = await confirmDialog({
    title: t('git.discard.title'),
    message: t(untracked.length ? 'git.discard.untracked' : 'git.discard.message', { what }),
    confirm: t(untracked.length && !tracked.length ? 'git.discard.delete' : 'git.discard'),
    danger: true,
  });
  if (ok) await runGit(m, repo, 'discard', { paths: tracked, untracked });
}

/** A new branch at a commit (HEAD by default), checked out if asked. */
export async function createBranch(m: string, repo: string, at?: string) {
  const v = await promptDialog(t('git.branch.create'), t('git.branch.createConfirm'), [
    { key: 'name', label: t('git.branch.name'), validate: badRefName },
    { key: 'checkout', label: t('git.branch.checkoutAfter'), check: true, value: 'y' },
  ]);
  if (v) await runGit(m, repo, 'branchCreate', { name: String(v.name).trim(), at, checkout: !!v.checkout });
}

export async function renameBranch(m: string, repo: string, name: string) {
  const v = await promptDialog(t('git.branch.rename'), t('git.branch.renameConfirm'), [
    { key: 'to', label: t('git.branch.name'), value: name, validate: badRefName },
  ]);
  if (v && v.to !== name) await runGit(m, repo, 'branchRename', { name, to: String(v.to).trim() });
}

export async function deleteBranch(m: string, repo: string, name: string, remote?: string) {
  const ok = await confirmDialog({
    title: t('git.branch.delete'),
    message: t(remote ? 'git.branch.deleteRemote' : 'git.branch.deleteMessage', { name: remote ? `${remote}/${name}` : name }),
    confirm: t('git.branch.delete'),
    danger: true,
  });
  if (!ok) return;
  if (remote) return runGit(m, repo, 'branchDelete', { name, remote });
  // Not merged: asked again before forcing.
  const done = await runGit(m, repo, 'branchDelete', { name });
  if (done) return;
  const force = await confirmDialog({
    title: t('git.branch.delete'),
    message: t('git.branch.forceMessage', { name }),
    confirm: t('git.branch.forceDelete'),
    danger: true,
  });
  if (force) await runGit(m, repo, 'branchDelete', { name, force: true });
}

/** Checks a remote branch out as a local one that tracks it. */
export async function checkoutRemote(m: string, repo: string, remoteBranch: string) {
  const local = remoteBranch.slice(remoteBranch.indexOf('/') + 1);
  return runGit(m, repo, 'branchCreate', { name: local, at: remoteBranch, checkout: true });
}

export async function createTag(m: string, repo: string, at: string) {
  const v = await promptDialog(t('git.tag.create'), t('git.tag.createConfirm'), [
    { key: 'name', label: t('git.tag.name'), validate: badRefName },
    { key: 'message', label: t('git.tag.message'), multiline: true, placeholder: t('git.tag.messageHint') },
  ]);
  if (v) await runGit(m, repo, 'tagCreate', { name: String(v.name).trim(), at, message: String(v.message ?? '') });
}

export async function deleteTag(m: string, repo: string, name: string) {
  const ok = await confirmDialog({
    title: t('git.tag.delete'),
    message: t('git.tag.deleteMessage', { name }),
    confirm: t('git.tag.delete'),
    danger: true,
  });
  if (ok) await runGit(m, repo, 'tagDelete', { name });
}

export async function reset(m: string, repo: string, rev: string, mode: 'soft' | 'mixed' | 'hard', branch?: string) {
  const ok = await confirmDialog({
    title: t('git.reset.title'),
    message: t(`git.reset.${mode}Message` as MessageKey, { branch: branch || 'HEAD', commit: short(rev) }),
    confirm: t('git.reset.confirm'),
    danger: mode === 'hard',
  });
  if (ok) await runGit(m, repo, 'reset', { rev, mode });
}

export async function stashPush(m: string, repo: string) {
  const v = await promptDialog(t('git.stash.push'), t('git.stash.pushConfirm'), [
    { key: 'message', label: t('git.stash.message') },
    { key: 'includeUntracked', label: t('git.stash.untracked'), check: true, value: 'y' },
  ]);
  if (v) await runGit(m, repo, 'stashPush', { message: String(v.message ?? ''), includeUntracked: !!v.includeUntracked });
}

/** The stash's actions name the entry with its commit: one pushed or
 * dropped meanwhile renumbers them, and the machine refuses (stale). */
export const stashParams = (s: Stash) => ({ index: s.index, hash: s.hash });

export async function stashDrop(m: string, repo: string, s: Stash) {
  const ok = await confirmDialog({
    title: t('git.stash.drop'),
    message: t('git.stash.dropMessage', { n: s.index }),
    confirm: t('git.stash.drop'),
    danger: true,
  });
  if (ok) await runGit(m, repo, 'stashDrop', stashParams(s));
}

/** Copies text, with a toast. */
export function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(
    () => useStore.getState().toast(t('git.copied')),
    () => undefined,
  );
}
