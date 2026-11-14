// The downloads panel: a status bar button, shown once this browser has
// downloaded from a machine, opens a list of the downloads running (progress,
// speed, time left, cancel) and the finished ones (how they ended, download
// again, forget). The same design as the uploads panel (Transfers.tsx); see
// download.ts.

import { useCallback, useRef } from 'react';
import { ArrowDownToLine, Ban, CircleAlert, CircleCheck, RotateCw, X } from 'lucide-react';
import { useStore } from '../state/store';
import { t } from '../i18n';
import { formatSize } from '../lib/files';
import { shortPath } from '../lib/herdr';
import {
  cancelAllDownloads,
  cancelDownload,
  clearDownloadHistory,
  downloadError,
  downloadsProgress,
  forgetDownload,
  retryDownload,
  useDownloads,
  type Download,
} from '../download';
import { duration, when } from './Transfers';
import { useDismiss } from './useDismiss';

/** The line under a download's name: how far it is or how it ended. */
export function downloadDetail(x: Download): string {
  switch (x.status) {
    case 'starting':
      return t('downloads.starting');
    case 'downloading': {
      const speed = formatSize(Math.round(x.speed));
      if (x.size === undefined) return t('downloads.received', { sent: formatSize(x.sent), speed });
      const line = t('transfers.progress', { sent: formatSize(x.sent), size: formatSize(x.size), speed });
      return x.speed > 0 ? `${line} · ${t('transfers.left', { time: duration(((x.size - x.sent) * 1000) / x.speed) })}` : line;
    }
    case 'done':
      return x.ended !== undefined
        ? t('transfers.doneIn', { size: formatSize(x.sent), time: duration(x.ended - x.started), speed: formatSize(Math.round(x.speed)) })
        : formatSize(x.sent);
    case 'failed':
      return downloadError(x.error);
    case 'cancelled':
      return t('transfers.cancelled');
  }
}

const icons = { done: CircleCheck, failed: CircleAlert, cancelled: Ban };

function Row({ x }: { x: Download }) {
  const home = useStore((s) => s.machines[x.m]?.info?.home);
  const first = shortPath(x.paths[0] ?? '', home);
  const where = x.paths.length > 1 ? t('downloads.paths', { path: first, n: x.paths.length - 1 }) : first;
  const running = x.status === 'starting' || x.status === 'downloading';
  const finished = !running;
  const known = x.size !== undefined && x.status === 'downloading';
  const pct = known && x.size ? Math.min(100, (x.sent / x.size) * 100) : 0;
  const Icon = finished ? icons[x.status as keyof typeof icons] : ArrowDownToLine;
  return (
    <div className={`transfer ${x.status}`}>
      <Icon className="transfer-icon" />
      <div className="transfer-body">
        <div className="transfer-name ellipsis" title={x.name}>
          {x.name}
        </div>
        <div className="muted small ellipsis" title={x.paths.join('\n')}>
          {x.machine} · {where}
        </div>
        {running && (
          <div
            className={`transfer-bar ${known ? '' : 'indeterminate'}`}
            role="progressbar"
            aria-valuenow={known ? Math.round(pct) : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div style={known ? { width: `${pct}%` } : undefined} />
          </div>
        )}
        <div className={`small transfer-detail ${x.status === 'failed' ? 'error' : 'muted'}`}>
          <span className="ellipsis">{downloadDetail(x)}</span>
          {finished && x.ended !== undefined && <span className="transfer-when">{when(x.ended)}</span>}
        </div>
      </div>
      <div className="transfer-actions">
        {running && (
          <button className="icon" title={t('downloads.cancel')} aria-label={t('downloads.cancel')} onClick={() => cancelDownload(x.id)}>
            <X />
          </button>
        )}
        {finished && (
          <>
            <button className="icon" title={t('downloads.retry')} aria-label={t('downloads.retry')} onClick={() => retryDownload(x)}>
              <RotateCw />
            </button>
            <button className="icon" title={t('transfers.forget')} aria-label={t('transfers.forget')} onClick={() => forgetDownload(x.id)}>
              <X />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Status bar entry: the downloads of this browser. */
export function DownloadsTray() {
  const active = useDownloads((s) => s.active);
  const history = useDownloads((s) => s.history);
  const open = useDownloads((s) => s.panel);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => useDownloads.getState().setPanel(false), []);
  useDismiss(open, ref, close);
  if (!active.length && !history.length && !open) return null;
  const { sent, size } = downloadsProgress(active);
  const busy = active.length > 0;
  const count =
    size === undefined || size === 0
      ? String(active.length)
      : t('transfers.tray', { n: active.length, pct: Math.floor((Math.min(sent, size) / size) * 100) });
  return (
    <span className="gui-menu-anchor" ref={ref}>
      <button
        className={`gui-tray transfers-tray ${busy ? 'attention' : ''}`}
        title={t('downloads.title')}
        aria-label={t('downloads.title')}
        aria-expanded={open}
        onClick={() => useDownloads.getState().setPanel(!open)}
      >
        <ArrowDownToLine />
        {busy && <span className="gui-count">{count}</span>}
      </button>
      {open && (
        <div className="gui-menu transfers-panel" role="dialog" aria-label={t('downloads.title')}>
          <div className="transfers-head">
            <span className="transfers-title">{t('downloads.title')}</span>
            <span className="spacer" />
            {active.length > 1 && <button onClick={cancelAllDownloads}>{t('transfers.cancelAll')}</button>}
            {history.length > 0 && <button onClick={clearDownloadHistory}>{t('transfers.clear')}</button>}
          </div>
          {!active.length && !history.length && <div className="muted small transfers-empty">{t('downloads.none')}</div>}
          {active.map((x) => (
            <Row key={x.id} x={x} />
          ))}
          {history.length > 0 && active.length > 0 && <div className="transfers-section muted small">{t('transfers.history')}</div>}
          {history.map((x) => (
            <Row key={x.id} x={x} />
          ))}
        </div>
      )}
    </span>
  );
}
