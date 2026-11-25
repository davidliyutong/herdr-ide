// Service workers on the UI's origin are VS Code's: the UI registers none,
// while code-server and its webviews do (served below /m/{id}/code/), and
// so can any script in a VS Code window. A worker stays registered in the
// browser after VS Code is turned off, so while VS Code is off for this
// kind of client the page unregisters every one, and nothing VS Code's
// content left keeps running on the origin (the hub also drops
// code-server's Service-Worker-Allowed, so no worker of VS Code's can
// claim the UI's own pages; SECURITY.md, Content on the UI's origin).
import { useSettings } from '../../settings';
import { isPluginOn } from '../registry';

type Workers = Pick<ServiceWorkerContainer, 'getRegistrations'>;

/** Unregisters every service worker of this origin; resolves to how many
 * were. Nothing where the browser has none (an insecure context). */
export async function dropServiceWorkers(sw: Workers | undefined = navigator.serviceWorker): Promise<number> {
  if (!sw?.getRegistrations) return 0;
  let n = 0;
  for (const r of await sw.getRegistrations()) {
    if (await r.unregister().catch(() => false)) n++;
  }
  return n;
}

/** Drops the service workers whenever VS Code is off for this client once
 * the hub told the settings (dropServiceWorkers); returns the
 * unsubscribe. */
export function followVSCodeSwitch(sw?: Workers): () => void {
  let dropped = false;
  const check = () => {
    if (!useSettings.getState().loaded) return;
    if (isPluginOn('vscode')) {
      dropped = false;
      return;
    }
    if (dropped) return;
    dropped = true;
    void dropServiceWorkers(sw).catch(() => {});
  };
  check();
  return useSettings.subscribe(check);
}
