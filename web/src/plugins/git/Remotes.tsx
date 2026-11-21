// The Git panel's remotes: a section of the repository's remotes with
// their URLs, to fetch from, pull from and push to.

import { Cloud, RefreshCw } from 'lucide-react';
import { useStore } from '../../state/store';
import { openMenu, type MenuEntry } from '../../contextMenu';
import { t } from '../../i18n';
import { useSize } from '../../lib/sizes';
import { Section, TreeRow } from '../../components/tree';
import { pullFrom, pushTo } from './pickers';
import { copyText } from '../files/ops';
import { runGit } from './state';
import type { RepoInfo } from './api';

/** The remotes, each with its URL (without a credential): fetch from one,
 * pull one's branch, push the branch to it; closed by default. */
export function Remotes({
  m,
  root,
  info,
  branch,
  upstream,
}: {
  m: string;
  root: string;
  info?: RepoInfo;
  branch?: string;
  upstream?: string;
}) {
  const readOnly = useStore((s) => s.readOnly);
  const rowH = useSize('row');
  const remotes = info?.remotes ?? [];
  if (!remotes.length) return null;
  const only = (remote: string): RepoInfo => ({ ...info!, remotes: [remote] });
  const menu = (e: React.MouseEvent, remote: string): MenuEntry[] => {
    const anchor = e.currentTarget;
    const url = info?.remoteUrls?.[remote];
    return [
      {
        label: t('git.graph.fetchRemote', { remote }),
        disabled: readOnly,
        run: () => void runGit(m, root, 'fetch', { remote, prune: true }),
      },
      { label: t('git.pullFrom'), disabled: readOnly, run: () => void pullFrom(m, root, anchor, only(remote), { branch }) },
      {
        label: t('git.graph.pushBranch', { remote }),
        disabled: readOnly || !branch,
        run: () => void pushTo(m, root, anchor, only(remote), branch!),
      },
      'sep',
      { label: t('git.remote.copyUrl'), disabled: !url, run: () => void copyText(url!) },
      { label: t('git.graph.copyName'), run: () => void copyText(remote) },
    ];
  };
  return (
    <Section id="git.remotes" title={t('git.group.remotes')} count={remotes.length} defaultOpen={false}>
      <div className="git-rows" style={{ height: remotes.length * rowH }}>
        {remotes.map((r, i) => (
          <TreeRow
            key={r}
            className="git-row"
            style={{ top: i * rowH, height: rowH }}
            depth={0}
            icon={<Cloud className="git-row-icon" />}
            label={r}
            description={info?.remoteUrls?.[r]}
            title={[r, info?.remoteUrls?.[r], upstream?.startsWith(r + '/') ? t('git.remote.upstream', { upstream }) : '']
              .filter(Boolean)
              .join('\n')}
            onContextMenu={(e) => openMenu(e, menu(e, r))}
            actions={
              readOnly ? undefined : (
                <button
                  className="icon"
                  title={t('git.graph.fetchRemote', { remote: r })}
                  aria-label={t('git.graph.fetchRemote', { remote: r })}
                  onClick={() => void runGit(m, root, 'fetch', { remote: r, prune: true })}
                >
                  <RefreshCw />
                </button>
              )
            }
          />
        ))}
      </div>
    </Section>
  );
}
