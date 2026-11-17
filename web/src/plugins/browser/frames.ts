// The frames of browser panes (view {plugin: 'browser', kind: 'page'}): one
// element per browser view a page shows, kept in a layer over the panes
// (BrowserLayer.tsx) and placed over the pane's body (its slot) while the
// pane is on screen. Moving an iframe in the document reloads it, so the
// layer never moves one: moving its pane, switching tabs, workspaces or
// machines only places it elsewhere or hides it. A frame off screen stays
// loaded for a while, so coming back is instant; a view that left its
// layout loses its frame at once. The model is that of codeFrames.ts (VS
// Code's windows), which these frames differ from in what they show: pages
// of other origins, whose windows and documents this page never touches.
//
// In a browser a frame is an <iframe>, which gives no way to follow the
// page's own navigation: back and forward go over the addresses the
// toolbar loaded (the trail). In the desktop app it is a <webview>, which
// does follow the page.

import { create } from 'zustand';

/** A browser view's frame in the page. */
export interface Frame {
  m: string;
  /** The view's id (PluginView.id). */
  id: string;
  /** When it went off screen; none while shown. */
  hidden?: number;
  /** Counts the reloads asked for: each is a new element. */
  load: number;
}

/** A browser pane on screen. */
export interface ShownView {
  m: string;
  id: string;
}

/** What a frame loads. */
export interface Page {
  /** The address the element loads (through the forward, on the host the
   * UI is not on). */
  src: string;
  /** The address as the user means it (http://localhost:3000/docs). */
  url: string;
  /** The machine's port it is a page of, and the local port that reaches
   * it, when it is forwarded. */
  forward?: { m: string; port: number; local: number };
}

/** What the toolbar shows of a frame. */
export interface Nav {
  /** The last address loaded, as the user means it. */
  url?: string;
  title?: string;
  back: boolean;
  forward: boolean;
  /** A load that failed (a webview's). */
  error?: string;
  /** A webview left its forwarded page for another address. */
  away?: boolean;
}

export const frameKey = (m: string, id: string) => `${m}|${id}`;

/** A frame off screen is unmounted after this long. */
export const FRAME_TTL = 10 * 60_000;
/** At most this many frames off screen stay mounted; the ones hidden
 * longest go first. */
export const MAX_HIDDEN_FRAMES = 4;

interface FramesState {
  frames: Record<string, Frame>;
  /** The browser panes on screen, by frameKey. */
  shown: Record<string, ShownView>;
  /** What each frame loads, once the pane has it (a forward is made
   * first). */
  pages: Record<string, Page>;
  nav: Record<string, Nav>;
  /** Counts the reloads asked of a pane that has no page to reload. */
  retries: Record<string, number>;
}

export const useFrames = create<FramesState>(() => ({ frames: {}, shown: {}, pages: {}, nav: {}, retries: {} }));

/**
 * The frames to keep: one for each pane on screen, and the others off
 * screen, without those whose view left its layout (alive says false;
 * undefined while its machine's layout is unknown), expired ones and the
 * oldest beyond MAX_HIDDEN_FRAMES. Frames keep their order: moving an
 * element in the document reloads it.
 */
export function nextFrames(
  frames: Record<string, Frame>,
  shown: Record<string, ShownView>,
  alive: (fr: Frame) => boolean | undefined,
  now: number,
): Record<string, Frame> {
  const hidden: [string, number][] = [];
  for (const [k, fr] of Object.entries(frames)) {
    if (shown[k] || alive(fr) === false) continue;
    const h = fr.hidden ?? now;
    if (now - h < FRAME_TTL) hidden.push([k, h]);
  }
  hidden.sort((a, b) => b[1] - a[1]);
  const keep = new Map(hidden.slice(0, MAX_HIDDEN_FRAMES));
  const next: Record<string, Frame> = {};
  for (const [k, fr] of Object.entries(frames)) {
    if (shown[k]) next[k] = fr.hidden === undefined ? fr : { m: fr.m, id: fr.id, load: fr.load };
    else if (keep.has(k)) next[k] = fr.hidden === keep.get(k) ? fr : { ...fr, hidden: keep.get(k) };
  }
  for (const [k, v] of Object.entries(shown)) if (!next[k]) next[k] = { m: v.m, id: v.id, load: 0 };
  const same = Object.keys(next).length === Object.keys(frames).length && Object.entries(next).every(([k, fr]) => frames[k] === fr);
  return same ? frames : next;
}

/** What a webview (Electron's) offers, which the page uses. */
export interface WebviewElement extends HTMLElement {
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  loadURL(url: string): Promise<void>;
}

export const isWebview = (el: Element | null | undefined): el is WebviewElement => el?.tagName === 'WEBVIEW';

// The slots (pane bodies) and elements on screen, placed by place().

const slots = new Map<string, HTMLElement>();
const elements = new Map<string, HTMLElement>();

/** Places a frame's element over its pane's slot, or hides it. */
export function place(k: string) {
  const el = elements.get(k);
  if (!el) return;
  const slot = slots.get(k);
  const r = slot?.isConnected ? slot.getBoundingClientRect() : undefined;
  if (!r || r.width < 1 || r.height < 1) {
    el.style.display = 'none';
    return;
  }
  // Relative to the layer, which lies over the workspace (BrowserLayer).
  const o = el.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
  Object.assign(el.style, {
    display: isWebview(el) ? 'inline-flex' : 'block',
    left: `${r.left - o.left}px`,
    top: `${r.top - o.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
}

export function placeAll() {
  for (const k of elements.keys()) place(k);
}

/** A browser pane on screen: its frame is placed over el (and follows its
 * size). Returns a function that takes the pane off screen. */
export function showSlot(view: ShownView, el: HTMLElement): () => void {
  const k = frameKey(view.m, view.id);
  slots.set(k, el);
  const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => place(k));
  ro?.observe(el);
  useFrames.setState((s) => ({ shown: { ...s.shown, [k]: view } }));
  place(k);
  return () => {
    ro?.disconnect();
    if (slots.get(k) !== el) return;
    slots.delete(k);
    useFrames.setState((s) => {
      const { [k]: _, ...shown } = s.shown;
      return { shown };
    });
    place(k);
  };
}

/** A frame's element of the layer; returns a function that forgets it. */
export function mountFrame(k: string, el: HTMLElement): () => void {
  elements.set(k, el);
  place(k);
  return () => {
    if (elements.get(k) === el) elements.delete(k);
  };
}

/** The element of a frame, if it is mounted. */
export const frameElement = (k: string): HTMLElement | undefined => elements.get(k);

/** Gives a frame's element the keyboard. */
export function focusFrame(k: string) {
  elements.get(k)?.focus();
}

/** The frame of the element that has the keyboard, when the page has it. */
export function focusedFrame(): string | undefined {
  if (typeof document === 'undefined' || !document.hasFocus()) return undefined;
  const a = document.activeElement as HTMLElement | null;
  return a?.classList.contains('browser-frame') ? a.dataset.frame : undefined;
}

// The addresses an iframe loaded, which back and forward go over.

interface Trail {
  entries: Page[];
  at: number;
}
const trails = new Map<string, Trail>();

const samePage = (a: Page | undefined, b: Page) => !!a && a.src === b.src && a.url === b.url;

function setNav(k: string, patch: Partial<Nav>) {
  useFrames.setState((s) => {
    const cur = s.nav[k] ?? { back: false, forward: false };
    const next = { ...cur, ...patch };
    const same = (Object.keys(next) as (keyof Nav)[]).every((f) => next[f] === cur[f]) && k in s.nav;
    return same ? s : { nav: { ...s.nav, [k]: next } };
  });
}

/** Updates what a webview reports (its navigation events). */
export function reportNav(k: string, patch: Partial<Nav>) {
  setNav(k, patch);
}

/** Shows a page in frame k: a new address of the trail (the one before it,
 * if it is the same, is kept). */
export function showPage(k: string, page: Page) {
  const el = elements.get(k);
  const tr = trails.get(k) ?? { entries: [], at: -1 };
  if (!samePage(tr.entries[tr.at], page)) {
    tr.entries = [...tr.entries.slice(0, tr.at + 1), page];
    tr.at = tr.entries.length - 1;
  } else tr.entries[tr.at] = page;
  trails.set(k, tr);
  useFrames.setState((s) => ({ pages: { ...s.pages, [k]: page } }));
  // A webview keeps its own history and says where it is.
  if (!isWebview(el)) setNav(k, { url: page.url, back: tr.at > 0, forward: false, error: undefined });
  else setNav(k, { url: page.url, error: undefined });
}

/** Takes the page off a frame (its pane shows a start page or an error);
 * its element goes. */
export function clearPage(k: string) {
  if (!(k in useFrames.getState().pages)) return;
  trails.delete(k);
  useFrames.setState((s) => {
    const { [k]: _, ...pages } = s.pages;
    const { [k]: __, ...nav } = s.nav;
    return { pages, nav };
  });
}

/** Takes the page off a frame whose forward ended and is not this page's
 * to make again, and has its pane look at its view again: it asks the
 * user. */
export function unloadPage(k: string) {
  clearPage(k);
  useFrames.setState((s) => ({ retries: { ...s.retries, [k]: (s.retries[k] ?? 0) + 1 } }));
}

/** Moves back or forward in frame k. An iframe goes over the trail and
 * returns the page it is at; a webview follows its page's own history. */
export function stepPage(k: string, step: -1 | 1): Page | undefined {
  const el = elements.get(k);
  if (isWebview(el)) {
    if (step < 0) el.goBack();
    else el.goForward();
    return undefined;
  }
  const tr = trails.get(k);
  const page = tr?.entries[tr.at + step];
  if (!tr || !page) return undefined;
  tr.at += step;
  useFrames.setState((s) => ({ pages: { ...s.pages, [k]: page } }));
  setNav(k, { url: page.url, back: tr.at > 0, forward: tr.at < tr.entries.length - 1, error: undefined });
  return page;
}

/** Loads frame k again: a webview reloads, an iframe is a new element.
 * Without a page (a start page, an error) the pane is asked to try
 * again. */
export function reloadPage(k: string) {
  const el = elements.get(k);
  const s = useFrames.getState();
  if (!(k in s.pages)) {
    useFrames.setState({ retries: { ...s.retries, [k]: (s.retries[k] ?? 0) + 1 } });
    return;
  }
  if (isWebview(el)) {
    el.reload();
    return;
  }
  const fr = s.frames[k];
  if (fr) useFrames.setState({ frames: { ...s.frames, [k]: { ...fr, load: fr.load + 1 } } });
}

/** A frame went (its view left, it expired): its trail goes with it. */
export function forgetFrames(keep: Record<string, Frame>) {
  const s = useFrames.getState();
  const gone = Object.keys(s.pages).filter((k) => !(k in keep));
  if (!gone.length) return;
  for (const k of gone) trails.delete(k);
  useFrames.setState((st) => {
    const pages = { ...st.pages };
    const nav = { ...st.nav };
    for (const k of gone) {
      delete pages[k];
      delete nav[k];
    }
    return { pages, nav };
  });
}

/** Resets the frames (tests). */
export function resetFrames() {
  slots.clear();
  elements.clear();
  trails.clear();
  useFrames.setState({ frames: {}, shown: {}, pages: {}, nav: {}, retries: {} });
}
