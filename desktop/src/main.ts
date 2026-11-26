import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeTheme,
  Notification,
  powerMonitor,
  safeStorage,
  session,
  shell,
  systemPreferences,
  type BaseWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { electronPort, refuseChannel, type ElectronPort } from '../../backend/hosts/desktop/bridge';
import registry from '../../spec/generated/registry.json';
import tokens from '../../spec/tokens.json';
import { APP_NAME, APP_SLUG } from '../../web/src/brand';
import { detectLocale, translate } from '../../web/src/i18n';
import type { MessageKey } from '../../web/src/i18n/en';
import type { OpenedFolders } from '../../web/src/shell';
import { channels } from './bridge';
import { closeGuard, isCloseAnswer, parseUnsaved, type CloseGuard } from './closeGuard';
import {
  channelHead,
  HubHost,
  hubEnv,
  hubInstance,
  DesktopError,
  ENV_PREFIX,
  isChannelId,
  nodeInstance,
  stdioChild,
  verifyKey,
  type HubSpawner,
} from './hub';
import { enclaveFor, helperPath, helperRunner, runBounded } from './enclave';
import { FolderQueue } from './folders';
import { followHub, type ShellSettings } from './follow';
import { menuCommands, menuTemplate, parseDisabled, type Binding } from './menu';
import { createNotifications } from './notifications';
import { APP_ORIGIN } from './origin';
import { APP_ID, hubResources, foldersOf, keyPlatform, quitsWithLastWindow, type Platform } from './platform';
import {
  allowGuestPermission,
  allowPermission,
  APP_PARTITION,
  appWindowPreferences,
  BROWSER_PARTITION,
  guestMayNavigate,
  guestPreferences,
  hostResolver,
  isExternal,
  isInternal,
  mainWindowPreferences,
  popupGate,
} from './policy';
import { serveApp } from './protocol';
import { bundleOf, privacyActions, terminalCoreExecutable } from './privacy';
import { sameBindings, startupGate, type StartupGate } from './startup';
import { macTrafficLightPosition, windowFrameOptions } from './titlebar';
import { codeIdentity, instanceFiles, KEYCHAIN_RECORD, keychainMigration, runTool, safeStorageItem, securityKeychain } from './keychain';
import { UNLOCK_FILE, unlockStore, type Prepared } from './unlockStore';
import { verifier, type Verifier } from './verify';
import { helloFor, helloKeysFor, HELLO_TIMEOUT_MS, POWERSHELL_ARGS, powershellPath, type RunPowerShell } from './windowsHello';

const platform = process.platform as Platform;
app.setName(APP_NAME);
// Windows shows the notifications of an app under its AppUserModelID, the
// one its installer gives the Start menu shortcut.
if (platform === 'win32') app.setAppUserModelId(APP_ID);
app.enableSandbox();
const devValue = process.env[`${ENV_PREFIX}DESKTOP_DEV`];
const dev = !app.isPackaged || !!devValue;
// The hub's instance; a name refused is reported once the app is ready.
let instance: string | DesktopError;
try {
  instance = hubInstance(dev, devValue);
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

// The hub, once the app is ready (hub.ts).
let hub: HubHost | undefined;
let mainWindow: BrowserWindow | undefined;
// The main window's page asks about unsaved changes before it closes.
let guard: CloseGuard | undefined;
// The origin of the app's pages, which only its session serves.
const origin = APP_ORIGIN;
// The hub served once: windows may open.
let serving = false;
// Coordinates parallel hub startup and first window paint (startup.ts).
let bootGate: StartupGate | undefined;
let quitting = false;
// Quit was chosen while the main window was open: it closes first.
let quitAfterClose = false;
let stopped = false;
let systemShutdown = false;
let reportingError = false;
let stopFollowing = () => {};
// The keybindings of this platform: its defaults until the hub's are read.
const keys = keyPlatform(platform);
let bindings = registry.keybindings[keys] as Binding[];
// appearance.language: "auto" follows the system's languages.
let language = 'auto';
// window.zoom as a factor: the main window's zoom, which Chromium keeps per
// origin, so the app's other windows (program windows, VS Code's own) share
// it. The setting is the only place it is kept.
let zoomFactor = 1;
// appearance.uiFontSize in CSS pixels: paired with zoomFactor to keep the
// macOS traffic lights vertically centered in the integrated header row.
let uiFontSize = tokens.font.root;
// The commands whose menu items are disabled, as the page last said.
let disabled = new Set<string>();
// Folders opened with the app, until the page takes them.
const folders = new FolderQueue();
// Native OS notifications (Electron Notification API), queued click routing.
const notifications = createNotifications({
  isSupported: () => Notification.isSupported(),
  create: (opts) => new Notification(opts),
  showMain,
  setBadgeCount: (count) => {
    app.setBadgeCount(count);
    if (platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '');
  },
});

/** macOS: the step that gives safeStorage's keychain item to this build
 * when another build made it, before the vault's unlock store first uses
 * safeStorage (keychain.ts). A development run (Electron's own executable,
 * which rebuilding the app does not change) only records that it made the
 * item, so that a packaged build moves it; an explicit --user-data-dir
 * (isolated runs) leaves the item and the instances' files alone. */
function keychainStep(): (() => Promise<Prepared>) | undefined {
  if (platform !== 'darwin' || app.commandLine.hasSwitch('user-data-dir')) return undefined;
  const appData = app.getPath('appData');
  return keychainMigration({
    move: app.isPackaged,
    safe: safeStorage,
    // The bundle of Contents/MacOS/<executable>, which a restored item trusts.
    keychain: securityKeychain(safeStorageItem(app.getName()), join(process.execPath, '..', '..', '..'), runTool),
    identity: () => codeIdentity(runTool, process.pid),
    own: join(app.getPath('userData'), UNLOCK_FILE),
    files: () => instanceFiles(appData),
    record: join(appData, KEYCHAIN_RECORD),
  });
}

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
  bootGate?.abort();
  console.error(error);
  // Stop before showing a modal dialog, including after a startup timeout.
  stopFollowing();
  if (!serving && mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  await hub?.stop();
  if (quitting) return;
  await dialog.showMessageBox({
    type: 'error',
    title: APP_NAME,
    message: t('desktop.failed'),
    detail: `${t('desktop.failureHelp')}\n\n${describe(error)}\n${hub?.diagnostics ?? ''}`,
    buttons: [t('desktop.quit')],
  });
  app.quit();
}

function openExternal(url: string) {
  if (isExternal(url)) void shell.openExternal(url).catch(console.error);
}

// Install on every window, including program windows and standalone VS Code.
app.on('web-contents-created', (_event, contents) => {
  // A webview attaches only in the main window's own page, and only as the
  // browser panes' guest, at an address that is not the hub's (policy.ts
  // guestPreferences).
  contents.on('will-attach-webview', (event, prefs, params) => {
    const ok =
      !!mainWindow &&
      contents === mainWindow.webContents &&
      isInternal(contents.getURL(), origin) &&
      guestPreferences(prefs, params, origin);
    if (!ok) event.preventDefault();
  });
  if (contents.getType() === 'webview') {
    // A guest is a web page of the browser pane: it follows http(s) links
    // itself, never to the hub's own address, and a popup becomes a new
    // browser tab in the page, a few at a time (policy.ts popupGate). Its
    // scripts never hand anything to the system's browser, and it gets no
    // menu.
    contents.on('will-navigate', (event, url) => {
      if (!guestMayNavigate(url, origin)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!guestMayNavigate(url, origin)) event.preventDefault();
    });
    const mayPopup = popupGate();
    contents.setWindowOpenHandler(({ url }) => {
      const host = contents.hostWebContents;
      if (guestMayNavigate(url, origin) && host && !host.isDestroyed() && host.mainFrame && mayPopup()) {
        host.mainFrame.send(channels.browserOpen, url);
      }
      return { action: 'deny' };
    });
    return;
  }
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
    // The app's other windows (program windows, VS Code's own): its
    // session, and the channels to the hub in each frame.
    if (isInternal(url, origin)) {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: appWindowPreferences(join(__dirname, 'frames.cjs')) } };
    }
    openExternal(url);
    return { action: 'deny' };
  });
});

/** Brings the main window forward; on macOS, where closing it leaves the app
 * running, opens it again. */
function showMain() {
  if (!mainWindow) {
    if (serving && !quitting) createWindow();
    return;
  }
  if (!serving) return;
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

/** Keeps the macOS traffic lights vertically centered in the integrated header
 * row as the UI font size or window zoom changes. */
function applyWindowButtons() {
  if (platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setWindowButtonPosition(macTrafficLightPosition(uiFontSize, zoomFactor));
  }
}

// The hub's settings and keybindings: the theme becomes the title bar's and
// native controls' (also when it differs from the system's appearance), the
// language the menu's, the zoom the windows'.
function applySettings(s: ShellSettings) {
  nativeTheme.themeSource = s.theme;
  zoomFactor = s.zoom;
  uiFontSize = s.uiFontSize;
  applyZoom();
  applyWindowButtons();
  if (s.language === language) return;
  language = s.language;
  buildMenu();
}

function applyBindings(b: Binding[]) {
  if (sameBindings(bindings, b)) return;
  bindings = b;
  buildMenu();
}

// Messages count only from the top frame of the main window showing the hub.
function fromMainPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    !!mainWindow &&
    !!frame &&
    event.sender === mainWindow.webContents &&
    frame === event.sender.mainFrame &&
    // The document's origin, not only its URL's: a sandboxed document at
    // a URL of the app's is of an opaque origin.
    frame.origin === origin &&
    isInternal(frame.url, origin)
  );
}

ipcMain.on(channels.menuState, (event, value: unknown) => {
  if (!fromMainPage(event)) return;
  const next = parseDisabled(value);
  if (next) applyDisabled(next);
});

ipcMain.on(channels.unsaved, (event, value: unknown) => {
  const n = parseUnsaved(value);
  if (fromMainPage(event) && n !== undefined) guard?.setUnsaved(n);
});

ipcMain.on(channels.closeAnswer, (event, value: unknown) => {
  if (fromMainPage(event) && isCloseAnswer(value)) guard?.answer(value);
});

ipcMain.on(channels.foldersWanted, (event, wanted: unknown) => {
  if (!fromMainPage(event)) return;
  const contents = event.sender;
  folders.takenBy(wanted === true ? (opened) => contents.send(channels.openFolders, opened) : undefined);
});

ipcMain.on(channels.fullScreenQuery, (event) => {
  if (fromMainPage(event) && mainWindow && !mainWindow.isDestroyed()) {
    event.sender.send(channels.fullScreen, mainWindow.isFullScreen());
  }
});

ipcMain.handle(channels.notifySupported, (event) => (fromMainPage(event) ? notifications.supported() : false));
ipcMain.handle(channels.notifyShow, (event, opts: unknown) => (fromMainPage(event) ? notifications.show(opts) : false));
ipcMain.on(channels.notifyClose, (event, tag: unknown) => {
  if (fromMainPage(event)) notifications.close(tag);
});
ipcMain.on(channels.notifyBadge, (event, count: unknown) => {
  if (fromMainPage(event)) notifications.setBadgeCount(count);
});
ipcMain.on(channels.notifyClickWanted, (event, wanted: unknown) => {
  if (!fromMainPage(event)) return;
  const contents = event.sender;
  notifications.takenBy(wanted === true ? (target) => contents.send(channels.notifyClick, target) : undefined);
});

// Full Disk Access (macOS): the page asks; what opens is the shell's own.
const privacy = privacyActions(
  {
    platform,
    // Looked up at each request: the agent installs it after the app started.
    get executable() {
      return terminalCoreExecutable(app.getPath('home'), typeof instance === 'string' ? nodeInstance(instance) : '');
    },
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

// What the app's processes use, for the page's Performance settings: the
// kind of each process, its share of a processor since the last asking and
// its memory. Nothing of what the processes hold.
ipcMain.handle(channels.metrics, (event) =>
  fromMainPage(event)
    ? app.getAppMetrics().map((p) => ({
        type: p.type,
        name: p.name ?? p.serviceName ?? '',
        cpu: p.cpu.percentCPUUsage,
        memory: p.memory.workingSetSize * 1024,
      }))
    : [],
);

// The system's prompt for the variable vault (verify.ts). The verifier
// exists once the hub runs, with the key of this launch, which only this
// process holds.
let verify: Verifier | undefined;
ipcMain.handle(channels.verifyAvailable, async (event) => (fromMainPage(event) && verify ? await verify.available() : null));
ipcMain.handle(channels.verifyProve, async (event, nonce: unknown) => (fromMainPage(event) && verify ? await verify.prove(nonce) : null));
ipcMain.handle(channels.verifyCanUnlock, async (event) => (fromMainPage(event) && verify ? await verify.canUnlock() : false));
ipcMain.handle(channels.verifyUnlock, async (event, nonce: unknown) => (fromMainPage(event) && verify ? await verify.unlock(nonce) : null));
ipcMain.handle(channels.verifyEnroll, async (event, nonce: unknown) => (fromMainPage(event) && verify ? await verify.enroll(nonce) : null));

/** Runs PowerShell with the script on stdin (Windows Hello). */
const runPowerShell: RunPowerShell = (script, env) =>
  runBounded(powershellPath(process.env.SystemRoot), POWERSHELL_ARGS, script, {
    env: { ...process.env, ...env },
    timeoutMs: HELLO_TIMEOUT_MS,
    maxOutput: 64 * 1024,
  });

/** What the hub says a nonce of the vault's proofs is for: asked of the
 * hub directly, as the desktop client. */
async function proofPurpose(nonce: string): Promise<unknown> {
  if (!hub) return undefined;
  const res = await hub.fetch(`/api/p/vault/proof/${encodeURIComponent(nonce)}`, { signal: AbortSignal.timeout(5000) });
  return res.ok ? await res.json() : undefined;
}

// A channel to the hub for a frame of the app's origin (frames.ts): the
// main process checks the frame and builds the request from what it knows
// of it, hands one end to the hub and the other to the frame. A request
// it refuses gets a channel that is closed at once.
ipcMain.on(channels.openChannel, (event, id: unknown, path: unknown, protocols: unknown) => {
  const frame = event.senderFrame;
  if (!frame || !isChannelId(id)) return;
  const head = channelHead(frame.origin, path, protocols);
  const { port1, port2 } = new MessageChannelMain();
  if (head && hub) void hub.connect(head, port1);
  else refuseChannel(electronPort(port1), 'refused');
  frame.postMessage(channels.channelPort, id, [port2]);
});

/** The page's background (color.background in spec/tokens.json), shown before it paints. */
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
    ...windowFrameOptions(platform, uiFontSize, zoomFactor),
    // Linux takes the window's icon from the window (macOS and Windows from
    // the application).
    ...(platform === 'linux' && { icon: join(app.getAppPath(), 'assets', 'icon.png') }),
    webPreferences: mainWindowPreferences(join(__dirname, 'preload.cjs')),
  });
  mainWindow = win;
  const g = closeGuard({
    ask: () => {
      // The question shows in the window: in front, also from the Dock's Quit.
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send(channels.closeRequest);
    },
    close: () => {
      if (!win.isDestroyed()) win.close();
    },
    cancelled: () => {
      quitAfterClose = false;
    },
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  });
  guard = g;
  const onTheme = () => win.setBackgroundColor(windowBackground());
  nativeTheme.on('updated', onTheme);
  // Folders opened from now on wait for the next page, which asks for them;
  // this runs before that page can.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      folders.takenBy(undefined);
      notifications.takenBy(undefined);
      notifications.setBadgeCount(0);
    }
  });
  // What a page said of its unsaved changes goes with it, once another one
  // is there (a navigation that never commits keeps it).
  win.webContents.on('did-navigate', () => g.reset());
  // Closing (also quitting) with unsaved changes: the page lists them and
  // asks; a system shutdown never waits.
  win.on('close', (event) => {
    if (!g.onClose(systemShutdown)) event.preventDefault();
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    folders.takenBy(undefined);
    notifications.takenBy(undefined);
    notifications.setBadgeCount(0);
    g.reset();
    if (!quitting) void fail(new DesktopError('desktop.rendererGone', details.reason));
  });
  // A frame objects to unloading (the page with unsaved changes it did not
  // ask about: a reload, a page that did not answer; a VS Code window): the
  // user decides, natively; a system shutdown never waits.
  win.webContents.on('will-prevent-unload', (event) => {
    if (systemShutdown) return event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: [t('unsaved.leave'), t('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      message: t('unsaved.title'),
      detail: t('unsaved.leaveDetail'),
    });
    // preventDefault here ignores the page's objection: the window goes.
    if (choice === 0) event.preventDefault();
    else quitAfterClose = false;
  });
  // Windows ends a session (log off, restart, shut down) with this.
  win.on('session-end', () => {
    systemShutdown = true;
  });
  // Each page loaded (also after a reload) gets the zoom.
  win.webContents.on('did-finish-load', applyZoom);
  if (platform === 'darwin') {
    const sendFullScreen = (full: boolean) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channels.fullScreen, full);
    };
    win.on('enter-full-screen', () => sendFullScreen(true));
    win.on('leave-full-screen', () => {
      // macOS resets custom traffic light coordinates after exiting full screen.
      applyWindowButtons();
      sendFullScreen(false);
    });
  }
  win.once('ready-to-show', () => {
    if (bootGate) bootGate.windowReady();
    else if (!reportingError && !quitting && !win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    g.reset();
    if (guard === g) guard = undefined;
    nativeTheme.off('updated', onTheme);
    folders.takenBy(undefined);
    notifications.takenBy(undefined);
    notifications.setBadgeCount(0);
    mainWindow = undefined;
    // Program windows do not keep the app open.
    if (!reportingError && (quitAfterClose || quitsWithLastWindow(platform))) app.quit();
  });
  void win.loadURL(`${origin}/`).catch(fail);
}

app.on('before-quit', (event) => {
  // The main window closes first, so a page with unsaved changes can keep
  // the app (will-prevent-unload) before the hub stops; quitting goes on
  // once it has closed.
  if (!stopped && !systemShutdown && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    quitAfterClose = true;
    mainWindow.close();
    return;
  }
  quitting = true;
  bootGate?.abort();
  stopFollowing();
  notifications.closeAll();
  if (stopped) return;
  if (systemShutdown) {
    // Delaying a logout, restart or shutdown would cancel it. Stop the hub
    // and let it clean up on its own.
    void hub?.stop();
    return;
  }
  event.preventDefault();
  void (hub?.stop() ?? Promise.resolve()).then(() => {
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
      // Before anything loads: names resolve as in the system's browser.
      app.configureHostResolver(hostResolver);
      // Linux and macOS report a logout, restart or shutdown here.
      powerMonitor.on('shutdown', () => {
        systemShutdown = true;
      });
      // The key of the system's prompts: to the hub in its start
      // message, and to nothing else.
      const key = verifyKey();
      const home = app.getPath('home');
      const resources = hubResources(
        app.isPackaged ? process.resourcesPath : undefined,
        join(app.getAppPath(), '..'),
        platform,
        process.arch,
      );
      // Development only: overrides for the hub executable, payloads,
      // machine builds and code-server seed of a test run.
      const devPath = (name: string) => (dev ? process.env[`${ENV_PREFIX}${name}`] || undefined : undefined);
      const seed = devPath('SEED_DIR');
      const hubBin = devPath('HUB_BIN') ?? resources.hub;
      const spawner: HubSpawner = {
        fork: () =>
          stdioChild(
            spawn(hubBin, ['desktop'], {
              stdio: ['pipe', 'pipe', 'pipe'],
              env: hubEnv(process.env, home, platform),
              cwd: home,
              windowsHide: true,
            }),
            (end) => electronPort(end as ElectronPort),
          ),
        pair: () => {
          const { port1, port2 } = new MessageChannelMain();
          return [port1, port2];
        },
        port: (end) => electronPort(end as ElectronPort),
      };
      const host = new HubHost({
        spawner,
        start: {
          instance,
          nodeInstance: nodeInstance(instance),
          localOnly: instance !== 'desktop',
          origin,
          verifyKey: key,
          payload: devPath('DESKTOP_PAYLOAD'),
          web: devPath('WEB_DIR'),
          agentDir: devPath('AGENT_DIR') ?? resources.machines,
          seedDirs: seed ? [seed] : undefined,
        },
        lost: (error) => void fail(error),
        log: (text) => process.stderr.write(text),
      });
      hub = host;
      (globalThis as { __hubPid?: () => number | undefined }).__hubPid = () => hub?.pid;
      // Spawn the hub first so its process initialization overlaps setting up
      // Electron sessions, menus and creating the main renderer window; any
      // request or channel waits on HubHost.serving() until the hub is ready.
      const starting = host.start();
      // The app's windows live in a session of their own, where the app's
      // origin is the hub's: protocol and permission handlers are installed
      // before any window is created.
      const ses = session.fromPartition(APP_PARTITION);
      serveApp(ses, host);
      ses.setPermissionRequestHandler((contents, permission, callback, details) => {
        callback(allowPermission(permission, details.requestingUrl, contents.getURL(), origin));
      });
      ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
        return allowPermission(permission, requestingOrigin, contents?.getURL() || '', origin);
      });
      // The browser panes' guests live in their own partition, so they share
      // nothing with the app, and the app's origin is not the hub's there.
      // A guest gets no permission but full screen; downloads keep
      // Electron's save dialog (no will-download handler saves by itself).
      const guests = session.fromPartition(BROWSER_PARTITION);
      guests.setPermissionRequestHandler((_contents, permission, callback) => callback(allowGuestPermission(permission)));
      guests.setPermissionCheckHandler((_contents, permission) => allowGuestPermission(permission));
      verify = verifier(key, {
        platform,
        canPromptTouchID: () => platform === 'darwin' && systemPreferences.canPromptTouchID(),
        promptTouchID: (reason) => systemPreferences.promptTouchID(reason),
        hello: helloFor(runPowerShell),
        purpose: proofPurpose,
        t,
        // The vault's unlock key: the Secure Enclave helper inside the app
        // on macOS, Hello keys on Windows, and this install's secret in the
        // user data.
        ...(platform === 'darwin' && {
          enclave: enclaveFor(helperRunner(helperPath(app.isPackaged ? process.resourcesPath : undefined, app.getAppPath()))),
        }),
        ...(platform === 'win32' && { helloKeys: helloKeysFor(runPowerShell) }),
        unlockStore: unlockStore(app.getPath('userData'), safeStorage, { prepare: keychainStep() }),
      });
      if (!app.isPackaged) app.dock?.setIcon(join(app.getAppPath(), 'assets', 'icon.png'));
      // Windows and Linux show these in About (macOS reads its bundle).
      app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });
      buildMenu();
      const gate = startupGate(() => {
        bootGate = undefined;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
      });
      bootGate = gate;
      stopFollowing = followHub(host, keys, { bindings: applyBindings, settings: applySettings });
      createWindow();
      await starting;
      serving = true;
      if (quitting || reportingError) return;
      gate.hubReady();
    })
    .catch(fail);
}
