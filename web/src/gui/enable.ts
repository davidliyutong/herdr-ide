// Terminals opened before a machine's display existed (or outside this UI)
// have no DISPLAY. The core types the display variables into shells waiting
// at their prompt; terminals running a program are left alone and reported,
// with the command to enter once the program exits.

import { useStore } from '../state/store';
import { hasMessage, t } from '../i18n';

interface EnableResult {
  enabled: number;
  already: number;
  busy: string[];
  failed: string[];
  command: string;
}

/** Enables program windows in the given terminals of machine m (all of them
 * when terminals is omitted) and reports the outcome in a toast. */
export async function enableGui(m: string, terminals: string[] = []): Promise<void> {
  const s = useStore.getState();
  try {
    const r = await fetch(`/api/m/${encodeURIComponent(m)}/gui/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminals }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const code = `gui.error.${j.error}`;
      s.toast(t('gui.enableFailed', { error: hasMessage(code) ? t(code) : String(j.error ?? r.status) }));
      return;
    }
    const res = j as EnableResult;
    let msg = t('gui.enabled', { n: res.enabled, already: res.already });
    if (res.failed?.length) msg += ` ${t('gui.enableUnreachable', { n: res.failed.length })}`;
    if (res.busy.length === 0) {
      s.toast(msg);
      return;
    }
    s.toast(`${msg} ${t('gui.enableBusy', { n: res.busy.length })}`, {
      label: t('gui.copyCommand'),
      run: () => void navigator.clipboard?.writeText(res.command),
    });
  } catch {
    s.toast(t('settings.error.network'));
  }
}
