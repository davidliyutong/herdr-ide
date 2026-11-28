import { createRoot } from 'react-dom/client';
import { App } from './App';
import { requestNotifyPermission } from './notify';
import './tokens.css';
import './styles.css';
import { paneHandle } from './state/panes';
import { terms } from './state/terms';
import { loadedVt } from './vt/module';
import { useStore } from './state/store';
import { APP_SLUG } from './brand';
import { initAppearance } from './appearance';
import { applyTitlebar } from './desktop';
import { desktopShell } from './shell';
import { initGuiAuto } from './gui/auto';
import { initUpdateCheck } from './update';
import { parseGuiPath, useGui } from './gui/state';
import { parseDetachedTab } from './detachedWindow';
import { conn } from './lib/conn';
import { unlockAudio } from './sound';
import { getPrefs } from './prefs';
import { refuseStrayFileDrops } from './drop';
import { useFrames } from './codeFrames';
import { actions } from './actions';
import { guardImeKeys } from './ime';
import { startBootstrap } from './bootstrap';

// Debug handle for the browser console (also used by end-to-end tests).
(window as unknown as Record<string, unknown>)[`__${APP_SLUG}`] = {
  pane: paneHandle,
  terms: () => terms,
  vt: loadedVt,
  store: useStore,
  gui: useGui,
  frames: useFrames,
  actions,
};

initAppearance();
refuseStrayFileDrops();
guardImeKeys();
// A browser window showing one program window (see gui/), or a detached tab
// window showing only the tab's core panes (see detachedWindow.ts).
const guiPage = parseGuiPath(location.pathname);
const detachedTab = guiPage ? undefined : parseDetachedTab(location.pathname, location.search);
if (guiPage) {
  // Fetch settings and the GUI window page chunk in parallel.
  const { settings } = startBootstrap({ preloadFont: false });
  void Promise.all([settings, import('./gui/GuiWindowPage')]).then(([, { GuiWindowPage }]) =>
    createRoot(document.getElementById('root')!).render(<GuiWindowPage m={guiPage.m} id={guiPage.id} />),
  );
} else if (detachedTab) {
  // Standalone core-pane window: keeps native window frame (no macOS titlebar inset).
  const { settings } = startBootstrap({ preloadFont: true });
  void Promise.all([settings, import('./components/DetachedTabApp')]).then(([, { DetachedTabApp }]) =>
    createRoot(document.getElementById('root')!).render(<DetachedTabApp m={detachedTab.m} pane={detachedTab.pane} />),
  );
  const onInput = () => {
    conn.markActive();
    if (getPrefs().notifySound) unlockAudio();
  };
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, onInput, { capture: true, passive: true });
  window.addEventListener('focus', () => conn.markActive());
} else {
  applyTitlebar();
  // Fetch settings, keybindings, config and the bundled terminal font in
  // parallel. Render as soon as settings (locale) resolve without waiting on
  // font decoding; terminals adopt the bundled font once loaded (whenTermFont).
  const { settings } = startBootstrap({ preloadFont: true });
  initGuiAuto();
  initUpdateCheck();
  void settings.then(() => {
    createRoot(document.getElementById('root')!).render(<App />);
    // Notification permission needs a user gesture (browsers only; Electron uses native notifications).
    if (!desktopShell?.notifications) window.addEventListener('pointerdown', () => void requestNotifyPermission(), { once: true });
  });
  // Input tells the hub which page is in use (it plays the sounds), and
  // lets the page start audio.
  const onInput = () => {
    conn.markActive();
    if (getPrefs().notifySound) unlockAudio();
  };
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, onInput, { capture: true, passive: true });
  window.addEventListener('focus', () => conn.markActive());
}
