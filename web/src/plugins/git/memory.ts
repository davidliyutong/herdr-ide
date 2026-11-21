// What the Git panel shows beyond the repositories' state on the machine
// (state.ts), kept in the page's memory while the panel is away (another
// panel shown, the sidebar hidden, another repository looked at): the
// repository last shown per machine and workspace, the one picked among
// nested ones; per machine and repository, folders collapsed in the tree,
// the view chosen in read-only mode, the rows selected, the commit message, its
// box's height and the Amend box, the lists' scroll positions, the
// history's commits and the one opened, the stashes. Sections' open or
// closed state is kept per browser apart from these (components/tree
// useSectionOpen).

import { useCallback, useState } from 'react';
import type { Selection } from '../../components/tree';
import type { Change, Commit, Ref, Stash } from './api';

export interface PanelMemory {
  /** Folders of the tree collapsed (their row ids). */
  collapsed: ReadonlySet<string>;
  /** The list or the tree, chosen for this view in read-only mode. */
  view?: string;
  selection: Selection;
  draft: string;
  /** The commit box's height as the user dragged it (CSS). */
  draftHeight?: string;
  amend: boolean;
  /** The changes' scroll position. */
  scroll: number;
  history?: { commits: Commit[]; refs: Ref[]; more: boolean };
  /** The commit opened in the history, with its files once read. */
  opened?: string;
  openedFiles?: { hash: string; files: Change[] };
  historyScroll: number;
  stashes?: Stash[];
}

/** The most repositories remembered (the least recently used go first). */
const MAX_REPOS = 32;

const kept = new Map<string, PanelMemory>();

const key = (m: string, root: string) => `${m}\u0000${root}`;

/** What the panel keeps of a machine's repository (made when first asked). */
export function panelMemory(m: string, root: string): PanelMemory {
  const k = key(m, root);
  let mem = kept.get(k);
  if (mem) {
    // The most recent last.
    kept.delete(k);
  } else {
    mem = { collapsed: new Set(), selection: { selection: [] }, draft: '', amend: false, scroll: 0, historyScroll: 0 };
  }
  kept.set(k, mem);
  while (kept.size > MAX_REPOS) kept.delete(kept.keys().next().value!);
  return mem;
}

type Field = 'collapsed' | 'view' | 'selection' | 'draft' | 'amend' | 'opened';

/** A field of the repository's memory as component state: it starts from
 * what was kept and every change is kept. */
export function useKept<F extends Field>(
  m: string,
  root: string,
  field: F,
): [PanelMemory[F], (v: PanelMemory[F] | ((cur: PanelMemory[F]) => PanelMemory[F])) => void] {
  const [value, setValue] = useState<PanelMemory[F]>(() => panelMemory(m, root)[field]);
  const set = useCallback(
    (v: PanelMemory[F] | ((cur: PanelMemory[F]) => PanelMemory[F])) =>
      setValue((cur) => {
        const next = typeof v === 'function' ? (v as (cur: PanelMemory[F]) => PanelMemory[F])(cur) : v;
        panelMemory(m, root)[field] = next;
        return next;
      }),
    [m, root, field],
  );
  return [value, set];
}

/** The repositories the panel last showed per machine and workspace
 * (innermost first, none outside repositories). */
export const lastShown = new Map<string, string[]>();
/** The repository picked among nested ones, by machine and innermost
 * repository. */
export const pickedRepo = new Map<string, string>();

/** Forgets what the panel keeps (tests). */
export function forgetPanels() {
  kept.clear();
  lastShown.clear();
  pickedRepo.clear();
}
