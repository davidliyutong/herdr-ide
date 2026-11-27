// Validation, URL construction and screen-bounds clamping for standalone
// detached tab windows (secondary BrowserWindows showing a single tab's core
// panes without sidebars).

import type { OpenTabWindowOptions } from '../../web/src/shell';

/** Maximum number of concurrent detached tab windows. */
export const MAX_DETACHED_WINDOWS = 16;

export const DETACHED_MIN_WIDTH = 420;
export const DETACHED_MIN_HEIGHT = 300;
export const DETACHED_DEFAULT_WIDTH = 1040;
export const DETACHED_DEFAULT_HEIGHT = 720;

const SAFE_ID = /^[A-Za-z0-9._:@/-]{1,128}$/;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Validates an open-tab-window request from the renderer; rejects malformed
 * ids and clamps dimensions. */
export function parseOpenTabRequest(v: unknown): OpenTabWindowOptions | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.m !== 'string' || !SAFE_ID.test(o.m)) return undefined;
  if (typeof o.pane !== 'string' || !SAFE_ID.test(o.pane)) return undefined;
  const out: OpenTabWindowOptions = { m: o.m, pane: o.pane };
  if (typeof o.x === 'number' && Number.isFinite(o.x)) out.x = Math.round(o.x);
  if (typeof o.y === 'number' && Number.isFinite(o.y)) out.y = Math.round(o.y);
  if (typeof o.width === 'number' && Number.isFinite(o.width)) {
    out.width = Math.round(Math.min(3840, Math.max(DETACHED_MIN_WIDTH, o.width)));
  }
  if (typeof o.height === 'number' && Number.isFinite(o.height)) {
    out.height = Math.round(Math.min(2160, Math.max(DETACHED_MIN_HEIGHT, o.height)));
  }
  if (typeof o.title === 'string' && o.title.trim()) {
    out.title = o.title.trim().slice(0, 200);
  }
  return out;
}

/** Builds the app-origin URL for a detached tab window (never takes a URL from the page). */
export function detachedWindowUrl(origin: string, m: string, pane: string): string {
  return `${origin}/window/tab?m=${encodeURIComponent(m)}&pane=${encodeURIComponent(pane)}`;
}

/** Clamps requested window bounds onto a display workArea so the titlebar and
 * body are always reachable on screen. */
export function clampWindowBounds(req: Pick<OpenTabWindowOptions, 'x' | 'y' | 'width' | 'height'>, workArea: Rect): Rect {
  const width = Math.min(workArea.width, Math.max(DETACHED_MIN_WIDTH, req.width ?? DETACHED_DEFAULT_WIDTH));
  const height = Math.min(workArea.height, Math.max(DETACHED_MIN_HEIGHT, req.height ?? DETACHED_DEFAULT_HEIGHT));
  const defaultX = workArea.x + Math.round((workArea.width - width) / 2);
  const defaultY = workArea.y + Math.round((workArea.height - height) / 2);
  const maxX = workArea.x + Math.max(0, workArea.width - width);
  const maxY = workArea.y + Math.max(0, workArea.height - height);
  const x = req.x !== undefined ? Math.min(maxX, Math.max(workArea.x, req.x)) : defaultX;
  const y = req.y !== undefined ? Math.min(maxY, Math.max(workArea.y, req.y)) : defaultY;
  return { x, y, width, height };
}

/** True when screen point (px, py) lies inside rect. */
export function pointInBounds(px: number, py: number, rect: Rect): boolean {
  return px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height;
}
