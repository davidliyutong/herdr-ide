// The status bar's item of the coding agent in the focused pane
// (usage.session): its service's mark, what its session has cost at API
// prices and the context in use. The mouse resting on it shows the
// session's model, requests, tokens by kind, cost and context, and the
// tightest window of the service's account on that machine; a click shows
// the service in the usage panel. Nothing shows while the focused pane is
// not a terminal whose agent has a session and a usage provider, while
// that provider is turned off, and before the machine's first answer.
// session.ts reads the numbers.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { showPanel } from '../../panelPanes';
import { useHoverOpen } from '../../components/useHoverOpen';
import { t } from '../../i18n';
import { agentKind } from '../../conversation/kinds';
import { useFocusedAgent } from './focus';
import { fetchSnapshot, setView, useUsage } from './state';
import {
  contextPct,
  contextShort,
  sessionAccount,
  sessionCost,
  shortModel,
  tightestFor,
  tightestWindow,
  tokens,
  type SessionUsage,
} from './model';
import { targetKey, useSessionReads, type SessionTarget } from './session';
import { AccountLine, useCardOnScreen, useWarnAt } from './StatusItem';
import { ProviderLogo } from './logos';

/** The session of the agent in the focused terminal, with its service
 * (useFocusedAgent); undefined without one. */
function useFocusedSession(): { target: SessionTarget; provider: string } | undefined {
  const a = useFocusedAgent();
  if (!a || a.source !== 'terminal' || (!a.session && !a.cwd)) return undefined;
  return {
    target: { m: a.m, kind: a.kind, session: a.session, cwd: a.cwd, pid: a.pid, terminal: a.terminal, status: a.status },
    provider: a.provider,
  };
}

/** The context in use in words: of the window and its share, else the
 * tokens. */
function contextLong(u: SessionUsage): string {
  const pct = contextPct(u);
  if (pct !== undefined) return t('usage.session.contextOf', { used: tokens(u.contextUsed), size: tokens(u.contextSize), pct });
  return u.contextUsed > 0 ? tokens(u.contextUsed) : '—';
}

function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function UsageSessionItem() {
  const focused = useFocusedSession();
  const target = focused?.target;
  useSessionReads(target);
  const key = target ? targetKey(target) : undefined;
  const entry = useUsage((s) => (key ? s.sessions[key] : undefined));
  const snapshot = useUsage((s) => s.snapshot);
  const remaining = useUsage((s) => s.remaining);
  const warnAt = useWarnAt();
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
  const u = entry && !entry.code ? entry.usage : undefined;
  // Another session, or none: the card of the one before closes.
  const { cancel } = hover;
  useEffect(() => {
    cancel();
    setOpen(false);
  }, [key, cancel]);
  if (!focused || !target || !u) return null;
  const { provider } = focused;
  const agent = agentKind(target.kind)?.title ?? target.kind;
  const cost = sessionCost(u);
  const ctx = contextShort(u);
  const nowSec = Date.now() / 1000;
  const counted = tightestFor(snapshot, provider, target.m, u.model, nowSec);
  const account = counted?.account ?? sessionAccount(snapshot, provider, target.m);
  const limit = counted?.window ?? (account && tightestWindow(account, nowSec));
  const accounts = (snapshot?.accounts ?? []).filter((a) => a.provider === provider).length;
  return (
    <span className="gui-menu-anchor" {...hover.anchor}>
      <button
        className="usage-status-item usage-session-item"
        data-provider={provider}
        aria-label={ctx ? t('usage.session.labelContext', { agent, cost, context: ctx }) : t('usage.session.label', { agent, cost })}
        aria-describedby={open ? id : undefined}
        onClick={() => {
          close();
          setView({ tab: provider });
          showPanel('usage');
        }}
      >
        <ProviderLogo provider={provider} />
        {u.model && <span className="usage-session-model">{shortModel(u.model)}</span>}
        <span className="usage-session-cost">{cost}</span>
        {ctx && <span className="usage-session-ctx">{t('usage.session.context.short', { context: ctx })}</span>}
      </button>
      {open && (
        <div ref={card} id={id} className="gui-menu usage-hover usage-session-hover" role="tooltip">
          <div className="usage-hover-line">
            <ProviderLogo provider={provider} />
            <b className="ellipsis">{agent}</b>
            <span className="spacer" />
            <span className="muted">{t('usage.session.heading')}</span>
          </div>
          <dl className="usage-session-facts">
            {u.model && <Fact name={t('usage.session.model')}>{u.model}</Fact>}
            <Fact name={t('usage.session.cost')}>
              {cost}
              {!u.priced && <span className="muted"> · {t('usage.session.noPrice')}</span>}
            </Fact>
            <Fact name={t('usage.session.context')}>{contextLong(u)}</Fact>
            <Fact name={t('usage.session.requests')}>{u.requests}</Fact>
            <Fact name={t('usage.session.input')}>{tokens(u.input)}</Fact>
            <Fact name={t('usage.session.cached')}>{tokens(u.cached)}</Fact>
            <Fact name={t('usage.session.cacheWrite')}>{tokens(u.cacheWrite)}</Fact>
            <Fact name={t('usage.session.output')}>{tokens(u.output)}</Fact>
            {u.reasoning > 0 && <Fact name={t('usage.session.reasoning')}>{tokens(u.reasoning)}</Fact>}
          </dl>
          {account && limit && (
            <div className="usage-session-account">
              <AccountLine account={account} window={limit} email={accounts > 1} remaining={remaining} warnAt={warnAt} nowSec={nowSec} />
            </div>
          )}
        </div>
      )}
    </span>
  );
}
