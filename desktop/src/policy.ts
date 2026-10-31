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

export function allowPermission(permission: string, requestingURL: string, topURL: string, origin: string): boolean {
  return (
    isInternal(requestingURL, origin) && isInternal(topURL, origin) && ['notifications', 'clipboard-sanitized-write'].includes(permission)
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
