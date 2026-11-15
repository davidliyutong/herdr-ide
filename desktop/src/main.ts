import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  session,
  shell,
  type BaseWindow,
  type IpcMainEvent,
} from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import registry from '../../design/generated/registry.json';
import tokens from '../../design/tokens.json';
import { APP_NAME, APP_SLUG } from '../../web/src/brand';
import { detectLocale, translate } from '../../web/src/i18n';
import type { MessageKey } from '../../web/src/i18n/en';
import type { OpenedFolders } from '../../web/src/shell';
import { channels } from './bridge';
import { CoreProcess, coreArgs, coreEnv, coreInstance, corePort, DesktopError, ENV_PREFIX } from './core';
import { FolderQueue } from './folders';
import { followCore, type ShellSettings } from './follow';
import { menuCommands, menuTemplate, parseDisabled, type Binding } from './menu';
import { APP_ID, coreBinary, foldersOf, keyPlatform, quitsWithLastWindow, type Platform } from './platform';
import { allowPermission, isExternal, isInternal, mainWindowPreferences, webPreferences } from './policy';
import { bundleOf, privacyActions, terminalCoreExecutable } from './privacy';

const platform = process.platform as Platform;
app.setName(APP_NAME);
// Windows shows the notifications of an app under its AppUserModelID, the
// one its installer gives the Start menu shortcut.
if (platform === 'win32') app.setAppUserModelId(APP_ID);
app.enableSandbox();
const devValue = process.env[`${ENV_PREFIX}DESKTOP_DEV`];
const dev = !app.isPackaged || !!devValue;
// The core's instance; a name refused is reported once the app is ready.
let instance: string | DesktopError;
try {
  instance = coreInstance(dev, devValue);
} catch (error) {
  instance = error as DesktopError;
}
// Each instance has its own profile and single-instance lock (`dev`'s ends
// in -dev); an explicit --user-data-dir (isolated smoke tests) takes the
// place of both.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const suffix = typeof instance === 'string' && instance !== 'desktop' ? `-${instance}` : dev ? '-dev' : '';
  app.setPath('userData', join(app.getPath('appData'), `${APP_SLUG}-desktop${suffix}`));
}
// The arguments before the ones the user gave: the executable, and the
// app's directory when Electron runs it unpackaged.
const leadingArgs = process.defaultApp ? 2 : 1;

const core = new CoreProcess();
let mainWindow: BrowserWindow | undefined;
let origin = '';
let quitting = false;
let stopped = false;
let systemShutdown = false;
let reportingError = false;
let stopFollowing = () => {};
// The keybindings of this platform: its defaults until the core's are read.
const keys = keyPlatform(platform);
let bindings = registry.keybindings[keys] as Binding[];
// appearance.language: "auto" follows the system's languages.
let language = 'auto';
// window.zoom as a factor: the main window's zoom, which Chromium keeps per
// origin, so the app's other windows (program windows, VS Code's own) share
// it. The setting is the only place it is kept.
let zoomFactor = 1;
// The commands whose menu items are disabled, as the page last said.
let disabled = new Set<string>();
// Folders opened with the app, until the page takes them.
const folders = new FolderQueue();

function t(key: MessageKey, vars?: Record<string, string>): string {
  return translate(detectLocale(language === 'auto' ? null : language, app.getPreferredSystemLanguages()), key, vars);
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
  stopFollowing();
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

/** Brings the main window forward; on macOS, where closing it leaves the app
 * running, opens it again. */
function showMain() {
  if (!mainWindow) {
    if (origin && !quitting) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** A command of the menu, for the main window's page. In another window (a
 * program's, VS Code's own) closing a pane or a tab closes that window. */
function runCommand(command: string, focused: BaseWindow | undefined) {
  if (focused && focused !== mainWindow && (command === 'pane.close' || command === 'tab.close')) {
    focused.close();
    return;
  }
  if (!mainWindow) return showMain();
  if (!mainWindow.isFocused()) showMain();
  mainWindow.webContents.send(channels.command, command);
}

function buildMenu() {
  const template = menuTemplate(bindings, APP_NAME, t, (command) => (_item, focused) => runCommand(command, focused), platform, disabled);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Disables the menu items of the commands the page says cannot run now. */
function applyDisabled(next: Set<string>) {
  disabled = next;
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const id of menuCommands()) {
    const item = menu.getMenuItemById(id);
    if (item) item.enabled = !disabled.has(id);
  }
}

/** Zooms the main window's page to the zoom setting. */
function applyZoom() {
  const contents = mainWindow?.webContents;
  if (contents && !contents.isDestroyed() && contents.getZoomFactor() !== zoomFactor) contents.setZoomFactor(zoomFactor);
}

// The core's settings and keybindings: the theme becomes the title bar's and
// native controls' (also when it differs from the system's appearance), the
// language the menu's, the zoom the windows'.
function applySettings(s: ShellSettings) {
  nativeTheme.themeSource = s.theme;
  zoomFactor = s.zoom;
  applyZoom();
  if (s.language === language) return;
  language = s.language;
  buildMenu();
}

function applyBindings(b: Binding[]) {
  bindings = b;
  buildMenu();
}

// Messages count only from the top frame of the main window showing the core.
function fromMainPage(event: IpcMainEvent): boolean {
  const frame = event.senderFrame;
  return (
    !!mainWindow && !!frame && event.sender === mainWindow.webContents && frame === event.sender.mainFrame && isInternal(frame.url, origin)
  );
}

ipcMain.on(channels.menuState, (event, value: unknown) => {
  if (!fromMainPage(event)) return;
  const next = parseDisabled(value);
  if (next) applyDisabled(next);
});

ipcMain.on(channels.foldersWanted, (event, wanted: unknown) => {
  if (!fromMainPage(event)) return;
  const contents = event.sender;
  folders.takenBy(wanted === true ? (opened) => contents.send(channels.openFolders, opened) : undefined);
});

// Full Disk Access (macOS): the page asks; what opens is the shell's own.
const privacy = privacyActions(
  {
    platform,
    executable: terminalCoreExecutable(app.getPath('home'), typeof instance === 'string' ? instance : ''),
    bundle: app.isPackaged ? bundleOf(process.execPath) : '',
    pid: process.pid,
    dev,
    log: dev && process.env[`${ENV_PREFIX}DESKTOP_NO_OPEN`] ? (line) => process.stderr.write(`no-open: ${line}\n`) : undefined,
  },
  {
    openExternal: (url) => void shell.openExternal(url).catch(console.error),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    exists: (path) => existsSync(path),
    spawnDetached: (file, args) => spawn(file, args, { detached: true, stdio: 'ignore' }).unref(),
    relaunch: () => app.relaunch(),
    quit: () => app.quit(),
  },
);
ipcMain.on(channels.openFullDiskAccess, (event) => {
  if (fromMainPage(event)) privacy.openFullDiskAccess();
});
ipcMain.on(channels.revealTerminalCore, (event) => {
  if (fromMainPage(event)) privacy.revealTerminalCore();
});
ipcMain.on(channels.relaunch, (event) => {
  if (fromMainPage(event)) privacy.relaunch();
});

/** The page's background (color.background in design/tokens.json), shown before it paints. */
function windowBackground(): string {
  return tokens.color.background[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
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
    // Linux takes the window's icon from the window (macOS and Windows from
    // the application).
    ...(platform === 'linux' && { icon: join(app.getAppPath(), 'assets', 'icon.png') }),
    webPreferences: { ...mainWindowPreferences, preload: join(__dirname, 'preload.cjs') },
  });
  mainWindow = win;
  const onTheme = () => win.setBackgroundColor(windowBackground());
  nativeTheme.on('updated', onTheme);
  // Folders opened from now on wait for the next page, which asks for them;
  // this runs before that page can.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) folders.takenBy(undefined);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    folders.takenBy(undefined);
    if (!quitting) void fail(new DesktopError('desktop.rendererGone', details.reason));
  });
  // Windows ends a session (log off, restart, shut down) with this.
  win.on('session-end', () => {
    systemShutdown = true;
  });
  // Each page loaded (also after a reload) gets the zoom.
  win.webContents.on('did-finish-load', applyZoom);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    nativeTheme.off('updated', onTheme);
    folders.takenBy(undefined);
    mainWindow = undefined;
    // Program windows do not keep the app open.
    if (quitsWithLastWindow(platform)) app.quit();
  });
  void win.loadURL(origin).catch(fail);
}

app.on('before-quit', (event) => {
  quitting = true;
  stopFollowing();
  if (stopped) return;
  if (systemShutdown) {
    // Delaying a logout, restart or shutdown would cancel it. Stop the core
    // and let it clean up on its own.
    void core.stop();
    return;
  }
  event.preventDefault();
  void core.stop().then(() => {
    stopped = true;
    app.quit();
  });
});
// On macOS the app stays in the Dock when its windows close, as Mac apps do;
// elsewhere closing the main window quits (its 'closed' handler).
app.on('window-all-closed', () => {
  if (quitsWithLastWindow(platform)) app.quit();
});
app.on('activate', showMain);

/** Opened folders go to the page together, with the number of items that
 * are not folders, which the page skips with a note. */
function openFolders(opened: OpenedFolders) {
  if (opened.folders.length || opened.skipped) folders.add(opened);
  showMain();
}

// A second launch brings the window forward; on Linux it may name folders
// (a file manager's Open With), as the first launch's command line may.
// Windows opens none: no agent runs on its local machine.
app.on('second-instance', (_event, argv, cwd) => {
  if (platform === 'linux') openFolders(foldersOf(argv, leadingArgs, cwd));
  else showMain();
});
if (platform === 'linux') {
  const first = foldersOf(process.argv, leadingArgs, process.cwd());
  if (first.folders.length || first.skipped) folders.add(first);
}

// macOS: folders dropped on the Dock icon or opened with the app, also those
// it was launched with (before ready). macOS reports each item of one
// request in a row; `open -a` passes any file.
let opening: OpenedFolders | undefined;
app.on('open-file', (event, path) => {
  event.preventDefault();
  if (!opening) {
    const batch: OpenedFolders = (opening = { folders: [], skipped: 0 });
    setImmediate(() => {
      opening = undefined;
      openFolders(batch);
    });
  }
  let folder = false;
  try {
    folder = statSync(path).isDirectory();
  } catch {}
  if (folder) opening.folders.push(path);
  else opening.skipped++;
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
      if (typeof instance !== 'string') throw instance;
      // Linux and macOS report a logout, restart or shutdown here.
      powerMonitor.on('shutdown', () => {
        systemShutdown = true;
      });
      if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'assets', 'icon.png'));
      // Windows and Linux show these in About (macOS reads its bundle).
      app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });
      buildMenu();
      const port = corePort(process.env[`${ENV_PREFIX}DESKTOP_PORT`] || (dev ? '7791' : '7781'));
      const binary = coreBinary(platform, process.arch, app.isPackaged ? process.resourcesPath : undefined, join(app.getAppPath(), '..'));
      origin = await core.start(
        binary,
        coreArgs(instance, port),
        port,
        coreEnv(process.env, app.getPath('home'), platform),
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
      stopFollowing = followCore(origin, keys, { bindings: applyBindings, settings: applySettings });
      createWindow();
    })
    .catch(fail);
}
