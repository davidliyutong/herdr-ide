// The Git plugin's searchable lists (components/Picker.tsx pick): the
// branch picker of the panel (check out a local, remote or tag ref, or
// create a branch from what is typed), a ref to create a branch from or
// to check out detached, and a remote. They read the refs when opened and
// stay fast with thousands of them (only the rows in view are drawn).

import { GitBranch, GitBranchPlus, GitCommitHorizontal, Plus, Tag as TagIcon } from 'lucide-react';
import { pick, type PickAnchor, type PickerItem } from '../../components/Picker';
import { useStore } from '../../state/store';
import { t } from '../../i18n';
import { gitApi, errorText, type Branch, type Tag } from './api';
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
