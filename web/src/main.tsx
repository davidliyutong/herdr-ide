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
import { currentAppearance, initAppearance } from './appearance';
import { applyTitlebar } from './desktop';
import { desktopShell } from './shell';
import { loadTermFont } from './terminal/fonts';
import { initGuiAuto } from './gui/auto';
import { initUpdateCheck } from './update';
import { parseGuiPath, useGui } from './gui/state';
import { conn } from './lib/conn';
import { unlockAudio } from './sound';
import { getPrefs } from './prefs';
import { loadSettings } from './settings';
import { setLocale } from './i18n';
import { GuiWindowPage } from './gui/GuiWindowPage';
import { refuseStrayFileDrops } from './drop';
import { useFrames } from './codeFrames';
import { actions } from './actions';
import { guardImeKeys } from './ime';

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
applyTitlebar();
refuseStrayFileDrops();
guardImeKeys();
// The settings come from the hub; until it answers the built-in defaults
// apply. The language must be known before anything is rendered.
const settingsLoaded = loadSettings().then(() => {
  setLocale(getPrefs().locale);
});
// A browser window showing one program window (see gui/).
const guiPage = parseGuiPath(location.pathname);
if (guiPage) {
  void settingsLoaded.then(() => createRoot(document.getElementById('root')!).render(<GuiWindowPage m={guiPage.m} id={guiPage.id} />));
} else {
  initGuiAuto();
  initUpdateCheck();
  // Terminals measure their cells when they open: give the bundled font a
  // moment to load (it comes from the hub). Terminals opened before it is
  // loaded switch to it later.
  const font = settingsLoaded.then(() => loadTermFont(currentAppearance().fontWeight));
  void Promise.race([font, new Promise((r) => setTimeout(r, 1500))]).then(async () => {
    await settingsLoaded;
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
