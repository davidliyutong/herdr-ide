// What plugins draw over a terminal's pane (plugins/api.ts terminalSurfaces)
// covers of the terminal: all of it, or a part, which leaves the terminal
// shown under it. A terminal covered whole is not drawn (Workspace.tsx:
// TerminalView covered, TermPane.setShown): like one kept hidden it keeps
// its stream and its emulator and gives up its canvas, and like one shown
// it is measured and attached. Neither changes the terminal's size. Covers come and
// go here as surfaces change; what a surface covers as it is drawn it also
// says at render time (plugins/api.ts TerminalSurfaceDef.covers), which
// Workspace.tsx takes with these.
import { useLayoutEffect } from 'react';
import { create } from 'zustand';

export type Cover = 'all' | 'part';

/** By machine and terminal (key), what each surface over it covers. */
type Covers = Record<string, Record<string, Cover>>;

export const useCovers = create<{ covers: Covers }>(() => ({ covers: {} }));

const key = (m: string, terminal: string) => `${m}\n${terminal}`;

/** What covers a terminal in covers: all of it when a surface covers it
 * all, else part of it when one covers a part. */
export function coverIn(covers: Covers, m: string, terminal: string): Cover | undefined {
  const own = covers[key(m, terminal)];
  return own ? strongestCover(Object.values(own)) : undefined;
}

/** The strongest of several covers: all, else part, else none. */
export function strongestCover(list: readonly (Cover | undefined)[]): Cover | undefined {
  return list.includes('all') ? 'all' : list.includes('part') ? 'part' : undefined;
}

/** Says what a surface (owner: its id, TerminalSurfaceDef.id, so that two
 * surfaces over a terminal keep their own) covers of a terminal;
 * undefined: nothing. */
export function setCover(m: string, terminal: string, cover: Cover | undefined, owner: string): void {
  const k = key(m, terminal);
  useCovers.setState((s) => {
    const own = s.covers[k] ?? {};
    if (own[owner] === cover) return s;
    const { [owner]: _, ...rest } = own;
    const next = cover ? { ...rest, [owner]: cover } : rest;
    const { [k]: __, ...others } = s.covers;
    return { covers: Object.keys(next).length ? { ...others, [k]: next } : others };
  });
}

/** What covers a terminal now. */
export const coverOf = (m: string, terminal: string): Cover | undefined => coverIn(useCovers.getState().covers, m, terminal);

/** What covers a terminal, for components. */
export function useCover(m: string, terminal: string): Cover | undefined {
  return useCovers((s) => coverIn(s.covers, m, terminal));
}

/** A surface's cover of a terminal while it is mounted (owner: the
 * surface's id): set before the page is painted, so the terminal is not
 * drawn for a frame first, and taken back when the surface goes. What a
 * surface covers as it is first drawn it says at render time as well
 * (TerminalSurfaceDef.covers), so that a pane shown again is not drawn for
 * a frame before this is set. */
export function useSetCover(m: string, terminal: string, cover: Cover | undefined, owner: string): void {
  useLayoutEffect(() => {
    setCover(m, terminal, cover, owner);
    return () => setCover(m, terminal, undefined, owner);
  }, [m, terminal, cover, owner]);
}
