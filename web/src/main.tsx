import { createRoot } from 'react-dom/client';
import { App } from './App';
import { requestNotifyPermission } from './notify';
import './styles.css';
import { getTerm } from './terminal/registry';
import { useStore } from './state/store';
import { APP_SLUG } from './brand';
import { initAppearance } from './appearance';
import { initSeen } from './seen';

// Debug handle for the browser console (also used by end-to-end tests).
(window as unknown as Record<string, unknown>)[`__${APP_SLUG}`] = { getTerm, store: useStore };

initAppearance();
initSeen();
createRoot(document.getElementById('root')!).render(<App />);
// Notification permission needs a user gesture.
window.addEventListener('pointerdown', requestNotifyPermission, { once: true });
