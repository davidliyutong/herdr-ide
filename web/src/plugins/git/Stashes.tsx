// The Git panel's stashes: a section of the repository's stashes, each
// applied, popped or dropped from its row.

import { useEffect, useState } from 'react';
import { Archive, ArrowUp, Check } from 'lucide-react';
import { useStore } from '../../state/store';
import { openMenu, type MenuEntry } from '../../contextMenu';
import { t } from '../../i18n';
import { useSize } from '../../lib/sizes';
import { Section, TreeRow } from '../../components/tree';
import { gitApi, type Stash } from './api';
import { stashDrop, stashParams } from './ops';
import { runGit } from './state';
import { panelMemory } from './memory';

/** The stashes, read again when the refs moved (version); none shown when
 * they could not be read (an entry shown must be one the machine has).
 * Those last read are shown while the panel comes back (memory.ts). */
export function Stashes({ m, root, version }: { m: string; root: string; version: number }) {
  const readOnly = useStore((s) => s.readOnly);
  const rowH = useSize('row');
  const [stashes, setStashes] = useState<Stash[]>(() => panelMemory(m, root).stashes ?? []);
  useEffect(() => {
    const ac = new AbortController();
    const set = (s: Stash[]) => {
      if (ac.signal.aborted) return;
      panelMemory(m, root).stashes = s;
      setStashes(s);
    };
    gitApi
      .stashes(m, root, ac.signal)
      .then(set)
      .catch(() => set([]));
    return () => {
      ac.abort();
    };
  }, [m, root, version]);
  if (!stashes.length) return null;
  const menu = (s: Stash): MenuEntry[] => [
    { label: t('git.stash.apply'), disabled: readOnly, run: () => void runGit(m, root, 'stashApply', stashParams(s)) },
    { label: t('git.stash.pop'), disabled: readOnly, run: () => void runGit(m, root, 'stashPop', stashParams(s)) },
    { label: t('git.stash.drop'), danger: true, disabled: readOnly, run: () => void stashDrop(m, root, s) },
  ];
  return (
    <Section id="git.stashes" title={t('git.group.stashes')} count={stashes.length} defaultOpen={false}>
      <div className="git-rows" style={{ height: stashes.length * rowH }}>
        {stashes.map((s, i) => (
          <TreeRow
            key={s.hash}
            className="git-row"
            style={{ top: i * rowH, height: rowH }}
            depth={0}
            icon={<Archive className="git-row-icon" />}
            label={s.message}
            title={s.message}
            onContextMenu={(e) => openMenu(e, menu(s))}
            actions={
              readOnly ? undefined : (
                <>
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
                </>
              )
            }
          />
        ))}
      </div>
    </Section>
  );
}
