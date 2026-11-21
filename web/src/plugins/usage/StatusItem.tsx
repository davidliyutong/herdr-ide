// The status bar's AI usage item (usage.statusBar): the tightest window of
// all accounts, in the warning color from the first threshold on; a click
// shows the panel, and the mouse resting on it shows a card with a line per
// account (the tightest first) and today's spend once the cost report is
// loaded.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { useSettings } from '../../settings';
import { togglePanel } from '../../components/RightBar';
import { useHoverOpen } from '../../components/useHoverOpen';
import { t } from '../../i18n';
import { fetchSnapshot, useUsage } from './state';
import {
  costOf,
  duration,
  money,
  parseThresholds,
  providerName,
  sortAccounts,
  tightest,
  tightestWindow,
  tokens,
  windowName,
} from './model';
import { Bar, tokensOf } from './UsagePanel';
import { ProviderLogo, providerColor } from './logos';

/** Accounts the card lists. */
const MAX_ACCOUNTS = 6;

export function UsageStatusItem() {
  const snapshot = useUsage((s) => s.snapshot);
  const remaining = useUsage((s) => s.remaining);
  const cost = useUsage((s) => s.cost);
  const thresholds = useSettings((s) => s.values['usage.thresholds']?.value);
  const shown = useSettings((s) => s.values['usage.statusBar']?.value !== false);
  const [open, setOpen] = useState(false);
  const hover = useHoverOpen(open, setOpen);
  const id = useId();
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!useUsage.getState().snapshot) void fetchSnapshot();
  }, []);
  // Right-aligned to the item, moved in where the screen's left edge cuts it.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    el.style.transform = '';
    const left = el.getBoundingClientRect().left;
    if (left < 8) el.style.transform = `translateX(${8 - left}px)`;
  });
  const close = useCallback(() => {
    hover.cancel();
    setOpen(false);
  }, [hover]);
  const top = tightest(snapshot);
  if (!top || !shown) return null;
  const warnAt = parseThresholds(thresholds)[0] ?? 80;
  const levelOf = (used: number) => (used >= 100 ? 'out' : used >= warnAt ? 'warn' : '');
  const pctOf = (used: number) => t(remaining ? 'usage.pctLeft' : 'usage.pctUsed', { pct: Math.round(remaining ? 100 - used : used) });
  const label = pctOf(top.window.usedPct);
  const level = levelOf(top.window.usedPct);
  const what = `${providerName(top.account.provider)} · ${windowName(top.window)}`;
  const nowSec = Date.now() / 1000;
  const rows = sortAccounts(snapshot?.accounts ?? [])
    .filter((a) => tightestWindow(a, nowSec))
    .slice(0, MAX_ACCOUNTS);
  // The email tells apart accounts of one service only.
  const shared = new Set(rows.map((a) => a.provider).filter((p, i, all) => all.indexOf(p) !== i));
  const today = cost ? t('usage.hover.today', { cost: money(costOf(cost.rows, 1)), tokens: tokens(tokensOf(cost.rows, 1)) }) : '';
  return (
    <span className="gui-menu-anchor" {...hover.anchor}>
      <button
        className={`usage-status-item ${level}`}
        aria-label={t('usage.statusTitle', { what, pct: label })}
        aria-describedby={open ? id : undefined}
        onClick={() => {
          close();
          togglePanel('usage');
        }}
      >
        <Gauge />
        <span>{label}</span>
      </button>
      {open && (
        <div ref={card} id={id} className="gui-menu usage-hover" role="tooltip">
          {rows.map((a) => {
            const w = tightestWindow(a, nowSec)!;
            return (
              <div
                key={a.key}
                className={`usage-hover-row level-${levelOf(w.usedPct) || 'ok'}`}
                data-account={a.key}
                style={{ '--brand': providerColor(a.provider) } as React.CSSProperties}
              >
                <div className="usage-hover-line">
                  <ProviderLogo provider={a.provider} />
                  <b className="ellipsis">{providerName(a.provider)}</b>
                  {a.email && shared.has(a.provider) && <span className="muted ellipsis usage-hover-id">{a.email}</span>}
                  <span className="spacer" />
                  <b className="usage-pct">{pctOf(w.usedPct)}</b>
                </div>
                <div className="usage-hover-line muted">
                  <span className="ellipsis">{windowName(w)}</span>
                  <span className="spacer" />
                  {w.resetsAt ? <span>{t('usage.resetsIn', { in: duration(w.resetsAt - nowSec) })}</span> : null}
                </div>
                <Bar w={w} remaining={remaining} small />
              </div>
            );
          })}
          {today && <div className="usage-hover-today">{today}</div>}
        </div>
      )}
    </span>
  );
}
