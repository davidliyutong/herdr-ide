// The Git plugin's searchable lists (components/Picker.tsx pick): the
// branch picker of the panel (check out a local, remote or tag ref, or
// create a branch from what is typed), a ref to create a branch from or
// to check out detached, a remote and a remote's branch. They read the
// refs when opened and stay fast with thousands of them (only the rows in
// view are drawn). With them, what acts on a chosen remote: Fetch From…,
// Pull From…, Push To… and publishing a branch, which asks for the remote
// when there are several; and the question before a pull or push that
// the setting git.confirmSync asks.

import { Cloud, GitBranch, GitBranchPlus, GitCommitHorizontal, Plus, Tag as TagIcon } from 'lucide-react';
import { confirmDialog } from '../../dialog';
import { settingValue } from '../../settings';
import { pick, type PickAnchor, type PickerItem } from '../../components/Picker';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { gitApi, errorText, type Branch, type RepoInfo, type Tag } from './api';
import { ago } from './History';
import { checkoutRemote, createBranch } from './ops';
import { badRefName } from './prompt';
import { runGit } from './state';

const toast = (e: unknown) => useStore.getState().toast(errorText(e), undefined, undefined, 'error');

/** A remote branch's remote: the longest of the remotes its name starts
 * with (a remote's name may have a /), else what is before the first /. */
export function remoteOf(name: string, remotes: readonly string[]): string {
  let best = '';
  for (const r of remotes) if (name.startsWith(r + '/') && r.length > best.length) best = r;
  return best || name.slice(0, name.indexOf('/'));
}

/** What a local branch's row says about its upstream. */
export function trackText(b: Branch): string | undefined {
  if (!b.upstream) return undefined;
  if (b.gone) return t('git.pick.gone', { upstream: b.upstream });
  const counts = [b.ahead ? `↑${b.ahead}` : '', b.behind ? `↓${b.behind}` : ''].filter(Boolean).join(' ');
  return counts ? `${b.upstream} ${counts}` : b.upstream;
}

/** A commit's line: its subject and how long ago it was made. */
const detailOf = (subject: string | undefined, date: number) => [subject, date ? ago(date) : ''].filter(Boolean).join(' · ');

/** The rows of refs: local branches, each remote's branches under its
 * name, tags; values b:<name>, r:<name>, t:<name>. */
export function refItems(branches: readonly Branch[], tags: readonly Tag[], remotes: readonly string[]): PickerItem[] {
  const items: PickerItem[] = [];
  for (const b of branches) {
    if (b.remote) continue;
    items.push({
      value: `b:${b.name}`,
      label: b.name,
      description: trackText(b),
      detail: detailOf(b.subject, b.date),
      icon: <GitBranch />,
      group: t('git.pick.branches'),
    });
  }
  for (const b of branches) {
    if (!b.remote) continue;
    items.push({
      value: `r:${b.name}`,
      label: b.name,
      detail: detailOf(b.subject, b.date),
      icon: <GitBranch />,
      group: t('git.pick.remote', { remote: remoteOf(b.name, remotes) }),
    });
  }
  for (const tg of tags) {
    items.push({
      value: `t:${tg.name}`,
      label: tg.name,
      detail: detailOf(tg.subject, tg.date),
      icon: <TagIcon />,
      group: t('git.pick.tags'),
    });
  }
  return items;
}

/** The refs of a repository, read when a list opens. */
async function refs(m: string, repo: string): Promise<{ branches: Branch[]; tags: Tag[] } | undefined> {
  try {
    const [branches, tags] = await Promise.all([gitApi.branches(m, repo), gitApi.tags(m, repo).catch(() => [] as Tag[])]);
    return { branches, tags };
  } catch (e) {
    toast(e);
    return undefined;
  }
}

/** A ref's name from its row's value. */
const refName = (v: string) => v.slice(2);

/** The panel's branch picker: check out a local branch, a remote branch
 * (its local branch, or a new one that tracks it), a tag (detached), or
 * create a branch named by what is typed; Create Branch…, Create Branch
 * From… and Checkout Detached… first. */
export async function pickBranch(m: string, repo: string, anchor: PickAnchor, o: { current?: string; remotes: readonly string[] }) {
  const r = await refs(m, repo);
  if (!r) return;
  const items: PickerItem[] = [
    { value: 'a:create', label: t('git.branch.create'), icon: <Plus /> },
    { value: 'a:createFrom', label: t('git.branch.createFrom'), icon: <GitBranchPlus /> },
    { value: 'a:detach', label: t('git.branch.checkoutDetached'), icon: <GitCommitHorizontal /> },
    ...refItems(r.branches, r.tags, o.remotes),
  ];
  const chosen = await pick(anchor, {
    items,
    value: o.current ? `b:${o.current}` : undefined,
    placeholder: t('git.pick.branch'),
    label: t('git.pick.branch'),
    create: (q) => (badRefName(q) ? undefined : t('git.pick.createNamed', { name: q })),
  });
  if (!chosen) return;
  if (typeof chosen === 'object') return runGit(m, repo, 'branchCreate', { name: chosen.create, checkout: true });
  const name = refName(chosen);
  switch (chosen.slice(0, 2)) {
    case 'b:':
      if (name !== o.current) await runGit(m, repo, 'checkout', { name });
      return;
    case 'r:': {
      const remote = remoteOf(name, o.remotes);
      const local = name.slice(remote.length + 1);
      if (r.branches.some((b) => !b.remote && b.name === local)) await runGit(m, repo, 'checkout', { name: local });
      else await checkoutRemote(m, repo, name, remote);
      return;
    }
    case 't:':
      await runGit(m, repo, 'checkout', { rev: name });
      return;
  }
  if (chosen === 'a:create') return createBranch(m, repo);
  const ref = await pickRef(m, repo, anchor, {
    remotes: o.remotes,
    placeholder: t(chosen === 'a:detach' ? 'git.pick.detach' : 'git.pick.from'),
    refs: r,
  });
  if (!ref) return;
  if (chosen === 'a:detach') await runGit(m, repo, 'checkout', { rev: ref });
  else await createBranch(m, repo, ref);
}

/** A branch, remote branch or tag (or a commit's hash typed): its name. */
export async function pickRef(
  m: string,
  repo: string,
  anchor: PickAnchor,
  o: { remotes: readonly string[]; placeholder: string; refs?: { branches: Branch[]; tags: Tag[] } },
): Promise<string | undefined> {
  const r = o.refs ?? (await refs(m, repo));
  if (!r) return undefined;
  const chosen = await pick(anchor, {
    items: refItems(r.branches, r.tags, o.remotes),
    placeholder: o.placeholder,
    label: o.placeholder,
    create: (q) => (/^[0-9a-f]{4,64}$/i.test(q) ? t('git.pick.commit', { hash: q }) : undefined),
  });
  if (!chosen) return undefined;
  return typeof chosen === 'object' ? chosen.create : refName(chosen);
}

/** The setting: ask before a pull, a push or a synchronization. */
export const CONFIRM_SYNC = 'git.confirmSync';

/** Asks before a pull, push or both when the setting says so; true to go
 * on. */
export async function confirmSync(kind: 'pull' | 'push' | 'sync', target: string): Promise<boolean> {
  if (settingValue(CONFIRM_SYNC) !== true) return true;
  return confirmDialog({
    title: t(`git.${kind}` as 'git.pull'),
    message: t(`git.confirm.${kind}` as 'git.confirm.pull', { target }),
    confirm: t(`git.${kind}` as 'git.pull'),
  });
}

/** A remote of the repository: the only one without asking, else the one
 * chosen (each with its URL). */
export async function pickRemote(anchor: PickAnchor, info: RepoInfo | undefined, ask = false): Promise<string | undefined> {
  const remotes = info?.remotes ?? [];
  if (!remotes.length) return undefined;
  if (remotes.length === 1 && !ask) return remotes[0];
  return pick(anchor, {
    items: remotes.map((r) => ({ value: r, label: r, description: info?.remoteUrls?.[r], icon: <Cloud /> })),
    placeholder: t('git.pick.remotePlaceholder'),
    label: t('git.pick.remotePlaceholder'),
    keepOrder: true,
  });
}

/** A branch of a remote, by its name there: those fetched, or a name
 * typed. */
export async function pickRemoteBranch(
  m: string,
  repo: string,
  anchor: PickAnchor,
  remote: string,
  o: { remotes: readonly string[]; current?: string },
): Promise<string | undefined> {
  let branches: Branch[];
  try {
    branches = await gitApi.branches(m, repo);
  } catch (e) {
    toast(e);
    return undefined;
  }
  const items: PickerItem[] = branches
    .filter((b) => b.remote && remoteOf(b.name, o.remotes) === remote)
    .map((b) => ({
      value: b.name.slice(remote.length + 1),
      label: b.name.slice(remote.length + 1),
      detail: detailOf(b.subject, b.date),
      icon: <GitBranch />,
    }))
    .filter((i) => i.value !== 'HEAD');
  const chosen = await pick(anchor, {
    items,
    value: o.current && items.some((i) => i.value === o.current) ? o.current : undefined,
    placeholder: t('git.pick.remoteBranchPlaceholder', { remote }),
    label: t('git.pick.remoteBranchPlaceholder', { remote }),
    create: (q) => (badRefName(q) ? undefined : t('git.pick.remoteBranch', { name: q })),
  });
  if (!chosen) return undefined;
  return typeof chosen === 'object' ? chosen.create : chosen;
}

/** Fetch From…: a remote chosen, pruned. */
export async function fetchFrom(m: string, repo: string, anchor: PickAnchor, info: RepoInfo | undefined) {
  const remote = await pickRemote(anchor, info, true);
  if (remote) await runGit(m, repo, 'fetch', { remote, prune: true });
}

/** Pull From…: a remote (asked when there are several) and one of its
 * branches. */
export async function pullFrom(
  m: string,
  repo: string,
  anchor: PickAnchor,
  info: RepoInfo | undefined,
  o: { branch?: string; rebase?: boolean } = {},
) {
  const remote = await pickRemote(anchor, info);
  if (!remote) return;
  const branch = await pickRemoteBranch(m, repo, anchor, remote, { remotes: info?.remotes ?? [], current: o.branch });
  if (!branch || !(await confirmSync('pull', `${remote}/${branch}`))) return;
  await runGit(m, repo, 'pull', { remote, branch, rebase: o.rebase || undefined });
}

/** Push To… (and publishing a branch): to a remote (asked when there are
 * several, or always with ask), which becomes the branch's upstream. */
export async function pushTo(m: string, repo: string, anchor: PickAnchor, info: RepoInfo | undefined, branch: string, ask = false) {
  const remote = await pickRemote(anchor, info, ask);
  if (!remote || !(await confirmSync('push', `${remote}/${branch}`))) return;
  await runGit(m, repo, 'push', { remote, branch, setUpstream: true });
}

/** Pushes a tag to a remote (asked when there are several). */
export async function pushTag(m: string, repo: string, anchor: PickAnchor, info: RepoInfo | undefined, tag: string) {
  const remote = await pickRemote(anchor, info);
  if (remote) await runGit(m, repo, 'push', { remote, tag });
}
