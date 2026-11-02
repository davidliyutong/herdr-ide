import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, session, shell, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { APP_NAME, APP_SLUG } from '../../web/src/brand';
import { en, type MessageKey } from '../../web/src/i18n/en';
import { zhCN } from '../../web/src/i18n/zh-CN';
import { CoreProcess, coreArgs, coreEnv, corePort, DesktopError, ENV_PREFIX } from './core';
import { channels } from './bridge';
import { allowPermission, isExternal, isInternal, mainWindowPreferences, themeSource, webPreferences } from './policy';
import {
  defaultShortcuts,
  isCodeFrame,
  recordedSpec,
  shortcutFor,
  shortcutsFromSettings,
  toAccelerator,
  type ShortcutAction,
  type Shortcuts,
} from './shortcuts';

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
// The platform's defaults until the core's settings are read, so a key never
// falls through to closing the window while they load.
let shortcuts: Shortcuts = defaultShortcuts(process.platform);
// The settings dialog is recording a key: the shell reports keys to it
// instead of running shortcuts.
let recording = false;
// The last key-down matched a shortcut but was left to VS Code, which has
// focus; if VS Code does not take it, the menu must not act on it either.
let leftToCode = false;

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

function runShortcut(action: ShortcutAction) {
  const win = mainWindow;
  if (!win) return;
  if (!win.isFocused()) win.focus();
  win.webContents.send(channels.shortcut, action);
}

// The menu shows the shortcuts; before-input-event runs them, so the menu does
// not register them (it would also catch keys meant for program windows).
// Window → Close closes program windows with cmd+w; the main window only when
// cmd+w is not a shortcut left to VS Code (closing it quits the app).
function buildMenu() {
  const item = (action: ShortcutAction, label: MessageKey) => ({
    label: t(label),
    accelerator: toAccelerator(shortcuts[action]),
    registerAccelerator: false,
    click: () => runShortcut(action),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: t('desktop.menu.tab'), submenu: [item('new_tab', 'desktop.menu.newTab'), item('close_tab', 'desktop.menu.closeTab')] },
      { role: 'viewMenu' },
      {
        role: 'window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          {
            label: t('desktop.menu.closeWindow'),
            accelerator: 'CommandOrControl+W',
            click: (_item, win, ev) => {
              if (win === mainWindow && ev.triggeredByAccelerator && leftToCode) return;
              win?.close();
            },
          },
          { type: 'separator' },
          { role: 'front' },
        ],
      },
    ]),
  );
}

// Shortcuts are core settings; the page reports changes, the shell reads them
// from the core itself. A failed read keeps the current ones and is retried.
async function loadShortcuts(attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(new URL('/api/settings', origin));
      if (!r.ok) throw new Error(`/api/settings: ${r.status}`);
      shortcuts = shortcutsFromSettings(await r.json());
      break;
    } catch (error) {
      console.error(error);
      if (i >= attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * i));
    }
  }
  buildMenu();
}

/** Whether keyboard focus is in a VS Code frame of win (or a webview inside
 * it): its keys, cmd+w closing an editor included, belong to VS Code. */
function focusInCode(win: BrowserWindow): boolean {
  let frame = win.webContents.focusedFrame;
  if (!frame?.parent) return false;
  while (frame.parent?.parent) frame = frame.parent;
  return isCodeFrame(frame.url, origin);
}

// Messages count only from the top frame of the main window showing the core.
function fromMainPage(event: IpcMainEvent): boolean {
  const frame = event.senderFrame;
  return (
    !!mainWindow && !!frame && event.sender === mainWindow.webContents && frame === event.sender.mainFrame && isInternal(frame.url, origin)
  );
}

ipcMain.on(channels.shortcutsChanged, (event) => {
  if (fromMainPage(event)) void loadShortcuts();
});
ipcMain.on(channels.recording, (event, active: unknown) => {
  if (fromMainPage(event)) recording = active === true;
});
// The title bar, native controls and the windows' background follow the
// page's theme setting, also when it differs from the system's appearance.
ipcMain.on(channels.theme, (event, value: unknown) => {
  const source = themeSource(value);
  if (fromMainPage(event) && source) nativeTheme.themeSource = source;
});

/** The page's background (--bg in web/src/styles.css), shown before it paints. */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0e1116' : '#ffffff';
}

function createWindow() {
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: windowBackground(),
    webPreferences: { ...mainWindowPreferences, preload: join(__dirname, 'preload.cjs') },
  });
  mainWindow = win;
  const onTheme = () => win.setBackgroundColor(windowBackground());
  nativeTheme.on('updated', onTheme);
  win.on('closed', () => nativeTheme.off('updated', onTheme));
  // Before the page and every frame in it, and before the menu.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    leftToCode = false;
    if (recording) {
      // Taken here, so the menu (cmd+w, cmd+q) never acts on a recorded key.
      const spec = recordedSpec(input);
      if (!spec) return;
      event.preventDefault();
      if (!input.isAutoRepeat) win.webContents.send(channels.recorded, spec);
      return;
    }
    const action = shortcutFor(shortcuts, input);
    if (!action) return;
    if (focusInCode(win)) {
      leftToCode = true;
      return;
    }
    event.preventDefault();
    if (!input.isAutoRepeat) runShortcut(action);
  });
  const stopRecording = () => {
    recording = false;
  };
  win.webContents.on('did-navigate', stopRecording);
  win.webContents.on('render-process-gone', stopRecording);
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
      buildMenu();
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
      await loadShortcuts();
    })
    .catch(fail);
}
