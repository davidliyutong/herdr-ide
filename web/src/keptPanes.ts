// The terminals (and recently viewed file editor/preview panes) shown last
// stay mounted while another tab, workspace or machine is shown: hidden,
// their state intact. Coming back to one shows it at once without remounting
// Monaco or flashing "Loading...", or for terminals without attaching again.
// How many terminals are kept is the setting performance.keptTerminals; at
// most MAX_KEPT_FILE_PANES file editor/preview panes are kept hidden.
import * as L from './term/layout';
import { mediaExt } from './terminal/links';

export interface KeptPane {
  m: string;
  /** The terminal's address. */
  pane: string;
  /** Where it was shown, as fractions of the tab, so that it keeps its size. */
  rect: L.Rect;
}

export interface KeptFilePane {
  m: string;
  /** The pane's key (`view:<id>` or `preview:<id>`). */
  pane: string;
  rect: L.Rect;
  leaf: L.PluginLeaf | L.PreviewLeaf;
}

/** At most this many hidden file editor/preview panes stay mounted across tab switches. */
export const MAX_KEPT_FILE_PANES = 8;

let recent: KeptPane[] = [];
let recentFiles: KeptFilePane[] = [];

const same = (a: { m: string; pane: string }, b: { m: string; pane: string }) => a.m === b.m && a.pane === b.pane;

/** Notes the terminals shown now and returns the ones to keep hidden: the
 * latest shown before that are still open (open says whether one is), at
 * most limit of them. */
export function keepPanes(shown: readonly KeptPane[], limit: number, open: (k: KeptPane) => boolean): KeptPane[] {
  const hidden = recent.filter((k) => !shown.some((s) => same(s, k)) && open(k)).slice(0, Math.max(0, limit));
  recent = [...shown, ...hidden];
  return hidden;
}

/** Whether a layout leaf is a text/code/Markdown file pane eligible to stay
 * mounted hidden across tab switches. Media panes (audio, video, images, PDFs)
 * are excluded so hidden tabs never keep media playing or streams open. */
export function isKeepableFileLeaf(leaf: L.Leaf): leaf is L.PluginLeaf | L.PreviewLeaf {
  if (L.isPreviewLeaf(leaf)) return !mediaExt.test(leaf.preview.path);
  return (
    L.isPluginLeaf(leaf) && leaf.view.plugin === 'files' && leaf.view.kind === 'editor' && !mediaExt.test(String(leaf.view.path ?? ''))
  );
}

/** Notes the file editor/preview panes shown now and returns the ones to keep
 * mounted hidden, updating each kept entry's leaf from the live layout (and
 * dropping any pane that closed). */
export function keepFilePanes(
  shown: readonly KeptFilePane[],
  resolveOpen: (k: KeptFilePane) => (L.PluginLeaf | L.PreviewLeaf) | null,
  limit = MAX_KEPT_FILE_PANES,
): KeptFilePane[] {
  const hidden: KeptFilePane[] = [];
  for (const k of recentFiles) {
    if (hidden.length >= Math.max(0, limit)) break;
    if (shown.some((s) => same(s, k))) continue;
    const live = resolveOpen(k);
    if (live) hidden.push({ ...k, leaf: live });
  }
  recentFiles = [...shown, ...hidden];
  return hidden;
}

/** Forgets the kept terminals and file panes: their view is gone (and in tests). */
export function resetKeptPanes() {
  recent = [];
  recentFiles = [];
}
