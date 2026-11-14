// The uploads panel: a status bar button, shown once this browser has
// uploaded a pasted or dropped file, opens a list of the uploads running and
// waiting (progress, speed, time left, cancel) and the finished ones
// (preview, copy the path, forget). See transfers.ts.

import { ArrowUpFromLine, Copy, Eye, X } from 'lucide-react';
import { useStore } from '../state/store';
import { t } from '../i18n';
import { formatSize } from '../lib/files';
import { shortPath } from '../lib/herdr';
import {
  activeProgress,
  cancelAllUploads,
  cancelUpload,
  cancellable,
  clearUploadHistory,
  forgetUpload,
  useTransfers,
  type Transfer,
} from '../transfers';
import { duration, TransferRow, TransferTray } from './TransferPanel';

export { duration, when } from './TransferPanel';

/** The line under an upload's name: how far it is or how it ended. */
export function detail(x: Transfer): string {
  switch (x.status) {
    case 'queued':
      return t('transfers.queued');
    case 'uploading': {
      const line = t('transfers.progress', { sent: formatSize(x.sent), size: formatSize(x.size), speed: formatSize(Math.round(x.speed)) });
      return x.speed > 0 ? `${line} · ${t('transfers.left', { time: duration(((x.size - x.sent) * 1000) / x.speed) })}` : line;
    }
    case 'finishing':
      return t('transfers.finishing');
    case 'done':
      return x.started !== undefined && x.ended !== undefined
        ? t('transfers.doneIn', { size: formatSize(x.size), time: duration(x.ended - x.started), speed: formatSize(Math.round(x.speed)) })
        : formatSize(x.size);
    case 'failed':
      return x.error || t('transfers.failed');
    case 'cancelled':
      return t('transfers.cancelled');
  }
}

function Row({ x }: { x: Transfer }) {
  const home = useStore((s) => s.machines[x.m]?.info?.home);
  const known = useStore((s) => !!s.machines[x.m]);
  const where = x.path ? shortPath(x.path, home) : x.dir ? shortPath(x.dir, home) : t('transfers.uploadDir');
  const running = x.status === 'uploading' || x.status === 'finishing';
  const finished = x.status === 'done' || x.status === 'failed' || x.status === 'cancelled';
  return (
    <TransferRow
      status={x.status}
      icon={ArrowUpFromLine}
      name={x.name}
      machine={x.machine}
      where={where}
      whereTitle={x.path ?? x.dir}
      bar={running ? { pct: x.size ? Math.min(100, (x.sent / x.size) * 100) : 100 } : undefined}
      detail={detail(x)}
      detailTitle={x.status === 'failed' ? x.error : undefined}
      ended={x.ended}
    >
      {cancellable(x) && (
        <button className="icon" title={t('transfers.cancel')} aria-label={t('transfers.cancel')} onClick={() => cancelUpload(x.id)}>
          <X />
        </button>
      )}
      {x.status === 'done' && x.path && (
        <>
          <button
            className="icon"
            title={t('transfers.preview')}
            aria-label={t('transfers.preview')}
            disabled={!known}
            onClick={() => {
              useTransfers.getState().setPanel(false);
              useStore.getState().openDock({ kind: 'preview', m: x.m, path: x.path! });
            }}
          >
            <Eye />
          </button>
          <button
            className="icon"
            title={t('transfers.copyPath')}
            aria-label={t('transfers.copyPath')}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(x.path!)
                .then(() => useStore.getState().toast(t('transfers.copied', { path: x.path! })))
                .catch(() => {});
            }}
          >
            <Copy />
          </button>
        </>
      )}
      {finished && (
        <button className="icon" title={t('transfers.forget')} aria-label={t('transfers.forget')} onClick={() => forgetUpload(x.id)}>
          <X />
        </button>
      )}
    </TransferRow>
  );
}

/** Status bar entry: the uploads of this browser. */
export function TransfersTray() {
  return (
    <TransferTray
      list={useTransfers}
      icon={ArrowUpFromLine}
      title={t('transfers.title')}
      none={t('transfers.none')}
      count={(active) => {
        const { sent, size } = activeProgress(active);
        return t('transfers.tray', { n: active.length, pct: size ? Math.floor((sent / size) * 100) : 0 });
      }}
      canCancelAll={(active) => active.filter(cancellable).length > 1}
      cancelAll={cancelAllUploads}
      clear={clearUploadHistory}
      row={Row}
    />
  );
}
