import { createRoot } from 'react-dom/client';
import { App } from './App';
import { requestNotifyPermission } from './notify';
import './styles.css';
import { getTerm } from './terminal/registry';
import { useStore } from './state/store';
import { APP_SLUG } from './brand';
import { currentAppearance, initAppearance } from './appearance';
import { loadTermFont } from './terminal/fonts';
import { initSeen } from './seen';
import { initGuiAuto } from './gui/auto';
import { initUpdateCheck } from './update';
import { parseGuiPath, useGui } from './gui/state';
import { GuiWindowPage } from './gui/GuiWindowPage';

// Debug handle for the browser console (also used by end-to-end tests).
(window as unknown as Record<string, unknown>)[`__${APP_SLUG}`] = { getTerm, store: useStore, gui: useGui };

initAppearance();
// A browser window showing one program window (see gui/).
const guiPage = parseGuiPath(location.pathname);
if (guiPage) {
  createRoot(document.getElementById('root')!).render(<GuiWindowPage m={guiPage.m} id={guiPage.id} />);
} else {
  initSeen();
  initGuiAuto();
  initUpdateCheck();
  // Terminals measure their cells when they open: give the bundled font a
  // moment to load (it comes from the core). Terminals opened before it is
  // loaded switch to it later.
  const font = loadTermFont(currentAppearance().fontWeight);
  void Promise.race([font, new Promise((r) => setTimeout(r, 1500))]).then(() =>
    createRoot(document.getElementById('root')!).render(<App />),
  );
  // Notification permission needs a user gesture.
  window.addEventListener('pointerdown', requestNotifyPermission, { once: true });
}
