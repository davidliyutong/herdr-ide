import type { ConfigureHostResolverOptions, WebPreferences } from 'electron';

// Only the owned hub may be shown in native windows. External HTTP(S) links
// leave the app; file:, javascript:, custom schemes and credential URLs do not.
export function isInternal(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function isExternal(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

// Clipboard reads match what the browser UI grants VS Code panes' frames
// (allow="clipboard-read" in web/src/components/CodeLayer.tsx), where a browser
// asks once; the desktop app has no prompt, so it grants them to the hub.
// fileSystem is the File System Access API: VS Code's Download… saves
// folders and files over 32 MB into a folder the user picks in the native
// dialog, which is the consent (Electron keeps system folders out).
// local-fonts lets the settings list the fonts installed on the computer
// (names and font files, read-only) for the terminal font picker, as a
// browser does after asking.
export function allowPermission(permission: string, requestingURL: string, topURL: string, origin: string): boolean {
  return (
    isInternal(requestingURL, origin) &&
    isInternal(topURL, origin) &&
    ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fileSystem', 'local-fonts'].includes(permission)
  );
}

export const webPreferences = {
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  allowRunningInsecureContent: false,
};

/** The session partition of the app's own windows, where the app's origin
 * is intercepted (protocol.ts); the browser panes' guests have theirs. */
export const APP_PARTITION = 'persist:app';

/** A window of the app: its session, and its preload in each of its frames
 * (nodeIntegrationInSubFrames runs the preload in subframes; with the
 * sandbox it gives them no Node), which gives the frames of the app's
 * origin their channels to the hub (frames.ts), VS Code's frames
 * included. */
export function appWindowPreferences(preload: string) {
  return { ...webPreferences, nodeIntegrationInSubFrames: true, partition: APP_PARTITION, preload };
}

// The main window may play notification sounds before the first click
// (after a restart, for example); other windows keep the default policy.
// It alone may hold <webview> tags: the browser panes show any web page in
// them (guestPreferences decides each attach).
export function mainWindowPreferences(preload: string) {
  return { ...appWindowPreferences(preload), autoplayPolicy: 'no-user-gesture-required' as const, webviewTag: true };
}

/** The session partition of the browser panes' webviews; its cookies,
 * storage and permissions are apart from the app's own. */
export const BROWSER_PARTITION = 'persist:browser';

/** How the app resolves host names (app.configureHostResolver, once ready;
 * every session, the browser panes' guests among them): with the system's
 * resolver (getaddrinfo), as the system's browser and other programs do.
 * Electron's default on macOS is Chromium's built-in resolver, which reads
 * the system's DNS servers and asks them itself, so a name the system
 * resolves another way (a VPN's or a company's DNS for some domains, a
 * tool that takes over the system's DNS) may not resolve in a pane. It is
 * Electron's default on Windows and Linux. DNS over HTTPS keeps its default. */
export const hostResolver: ConfigureHostResolverOptions = { enableBuiltInResolver: false };

/** Whether url names the app's own host (origin's), under any scheme and
 * port; an origin that does not read counts as the app's, so that nothing
 * is taken for another page by mistake. A guest's session does not
 * intercept the app's origin, so such an address never reaches the hub:
 * a page there would be another program's passing for the app. */
function leadsToHub(url: string, origin: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === new URL(origin).hostname.toLowerCase();
  } catch {
    return true;
  }
}

/** Addresses a webview may load or follow: http(s) without credentials,
 * and never the app's own host (origin's), which is no page for a pane: a
 * page shown in one must not put the UI there or open it as a tab. */
export function guestMayNavigate(url: string, origin: string): boolean {
  return isExternal(url) && !leadsToHub(url, origin);
}

/** Decides a webview's attach (will-attach-webview): false cancels it. An
 * attach is allowed only for the browser partition and an http(s) address
 * that is not the hub's (origin); the guest's preferences are then
 * rewritten in place, whatever the page asked for, so that it is an
 * ordinary sandboxed web page with no preload and no Node. */
export function guestPreferences(prefs: WebPreferences, params: Record<string, string>, origin: string): boolean {
  if (params.partition !== BROWSER_PARTITION || !guestMayNavigate(params.src ?? '', origin)) return false;
  const loose = prefs as WebPreferences & { preloadURL?: string };
  delete loose.preload;
  delete loose.preloadURL;
  Object.assign(prefs, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    plugins: false,
    experimentalFeatures: false,
    partition: BROWSER_PARTITION,
  });
  return true;
}

// A page's scripts open windows without the user (Electron has no popup
// blocker) and each popup becomes a tab with a page of its own, so a guest
// opens at most POPUP_LIMIT of them within POPUP_WINDOW_MS.
export const POPUP_LIMIT = 3;
export const POPUP_WINDOW_MS = 10_000;

/** One guest's gate for popups: the function says whether one more may
 * open now, and counts it. */
export function popupGate(now: () => number = Date.now): () => boolean {
  let opened: number[] = [];
  return () => {
    const at = now();
    opened = opened.filter((t) => at - t < POPUP_WINDOW_MS);
    if (opened.length >= POPUP_LIMIT) return false;
    opened.push(at);
    return true;
  };
}

// A page shown in a pane is any web page, not the app: camera, microphone,
// location, notifications, clipboard reads and the rest would be granted to
// it without a prompt, since the app has none, so nothing is granted but a
// video going full screen.
export function allowGuestPermission(permission: string): boolean {
  return permission === 'fullscreen';
}
