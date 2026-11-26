// The end of the terminal history plugin's page in Settings: for the
// machine shown, how many snapshots of terminal output it keeps and their
// size, whether the terminal core restores screens itself (its own
// restore_screen, which this app only reads), and a button that removes
// the snapshots after asking.
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { t } from '../../i18n';
import { confirmDialog } from '../../dialog';
import { formatSize } from '../../lib/files';
import { useStore } from '../../state/store';
import type { PluginSettingsProps } from '../api';
import { clearHistory, historyErrorText, listHistory, type HistoryList } from './api';
import { historyCleared } from './follow';

/** The generations a list holds and the bytes they take. */
export function listTotals(l: HistoryList): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const e of l.terminals) {
    if (e.at > 0) {
      count++;
      bytes += e.bytes;
    }
    if (e.previous) {
      count++;
      bytes += e.previous.bytes;
    }
  }
  return { count, bytes };
}

export function HistorySettingsExtra({ readOnly }: PluginSettingsProps) {
  const m = useStore((s) => s.machineId);
  const machine = useStore((s) => (s.machineId ? (s.machines[s.machineId]?.label ?? s.machineId) : ''));
  const [list, setList] = useState<HistoryList>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<number>();
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let live = true;
    setList(undefined);
    setError('');
    if (!m) return;
    listHistory(m).then(
      (l) => live && setList(l),
      (e) => live && setError(historyErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [m, reads]);
  // Another machine shown: what was removed was another's.
  useEffect(() => setRemoved(undefined), [m]);

  const clear = async () => {
    if (!m) return;
    const ok = await confirmDialog({
      title: t('history.settings.clearTitle'),
      message: t('history.settings.clearMessage', { machine }),
      confirm: t('history.settings.clearConfirm'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      setRemoved(await clearHistory(m));
      historyCleared(m);
      setReads((n) => n + 1);
    } catch (e) {
      setError(historyErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const totals = list && listTotals(list);
  const summary = !m
    ? t('history.settings.noMachine')
    : error
      ? error
      : !totals
        ? t('history.settings.loading')
        : totals.count === 0
          ? t('history.settings.none', { machine })
          : t('history.settings.count', { machine, count: totals.count, size: formatSize(totals.bytes) });
  return (
    <div className="setting" data-history-saved>
      <h4 className="settings-group">{t('history.settings.saved')}</h4>
      <p className="settings-note" data-summary>
        {summary}
      </p>
      {list && (
        <p className="settings-note" data-restore-screen={list.restoreScreen ? 'on' : 'off'}>
          {t(list.restoreScreen ? 'history.settings.restoreScreenOn' : 'history.settings.restoreScreenOff', { machine })}
        </p>
      )}
      <div className="setting-control row-gap">
        <button data-action="clear" disabled={readOnly || busy || !m || !totals?.count} onClick={() => void clear()}>
          <Trash2 /> {t('history.settings.clear')}
        </button>
      </div>
      {removed !== undefined && (
        <p className="settings-note" data-removed>
          {t('history.settings.removed', { count: removed })}
        </p>
      )}
    </div>
  );
}
