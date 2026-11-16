// The file entries of the Git panel's context menus: the file explorer's
// own (files/ops.ts fileMenuEntries: Open, Open to the Side, Open Preview,
// Open in VS Code, Open in Terminal, Copy Path, Copy Relative Path,
// Download, Reveal in Explorer), so both panels offer the same entries in
// the same order, for the targets that are there (a deleted file has
// nothing to open, download or reveal).

import type { MenuEntry } from '../../contextMenu';
import { fileMenuEntries } from '../files/ops';

export interface FileTargets {
  /** Absolute paths of the machine, the one pointed at first: files, and
   * the tree's folders (in dirs). */
  paths: string[];
  /** The repository's top level, which relative paths start from. */
  root: string;
  /** Paths that are folders (the tree's). */
  dirs?: ReadonlySet<string>;
  /** Paths that are not there (deleted files). */
  gone?: ReadonlySet<string>;
  /** Where the keyboard goes back to after Open Preview (the list). */
  el?: HTMLElement | null;
}

/** The file entries of a context menu for paths. */
export function fileEntries(m: string, o: FileTargets): MenuEntry[] {
  const there = o.paths.filter((p) => !o.gone?.has(p));
  return fileMenuEntries(m, there, { root: o.root, isDir: (p) => !!o.dirs?.has(p), el: o.el });
}
