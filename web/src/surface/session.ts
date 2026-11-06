// The browser side of the core's surface stream (internal/server/surface.go).
//
// One browser at a time owns the core's session, like a KVM console: it
// chooses the machine, tab and size herdr renders, and its input reaches the
// panes. This module keeps the ownership state, the shown surface's grid and
// metadata, and sends the view, input, focus and host colors.

import { create } from 'zustand';
import { conn } from '../lib/conn';
import { useStore, type ToastAction } from '../state/store';
import { usePrefs } from '../prefs';
import { t } from '../i18n';
import { Grid } from './grid';
import { decodeUpdate, type SurfaceMeta } from './protocol';
import type { InputEvent } from './input';

export type Ownership = 'pending' | 'owner' | 'busy' | 'taken_over';

export interface SurfStatus {
  m: string;
  gen: number;
  ev: 'open' | 'error' | 'notice';
  code?: string;
  detail?: string;
}

export interface View {
  m: string;
  tab: string;
  pane?: string;
  cols: number;
  rows: number;
  /** Cell size in device pixels. */
  cw: number;
  ch: number;
}

export interface HostColors {
  fg: [number, number, number];
  bg: [number, number, number];
  palette: Array<[number, number, number]>;
  dark: boolean;
}

interface SurfaceState {
  ownership: Ownership;
  status?: SurfStatus;
  meta?: SurfaceMeta;
  /** The tab herdr currently renders for this connection. */
  shown?: { m: string; tab: string; ws: string };
  bell: number;
  /** Counts complete surfaces received. */
  fulls: number;
}

export const useSurface = create<SurfaceState>(() => ({ ownership: 'pending', bell: 0, fulls: 0 }));

/** The grid of the shown surface. */
export const grid = new Grid();

let view: View | undefined;
let host: HostColors | undefined;
let paint: (() => void) | undefined;

/** Called after the grid changed (set by the view that draws it). */
export function onPaint(fn: (() => void) | undefined) {
  paint = fn;
}

function owner() {
  return useSurface.getState().ownership === 'owner';
}

function sendView() {
  if (view && owner()) conn.sendNow({ t: 'view', ...view });
}

function sendHost() {
  if (host && owner()) conn.sendNow({ t: 'host', host });
}

/** Sets what this browser wants to see; sent when it owns the session. */
export function setView(v: View) {
  const same = view && JSON.stringify(view) === JSON.stringify(v);
  view = v;
  if (!same) sendView();
}

/** Sets the colors pane programs see as the terminal's (OSC 10/11/4). */
export function setHostColors(h: HostColors) {
  const same = host && JSON.stringify(host) === JSON.stringify(h);
  host = h;
  if (!same) sendHost();
}

/** When this browser last sent a pane a key, text, paste or button press
 * (Date.now()). */
let lastInput = 0;

/** A program's clipboard write (OSC 52) is copied without asking when it
 * arrives this soon after such input: the program answers the user's own
 * selection or command, even over a slow link. */
export const CLIP_AUTO_MS = 10_000;

/** How long a program's copy stays available to the pane menu's Copy. */
export const PROGRAM_CLIP_MS = 120_000;

/** The text a pane program of machine `m` copied in answer to the user
 * (a copy that passed the automatic gate, also one the browser refused):
 * the program, not the page, holds that selection (Claude Code, Codex,
 * tmux), so the pane menu's Copy and ⌘C copy this text. The next key or
 * button press in a pane ends it, as it ends the program's selection, and
 * so do losing the session and PROGRAM_CLIP_MS. */
let programClip: { text: string; m: string; at: number } | undefined;

/** The program's copy for the pane menu's Copy and ⌘C in machine m. */
export function programClipboard(m: string): string | undefined {
  const c = programClip;
  return c && c.m === m && Date.now() - c.at <= PROGRAM_CLIP_MS ? c.text : undefined;
}

export function forgetProgramClipboard() {
  programClip = undefined;
}

/** Says that the program's copy went on the clipboard (⌘C, menu Copy). */
export function programClipboardCopied(text: string) {
  showClipToast(t('surface.copied', { n: text.length, text: clipPreview(text) }), undefined, 2000);
}

export function sendInput(m: string, pane: string, ev: InputEvent[]) {
  if (!owner() || !ev.length) return;
  // Moves, drags, wheel turns and key releases are not new actions.
  if (ev.some((e) => (e.t === 'key' ? e.key.kind !== 2 : e.t !== 'mouse' || e.mouse.kind === 'down'))) {
    lastInput = Date.now();
    programClip = undefined;
  }
  conn.sendNow({ t: 'in', m, pane, ev });
}

export function sendFocus(m: string, focused: boolean) {
  if (owner()) conn.sendNow({ t: 'focus', m, focused });
}

export function takeOver() {
  conn.sendNow({ t: 'takeover' });
}

function decodeBase64(s: string): string {
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Handles the surface messages of the connection. */
export function handleSurfaceMessage(m: { t: string } & Record<string, any>) {
  switch (m.t) {
    case 'session':
      useSurface.setState({ ownership: m.state as Ownership });
      if (m.state !== 'owner') programClip = undefined;
      if (m.state === 'owner') {
        sendHost();
        sendView();
      }
      break;
    case 'surf':
      if (view && m.m !== view.m) break;
      useSurface.setState({ status: { m: m.m, gen: m.gen, ev: m.ev, code: m.code, detail: m.detail } });
      break;
    case 'surf.meta':
      if (view && m.m !== view.m) break;
      useSurface.setState({ meta: m as unknown as SurfaceMeta });
      break;
    case 'surf.tab':
      useSurface.setState({ shown: { m: m.m, tab: m.tab, ws: m.ws } });
      break;
    case 'clip':
      programCopied(m.m, decodeBase64(m.data));
      break;
    case 'bell':
      useSurface.setState((s) => ({ bell: s.bell + 1 }));
      break;
  }
}

let clipToast: number | undefined;

/** Shows a clipboard toast in place of the previous one: programs that copy
 * on every selection leave one toast, not a pile. */
function showClipToast(msg: string, action?: ToastAction, ttl?: number) {
  const prev = clipToast;
  if (prev !== undefined) useStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== prev) }));
  clipToast = useStore.getState().toast(msg, action, ttl);
}

function clipPreview(text: string): string {
  return (text.length > 60 ? `${text.slice(0, 60)}…` : text).replace(/\s+/g, ' ');
}

/** OSC 52 from a pane program of machine m (setting `programClipboard`).
 * Pane output is not trusted: with `auto` the text goes on the clipboard at
 * once only right after the user's input to a pane, when the program
 * answers the user (a selection in Claude Code, a yank in vim); otherwise,
 * or when the browser refuses the write, a toast shows the text and its Copy
 * button writes it (the click is also the gesture browsers want). Either
 * toast shows what the program copied. Only a copy that passed the gate is
 * kept for the pane menu (programClipboard). */
function programCopied(m: string, text: string) {
  const mode = usePrefs.getState().prefs.programClipboard;
  if (!text || mode === 'off') return;
  const preview = clipPreview(text);
  const ask = () =>
    showClipToast(t('surface.clipboard', { n: text.length, text: preview }), {
      label: t('surface.copy'),
      ttl: 5000,
      run: () => void navigator.clipboard?.writeText(text).catch(() => {}),
    });
  if (mode !== 'auto' || Date.now() - lastInput > CLIP_AUTO_MS) return ask();
  programClip = { text, m, at: Date.now() };
  if (!navigator.clipboard?.writeText) return ask();
  navigator.clipboard
    .writeText(text)
    .then(() => showClipToast(t('surface.copied', { n: text.length, text: preview }), undefined, 2000), ask);
}

export function handleSurfaceBinary(buf: ArrayBuffer) {
  const u = decodeUpdate(buf);
  if (!grid.apply(u)) return;
  if (u.full) useSurface.setState((s) => ({ fulls: s.fulls + 1 }));
  paint?.();
}

/** The connection dropped: the core decides ownership again on reconnect. */
export function surfaceDisconnected() {
  useSurface.setState({ ownership: 'pending', status: undefined });
}

/** Connects this module to the core connection. */
export function initSurface() {
  conn.setSurfaceHandler({ json: handleSurfaceMessage, binary: handleSurfaceBinary });
}
