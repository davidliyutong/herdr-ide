// The core host's herdr as the UI manages it (docs/features/17): its status,
// starting and stopping its server, and updating the application's copy.

export interface LocalHerdr {
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
   * update_failed, not_managed, transport. */
  error?: string;
  /** herdr's own output for the error, or of an update. */
  output?: string;
}

export type HerdrAction = 'start' | 'stop' | 'check' | 'update';

export async function herdrRequest(m: string, action?: HerdrAction): Promise<LocalHerdr> {
  const url = `/api/m/${encodeURIComponent(m)}/herdr${action ? '/' + action : ''}`;
  try {
    const res = await fetch(url, action ? { method: 'POST' } : undefined);
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body as LocalHerdr;
    return { managed: false, running: false, error: 'transport', output: [body.error, body.detail].filter(Boolean).join(': ') };
  } catch (e) {
    return { managed: false, running: false, error: 'transport', output: String(e) };
  }
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
