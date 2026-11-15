// The status bar's AI usage item: the tightest window of all accounts, in
// the warning color from the first threshold on; a click shows the panel.
import { useEffect } from 'react';
import { Gauge } from 'lucide-react';
import { useSettings } from '../../settings';
import { togglePanel } from '../../components/RightBar';
import { t } from '../../i18n';
import { fetchSnapshot, useUsage } from './state';
import { parseThresholds, providerName, tightest, windowName } from './model';

export function UsageStatusItem() {
  const snapshot = useUsage((s) => s.snapshot);
  const remaining = useUsage((s) => s.remaining);
  const thresholds = useSettings((s) => s.values['usage.thresholds']?.value);
  useEffect(() => {
    if (!useUsage.getState().snapshot) void fetchSnapshot();
  }, []);
  const top = tightest(snapshot);
  if (!top) return null;
  const pct = Math.round(remaining ? 100 - top.window.usedPct : top.window.usedPct);
  const warnAt = parseThresholds(thresholds)[0] ?? 80;
  const level = top.window.usedPct >= 100 ? 'out' : top.window.usedPct >= warnAt ? 'warn' : '';
  const what = `${providerName(top.account.provider)} · ${windowName(top.window)}`;
  const label = t(remaining ? 'usage.pctLeft' : 'usage.pctUsed', { pct });
  return (
    <button
      className={`usage-status-item ${level}`}
      title={t('usage.statusTitle', { what, pct: label })}
      aria-label={t('usage.statusTitle', { what, pct: label })}
      onClick={() => togglePanel('usage')}
    >
      <Gauge />
      <span>{label}</span>
    </button>
  );
}
