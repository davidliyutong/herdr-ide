// The browser side of the core's surface stream (internal/server/surface.go).
//
// One browser at a time owns the core's session, like a KVM console: it
// chooses the machine, tab and size herdr renders, and its input reaches the
// panes. This module keeps the ownership state, the shown surface's grid and
// metadata, and sends the view, input, focus and host colors.

import { create } from 'zustand';
import { conn } from '../lib/conn';
import { useStore } from '../state/store';
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

export function sendInput(m: string, pane: string, ev: InputEvent[]) {
  if (owner() && ev.length) conn.sendNow({ t: 'in', m, pane, ev });
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
    case 'clip': {
      // OSC 52 from a pane program: pane output is not trusted, so the user
      // confirms before it replaces the clipboard (the click is also the
      // gesture browsers want).
      const text = decodeBase64(m.data);
      if (!text) break;
      const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      useStore.getState().toast(t('surface.clipboard', { n: text.length, text: preview.replace(/\s+/g, ' ') }), {
        label: t('surface.copy'),
        ttl: 5000,
        run: () => void navigator.clipboard?.writeText(text).catch(() => {}),
      });
      break;
    }
    case 'bell':
      useSurface.setState((s) => ({ bell: s.bell + 1 }));
      break;
  }
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
