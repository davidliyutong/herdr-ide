// Decorations of the file explorer's rows that other plugins provide (the
// state of files in version control): a color for the name, a short badge
// and a tooltip. A provider answers for the entries of one directory; it
// calls refreshDecorations when its answers change.

import { create } from 'zustand';

export interface FileDecoration {
  /** A CSS color for the name (a variable such as var(--working)). */
  color?: string;
  /** One or two characters shown at the row's end. */
  badge?: string;
  tooltip?: string;
}

/** Decorations of the entries of directory dir of machine m, by name. */
export type DecorationProvider = (m: string, dir: string) => Record<string, FileDecoration> | undefined;

const providers = new Set<DecorationProvider>();

/** Bumped when providers or their answers change; the tree re-renders. */
export const useDecorationVersion = create<{ v: number }>(() => ({ v: 0 }));

/** Adds a provider; returns the function that removes it. */
export function registerFileDecorations(provider: DecorationProvider): () => void {
  providers.add(provider);
  refreshDecorations();
  return () => {
    providers.delete(provider);
    refreshDecorations();
  };
}

/** Tells the tree that decorations changed. */
export function refreshDecorations() {
  useDecorationVersion.setState((s) => ({ v: s.v + 1 }));
}

/** The decorations of a directory's entries: the providers' answers, the
 * later provider's fields winning. */
export function decorationsOf(m: string, dir: string): Record<string, FileDecoration> {
  const out: Record<string, FileDecoration> = {};
  for (const p of providers) {
    let got: Record<string, FileDecoration> | undefined;
    try {
      got = p(m, dir);
    } catch {
      continue;
    }
    for (const [name, d] of Object.entries(got ?? {})) out[name] = { ...out[name], ...d };
  }
  return out;
}
