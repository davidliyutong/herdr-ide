// A machine's herdr as the UI manages it (docs/features/17): its status and
// starting, stopping and restarting its server on every machine, and, on the
// core host, updating the application's copy.

import { hasMessage, t } from '../i18n';
import type { MachineState } from './herdr';

/** Whether a connected machine's agent finds no herdr executable there: not
 * installed, or removed or moved since. A server started before may still
 * run, but nothing can start or restart one until herdr is back; on an SSH
 * machine herdr --remote installs it (RemoteHerdrDialog). */
export function herdrMissing(m?: MachineState): boolean {
  return !!m?.info && !m.info.herdr_bin && (m.status === 'ready' || m.status === 'degraded');
}

export interface MachineHerdr {
  bin?: string;
  version?: string;
  /** The application's copy of herdr, which it may update. */
  managed: boolean;
  running: boolean;
  server_version?: string;
  restart_needed?: boolean;
  /** herdr's newest release, after a check. */
  latest?: string;
  /** A code: not_found, start_failed, stop_failed, check_failed,
   * update_failed, not_managed, not_local, foreign_server,
   * server_unresponsive, transport. */
  error?: string;
  /** herdr's own output for the error, or of an update. */
  output?: string;
}

/** check and update are for the core host only. */
export type HerdrAction = 'start' | 'stop' | 'restart' | 'check' | 'update';

export async function herdrRequest(m: string, action?: HerdrAction): Promise<MachineHerdr> {
  const url = `/api/m/${encodeURIComponent(m)}/herdr${action ? '/' + action : ''}`;
  try {
    const res = await fetch(url, action ? { method: 'POST' } : undefined);
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body as MachineHerdr;
    return { managed: false, running: false, error: 'transport', output: [body.error, body.detail].filter(Boolean).join(': ') };
  } catch (e) {
    return { managed: false, running: false, error: 'transport', output: String(e) };
  }
}

/** The message for a status's error code, empty without one. */
export function herdrError(st?: MachineHerdr): string {
  if (!st?.error) return '';
  const key = `herdr.error.${st.error}`;
  return hasMessage(key) ? t(key) : t('herdr.error.transport');
}

function parts(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split('.')
    .slice(0, 3)
    .map((p) => parseInt(p, 10) || 0);
}

/** Whether release `latest` is newer than `version` (major.minor.patch). */
export function isNewer(latest?: string, version?: string): boolean {
  if (!latest || !version) return false;
  const a = parts(latest);
  const b = parts(version);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}
