// The uploads panel: a status bar button, shown once this browser has
// uploaded a pasted or dropped file, opens a list of the uploads running and
// waiting (progress, speed, time left, cancel) and the finished ones
// (preview, copy the path, forget). See transfers.ts.

import { useCallback, useRef } from 'react';
import { ArrowUpFromLine, Ban, CircleAlert, CircleCheck, Copy, Eye, X } from 'lucide-react';
import { useStore } from '../state/store';
import { locale, t } from '../i18n';
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
import { useDismiss } from './useDismiss';

export function duration(ms: number): string {
  if (ms < 1000) return t('transfers.underSecond');
  const s = Math.round(ms / 1000);
  if (s < 60) return t('transfers.seconds', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('transfers.minutes', { m, s: s % 60 });
  return t('transfers.hours', { h: Math.floor(m / 60), m: m % 60 });
}

function when(ms: number): string {
  const d = new Date(ms);
  const today = d.toDateString() === new Date().toDateString();
  return today
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

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

const icons = { done: CircleCheck, failed: CircleAlert, cancelled: Ban };

function Row({ x }: { x: Transfer }) {
  const home = useStore((s) => s.machines[x.m]?.info?.home);
  const known = useStore((s) => !!s.machines[x.m]);
  const where = x.path ? shortPath(x.path, home) : x.dir ? shortPath(x.dir, home) : t('transfers.uploadDir');
  const pct = x.size ? Math.min(100, (x.sent / x.size) * 100) : 100;
  const running = x.status === 'uploading' || x.status === 'finishing';
  const finished = x.status === 'done' || x.status === 'failed' || x.status === 'cancelled';
  const Icon = finished ? icons[x.status as keyof typeof icons] : ArrowUpFromLine;
  return (
    <div className={`transfer ${x.status}`}>
      <Icon className="transfer-icon" />
      <div className="transfer-body">
        <div className="transfer-name ellipsis" title={x.name}>
          {x.name}
        </div>
        <div className="muted small ellipsis" title={x.path ?? x.dir}>
          {x.machine} · {where}
        </div>
        {running && (
          <div className="transfer-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className={`small transfer-detail ${x.status === 'failed' ? 'error' : 'muted'}`}>
          <span className="ellipsis" title={x.status === 'failed' ? x.error : undefined}>
            {detail(x)}
          </span>
          {finished && x.ended !== undefined && <span className="transfer-when">{when(x.ended)}</span>}
        </div>
      </div>
      <div className="transfer-actions">
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
      </div>
    </div>
  );
}

/** Status bar entry: the uploads of this browser. */
export function TransfersTray() {
  const active = useTransfers((s) => s.active);
  const history = useTransfers((s) => s.history);
  const open = useTransfers((s) => s.panel);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => useTransfers.getState().setPanel(false), []);
  useDismiss(open, ref, close);
  if (!active.length && !history.length && !open) return null;
  const { sent, size } = activeProgress(active);
  const pct = size ? Math.floor((sent / size) * 100) : 0;
  const busy = active.length > 0;
  const stoppable = active.filter(cancellable).length;
  return (
    <span className="gui-menu-anchor" ref={ref}>
      <button
        className={`gui-tray transfers-tray ${busy ? 'attention' : ''}`}
        title={t('transfers.title')}
        aria-label={t('transfers.title')}
        aria-expanded={open}
        onClick={() => useTransfers.getState().setPanel(!open)}
      >
        <ArrowUpFromLine />
        {busy && <span className="gui-count">{t('transfers.tray', { n: active.length, pct })}</span>}
      </button>
      {open && (
        <div className="gui-menu transfers-panel" role="dialog" aria-label={t('transfers.title')}>
          <div className="transfers-head">
            <span className="transfers-title">{t('transfers.title')}</span>
            <span className="spacer" />
            {stoppable > 1 && <button onClick={cancelAllUploads}>{t('transfers.cancelAll')}</button>}
            {history.length > 0 && <button onClick={clearUploadHistory}>{t('transfers.clear')}</button>}
          </div>
          {!active.length && !history.length && <div className="muted small transfers-empty">{t('transfers.none')}</div>}
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
