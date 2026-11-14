// The downloads panel: a status bar button, shown once this browser has
// downloaded from a machine, opens a list of the downloads running (progress,
// speed, time left, cancel) and the finished ones (how they ended, download
// again, forget). The same design as the uploads panel (Transfers.tsx); see
// download.ts.

import { ArrowDownToLine, RotateCw, X } from 'lucide-react';
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
import { duration, TransferRow, TransferTray } from './TransferPanel';

/** The line under a download's name: how far it is or how it ended. */
export function downloadDetail(x: Download): string {
  switch (x.status) {
    case 'starting':
      return t(x.waiting ? 'downloads.waiting' : 'downloads.starting');
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

function Row({ x }: { x: Download }) {
  const home = useStore((s) => s.machines[x.m]?.info?.home);
  const first = shortPath(x.paths[0] ?? '', home);
  const where = x.paths.length > 1 ? t('downloads.paths', { path: first, n: x.paths.length - 1 }) : first;
  const running = x.status === 'starting' || x.status === 'downloading';
  const known = x.size !== undefined && x.status === 'downloading';
  return (
    <TransferRow
      status={x.status}
      icon={ArrowDownToLine}
      name={x.name}
      machine={x.machine}
      where={where}
      whereTitle={x.paths.join('\n')}
      bar={running ? { pct: known ? (x.size ? Math.min(100, (x.sent / x.size) * 100) : 0) : undefined } : undefined}
      detail={downloadDetail(x)}
      ended={x.ended}
    >
      {running ? (
        <button className="icon" title={t('downloads.cancel')} aria-label={t('downloads.cancel')} onClick={() => cancelDownload(x.id)}>
          <X />
        </button>
      ) : (
        <>
          <button className="icon" title={t('downloads.retry')} aria-label={t('downloads.retry')} onClick={() => retryDownload(x)}>
            <RotateCw />
          </button>
          <button className="icon" title={t('transfers.forget')} aria-label={t('transfers.forget')} onClick={() => forgetDownload(x.id)}>
            <X />
          </button>
        </>
      )}
    </TransferRow>
  );
}

/** Status bar entry: the downloads of this browser. */
export function DownloadsTray() {
  return (
    <TransferTray
      list={useDownloads}
      icon={ArrowDownToLine}
      title={t('downloads.title')}
      none={t('downloads.none')}
      count={(active) => {
        const { sent, size } = downloadsProgress(active);
        return size === undefined || size === 0
          ? String(active.length)
          : t('transfers.tray', { n: active.length, pct: Math.floor((Math.min(sent, size) / size) * 100) });
      }}
      canCancelAll={(active) => active.length > 1}
      cancelAll={cancelAllDownloads}
      clear={clearDownloadHistory}
      row={Row}
    />
  );
}
