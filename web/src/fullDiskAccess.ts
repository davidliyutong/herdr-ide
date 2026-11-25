// Full Disk Access in the desktop app on macOS. macOS gives it per program,
// to the one it holds responsible for a file access: the app for its hub
// (the file browser, uploads, downloads) and the VS Code it starts, and
// herdr-core, the terminal service, for the programs of terminals (it is
// started as a launchd job, not as a child of the app). The settings show
// both as the hub finds them (GET /api/m/{id}/privacy), and the app's
// shell opens System Settings at the list, shows herdr-core in Finder and
// reopens the app. Browsers, Windows and Linux have none of it.

import { APP_NAME } from './brand';
import { confirmDialog } from './dialog';
import { t } from './i18n';
import { desktopShell } from './shell';
import { useStore } from './state/store';

/** Granted, denied or unknown, for files (the app) and terminals
 * (herdr-core), with herdr-core's executable. */
export type Access = 'granted' | 'denied' | 'unknown';
export interface PrivacyState {
  files: Access;
  terminals: Access;
  hc: string;
}

/** The settings row's id, which Open Full Disk Access Settings… shows. */
export const FDA_ROW = 'fullDiskAccess';

/** Whether this page can ask for Full Disk Access: the desktop app on macOS. */
export function fullDiskAccessAvailable(): boolean {
  return !!desktopShell?.privacy;
}

/** The hub's local machine, whose processes the access concerns. */
export function localMachine(): string | undefined {
  const s = useStore.getState();
  return s.order.find((id) => s.machines[id]?.kind === 'local');
}

const accessValues: readonly string[] = ['granted', 'denied', 'unknown'];
const access = (v: unknown): Access => (accessValues.includes(v as string) ? (v as Access) : 'unknown');

/** The access of machine m's processes; all unknown when the hub cannot
 * tell (machine offline, an error). */
export async function fetchPrivacy(m: string): Promise<PrivacyState> {
  try {
    const res = await fetch(`/api/m/${encodeURIComponent(m)}/privacy`);
    if (res.ok) {
      const body = (await res.json()) as Partial<PrivacyState>;
      return { files: access(body.files), terminals: access(body.terminals), hc: typeof body.hc === 'string' ? body.hc : '' };
    }
  } catch {
    /* unknown */
  }
  return { files: 'unknown', terminals: 'unknown', hc: '' };
}

/** Open Full Disk Access Settings…: System Settings at the list, and the
 * settings' row, which says what to turn on there and what to restart. */
export function openFullDiskAccess() {
  if (!desktopShell?.privacy) return;
  useStore.getState().openSettings({ page: 'terminal', row: FDA_ROW });
  desktopShell.privacy.openFullDiskAccess();
}

/** Quits the app and opens it again, after asking. */
export async function relaunchApp() {
  if (!desktopShell?.privacy) return;
  const ok = await confirmDialog({
    title: t('fda.relaunchTitle', { app: APP_NAME }),
    message: t('fda.relaunchInfo'),
    confirm: t('fda.relaunchConfirm'),
  });
  if (ok) desktopShell.privacy.relaunch();
}
