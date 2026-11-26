// The status bar's AI usage item (usage.statusBar): the tightest window
// that counts the coding agent in the focused pane (its service's, on its
// machine, its model's among the windows of models; useFocusedAgent), else
// the tightest of all accounts, in the warning color from the first
// threshold on; a click
// shows the panel, and the mouse resting on it shows a card with a line per
// account (the tightest first) and today's spend once the cost report is
// loaded.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Gauge } from 'lucide-react';
import { useStore } from '../../state/store';
import { useSettings } from '../../settings';
import { togglePanel } from '../../components/RightBar';
import { useHoverOpen } from '../../components/useHoverOpen';
import { t } from '../../i18n';
import { fetchSnapshot, useUsage } from './state';
import {
  costOf,
  duration,
  is5hWindow,
  is7dWindow,
  isMergedAccount,
  money,
  parseThresholds,
  previewAccounts,
  providerName,
  statusBarSelection,
  tightestWindow,
  tokens,
  windowName,
  type StatusBarProvider,
  type StatusBarWindowMode,
  type UsageAccount,
  type UsageWindow,
} from './model';
import { Bar, tokensOf } from './UsagePanel';
import { ProviderLogo, providerColor } from './logos';
import { useFocusedAgent } from './focus';

/** Accounts the card lists. */
const MAX_ACCOUNTS = 6;

/** How close a window is to running out: out, warn from warnAt (the first
 * threshold) on, else "". */
export const levelOf = (used: number, warnAt: number) => (used >= 100 ? 'out' : used >= warnAt ? 'warn' : '');

/** A window's share as the panel's switch says it: used or left. */
export const pctText = (used: number, remaining: boolean) =>
  t(remaining ? 'usage.pctLeft' : 'usage.pctUsed', { pct: Math.round(remaining ? 100 - used : used) });

/** The first threshold of usage.thresholds (default 80). */
export const useWarnAt = () => parseThresholds(useSettings((s) => s.values['usage.thresholds']?.value))[0] ?? 80;

/** Keeps a status bar item's card right-aligned to the item, moved in where
 * the screen's left edge cuts it. */
export function useCardOnScreen(card: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    el.style.transform = '';
    const left = el.getBoundingClientRect().left;
    if (left < 8) el.style.transform = `translateX(${8 - left}px)`;
  });
}

/** An account's line in a status bar card: the service's mark and name,
 * the email when asked, its window's share, name and reset, and a thin bar
 * in the service's color. */
export function AccountLine({
  account: a,
  window: w,
  email,
  remaining,
  warnAt,
  nowSec,
}: {
  account: UsageAccount;
  window: UsageWindow;
  email: boolean;
  remaining: boolean;
  warnAt: number;
  nowSec: number;
}) {
  const merged = isMergedAccount(a);
  return (
    <div
      className={`usage-hover-row level-${levelOf(w.usedPct, warnAt) || 'ok'}`}
      data-account={a.key}
      style={{ '--brand': providerColor(a.provider) } as React.CSSProperties}
    >
      <div className="usage-hover-line">
        <ProviderLogo provider={a.provider} />
        <b className="ellipsis">{providerName(a.provider)}</b>
        {merged && <span className="muted ellipsis usage-hover-id">{t('usage.accountCount', { n: a.accountCount })}</span>}
        {!merged && a.email && email && <span className="muted ellipsis usage-hover-id">{a.email}</span>}
        <span className="spacer" />
        <b className="usage-pct">{pctText(w.usedPct, remaining)}</b>
      </div>
      <div className="usage-hover-line muted">
        <span className="ellipsis">{windowName(w)}</span>
        <span className="spacer" />
        {w.resetsAt ? <span>{t('usage.resetsIn', { in: duration(w.resetsAt - nowSec) })}</span> : null}
      </div>
      <Bar w={w} remaining={remaining} small />
      {merged && (
        <div className="usage-hover-members">
          {a.members.map((m) => {
            const mw = tightestWindow(m, nowSec);
            return (
              <div key={m.key} className="usage-hover-sub muted" data-member={m.key}>
                <span className="ellipsis">{m.email || m.plan || m.key}</span>
                <span className="spacer" />
                {mw && <span>{pctText(mw.usedPct, remaining)}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const VALID_WINDOWS = new Set<StatusBarWindowMode>(['auto', '5h', '7d', 'both']);
const VALID_PROVIDERS = new Set<StatusBarProvider>(['auto', 'claude', 'codex', 'grok', 'antigravity', 'kimi']);

/** Formats the status bar button label for the selected window(s) and mode. */
export function formatStatusBarLabel(
  primary: UsageWindow,
  secondary: UsageWindow | undefined,
  mode: StatusBarWindowMode,
  remaining: boolean,
): string {
  const shown = (w: UsageWindow) => Math.round(remaining ? 100 - w.usedPct : w.usedPct);
  if (mode === 'both' && secondary) {
    return t(remaining ? 'usage.statusBar.bothLeft' : 'usage.statusBar.both', { p5: shown(primary), p7: shown(secondary) });
  }
  if (mode === '5h' || (mode === 'both' && is5hWindow(primary))) {
    if (is5hWindow(primary))
      return t('usage.statusBar.windowPct', { window: t('usage.window.short.5h'), pct: pctText(primary.usedPct, remaining) });
  }
  if (mode === '7d' || (mode === 'both' && is7dWindow(primary))) {
    if (is7dWindow(primary))
      return t('usage.statusBar.windowPct', { window: t('usage.window.short.7d'), pct: pctText(primary.usedPct, remaining) });
  }
  return pctText(primary.usedPct, remaining);
}

export function UsageStatusItem() {
  const snapshot = useUsage((s) => s.snapshot);
  const remaining = useUsage((s) => s.remaining);
  const cost = useUsage((s) => s.cost);
  const warnAt = useWarnAt();
  const shown = useSettings((s) => s.values['usage.statusBar']?.value !== false);
  const windowMode = useSettings((s) => {
    const v = s.values['usage.statusBarWindow']?.value;
    return typeof v === 'string' && VALID_WINDOWS.has(v as StatusBarWindowMode) ? (v as StatusBarWindowMode) : 'auto';
  });
  const defaultProvider = useSettings((s) => {
    const v = s.values['usage.statusBarProvider']?.value;
    return typeof v === 'string' && VALID_PROVIDERS.has(v as StatusBarProvider) ? (v as StatusBarProvider) : 'auto';
  });
  const machineId = useStore((s) => s.machineId);
  const [open, setOpen] = useState(false);
  const hover = useHoverOpen(open, setOpen);
  const id = useId();
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!useUsage.getState().snapshot) void fetchSnapshot();
  }, []);
  useCardOnScreen(card);
  const close = useCallback(() => {
    hover.cancel();
    setOpen(false);
  }, [hover]);
  const agent = useFocusedAgent();
  const nowSec = Date.now() / 1000;
  const top = statusBarSelection(snapshot, { agent, defaultProvider, windowMode, machineId, now: nowSec });
  if (!top || !shown) return null;
  const label = formatStatusBarLabel(top.primary, top.secondary, windowMode, remaining);
  const worstPct = top.secondary ? Math.max(top.primary.usedPct, top.secondary.usedPct) : top.primary.usedPct;
  const level = levelOf(worstPct, warnAt);
  const what = top.secondary
    ? `${providerName(top.account.provider)} · ${windowName(top.primary)} / ${windowName(top.secondary)}`
    : `${providerName(top.account.provider)} · ${windowName(top.primary)}`;
  const rows = previewAccounts(snapshot?.accounts ?? [], nowSec)
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
        {top.showLogo ? <ProviderLogo provider={top.account.provider} /> : <Gauge />}
        <span>{label}</span>
      </button>
      {open && (
        <div ref={card} id={id} className="gui-menu usage-hover" role="tooltip">
          {rows.map((a) => (
            <AccountLine
              key={a.key}
              account={a}
              window={tightestWindow(a, nowSec)!}
              email={shared.has(a.provider)}
              remaining={remaining}
              warnAt={warnAt}
              nowSec={nowSec}
            />
          ))}
          {today && <div className="usage-hover-today">{today}</div>}
        </div>
      )}
    </span>
  );
}
