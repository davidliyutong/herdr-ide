// Only the owned core may be shown in native windows. External HTTP(S) links
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

// Clipboard reads match what the browser UI grants VS Code's frame
// (allow="clipboard-read" in web/src/components/Dock.tsx), where a browser
// asks once; the desktop app has no prompt, so it grants them to the core.
// fileSystem is the File System Access API: VS Code's Download… saves
// folders and files over 32 MB into a folder the user picks in the native
// dialog, which is the consent (Electron keeps system folders out).
export function allowPermission(permission: string, requestingURL: string, topURL: string, origin: string): boolean {
  return (
    isInternal(requestingURL, origin) &&
    isInternal(topURL, origin) &&
    ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fileSystem'].includes(permission)
  );
}

/** The page's theme setting as Electron's nativeTheme.themeSource; anything
 * else is ignored. */
export function themeSource(value: unknown): 'system' | 'light' | 'dark' | undefined {
  return value === 'system' || value === 'light' || value === 'dark' ? value : undefined;
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

// The main window may play notification sounds before the first click
// (after a restart, for example); other windows keep the default policy.
export const mainWindowPreferences = { ...webPreferences, autoplayPolicy: 'no-user-gesture-required' as const };
