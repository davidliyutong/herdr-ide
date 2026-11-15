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
import { statSync } from 'node:fs';
import { join } from 'node:path';
import registry from '../../design/generated/registry.json';
import tokens from '../../design/tokens.json';
import { APP_NAME, APP_SLUG } from '../../web/src/brand';
import { detectLocale, translate } from '../../web/src/i18n';
import type { MessageKey } from '../../web/src/i18n/en';
import type { OpenedFolders } from '../../web/src/shell';
import { channels } from './bridge';
import { CoreProcess, coreArgs, coreEnv, corePort, DesktopError, ENV_PREFIX } from './core';
import { FolderQueue } from './folders';
import { followCore, type ShellSettings } from './follow';
import { menuTemplate, type Binding } from './menu';
import { allowPermission, isExternal, isInternal, mainWindowPreferences, webPreferences } from './policy';

app.setName(APP_NAME);
app.enableSandbox();
const dev = !app.isPackaged || process.env[`${ENV_PREFIX}DESKTOP_DEV`] === '1';
// Each mode has its own profile and single-instance lock; an explicit
// --user-data-dir (isolated smoke tests) takes the place of both.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), `${APP_SLUG}-desktop${dev ? '-dev' : ''}`));
}

const core = new CoreProcess();
let mainWindow: BrowserWindow | undefined;
let origin = '';
let quitting = false;
let stopped = false;
let systemShutdown = false;
let reportingError = false;
let stopFollowing = () => {};
// The keybindings of this platform: its defaults until the core's are read.
const platform = process.platform === 'darwin' ? 'mac' : 'pc';
let bindings = registry.keybindings[platform] as Binding[];
// appearance.language: "auto" follows the system's languages.
let language = 'auto';
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

function showMain() {
  if (!mainWindow) return;
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
  if (!mainWindow) return;
  if (!mainWindow.isFocused()) showMain();
  mainWindow.webContents.send(channels.command, command);
}

function buildMenu() {
  const template = menuTemplate(bindings, APP_NAME, t, (command) => (_item, focused) => runCommand(command, focused));
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The core's settings and keybindings: the theme becomes the title bar's and
// native controls' (also when it differs from the system's appearance), the
// language the menu's.
function applySettings(s: ShellSettings) {
  nativeTheme.themeSource = s.theme;
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

ipcMain.on(channels.foldersWanted, (event, wanted: unknown) => {
  if (!fromMainPage(event)) return;
  const contents = event.sender;
  folders.takenBy(wanted === true ? (opened) => contents.send(channels.openFolders, opened) : undefined);
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
    webPreferences: { ...mainWindowPreferences, preload: join(__dirname, 'preload.cjs') },
  });
  mainWindow = win;
  const onTheme = () => win.setBackgroundColor(windowBackground());
  nativeTheme.on('updated', onTheme);
  win.on('closed', () => nativeTheme.off('updated', onTheme));
  // Folders opened from now on wait for the next page, which asks for them;
  // this runs before that page can.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) folders.takenBy(undefined);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    folders.takenBy(undefined);
    if (!quitting) void fail(new DesktopError('desktop.rendererGone', details.reason));
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = undefined;
    app.quit();
  });
  void win.loadURL(origin).catch(fail);
}

app.on('before-quit', (event) => {
  quitting = true;
  stopFollowing();
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
app.on('second-instance', showMain);
app.on('activate', showMain);

// Folders dropped on the Dock icon or opened with the app, also those it was
// launched with (before ready). macOS reports each item of one request in a
// row; they go to the page together, with the number of items that are not
// folders (`open -a` passes any file), which the page skips with a note.
let opening: OpenedFolders | undefined;
app.on('open-file', (event, path) => {
  event.preventDefault();
  if (!opening) {
    const batch: OpenedFolders = (opening = { folders: [], skipped: 0 });
    setImmediate(() => {
      opening = undefined;
      folders.add(batch);
      showMain();
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
      stopFollowing = followCore(origin, platform, { bindings: applyBindings, settings: applySettings });
      createWindow();
    })
    .catch(fail);
}
