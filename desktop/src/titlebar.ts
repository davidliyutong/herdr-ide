// Integrated window title bar geometry on macOS: the native title bar is
// hidden and the traffic lights sit in the top-left of the UI's header row
// (sidebar head, or the tab bar when the sidebar is closed). Everything is
// expressed in unzoomed window points so the main process and the page agree
// across UI font sizes and window zoom levels. Kept without Node imports so
// the sandboxed preload can read the same constants.

import tokens from '../../spec/tokens.json';

/** Minimum header height in window points while the integrated title bar is shown. */
export const MAC_TITLEBAR_MIN_HEIGHT = 44;

/** Extra top breathing room in window points so header controls and tabs do
 * not hug the top edge of the window. */
export const MAC_TITLEBAR_TOP_SPACE = 4;

/** Horizontal clearance in window points on the left of the header for the
 * traffic lights (left edge + three buttons + breathing gap). */
export const MAC_TITLEBAR_INSET = 84;

/** macOS traffic light button diameter and left inset in window points. */
const TRAFFIC_LIGHT_SIZE = 12;
const TRAFFIC_LIGHT_X = 16;

const HEADER_REM = tokens.size.header / tokens.font.root;

/** Where macOS places the traffic lights so they stay vertically aligned with
 * the header row's controls at any UI font size and window zoom factor. */
export function macTrafficLightPosition(uiFontSize = tokens.font.root, zoom = 1): { x: number; y: number } {
  const headerPts = Math.max(Math.round(uiFontSize * HEADER_REM * zoom) + MAC_TITLEBAR_TOP_SPACE, MAC_TITLEBAR_MIN_HEIGHT);
  return { x: TRAFFIC_LIGHT_X, y: Math.round((headerPts + MAC_TITLEBAR_TOP_SPACE - TRAFFIC_LIGHT_SIZE) / 2) };
}

/** BrowserWindow frame options per platform. macOS hides the separate title
 * bar and embeds the traffic lights into the UI's top header row; Windows and
 * Linux keep their native frames (which hold their in-window menu bars). */
export function windowFrameOptions(
  platform: string,
  uiFontSize = tokens.font.root,
  zoom = 1,
): { titleBarStyle?: 'hidden'; trafficLightPosition?: { x: number; y: number } } {
  if (platform !== 'darwin') return {};
  return {
    titleBarStyle: 'hidden',
    trafficLightPosition: macTrafficLightPosition(uiFontSize, zoom),
  };
}
