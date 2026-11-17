// The AI usage panel of the right sidebar, laid out as CodexBar: a tile per
// service at the top (its mark, its name and a bar in its color of what is
// left of its tightest window), then the overview (the spend and tokens of
// the local logs at API prices, a chart of the days in the services'
// colors, a row per account) or one service: its accounts with their
// windows (grouped by the model group they count, with the reset, the
// pace marker and how far ahead of an even pace they are), credits and
// balances, incidents of its status page and the machines it was seen on,
// and its own spend.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../state/store';
import { setSetting, useSettings } from '../../settings';
import { t } from '../../i18n';
import { type Metric, costStale, fetchCost, fetchSnapshot, refreshNow, setDeepseekKey, setView, useUsage, type UsageTab } from './state';
import {
  costOf,
  daily,
  duration,
  equivalents,
  money,
  parseThresholds,
  pastReset,
  PROVIDERS,
  providerName,
  rank,
  rankTokens,
  sortAccounts,
  dailyTokens,
  tightestWindow,
  tokenKinds,
  tokens,
  type CostReport,
  type CostRow,
  type RankBy,
  type TokenKinds,
  type UsageAccount,
  type UsageWindow,
} from './model';
import { OverviewLogo, ProviderLogo, providerColor } from './logos';
import './usage.css';

/** Seconds since the epoch, every 30 s. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** The services with an account or spend, in the order of PROVIDERS. */
function shownProviders(accounts: UsageAccount[], cost?: CostReport): string[] {
  const has = new Set([...accounts.map((a) => a.provider), ...(cost?.rows ?? []).map((r) => r.provider)]);
  const known = PROVIDERS.filter((p) => has.has(p));
  return [...known, ...[...has].filter((p) => !(PROVIDERS as readonly string[]).includes(p)).sort()];
}

export function UsagePanel() {
  const tab = useUsage((s) => s.tab);
  const snapshot = useUsage((s) => s.snapshot);
  const cost = useUsage((s) => s.cost);
  const deepseekOn = useSettings((s) => s.values['usage.providers.deepseek']?.value !== false);
  // While the panel is open and the page shown the core asks at
  // usage.refreshOpen (adaptive); a hidden page says nothing, so a
  // forgotten tab does not keep it asking. The cost is read again once it
  // is older than usage.costRefresh, else on demand.
  useEffect(() => {
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const look = () => {
      if (!visible()) return;
      void fetchSnapshot(true);
      if (costStale()) void fetchCost();
    };
    look();
    const id = setInterval(look, 60_000);
    document.addEventListener('visibilitychange', look);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', look);
    };
  }, []);
  const accounts = useMemo(() => sortAccounts(snapshot?.accounts ?? []), [snapshot]);
  const providers = useMemo(() => shownProviders(accounts, cost), [accounts, cost]);
  // DeepSeek's page has the form for its key, so it opens without one.
  const shown: UsageTab = tab === 'overview' || providers.includes(tab) || (tab === 'deepseek' && deepseekOn) ? tab : 'overview';
  return (
    <div className="usage-panel">
      <Tiles providers={providers} accounts={accounts} shown={shown} />
      <Meta />
      {shown === 'overview' ? (
        <Overview accounts={accounts} />
      ) : (
        <Provider provider={shown} accounts={accounts.filter((a) => a.provider === shown)} />
      )}
    </div>
  );
}

/** The tiles: the overview and each service, its bar what is left of its
 * tightest window. */
function Tiles({ providers, accounts, shown }: { providers: string[]; accounts: UsageAccount[]; shown: UsageTab }) {
  const left = (p: string) => {
    let min: number | undefined;
    for (const a of accounts) {
      if (a.provider !== p) continue;
      const w = tightestWindow(a);
      if (w) min = Math.min(min ?? 100, 100 - w.usedPct);
    }
    return min;
  };
  return (
    <div className="usage-tiles" role="tablist" aria-label={t('usage.title')}>
      <button
        role="tab"
        aria-selected={shown === 'overview'}
        className={`usage-tile ${shown === 'overview' ? 'on' : ''}`}
        onClick={() => setView({ tab: 'overview' })}
      >
        <OverviewLogo />
        <span className="usage-tile-name">{t('usage.overview')}</span>
        <span className="usage-tile-meter" />
      </button>
      {providers.map((p) => {
        const l = left(p);
        return (
          <button
            key={p}
            role="tab"
            aria-selected={shown === p}
            className={`usage-tile ${shown === p ? 'on' : ''}`}
            data-provider={p}
            style={{ '--brand': providerColor(p) } as React.CSSProperties}
            title={l === undefined ? providerName(p) : `${providerName(p)} · ${t('usage.pctLeft', { pct: Math.round(l) })}`}
            onClick={() => setView({ tab: p })}
          >
            <ProviderLogo provider={p} />
            <span className="usage-tile-name ellipsis">{providerName(p)}</span>
            <span className="usage-tile-meter">{l !== undefined && <i style={{ width: `${Math.max(2, l)}%` }} />}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The refresh modes of usage.refresh, as the settings list them. */
const REFRESH_MODES = ['adaptive', 'manual', '1', '2', '5', '15', '30', '60'] as const;

/** When the numbers were read, the used/left switch, how often to read
 * (usage.refresh) and Refresh. */
function Meta() {
  const snapshot = useUsage((s) => s.snapshot);
  const remaining = useUsage((s) => s.remaining);
  const readOnly = useSettings((s) => s.readOnly);
  const mode = useSettings((s) => String(s.values['usage.refresh']?.value ?? snapshot?.refresh ?? 'adaptive'));
  const now = useNow();
  const [error, setError] = useState<string>();
  const refresh = async () => {
    setError(undefined);
    const err = await refreshNow();
    if (err) setError(t('usage.refreshFailed', { code: err }));
    void fetchCost();
  };
  return (
    <>
      <div className="usage-meta">
        <span className="ellipsis">
          {snapshot?.updatedAt ? t('usage.updated', { ago: duration(now - snapshot.updatedAt) }) : t('usage.never')}
          {snapshot?.nextAt ? ` · ${t('usage.next', { in: duration(snapshot.nextAt - now) })}` : ''}
          {snapshot?.refresh === 'manual' ? ` · ${t('usage.manual')}` : ''}
        </span>
        <span className="spacer" />
        <div className="segmented sm" role="radiogroup" aria-label={t('usage.showRemaining')}>
          {([false, true] as const).map((r) => (
            <button
              key={String(r)}
              role="radio"
              aria-checked={remaining === r}
              className={remaining === r ? 'on' : ''}
              onClick={() => setView({ remaining: r })}
            >
              {t(r ? 'usage.showRemaining' : 'usage.showUsed')}
            </button>
          ))}
        </div>
        <select
          className="usage-interval"
          title={t('usage.interval')}
          aria-label={t('usage.interval')}
          value={mode}
          disabled={readOnly}
          onChange={(e) => {
            void setSetting('usage.refresh', e.target.value).then((err) => err && setError(err));
          }}
        >
          {REFRESH_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`settings.usage.refresh.${m}` as 'settings.usage.refresh.manual')}
            </option>
          ))}
        </select>
        <button
          className="icon sm usage-refresh"
          title={t('usage.refresh')}
          aria-label={t('usage.refresh')}
          disabled={readOnly || snapshot?.polling}
          onClick={() => void refresh()}
        >
          <RefreshCw className={snapshot?.polling ? 'spin' : ''} />
        </button>
      </div>
      {error && <div className="callout error">{error}</div>}
    </>
  );
}

// ---- overview ----

function Overview({ accounts }: { accounts: UsageAccount[] }) {
  const snapshot = useUsage((s) => s.snapshot);
  const readOnly = useSettings((s) => s.readOnly);
  const deepseekOn = useSettings((s) => s.values['usage.providers.deepseek']?.value !== false);
  const noDeepseek = deepseekOn && !readOnly && !accounts.some((a) => a.provider === 'deepseek');
  return (
    <>
      <Spend />
      {snapshot && accounts.length === 0 && <div className="empty-note">{t('usage.empty')}</div>}
      {noDeepseek && (
        <button className="link usage-add-key" onClick={() => setView({ tab: 'deepseek' })}>
          {t('usage.deepseek.add')}
        </button>
      )}
      {accounts.length > 0 && (
        <section className="usage-section">
          <h4 className="usage-heading">{t('usage.accounts')}</h4>
          <div className="usage-rows">
            {accounts.map((a) => (
              <AccountRow key={a.key} account={a} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** An account in the overview: its service, plan and tightest window; a
 * click shows its service. */
function AccountRow({ account: a }: { account: UsageAccount }) {
  const remaining = useUsage((s) => s.remaining);
  const now = useNow();
  const w = tightestWindow(a);
  const shown = w ? (remaining ? 100 - w.usedPct : w.usedPct) : undefined;
  return (
    <button
      className={`usage-row level-${w ? level(w) : 'none'}`}
      data-account={a.key}
      style={{ '--brand': providerColor(a.provider) } as React.CSSProperties}
      onClick={() => setView({ tab: a.provider })}
    >
      <ProviderLogo provider={a.provider} />
      <span className="usage-row-text">
        <span className="usage-row-title">
          <b>{providerName(a.provider)}</b>
          {a.plan && <span className="muted">{a.plan}</span>}
          {a.status !== 'ok' && (
            <span className={`tag usage-status ${a.status}`}>{t(`usage.status.${a.status}` as 'usage.status.stale')}</span>
          )}
        </span>
        {w && (
          <span className="usage-row-window muted ellipsis">
            {windowLabel(w)}
            {w.resetsAt ? ` · ${t('usage.resetsIn', { in: duration(w.resetsAt - now) })}` : ''}
          </span>
        )}
      </span>
      {shown !== undefined && (
        <span className="usage-row-meter">
          <span className="usage-row-pct">{Math.round(shown)}%</span>
          <Bar w={w!} remaining={remaining} small />
        </span>
      )}
    </button>
  );
}

// ---- a service ----

function Provider({ provider, accounts }: { provider: string; accounts: UsageAccount[] }) {
  const readOnly = useSettings((s) => s.readOnly);
  return (
    <div className="usage-provider" style={{ '--brand': providerColor(provider) } as React.CSSProperties}>
      {accounts.map((a) => (
        <AccountCard key={a.key} account={a} />
      ))}
      <ProviderSpend provider={provider} />
      {provider === 'deepseek' && !readOnly && <DeepseekKey />}
    </div>
  );
}

function AccountCard({ account: a }: { account: UsageAccount }) {
  const labels = useStore(useShallow((s) => Object.fromEntries(Object.entries(s.machines).map(([id, st]) => [id, st.label]))));
  const incident = useUsage((s) => s.snapshot?.status[a.provider]);
  const now = useNow();
  const bad = incident?.indicator && incident.indicator !== 'none';
  const groups = groupWindows(a.windows ?? []);
  return (
    <section className="usage-card" data-account={a.key}>
      <header className="usage-card-head">
        <ProviderLogo provider={a.provider} className="lg" />
        <div className="usage-card-title">
          <div className="usage-card-line">
            <b className="usage-provider-name">{providerName(a.provider)}</b>
            <span className="spacer" />
            {a.email && <span className="usage-email ellipsis">{a.email}</span>}
          </div>
          <div className="usage-card-line muted">
            <span>
              {a.fetchedAt ? t('usage.updated', { ago: duration(now - a.fetchedAt) }) : ''}
              {a.status !== 'ok' && a.fetchedAt ? ` · ${t('usage.asOf', { ago: duration(now - a.fetchedAt) })}` : ''}
            </span>
            <span className="spacer" />
            {a.plan && <span className="usage-plan">{a.plan}</span>}
          </div>
        </div>
      </header>
      {(bad || a.status !== 'ok') && (
        <div className="usage-notes">
          {bad && (
            <a
              className={`usage-incident ${incident.indicator}`}
              href={incident.url}
              target="_blank"
              rel="noreferrer"
              title={incident.description}
            >
              <AlertTriangle />
              {incident.description || t('usage.incident')}
            </a>
          )}
          {a.status !== 'ok' && (
            <div className={`callout ${a.status === 'stale' ? 'warning' : 'error'} usage-hint`}>
              <span>
                <b>{t(`usage.status.${a.status}` as 'usage.status.stale')}</b> · {hint(a)}
              </span>
            </div>
          )}
        </div>
      )}
      {groups.map((g) => (
        <div key={g.label ?? ''} className="usage-group">
          {g.label && <div className="usage-group-label">{g.label}</div>}
          {g.windows.map((w) => (
            <WindowRow key={w.id ?? `${w.kind}|${w.label ?? ''}`} w={w} grouped={!!g.label} now={now} />
          ))}
        </div>
      ))}
      <Money account={a} />
      {a.machines.length > 0 && (
        <div className="usage-machines muted">{t('usage.seenOn', { machines: a.machines.map((m) => labels[m] ?? m).join(', ') })}</div>
      )}
      {issueGroups(a).map(([reason, ms]) => (
        <div key={reason} className="usage-issues">
          <AlertTriangle />
          <span>{t('usage.issues', { machines: ms.map((m) => labels[m] ?? m).join(', '), reason })}</span>
        </div>
      ))}
    </section>
  );
}

/** Windows by the group of models they count (a labelled session or weekly
 * window, as Antigravity's), the unlabelled first; in a group, the
 * session before the week and the month. */
export function groupWindows(windows: UsageWindow[]): { label?: string; windows: UsageWindow[] }[] {
  const order = { session: 0, weekly: 1, monthly: 2, model: 3 };
  const groups = new Map<string, UsageWindow[]>();
  for (const w of windows) {
    const key = w.kind === 'model' ? '\u0000models' : (w.label ?? '');
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : 0))
    .map(([key, ws]) => ({
      label: key === '' ? undefined : key === '\u0000models' ? t('usage.kind.models') : key,
      windows: ws.sort((x, y) => order[x.kind] - order[y.kind]),
    }));
}

/** A window's name in a row: its kind (its group says the rest), else, for
 * a model's own window, the model. */
function windowLabel(w: UsageWindow, grouped = false): string {
  if (w.kind === 'model') return w.label ?? t('usage.kind.model');
  // A session of whole hours says how long it is (5 hours).
  const hours = w.kind === 'session' && w.windowSec && w.windowSec % 3600 === 0 ? w.windowSec / 3600 : 0;
  const kind = hours ? t('usage.kind.hours', { n: hours }) : t(`usage.kind.${w.kind}` as 'usage.kind.session');
  return w.label && !grouped ? `${w.label} · ${kind}` : kind;
}

/** The machines that could not read an account, by why. */
function issueGroups(a: UsageAccount): [string, string[]][] {
  const by = new Map<string, string[]>();
  for (const i of a.issues ?? []) {
    const reason =
      i.status === 'stale' ? t('usage.issue.expired') : i.status === 'unauth' ? t('usage.issue.unauth') : t('usage.issue.error');
    by.set(reason, [...(by.get(reason) ?? []), i.machine]);
  }
  return [...by.entries()];
}

/** What to do about an account that is not ok. */
function hint(a: UsageAccount): string {
  if (a.code === 'token_expired' && a.provider === 'kimi') return t('usage.hint.kimiExpired');
  if (a.code === 'lock_busy') return t('usage.hint.kimiBusy');
  if (a.code === 'token_expired') return t('usage.hint.expired', { cli: providerName(a.provider) });
  if (a.code === 'from_log') return t('usage.hint.fromLog');
  if (a.status === 'unauth') return t('usage.hint.unauth', { cli: providerName(a.provider) });
  if (a.code === 'rate_limited') return t('usage.hint.rateLimited');
  return t('usage.hint.error', { code: a.code ?? a.status });
}

/** A window's level: over the first threshold, out, or fine. */
function level(w: UsageWindow): 'out' | 'warn' | 'ok' {
  const th = parseThresholds(useSettings.getState().values['usage.thresholds']?.value)[0] ?? 80;
  return w.usedPct >= 100 ? 'out' : w.usedPct >= th ? 'warn' : 'ok';
}

function WindowRow({ w, grouped, now }: { w: UsageWindow; grouped: boolean; now: number }) {
  const remaining = useUsage((s) => s.remaining);
  useSettings((s) => s.values['usage.thresholds']);
  const shown = remaining ? 100 - w.usedPct : w.usedPct;
  const ahead = w.pace ? Math.round(w.usedPct - w.pace.expectedPct) : 0;
  // Past its reset the numbers are of the period before: said so, not
  // counted as a warning.
  const past = pastReset(w, now);
  const notes = past
    ? [t('usage.pastReset')]
    : [
        ahead >= 5 && w.usedPct < 100 ? t('usage.ahead', { pct: ahead }) : '',
        w.pace?.beforeReset && w.pace.exhaustsAt && w.usedPct < 100
          ? t('usage.runsOutShort', { in: duration(w.pace.exhaustsAt - now) })
          : '',
      ].filter(Boolean);
  return (
    <div className={`usage-window level-${past ? 'past' : level(w)}`} data-window={w.kind}>
      <div className="usage-window-head">
        <span className="usage-window-name ellipsis">
          {windowLabel(w, grouped)}{' '}
          <b className="usage-pct">{t(remaining ? 'usage.pctLeft' : 'usage.pctUsed', { pct: Math.round(shown) })}</b>
        </span>
        <span className="spacer" />
        {w.resetsAt && !past ? <span className="usage-reset">{t('usage.resetsIn', { in: duration(w.resetsAt - now) })}</span> : null}
      </div>
      <Bar w={w} remaining={remaining} />
      {notes.length > 0 && <div className={`usage-window-note ${w.pace?.beforeReset ? 'warn' : ''}`}>{notes.join(' · ')}</div>}
    </div>
  );
}

/** A window's bar in its service's color (the warning and error colors over
 * the threshold and out), with quarter marks and the even pace's mark. */
export function Bar({ w, remaining, small }: { w: UsageWindow; remaining: boolean; small?: boolean }) {
  const shown = Math.min(100, Math.max(0, remaining ? 100 - w.usedPct : w.usedPct));
  // The even pace's mark, once the window is under way.
  const pace =
    w.pace && w.pace.expectedPct >= 2 ? Math.min(100, Math.max(0, remaining ? 100 - w.pace.expectedPct : w.pace.expectedPct)) : undefined;
  return (
    <div
      className={`usage-bar ${small ? 'small' : ''}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown)}
      aria-label={windowLabel(w)}
    >
      <div className="usage-bar-fill" style={{ width: `${shown}%` }} />
      {!small && <div className="usage-bar-ticks" />}
      {pace !== undefined && !small && <div className="usage-pace" title={t('usage.paceMarker')} style={{ left: `${pace}%` }} />}
    </div>
  );
}

function Money({ account: a }: { account: UsageAccount }) {
  const c = a.credits;
  const parts: string[] = [];
  if (c) {
    // Dollars, another currency by its code (Kimi's wallet), or credits.
    const unit = (v: number) =>
      c.unit === 'usd'
        ? money(v)
        : /^[a-z]{3}$/.test(c.unit ?? '')
          ? `${v.toFixed(2)} ${c.unit!.toUpperCase()}`
          : v.toFixed(2).replace(/\.00$/, '');
    if (c.unlimited) parts.push(t('usage.credits.unlimited'));
    else if (c.balance !== undefined) parts.push(t('usage.credits.balance', { v: unit(c.balance) }));
    if (c.used !== undefined && c.limit !== undefined) parts.push(t('usage.credits.usedOf', { used: unit(c.used), limit: unit(c.limit) }));
    if (c.enabled === false) parts.push(t('usage.credits.off'));
  }
  for (const b of a.balances ?? []) parts.push(t('usage.balance', { v: b.total.toFixed(2), currency: b.currency }));
  if (a.available === false) parts.push(t('usage.unavailable'));
  if (!parts.length) return null;
  return <div className="usage-money">{parts.join(' · ')}</div>;
}

// ---- spend ----

const KINDS = ['input', 'cached', 'cacheWrite', 'output'] as const;
type Kind = (typeof KINDS)[number];

const kindColor = (k: Kind) => `var(--usage-kind-${k})`;

/** The spend / tokens switch, shared by the overview and the services. */
function MetricSwitch() {
  const metric = useUsage((s) => s.metric);
  return (
    <div className="segmented sm" role="group" aria-label={t('usage.metric')}>
      {(['spend', 'tokens'] as const).map((m) => (
        <button key={m} aria-pressed={metric === m} className={metric === m ? 'on' : ''} onClick={() => setView({ metric: m })}>
          {t(`usage.metric.${m}`)}
        </button>
      ))}
    </div>
  );
}

/** The kinds of tokens as a thin stacked bar of their shares, and a legend
 * with each one's count (the output says how much of it was reasoning). */
function KindBreakdown({ kinds }: { kinds: TokenKinds }) {
  return (
    <>
      <div className="usage-kinds" role="img" aria-label={t('usage.tokens.kinds')}>
        {KINDS.map((k) =>
          kinds[k] > 0 ? <i key={k} style={{ background: kindColor(k), width: `${(kinds[k] / kinds.total) * 100}%` }} /> : null,
        )}
      </div>
      <div className="usage-legend usage-kind-legend">
        {KINDS.map((k) => (
          <span key={k} className="usage-legend-item">
            <i style={{ background: kindColor(k) }} />
            {t(`usage.tokens.${k}`)} {tokens(kinds[k])}
            {k === 'output' && kinds.reasoning > 0 && ` (${t('usage.tokens.reasoning')} ${tokens(kinds.reasoning)})`}
          </span>
        ))}
      </div>
    </>
  );
}

/** The overview's spend: the days chosen, all services. */
function Spend() {
  const { cost, costLoading, costError, costDays, metric } = useUsage(
    useShallow((s) => ({ cost: s.cost, costLoading: s.costLoading, costError: s.costError, costDays: s.costDays, metric: s.metric })),
  );
  const labels = useStore(useShallow((s) => Object.fromEntries(Object.entries(s.machines).map(([id, st]) => [id, st.label]))));
  const [by, setBy] = useState<RankBy>('model');
  const today = new Date();
  const isTokens = metric === 'tokens';
  return (
    <section className="usage-card usage-spend">
      <div className="usage-card-line">
        <span className="usage-heading">{t(isTokens ? 'usage.tokens.title' : 'usage.spend.title', { days: costDays })}</span>
        <span className="spacer" />
        <MetricSwitch />
        <div className="segmented sm" role="radiogroup" aria-label={t('usage.spend.days')}>
          {([7, 30, 90] as const).map((d) => (
            <button
              key={d}
              role="radio"
              aria-checked={costDays === d}
              className={costDays === d ? 'on' : ''}
              onClick={() => setView({ costDays: d })}
            >
              {t('usage.cost.days', { n: d })}
            </button>
          ))}
        </div>
      </div>
      {costError && <div className="callout error">{t('usage.cost.failed', { code: costError })}</div>}
      {!cost && costLoading && <div className="muted usage-loading">{t('usage.cost.loading')}</div>}
      {cost &&
        (() => {
          const rows = cost.rows;
          const total = costOf(rows, costDays, today);
          const kinds = tokenKinds(rows, costDays, today);
          const eq = equivalents(isTokens ? kinds.total : total, costDays, cost.weekHours, cost.monthHours);
          const label = (r: CostRow) => (by === 'machine' ? (labels[r.machine] ?? r.machine) : (r[by] ?? ''));
          const ranking = isTokens
            ? rankTokens(rows, by, costDays, today, label).slice(0, 8)
            : rank(rows, by, costDays, today, label)
                .slice(0, 8)
                .map((r) => ({ ...r, unpriced: false }));
          const failed = Object.entries(cost.machines).filter(([, m]) => m.error);
          const unpriced = [...new Set(Object.values(cost.machines).flatMap((m) => m.unpriced ?? []))];
          const main = (r: (typeof ranking)[number]) => (isTokens ? r.tokens : r.cost);
          return (
            <>
              <div className="usage-big">~{isTokens ? tokens(kinds.total) : money(total)}</div>
              <div className="usage-sub muted">
                {isTokens ? (
                  <>
                    {t('usage.tokens.requests', { n: kinds.requests })} ·{' '}
                    {t('usage.tokens.equivalentShort', { week: tokens(Math.round(eq.week)), month: tokens(Math.round(eq.month)) })}
                  </>
                ) : (
                  <>
                    {t('usage.spend.tokens', { tokens: tokens(kinds.total) })} ·{' '}
                    {t('usage.cost.equivalentShort', { week: money(eq.week), month: money(eq.month) })}
                  </>
                )}
              </div>
              {isTokens && <KindBreakdown kinds={kinds} />}
              <DailyBars rows={rows} days={costDays} stacked metric={metric} />
              <div className="usage-legend">
                {shownProviders([], cost).map((p) => {
                  const mine = rows.filter((r) => r.provider === p);
                  return (
                    <span key={p} className="usage-legend-item">
                      <i style={{ background: providerColor(p) }} />
                      {providerName(p)} {isTokens ? tokens(tokenKinds(mine, costDays, today).total) : money(costOf(mine, costDays, today))}
                    </span>
                  );
                })}
              </div>
              <div className="usage-card-line">
                <span className="usage-heading">{t('usage.spend.top')}</span>
                <span className="spacer" />
                <div className="segmented sm" role="radiogroup" aria-label={t('usage.spend.top')}>
                  {(['model', 'project', 'machine'] as const).map((b) => (
                    <button key={b} role="radio" aria-checked={by === b} className={by === b ? 'on' : ''} onClick={() => setBy(b)}>
                      {t(`usage.cost.by.${b}`)}
                    </button>
                  ))}
                </div>
              </div>
              <ol className="usage-rank">
                {ranking.map((r) => (
                  <li key={r.name}>
                    <span className="ellipsis">{r.name}</span>
                    {r.unpriced && <span className="usage-noprice muted">{t('usage.tokens.noPrice')}</span>}
                    {isTokens ? <span className="muted">{money(r.cost)}</span> : <span className="muted">{tokens(r.tokens)}</span>}
                    <span className="usage-rank-cost">{isTokens ? tokens(r.tokens) : money(r.cost)}</span>
                    <div className="usage-rank-bar" style={{ width: `${main(ranking[0]) ? (main(r) / main(ranking[0])) * 100 : 0}%` }} />
                  </li>
                ))}
              </ol>
              {ranking.length === 0 && <div className="muted">{t('usage.cost.empty')}</div>}
              <p className="usage-footnote muted">{t('usage.cost.about')}</p>
              {unpriced.length > 0 && (
                <p className="usage-footnote muted">
                  {t('usage.cost.unpriced', { models: unpriced.join(', ') })}{' '}
                  <button className="link" onClick={() => useStore.getState().openSettings({ page: 'usage', row: 'usage.prices' })}>
                    {t('usage.cost.setPrices')}
                  </button>
                </p>
              )}
              {failed.map(([m, x]) => (
                <div key={m} className="callout error">
                  {t('usage.cost.machineFailed', { m: labels[m] ?? m, code: x.error ?? '' })}
                </div>
              ))}
            </>
          );
        })()}
    </section>
  );
}

/** A service's own spend: today, 30 days, tokens, its chart and model. */
function ProviderSpend({ provider }: { provider: string }) {
  const cost = useUsage((s) => s.cost);
  const metric = useUsage((s) => s.metric);
  if (!cost) return null;
  const rows = cost.rows.filter((r) => r.provider === provider);
  if (!rows.length) return null;
  const today = new Date();
  const isTokens = metric === 'tokens';
  const top = (isTokens ? rankTokens(rows, 'model', 30, today) : rank(rows, 'model', 30, today))[0];
  const kinds = tokenKinds(rows, 30, today);
  const eq = equivalents(kinds.total, 30, cost.weekHours, cost.monthHours);
  return (
    <section className="usage-card usage-spend">
      <div className="usage-card-line">
        <span className="usage-heading">{t(isTokens ? 'usage.tokens.title' : 'usage.spend.title', { days: 30 })}</span>
        <span className="spacer" />
        <MetricSwitch />
      </div>
      {isTokens ? (
        <>
          <div className="usage-stats">
            <Stat label={t('usage.spend.tokensToday')} value={tokens(tokensOf(rows, 1, today))} />
            <Stat label={t('usage.spend.tokens30')} value={tokens(kinds.total)} />
          </div>
          <div className="usage-sub muted">
            {t('usage.tokens.requests', { n: kinds.requests })} ·{' '}
            {t('usage.tokens.equivalentShort', { week: tokens(Math.round(eq.week)), month: tokens(Math.round(eq.month)) })}
          </div>
          <KindBreakdown kinds={kinds} />
        </>
      ) : (
        <div className="usage-stats">
          <Stat label={t('usage.cost.today')} value={money(costOf(rows, 1, today))} />
          <Stat label={t('usage.cost.days', { n: 30 })} value={money(costOf(rows, 30, today))} />
          <Stat label={t('usage.spend.tokensToday')} value={tokens(tokensOf(rows, 1, today))} />
          <Stat label={t('usage.spend.tokens30')} value={tokens(tokensOf(rows, 30, today))} />
        </div>
      )}
      <DailyBars rows={rows} days={30} metric={metric} />
      {top && <div className="usage-sub muted">{t('usage.spend.topModel', { model: top.name })}</div>}
      <p className="usage-footnote muted">{t('usage.cost.about')}</p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-stat">
      <div className="muted">{label}</div>
      <div className="usage-stat-value">{value}</div>
    </div>
  );
}

/** The tokens of the rows of the last n days. */
export function tokensOf(rows: CostRow[], n: number, today = new Date()): number {
  return tokenKinds(rows, n, today).total;
}

/** The day's tokens as a tooltip: the total and the kinds. */
function tokensTitle(day: string, k: TokenKinds): string {
  const kinds = KINDS.map((x) => `${t(`usage.tokens.${x}`)} ${tokens(k[x])}`).join(', ');
  return `${day}: ${tokens(k.total)} (${kinds})`;
}

/** The cost or the tokens per day as bars (plain SVG): the cost in the
 * service's color, or, with `stacked`, in the services' colors; the tokens
 * stacked by service with `stacked`, else by kind. */
function DailyBars({ rows, days, stacked, metric = 'spend' }: { rows: CostRow[]; days: number; stacked?: boolean; metric?: Metric }) {
  const W = 300;
  const H = 72;
  const today = new Date();
  const isTokens = metric === 'tokens';
  const providers = stacked ? shownProviders([], { rows } as CostReport) : [];
  const all = dailyTokens(rows, days, today);
  const cost = daily(rows, days, today);
  type Layer = { key: string; color: string; values: number[] };
  let layers: Layer[];
  if (!isTokens) {
    layers = stacked
      ? providers.map((p) => ({
          key: p,
          color: providerColor(p),
          values: daily(
            rows.filter((r) => r.provider === p),
            days,
            today,
          ).map((d) => d.cost),
        }))
      : [{ key: 'cost', color: 'var(--brand)', values: cost.map((d) => d.cost) }];
  } else {
    layers = stacked
      ? providers.map((p) => ({
          key: p,
          color: providerColor(p),
          values: dailyTokens(
            rows.filter((r) => r.provider === p),
            days,
            today,
          ).map((d) => d.total),
        }))
      : KINDS.map((k) => ({ key: k, color: kindColor(k), values: all.map((d) => d[k]) }));
  }
  const totals = isTokens ? all.map((d) => d.total) : cost.map((d) => d.cost);
  const max = Math.max(...totals, isTokens ? 1 : 0.01);
  const bw = W / totals.length;
  return (
    <div className="usage-daily-box">
      <span className="usage-daily-max muted">{isTokens ? tokens(max) : money(max)}</span>
      <svg
        className="usage-daily"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t(isTokens ? 'usage.tokens.daily' : 'usage.cost.daily')}
      >
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="usage-daily-axis" />
        {totals.map((_, i) => {
          let y = H;
          return (
            <g key={all[i].day}>
              <title>{isTokens ? tokensTitle(all[i].day, all[i]) : `${cost[i].day}: ${money(cost[i].cost)}`}</title>
              {layers.map((l) => {
                const h = (l.values[i] / max) * (H - 2);
                y -= h;
                return h > 0 ? <rect key={l.key} x={i * bw + bw * 0.15} y={y} width={bw * 0.7} height={h} fill={l.color} /> : null;
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** The DeepSeek key file of a machine (written there, never shown). */
function DeepseekKey() {
  // Strings only: useShallow compares the items, and new objects would differ every time.
  const ids = useStore(useShallow((s) => s.order.filter((id) => s.machines[id]?.status === 'ready')));
  const names = useStore(useShallow((s) => ids.map((id) => s.machines[id]?.label ?? id)));
  const machines = ids.map((id, i) => ({ id, label: names[i] }));
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
    <section className="usage-card usage-deepseek">
      <div className="usage-heading">{t('usage.deepseek.title')}</div>
      <p className="usage-footnote muted">{t('usage.deepseek.about')}</p>
      <div className="usage-deepseek-form">
        <select value={target} onChange={(e) => setM(e.target.value)} aria-label={t('usage.deepseek.machine')}>
          {machines.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="password"
          autoComplete="off"
          value={key}
          placeholder={t('usage.deepseek.placeholder')}
          aria-label={t('usage.deepseek.placeholder')}
          onChange={(e) => setKey(e.target.value)}
        />
        <button className="primary" disabled={!key.trim()} onClick={() => void save(key.trim())}>
          {t('usage.deepseek.save')}
        </button>
        <button onClick={() => void save('')}>{t('usage.deepseek.remove')}</button>
      </div>
      {msg && <p className="usage-footnote">{msg}</p>}
    </section>
  );
}
