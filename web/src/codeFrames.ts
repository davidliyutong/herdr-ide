// The windows of VS Code panes (term/layout.ts CodeLeaf): one same-origin
// iframe per VS Code view a page shows, kept in a layer over the panes
// (components/CodeLayer.tsx) and placed over the pane's body (its slot)
// while the pane is on screen. Moving an iframe in the document reloads it,
// so the layer never moves one: moving its pane, switching tabs, workspaces
// or machines only places it elsewhere or hides it. A window off screen
// stays loaded for a while, so coming back is instant; then it is
// unmounted, which closes its connection and lets the core stop that
// machine's idle code-server (docs/features/05-vscode-panes.md).
//
// Each iframe is a VS Code window of its own. The page learns which window
// an iframe shows when the window reports the keyboard (bridge.focus) while
// that iframe has it, or from the reply to a command; commands for the pane
// then name that window (lib/bridge.ts).

import { create } from 'zustand';
import * as L from './term/layout';
import { terms } from './state/terms';
import { withView } from './state/panes';

/** A VS Code view's window in the page. */
export interface Frame {
  m: string;
  /** The view's id (CodeView.id). */
  id: string;
  folder: string;
  /** When it went off screen; none while shown. */
  hidden?: number;
  /** Counts the reloads asked for: each is a new iframe. */
  load: number;
}

/** A VS Code pane on screen. */
export interface ShownView {
  m: string;
  id: string;
  folder: string;
}

export const frameKey = (m: string, id: string) => `${m}|${id}`;

/** A window off screen is unmounted after this long, which closes its
 * connection and lets the core stop that machine's idle code-server. */
export const FRAME_TTL = 10 * 60_000;
/** At most this many windows off screen stay mounted (each is a whole VS Code
 * workbench); the ones hidden longest go first. */
export const MAX_HIDDEN_FRAMES = 3;

interface FramesState {
  frames: Record<string, Frame>;
  /** The VS Code panes on screen, by frameKey. */
  shown: Record<string, ShownView>;
  /** Machines whose code-server was stopped from this page, until VS Code
   * is started there again. */
  stopped: Record<string, true>;
  /** The VS Code window each frame shows, by frameKey, once known. */
  windows: Record<string, string>;
}

export const useFrames = create<FramesState>(() => ({ frames: {}, shown: {}, stopped: {}, windows: {} }));

/**
 * The frames to keep: one for each pane on screen whose machine has
 * VS Code (off says which have none: disabled, stopped, read-only), and the
 * others off screen, without those whose view left its layout (alive says
 * false; undefined while its machine's layout is unknown), expired ones and
 * the oldest beyond MAX_HIDDEN_FRAMES. Frames keep their order: moving an
 * iframe in the document reloads it.
 */
export function nextFrames(
  frames: Record<string, Frame>,
  shown: Record<string, ShownView>,
  alive: (fr: Frame) => boolean | undefined,
  off: (m: string) => boolean,
  now: number,
): Record<string, Frame> {
  const hidden: [string, number][] = [];
  for (const [k, fr] of Object.entries(frames)) {
    if (shown[k] || off(fr.m) || alive(fr) === false) continue;
    const h = fr.hidden ?? now;
    if (now - h < FRAME_TTL) hidden.push([k, h]);
  }
  hidden.sort((a, b) => b[1] - a[1]);
  const keep = new Map(hidden.slice(0, MAX_HIDDEN_FRAMES));
  const next: Record<string, Frame> = {};
  for (const [k, fr] of Object.entries(frames)) {
    if (shown[k] && !off(fr.m)) next[k] = fr.hidden === undefined ? fr : { m: fr.m, id: fr.id, folder: fr.folder, load: fr.load };
    else if (keep.has(k)) next[k] = fr.hidden === keep.get(k) ? fr : { ...fr, hidden: keep.get(k) };
  }
  for (const [k, v] of Object.entries(shown)) if (!next[k] && !off(v.m)) next[k] = { m: v.m, id: v.id, folder: v.folder, load: 0 };
  const same = Object.keys(next).length === Object.keys(frames).length && Object.entries(next).every(([k, fr]) => frames[k] === fr);
  return same ? frames : next;
}

/** The address of a VS Code window of a machine and folder ("" for the one
 * code-server opens). */
export function codeUrl(m: string, folder?: string) {
  const q = folder ? `?${new URLSearchParams({ folder })}` : '';
  return `/m/${encodeURIComponent(m)}/code/${q}`;
}

// The slots (pane bodies) and iframes on screen, placed by place().

const slots = new Map<string, HTMLElement>();
const iframes = new Map<string, HTMLIFrameElement>();

/** Places a frame's iframe over its pane's slot, or hides it. */
export function place(k: string) {
  const el = iframes.get(k);
  if (!el) return;
  const slot = slots.get(k);
  const r = slot?.isConnected ? slot.getBoundingClientRect() : undefined;
  if (!r || r.width < 1 || r.height < 1) {
    el.style.display = 'none';
    return;
  }
  // Relative to the layer, which lies over the workspace (CodeLayer).
  const o = el.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
  Object.assign(el.style, {
    display: 'block',
    left: `${r.left - o.left}px`,
    top: `${r.top - o.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
}

export function placeAll() {
  for (const k of iframes.keys()) place(k);
}

/** A VS Code pane on screen: its iframe is placed over el (and follows its
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

/** When the user or the page last asked for each frame's keyboard (a press
 * or a key in it, focusFrame), and when each last loaded. VS Code takes the
 * keyboard by itself as it starts; a frame that gets it unasked within
 * SETTLE_MS of loading gives it back to the focused pane, so a VS Code pane
 * that loads beside a terminal (after a reload, say) does not take the
 * terminal's keys. */
const asked = new Map<string, number>();
const loaded = new Map<string, number>();
export const SETTLE_MS = 15_000;
const ASK_MS = 3_000;

const ask = (k: string) => asked.set(k, Date.now());
// The focusFrame request under way for each frame, by its number.
const focusing = new Map<string, number>();
let focusRun = 0;

/** Whether a frame that got the keyboard was meant to. */
function wanted(k: string, now = Date.now()): boolean {
  return now - (asked.get(k) ?? -Infinity) < ASK_MS || now - (loaded.get(k) ?? -Infinity) > SETTLE_MS;
}

/** An iframe of the layer; returns a function that forgets it. */
export function mountFrame(k: string, el: HTMLIFrameElement): () => void {
  iframes.set(k, el);
  loaded.set(k, Date.now());
  place(k);
  return () => {
    if (iframes.get(k) !== el) return;
    iframes.delete(k);
    loaded.delete(k);
    // A press can come before the frame it asked for (a reload's next
    // iframe): when a frame was asked for outlives the one that went.
    if (Date.now() - (asked.get(k) ?? -Infinity) >= ASK_MS) asked.delete(k);
    unbind(k);
  };
}

/** Gives a VS Code pane's window the keyboard once its iframe is placed (a
 * new pane's is made after its slot shows), within about two seconds. */
export function focusFrame(k: string) {
  const run = ++focusRun;
  focusing.set(k, run);
  const attempt = (tries: number) => {
    // A newer request for the frame, or resetFrames, ends this one: it
    // would otherwise go on marking the frame asked for.
    if (focusing.get(k) !== run) return;
    ask(k);
    requestAnimationFrame(() => {
      if (focusing.get(k) !== run) return;
      const el = iframes.get(k);
      if (!el || el.style.display === 'none') {
        if (tries > 0) attempt(tries - 1);
        else focusing.delete(k);
        return;
      }
      focusing.delete(k);
      el.focus();
      try {
        el.contentWindow?.focus();
      } catch {
        /* not the page's origin */
      }
    });
  };
  attempt(120);
}

/** A frame got the keyboard. Asked for (a click in VS Code, focusFrame), or
 * once VS Code has settled: its pane is the focused one of its tab. Else
 * (VS Code starting) the focused pane takes the keyboard back. */
function frameFocused(k: string) {
  const fr = useFrames.getState().frames[k];
  if (!fr) return;
  const key = L.codeKey(fr.id);
  const layout = terms.layout(fr.m);
  const focused = layout && L.focusedPane(layout);
  if (focused === key) return;
  if (wanted(k)) {
    terms.mutate(fr.m, (l) => L.focusPane(l, key));
    return;
  }
  if (focused) withView(fr.m, focused, (h) => h.focus(), 0);
  else (document.activeElement as HTMLElement | null)?.blur();
}

let frameKeys: ((ev: KeyboardEvent, focus: () => void) => boolean) | undefined;

/** Sets what sees a key pressed in a frame before VS Code does
 * (keymap.ts handleFrameKey): true takes the key from VS Code; focus makes
 * the frame's pane the focused one first. */
export function onFrameKey(fn: (ev: KeyboardEvent, focus: () => void) => boolean) {
  frameKeys = fn;
}

/** Follows the keyboard into a frame's document, after each load (the
 * loading page, then VS Code), and gives the app the keys it takes there
 * first (onFrameKey), for the frame's pane. */
export function frameLoaded(k: string, el: HTMLIFrameElement) {
  loaded.set(k, Date.now());
  try {
    const w = el.contentWindow;
    w?.addEventListener('focus', () => frameFocused(k));
    w?.addEventListener('pointerdown', () => ask(k), true);
    w?.addEventListener(
      'keydown',
      (ev) => {
        ask(k);
        if (!frameKeys?.(ev, () => frameFocused(k))) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
      },
      true,
    );
  } catch {
    /* not the page's origin */
  }
}

/** The frame of the iframe that has the keyboard, when the page has it. */
export function focusedFrame(): string | undefined {
  if (typeof document === 'undefined' || !document.hasFocus()) return undefined;
  const a = document.activeElement as HTMLElement | null;
  return a?.classList.contains('code-frame') ? a.dataset.frame : undefined;
}

// Focus moving from the page into a frame, also into a webview inside
// VS Code, whose window then gets no focus event of its own.
if (typeof window !== 'undefined')
  window.addEventListener('blur', () =>
    setTimeout(() => {
      const k = focusedFrame();
      if (k) frameFocused(k);
    }),
  );

// The windows frames show.

function unbind(k: string) {
  if (!(k in useFrames.getState().windows)) return;
  useFrames.setState((s) => {
    const { [k]: _, ...windows } = s.windows;
    return { windows };
  });
}

/** Records that frame k shows window; no other frame shows it. */
export function bindWindow(k: string, window: string) {
  const s = useFrames.getState();
  if (s.windows[k] === window || !s.frames[k]) return;
  const windows: Record<string, string> = {};
  for (const [key, w] of Object.entries(s.windows)) if (w !== window) windows[key] = w;
  windows[k] = window;
  useFrames.setState({ windows });
}

/** The frame showing a window of machine m. */
export function frameOfWindow(m: string, window: string): string | undefined {
  const s = useFrames.getState();
  return Object.keys(s.windows).find((k) => s.windows[k] === window && s.frames[k]?.m === m);
}

const showsFolder = (fr: Frame, folders?: string[]) =>
  !folders || !fr.folder || folders.some((f) => L.normFolder(f) === L.normFolder(fr.folder));

/**
 * A VS Code window of machine m with these folders got the keyboard
 * (bridge.focus, or a message it sent): when this page has the keyboard in
 * a frame of m showing one of them, that frame shows the window. Returns the
 * frame.
 */
export function windowFocused(m: string, window: string, folders?: string[]): string | undefined {
  const k = focusedFrame();
  const fr = k ? useFrames.getState().frames[k] : undefined;
  if (!k || !fr || fr.m !== m || !showsFolder(fr, folders)) return undefined;
  bindWindow(k, window);
  return k;
}

/** The frames of machine m showing one of these folders (any, without
 * folders), those on screen first. */
export function framesShowing(m: string, folders?: string[]): string[] {
  const s = useFrames.getState();
  return Object.keys(s.frames)
    .filter((k) => s.frames[k].m === m && showsFolder(s.frames[k], folders))
    .sort((a, b) => Number(!s.shown[a]) - Number(!s.shown[b]));
}

// Reloading and stopping.

/** Loads a VS Code pane's window again (a new iframe). */
export function reloadFrame(m: string, id: string) {
  const k = frameKey(m, id);
  const fr = useFrames.getState().frames[k];
  if (!fr) return;
  unbind(k);
  useFrames.setState((s) => ({ frames: { ...s.frames, [k]: { ...fr, load: fr.load + 1 } } }));
}

/** Marks a machine's code-server stopped from this page: its frames go and
 * its panes offer to start it again. */
export function setStopped(m: string, stopped: boolean) {
  if (!!useFrames.getState().stopped[m] === stopped) return;
  useFrames.setState((s) => {
    const { [m]: _, ...rest } = s.stopped;
    return { stopped: stopped ? { ...rest, [m]: true } : rest };
  });
}

/** Resets the frames (tests). */
export function resetFrames() {
  slots.clear();
  iframes.clear();
  asked.clear();
  loaded.clear();
  focusing.clear();
  useFrames.setState({ frames: {}, shown: {}, stopped: {}, windows: {} });
}
