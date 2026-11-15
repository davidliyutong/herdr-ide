// The AI usage panel of the right sidebar: the accounts the machines'
// CLIs are signed in to, tightest first, with their windows (bar, reset
// countdown, pace marker, burndown), credits and balances, incidents of
// the providers' status pages and the machines they were seen on; and the
// Cost tab with the local logs' cost at API prices.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../state/store';
import { useSettings } from '../../settings';
import { t } from '../../i18n';
import { fetchCost, fetchSnapshot, refreshNow, setDeepseekKey, setView, useUsage } from './state';
import {
  costOf,
  daily,
  duration,
  equivalents,
  money,
  providerName,
  rank,
  sortAccounts,
  tokens,
  windowName,
  type CostReport,
  type RankBy,
  type UsageAccount,
  type UsageWindow,
} from './model';

/** Seconds since the epoch, every 30 s. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function UsagePanel() {
  const tab = useUsage((s) => s.tab);
  // While the panel is open the core asks every 2 minutes (adaptive).
  useEffect(() => {
    void fetchSnapshot(true);
    const id = setInterval(() => void fetchSnapshot(true), 60_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="usage-panel">
      <div className="usage-tabs" role="tablist">
        {(['limits', 'cost'] as const).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setView({ tab: id })}
          >
            {t(`usage.tab.${id}`)}
          </button>
        ))}
      </div>
      {tab === 'limits' ? <Limits /> : <Cost />}
    </div>
  );
}

function Limits() {
  const snapshot = useUsage((s) => s.snapshot);
  const remaining = useUsage((s) => s.remaining);
  const compact = useUsage((s) => s.compact);
  const readOnly = useSettings((s) => s.readOnly);
  const now = useNow();
  const [error, setError] = useState<string>();
  const accounts = useMemo(() => sortAccounts(snapshot?.accounts ?? []), [snapshot]);
  const refresh = async () => {
    setError(undefined);
    const err = await refreshNow();
    if (err) setError(t('usage.refreshFailed', { code: err }));
  };
  return (
    <>
      <div className="usage-toolbar">
        <button
          className={`usage-toggle ${remaining ? 'on' : ''}`}
          aria-pressed={remaining}
          onClick={() => setView({ remaining: !remaining })}
        >
          {remaining ? t('usage.showRemaining') : t('usage.showUsed')}
        </button>
        <button className={`usage-toggle ${compact ? 'on' : ''}`} aria-pressed={compact} onClick={() => setView({ compact: !compact })}>
          {compact ? t('usage.compact') : t('usage.detailed')}
        </button>
        <span className="spacer" />
        <button
          className="icon usage-refresh"
          title={t('usage.refresh')}
          aria-label={t('usage.refresh')}
          disabled={readOnly || snapshot?.polling}
          onClick={() => void refresh()}
        >
          <RefreshCw className={snapshot?.polling ? 'spin' : ''} />
        </button>
      </div>
      <div className="usage-meta muted small">
        {snapshot?.updatedAt ? t('usage.updated', { ago: duration(now - snapshot.updatedAt) }) : t('usage.never')}
        {snapshot?.nextAt ? ` · ${t('usage.next', { in: duration(snapshot.nextAt - now) })}` : ''}
        {snapshot?.refresh === 'manual' ? ` · ${t('usage.manual')}` : ''}
      </div>
      {error && <p className="error small usage-error">{error}</p>}
      {snapshot && accounts.length === 0 && <p className="muted small usage-empty">{t('usage.empty')}</p>}
      <div className="usage-accounts">
        {accounts.map((a) => (
          <AccountCard key={a.key} account={a} remaining={remaining} compact={compact} now={now} />
        ))}
      </div>
      {!readOnly && <DeepseekKey />}
    </>
  );
}

function AccountCard({
  account: a,
  remaining,
  compact,
  now,
}: {
  account: UsageAccount;
  remaining: boolean;
  compact: boolean;
  now: number;
}) {
  const labels = useStore(useShallow((s) => Object.fromEntries(Object.entries(s.machines).map(([id, st]) => [id, st.label]))));
  const incident = useUsage((s) => s.snapshot?.status[a.provider]);
  const bad = incident?.indicator && incident.indicator !== 'none';
  const windows = compact
    ? a.windows
        .slice()
        .sort((x, y) => y.usedPct - x.usedPct)
        .slice(0, 1)
    : a.windows;
  return (
    <section className={`usage-card status-${a.status} ${compact ? 'compact' : ''}`} data-account={a.key}>
      <header className="usage-card-head">
        <span className="usage-provider">{providerName(a.provider)}</span>
        {a.plan && <span className="usage-plan">{a.plan}</span>}
        <span className="spacer" />
        {bad && (
          <a
            className={`usage-incident ${incident.indicator}`}
            href={incident.url}
            target="_blank"
            rel="noreferrer"
            title={incident.description}
          >
            <AlertTriangle />
            {t('usage.incident')}
          </a>
        )}
        {a.status !== 'ok' && <span className={`usage-status ${a.status}`}>{t(`usage.status.${a.status}` as 'usage.status.stale')}</span>}
      </header>
      {!compact && a.email && <div className="usage-email muted small ellipsis">{a.email}</div>}
      {a.status !== 'ok' && !compact && <div className="usage-hint small">{hint(a)}</div>}
      {windows.map((w) => (
        <WindowRow key={`${w.kind}|${w.label ?? ''}`} w={w} remaining={remaining} compact={compact} now={now} />
      ))}
      {!compact && <Money account={a} />}
      {!compact && a.machines.length > 0 && (
        <div className="usage-machines muted small ellipsis">
          {t('usage.seenOn', { machines: a.machines.map((m) => labels[m] ?? m).join(', ') })}
          {a.fetchedAt && a.status !== 'ok' ? ` · ${t('usage.asOf', { ago: duration(now - a.fetchedAt) })}` : ''}
        </div>
      )}
    </section>
  );
}

/** What to do about an account that is not ok. */
function hint(a: UsageAccount): string {
  if (a.code === 'token_expired') return t('usage.hint.expired', { cli: providerName(a.provider) });
  if (a.code === 'from_log') return t('usage.hint.fromLog');
  if (a.status === 'unauth') return t('usage.hint.unauth', { cli: providerName(a.provider) });
  if (a.code === 'rate_limited') return t('usage.hint.rateLimited');
  return t('usage.hint.error', { code: a.code ?? a.status });
}

function WindowRow({ w, remaining, compact, now }: { w: UsageWindow; remaining: boolean; compact: boolean; now: number }) {
  const thresholds = useSettings((s) => s.values['usage.thresholds']?.value);
  const warnAt = Array.isArray(thresholds) && thresholds.length ? Number(thresholds[0]) : 80;
  const shown = remaining ? 100 - w.usedPct : w.usedPct;
  const level = w.usedPct >= 100 ? 'out' : w.usedPct >= warnAt ? 'warn' : '';
  return (
    <div className={`usage-window ${level}`} data-window={w.kind}>
      <div className="usage-window-line small">
        <span className="usage-window-name ellipsis">{windowName(w)}</span>
        <span className="usage-pct">{t(remaining ? 'usage.pctLeft' : 'usage.pctUsed', { pct: Math.round(shown) })}</span>
        {w.resetsAt ? <span className="muted">{t('usage.resetsIn', { in: duration(w.resetsAt - now) })}</span> : null}
      </div>
      <div
        className="usage-bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown)}
        aria-label={windowName(w)}
      >
        <div className="usage-bar-fill" style={{ width: `${Math.min(100, Math.max(0, shown))}%` }} />
        {w.pace && (
          <div
            className="usage-pace"
            title={t('usage.paceMarker')}
            style={{ left: `${Math.min(100, remaining ? 100 - w.pace.expectedPct : w.pace.expectedPct)}%` }}
          />
        )}
      </div>
      {!compact && w.pace?.beforeReset && w.pace.exhaustsAt && w.usedPct < 100 && (
        <div className="usage-pace-warn small">{t('usage.runsOut', { in: duration(w.pace.exhaustsAt - now) })}</div>
      )}
      {!compact && w.history && w.history.length > 1 && <Burndown points={w.history} w={w} remaining={remaining} />}
    </div>
  );
}

/** The window's use over its period, as a sparkline. */
function Burndown({ points, w, remaining }: { points: [number, number][]; w: UsageWindow; remaining: boolean }) {
  const W = 200;
  const H = 24;
  const t0 = w.resetsAt && w.windowSec ? w.resetsAt - w.windowSec : points[0][0];
  const t1 = w.resetsAt && w.windowSec ? w.resetsAt : points[points.length - 1][0];
  const span = Math.max(1, t1 - t0);
  const d = points
    .map(([ts, pct], i) => {
      const x = ((ts - t0) / span) * W;
      const y = H - ((remaining ? 100 - pct : pct) / 100) * H;
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg className="usage-burndown" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={t('usage.burndown')}>
      <path d={d} />
    </svg>
  );
}

function Money({ account: a }: { account: UsageAccount }) {
  const c = a.credits;
  const parts: string[] = [];
  if (c) {
    const unit = (v: number) => (c.unit === 'usd' ? money(v) : v.toFixed(2).replace(/\.00$/, ''));
    if (c.unlimited) parts.push(t('usage.credits.unlimited'));
    else if (c.balance !== undefined) parts.push(t('usage.credits.balance', { v: unit(c.balance) }));
    if (c.used !== undefined && c.limit !== undefined) parts.push(t('usage.credits.usedOf', { used: unit(c.used), limit: unit(c.limit) }));
    if (c.enabled === false) parts.push(t('usage.credits.off'));
  }
  for (const b of a.balances ?? []) parts.push(t('usage.balance', { v: b.total.toFixed(2), currency: b.currency }));
  if (a.available === false) parts.push(t('usage.unavailable'));
  if (!parts.length) return null;
  return <div className="usage-money small">{parts.join(' · ')}</div>;
}

/** The DeepSeek key file of a machine (written there, never shown). */
function DeepseekKey() {
  // Strings only: useShallow compares the items, and new objects would differ every time.
  const ids = useStore(useShallow((s) => s.order.filter((id) => s.machines[id]?.status === 'ready')));
  const names = useStore(useShallow((s) => ids.map((id) => s.machines[id]?.label ?? id)));
  const machines = ids.map((id, i) => ({ id, label: names[i] }));
  const [open, setOpen] = useState(false);
  const [m, setM] = useState('');
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<string>();
  if (!machines.length) return null;
  const target = m || machines[0].id;
  const save = async (value: string) => {
    setMsg(undefined);
    const err = await setDeepseekKey(target, value);
    setMsg(err ? t('usage.deepseek.failed', { code: err }) : value ? t('usage.deepseek.saved') : t('usage.deepseek.removed'));
    if (!err) setKey('');
  };
  return (
    <details className="usage-deepseek" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="small">{t('usage.deepseek.title')}</summary>
      <p className="muted small">{t('usage.deepseek.about')}</p>
      <div className="usage-deepseek-form">
        <select value={target} onChange={(e) => setM(e.target.value)} aria-label={t('usage.deepseek.machine')}>
          {machines.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <input
          type="password"
          autoComplete="off"
          value={key}
          placeholder={t('usage.deepseek.placeholder')}
          aria-label={t('usage.deepseek.placeholder')}
          onChange={(e) => setKey(e.target.value)}
        />
        <button disabled={!key.trim()} onClick={() => void save(key.trim())}>
          {t('usage.deepseek.save')}
        </button>
        <button onClick={() => void save('')}>{t('usage.deepseek.remove')}</button>
      </div>
      {msg && <p className="small">{msg}</p>}
    </details>
  );
}

// ---- cost ----

function Cost() {
  const { cost, costLoading, costError, costDays } = useUsage(
    useShallow((s) => ({ cost: s.cost, costLoading: s.costLoading, costError: s.costError, costDays: s.costDays })),
  );
  useEffect(() => {
    if (!useUsage.getState().cost) void fetchCost();
  }, []);
  return (
    <>
      <div className="usage-toolbar">
        {([7, 30, 90] as const).map((d) => (
          <button
            key={d}
            className={`usage-toggle ${costDays === d ? 'on' : ''}`}
            aria-pressed={costDays === d}
            onClick={() => setView({ costDays: d })}
          >
            {t('usage.cost.days', { n: d })}
          </button>
        ))}
        <span className="spacer" />
        <button
          className="icon usage-refresh"
          title={t('usage.refresh')}
          aria-label={t('usage.refresh')}
          disabled={costLoading}
          onClick={() => void fetchCost()}
        >
          <RefreshCw className={costLoading ? 'spin' : ''} />
        </button>
      </div>
      {costError && <p className="error small usage-error">{t('usage.cost.failed', { code: costError })}</p>}
      {!cost && costLoading && <p className="muted small usage-empty">{t('usage.cost.loading')}</p>}
      {cost && <CostBody cost={cost} days={costDays} />}
    </>
  );
}

function CostBody({ cost, days }: { cost: CostReport; days: number }) {
  const labels = useStore(useShallow((s) => Object.fromEntries(Object.entries(s.machines).map(([id, st]) => [id, st.label]))));
  const [by, setBy] = useState<RankBy>('model');
  const today = new Date();
  const rows = cost.rows;
  const total = costOf(rows, days, today);
  const eq = equivalents(total, days, cost.weekHours, cost.monthHours);
  const series = daily(rows, days, today);
  const ranking = rank(rows, by, days, today, (r) => (by === 'machine' ? (labels[r.machine] ?? r.machine) : (r[by] ?? ''))).slice(0, 10);
  const failed = Object.entries(cost.machines).filter(([, m]) => m.error);
  const unpriced = [...new Set(Object.values(cost.machines).flatMap((m) => m.unpriced ?? []))];
  return (
    <div className="usage-cost">
      <div className="usage-totals">
        {([1, 7, 30, 90] as const).map((n) => (
          <div key={n} className="usage-total">
            <div className="muted small">{n === 1 ? t('usage.cost.today') : t('usage.cost.days', { n })}</div>
            <div className="usage-total-value">{money(costOf(rows, n, today))}</div>
          </div>
        ))}
      </div>
      <DailyBars series={series} />
      <div className="usage-equiv small">{t('usage.cost.equivalent', { week: money(eq.week), month: money(eq.month), days })}</div>
      <div className="usage-toolbar">
        {(['model', 'project', 'machine'] as const).map((b) => (
          <button key={b} className={`usage-toggle ${by === b ? 'on' : ''}`} aria-pressed={by === b} onClick={() => setBy(b)}>
            {t(`usage.cost.by.${b}`)}
          </button>
        ))}
      </div>
      <ol className="usage-rank">
        {ranking.map((r) => (
          <li key={r.name}>
            <span className="ellipsis">{r.name}</span>
            <span className="muted small">{tokens(r.tokens)}</span>
            <span className="usage-rank-cost">{money(r.cost)}</span>
            <div className="usage-rank-bar" style={{ width: `${ranking[0].cost ? (r.cost / ranking[0].cost) * 100 : 0}%` }} />
          </li>
        ))}
      </ol>
      {ranking.length === 0 && <p className="muted small usage-empty">{t('usage.cost.empty')}</p>}
      <p className="muted small">{t('usage.cost.about')}</p>
      {unpriced.length > 0 && <p className="muted small">{t('usage.cost.unpriced', { models: unpriced.join(', ') })}</p>}
      {failed.map(([m, x]) => (
        <p key={m} className="error small">
          {t('usage.cost.machineFailed', { m: labels[m] ?? m, code: x.error ?? '' })}
        </p>
      ))}
    </div>
  );
}

/** The cost per day, as bars (plain SVG). */
function DailyBars({ series }: { series: { day: string; cost: number }[] }) {
  const W = 300;
  const H = 80;
  const max = Math.max(...series.map((s) => s.cost), 0.01);
  const bw = W / series.length;
  return (
    <svg className="usage-daily" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={t('usage.cost.daily')}>
      {series.map((s, i) => {
        const h = (s.cost / max) * (H - 2);
        return (
          <rect key={s.day} x={i * bw + bw * 0.1} y={H - h} width={bw * 0.8} height={h}>
            <title>{`${s.day}: ${money(s.cost)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
