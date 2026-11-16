// The entries of the Git plugin's context menus that act on files as the
// file explorer's do (open, open to the side, Quick Look, VS Code, a
// terminal, copying paths, downloads, showing the file in the explorer),
// in one function: the explorer's own list can take its place.

import { actions } from '../../actions';
import type { MenuEntry } from '../../contextMenu';
import { canDownload, startDownload } from '../../download';
import { t } from '../../i18n';
import { keyLabel } from '../../keys';
import { isPluginOn } from '../registry';
import { copyText, openEditor, openTerminal, quickLook, reveal } from '../files/ops';
import { relativePath } from '../files/tree';

const parentOf = (p: string) => (p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/')) : '/');

/** Opens a file in an editor of its own beside the focused pane. */
export function openToSide(m: string, path: string) {
  return actions.openView(m, { plugin: 'files', kind: 'editor', path, preview: false }, { reuse: () => false });
}

export interface FileTargets {
  /** Absolute paths of the machine, the one pointed at first. */
  paths: string[];
  /** The repository's top level, which relative paths start from. */
  root: string;
  /** Paths are folders (Open in Terminal opens them, not their parent). */
  dirs?: boolean;
  /** Paths that are not there (deleted files): nothing opens them. */
  gone?: ReadonlySet<string>;
  /** Where the keyboard goes back to after Quick Look. */
  el?: HTMLElement | null;
}

/** The file entries of a context menu for paths. */
export function fileEntries(m: string, o: FileTargets): MenuEntry[] {
  const { paths, root } = o;
  const there = paths.filter((p) => !o.gone?.has(p));
  const one = paths.length === 1;
  const target = paths[0];
  const out: MenuEntry[] = [];
  if (!o.dirs && there.length) {
    out.push({ label: t('files.open'), run: () => there.forEach((p) => void openEditor(m, p)) });
    out.push({ label: t('git.openToSide'), run: () => there.forEach((p) => void openToSide(m, p)) });
    if (one) out.push({ label: t('files.quickLook'), hint: keyLabel('space'), run: () => void quickLook(m, target, o.el) });
  }
  if (one && (o.dirs || there.length) && isPluginOn('vscode')) {
    out.push({
      label: t('files.openInCode'),
      run: () => void (o.dirs ? actions.openCode(m, target) : actions.openInCode(m, target)),
    });
  }
  if (one) out.push({ label: t('files.openInTerminal'), run: () => void openTerminal(m, o.dirs ? target : parentOf(target)) });
  out.push('sep');
  out.push({ label: t('files.copyPath'), run: () => void copyText(paths.join('\n')) });
  out.push({ label: t('files.copyRelativePath'), run: () => void copyText(paths.map((p) => relativePath(root, p)).join('\n')) });
  if (there.length && canDownload(m)) out.push({ label: t('files.download'), run: () => void startDownload(m, there) });
  if (one && there.length) out.push({ label: t('files.reveal'), run: () => reveal(m, target) });
  return out;
}
