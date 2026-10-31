import { app, BrowserWindow, dialog, Menu, powerMonitor, session, shell } from 'electron';
import { join } from 'node:path';
import { APP_NAME, APP_SLUG } from '../../web/src/brand';
import { en, type MessageKey } from '../../web/src/i18n/en';
import { zhCN } from '../../web/src/i18n/zh-CN';
import { CoreProcess, coreArgs, coreEnv, corePort, DesktopError, ENV_PREFIX } from './core';
import { allowPermission, isExternal, isInternal, webPreferences } from './policy';

app.setName(APP_NAME);
app.enableSandbox();
const dev = !app.isPackaged || process.env[`${ENV_PREFIX}DESKTOP_DEV`] === '1';
app.setPath('userData', join(app.getPath('appData'), `${APP_SLUG}-desktop${dev ? '-dev' : ''}`));

const core = new CoreProcess();
let mainWindow: BrowserWindow | undefined;
let origin = '';
let quitting = false;
let stopped = false;
let systemShutdown = false;
let reportingError = false;

function t(key: MessageKey): string {
  return (app.getLocale().toLowerCase().startsWith('zh') ? zhCN : en)[key];
}

function describe(error: unknown): string {
  if (error instanceof DesktopError) return t(error.key) + (error.detail ? ` (${error.detail})` : '');
  return String(error);
}

async function fail(error: unknown) {
  if (reportingError || quitting) return;
  reportingError = true;
  console.error(error);
  // Stop before showing a modal dialog, including after a startup timeout.
  await core.stop();
  if (quitting) return;
  await dialog.showMessageBox({
    type: 'error',
    title: APP_NAME,
    message: t('desktop.failed'),
    detail: `${t('desktop.failureHelp')}\n\n${describe(error)}\n${core.diagnostics}`,
    buttons: [t('desktop.quit')],
  });
  app.quit();
}

function openExternal(url: string) {
  if (isExternal(url)) void shell.openExternal(url).catch(console.error);
}

// Install on every window, including program windows and standalone VS Code.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, url) => {
    if (!isInternal(url, origin)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame && !isInternal(url, origin)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url, origin)) {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { ...webPreferences } } };
    }
    openExternal(url);
    return { action: 'deny' };
  });
});

function createWindow() {
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: '#18181b',
    webPreferences: { ...webPreferences },
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = undefined;
    app.quit();
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting) void fail(new DesktopError('desktop.rendererGone', details.reason));
  });
  void win.loadURL(origin).catch(fail);
}

app.on('before-quit', (event) => {
  quitting = true;
  if (stopped) return;
  if (systemShutdown) {
    // Delaying a logout, restart or shutdown would cancel it. Signal the core
    // and let it clean up on its own; the closed stdin pipe stops it as well.
    void core.stop();
    return;
  }
  event.preventDefault();
  void core.stop().then(() => {
    stopped = true;
    app.quit();
  });
});
// Closing the main window quits (its 'closed' handler); program windows do not.
app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
});
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(async () => {
      if (quitting) return;
      powerMonitor.on('shutdown', () => {
        systemShutdown = true;
      });
      if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'assets', 'icon.png'));
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]),
      );
      const port = corePort(process.env[`${ENV_PREFIX}DESKTOP_PORT`] || (dev ? '7791' : '7781'));
      const goArch = process.arch === 'x64' ? 'amd64' : process.arch;
      const binary = app.isPackaged
        ? join(process.resourcesPath, 'bin', APP_SLUG)
        : join(app.getAppPath(), '..', 'dist', `${APP_SLUG}-darwin-${goArch}`);
      origin = await core.start(
        binary,
        coreArgs(dev, port),
        port,
        coreEnv(process.env, app.getPath('home')),
        app.getPath('home'),
        () => void fail(new DesktopError('desktop.coreLost')),
      );
      if (quitting) return;
      const ses = session.defaultSession;
      ses.setPermissionRequestHandler((contents, permission, callback, details) => {
        callback(allowPermission(permission, details.requestingUrl, contents.getURL(), origin));
      });
      ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
        return allowPermission(permission, requestingOrigin, contents?.getURL() || '', origin);
      });
      createWindow();
    })
    .catch(fail);
}
