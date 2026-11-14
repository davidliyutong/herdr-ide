// What the uploads and downloads panels share (Transfers.tsx,
// Downloads.tsx): the status bar button with the panel it opens, a row per
// transfer, and how durations and times are written.

import { useCallback, useRef, type ComponentType, type ReactNode } from 'react';
import { Ban, CircleAlert, CircleCheck, type LucideIcon } from 'lucide-react';
import type { StoreApi, UseBoundStore } from 'zustand';
import { locale, t } from '../i18n';
import type { ListState } from '../transferList';
import { useDismiss } from './useDismiss';

export function duration(ms: number): string {
  if (ms < 1000) return t('transfers.underSecond');
  const s = Math.round(ms / 1000);
  if (s < 60) return t('transfers.seconds', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('transfers.minutes', { m, s: s % 60 });
  return t('transfers.hours', { h: Math.floor(m / 60), m: m % 60 });
}

export function when(ms: number): string {
  const d = new Date(ms);
  const today = d.toDateString() === new Date().toDateString();
  return today
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const icons: Record<string, LucideIcon> = { done: CircleCheck, failed: CircleAlert, cancelled: Ban };

export interface RowProps {
  status: string;
  /** The icon while it runs or waits; a finished one shows how it ended. */
  icon: LucideIcon;
  name: string;
  machine: string;
  /** Where on the machine, and its full form. */
  where: string;
  whereTitle?: string;
  /** The bar of a running transfer: the share done, undefined while the
   * size is not known (a moving bar). Absent: no bar. */
  bar?: { pct?: number };
  /** How far it is or how it ended, and its full form. */
  detail: string;
  detailTitle?: string;
  ended?: number;
  children?: ReactNode;
}

const FINISHED = new Set(['done', 'failed', 'cancelled']);

/** One transfer: its name, machine and place, a bar while it runs, how far
 * it is or how it ended, and its buttons (children). */
export function TransferRow(p: RowProps) {
  const finished = FINISHED.has(p.status);
  const Icon = (finished && icons[p.status]) || p.icon;
  const known = p.bar?.pct !== undefined;
  return (
    <div className={`transfer ${p.status}`}>
      <Icon className="transfer-icon" />
      <div className="transfer-body">
        <div className="transfer-name ellipsis" title={p.name}>
          {p.name}
        </div>
        <div className="muted small ellipsis" title={p.whereTitle}>
          {p.machine} · {p.where}
        </div>
        {p.bar && (
          <div
            className={`transfer-bar ${known ? '' : 'indeterminate'}`}
            role="progressbar"
            aria-valuenow={known ? Math.round(p.bar.pct!) : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div style={known ? { width: `${p.bar.pct}%` } : undefined} />
          </div>
        )}
        <div className={`small transfer-detail ${p.status === 'failed' ? 'error' : 'muted'}`}>
          <span className="ellipsis" title={p.detailTitle}>
            {p.detail}
          </span>
          {finished && p.ended !== undefined && <span className="transfer-when">{when(p.ended)}</span>}
        </div>
      </div>
      <div className="transfer-actions">{p.children}</div>
    </div>
  );
}

export interface TrayProps<T extends { id: string }> {
  list: UseBoundStore<StoreApi<ListState<T>>>;
  icon: LucideIcon;
  title: string;
  /** Shown in an empty panel. */
  none: string;
  /** The button's count while some run. */
  count(active: T[]): string;
  /** Whether Cancel all is offered, and what it does. */
  canCancelAll(active: T[]): boolean;
  cancelAll(): void;
  clear(): void;
  /** The row of one transfer. */
  row: ComponentType<{ x: T }>;
}

/** A status bar button, shown once this browser has such transfers, and the
 * panel it opens: the running ones, then the finished ones. */
export function TransferTray<T extends { id: string }>(p: TrayProps<T>) {
  const { list } = p;
  const active = list((s) => s.active);
  const history = list((s) => s.history);
  const open = list((s) => s.panel);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => list.getState().setPanel(false), [list]);
  useDismiss(open, ref, close);
  if (!active.length && !history.length && !open) return null;
  const busy = active.length > 0;
  const Icon = p.icon;
  const Row = p.row;
  return (
    <span className="gui-menu-anchor" ref={ref}>
      <button
        className={`gui-tray transfers-tray ${busy ? 'attention' : ''}`}
        title={p.title}
        aria-label={p.title}
        aria-expanded={open}
        onClick={() => list.getState().setPanel(!open)}
      >
        <Icon />
        {busy && <span className="gui-count">{p.count(active)}</span>}
      </button>
      {open && (
        <div className="gui-menu transfers-panel" role="dialog" aria-label={p.title}>
          <div className="transfers-head">
            <span className="transfers-title">{p.title}</span>
            <span className="spacer" />
            {p.canCancelAll(active) && <button onClick={p.cancelAll}>{t('transfers.cancelAll')}</button>}
            {history.length > 0 && <button onClick={p.clear}>{t('transfers.clear')}</button>}
          </div>
          {!active.length && !history.length && <div className="muted small transfers-empty">{p.none}</div>}
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
