// The terminals, recently viewed file editor/preview panes, and agent chat
// panes shown last stay mounted while another tab, workspace or machine is
// shown: hidden, their state intact. Coming back to one shows it at once
// without remounting Monaco/Markdown, replaying scroll, or flashing "Loading...",
// or for terminals without attaching again.
// How many terminals are kept is the setting performance.keptTerminals; at
// most MAX_KEPT_FILE_PANES file editor/preview panes are kept hidden. Actively
// working/waiting/starting chat panes are protected from idle LRU eviction
// (up to MAX_PROTECTED_CHAT_PANES) while up to MAX_KEPT_CHAT_PANES idle chat
// panes also stay mounted hidden.
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

export interface KeptChatPane {
  m: string;
  /** The pane's key (`view:<id>`). */
  pane: string;
  rect: L.Rect;
  leaf: L.PluginLeaf;
}

/** At most this many hidden file editor/preview panes stay mounted across tab switches. */
export const MAX_KEPT_FILE_PANES = 8;
/** At most this many idle/stopped hidden chat panes stay mounted across tab switches. */
export const MAX_KEPT_CHAT_PANES = 8;
/** Safety cap for protected actively working hidden chat panes (aligns with chat WS per-machine limit). */
export const MAX_PROTECTED_CHAT_PANES = 16;

let recent: KeptPane[] = [];
let recentFiles: KeptFilePane[] = [];
let recentChats: KeptChatPane[] = [];

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

/** Whether a layout leaf is an Agent Chat pane eligible to stay mounted hidden
 * across tab/workspace/machine switches. */
export function isKeepableChatLeaf(leaf: L.Leaf): leaf is L.PluginLeaf {
  return (
    L.isPluginLeaf(leaf) &&
    leaf.view.plugin === 'chat' &&
    leaf.view.kind === 'chat' &&
    typeof leaf.view.chat === 'string' &&
    leaf.view.chat !== ''
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

/** Notes the chat panes shown now and returns the ones to keep mounted hidden.
 * Actively working/waiting/starting panes (`isProtected(k) === true`) are
 * protected from idle LRU eviction (up to `protectedLimit`), while up to
 * `idleLimit` idle/stopped chat panes also remain mounted hidden. Closed panes
 * are dropped immediately. */
export function keepChatPanes(
  shown: readonly KeptChatPane[],
  resolveOpen: (k: KeptChatPane) => L.PluginLeaf | null,
  isProtected: (k: KeptChatPane) => boolean,
  idleLimit = MAX_KEPT_CHAT_PANES,
  protectedLimit = MAX_PROTECTED_CHAT_PANES,
): KeptChatPane[] {
  const protectedHidden: KeptChatPane[] = [];
  const idleHidden: KeptChatPane[] = [];
  const maxIdle = Math.max(0, idleLimit);
  const maxProtected = Math.max(0, protectedLimit);
  for (const k of recentChats) {
    if (shown.some((s) => same(s, k))) continue;
    const live = resolveOpen(k);
    if (!live) continue;
    const updated: KeptChatPane = { ...k, leaf: live };
    if (isProtected(updated)) {
      if (protectedHidden.length < maxProtected) protectedHidden.push(updated);
    } else if (idleHidden.length < maxIdle) {
      idleHidden.push(updated);
    }
  }
  const hidden = [...protectedHidden, ...idleHidden];
  recentChats = [...shown, ...hidden];
  return hidden;
}

/** Forgets the kept terminals, file panes and chat panes: their view is gone (and in tests). */
export function resetKeptPanes() {
  recent = [];
  recentFiles = [];
  recentChats = [];
}
