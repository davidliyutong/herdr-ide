// The desktop app's zoom: the setting window.zoom (percent) is the one place
// it is kept, and the app's shell zooms its windows to it whenever it changes
// (desktop/src/main.ts), as it applies the theme. The commands (View › Zoom
// In, Zoom Out, Reset Zoom) step the setting through the levels browsers
// use. In a browser there is no shell: the commands do not run and the
// browser's own zoom keys work as ever.

import { resetSetting, setSetting, settingValue } from './settings';
import { desktopShell } from './shell';

export const ZOOM_KEY = 'window.zoom';

/** The zoom levels the commands step through, in percent (Chromium's). */
export const ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300] as const;

/** The next level above (1) or below (-1) a zoom; a zoom between levels goes
 * to the nearest one that way, and the ends stay where they are. */
export function zoomStep(current: number, dir: 1 | -1): number {
  const levels: readonly number[] = ZOOM_LEVELS;
  if (dir > 0) return levels.find((l) => l > current + 0.5) ?? Math.max(current, levels[levels.length - 1]);
  return [...levels].reverse().find((l) => l < current - 0.5) ?? Math.min(current, levels[0]);
}

/** The current zoom in percent. */
export function currentZoom(): number {
  const v = Number(settingValue(ZOOM_KEY));
  return Number.isFinite(v) && v > 0 ? v : 100;
}

/** Whether the zoom can change here: in the desktop app, on a page that may
 * change settings. */
export function zoomAvailable(readOnly: boolean): boolean {
  return !!desktopShell && !readOnly;
}

/** Zooms in (1), out (-1) or back to 100% (0). */
export function zoom(dir: 1 | -1 | 0) {
  if (!desktopShell) return;
  if (dir === 0) {
    if (currentZoom() !== 100) void resetSetting(ZOOM_KEY);
    return;
  }
  const next = zoomStep(currentZoom(), dir);
  if (next !== currentZoom()) void setSetting(ZOOM_KEY, next);
}
