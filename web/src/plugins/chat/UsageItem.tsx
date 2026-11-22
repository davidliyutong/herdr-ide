// The status bar's item of the chat in the focused pane (chat.usage): what
// its session cost so far, the share of the context window in use and the
// subscription's limit window closest to its end, as the chat states them
// (source.ts). Nothing shows while the focused pane is no chat or its chat
// told none of these.
import { contextPercent, formatCost, tightest, windowLabel } from '../../conversation/format';
import type { Limit } from './protocol';
import { locale, t } from '../../i18n';
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import * as L from '../../term/layout';
import { agentName, kindIcon } from './ops';
import { liveKey, useChats } from './state';
import { CHAT_PLUGIN, CHAT_VIEW, chatRef } from './view';

/** The chat of the focused pane of the machine shown: its machine, id and
 * the agent's kind. */
function useFocusedChat(): { m: string; chat: string; kind?: string } | undefined {
  const m = useStore((s) => s.machineId);
  const view = useTerms((s) => {
    const layout = m ? s.machines[m]?.layout : undefined;
    const pane = layout ? L.focusedPane(layout) : undefined;
    const leaf = layout && pane ? L.findLeaf(layout, pane) : null;
    return leaf && L.isPluginLeaf(leaf) && leaf.view.plugin === CHAT_PLUGIN && leaf.view.kind === CHAT_VIEW ? leaf.view : undefined;
  });
  const ref = view ? chatRef(view) : undefined;
  const stated = useChats((s) => (m && ref?.chat ? s.states[m]?.[ref.chat]?.kind : undefined));
  return m && ref?.chat ? { m, chat: ref.chat, kind: ref.agent ?? stated } : undefined;
}

/** A limit window's name: its label, else its length. */
const limitName = (l: Limit) => l.label || (l.windowMinutes ? windowLabel(l.windowMinutes) : l.id);

export function ChatUsageItem() {
  const focused = useFocusedChat();
  const usage = useChats((s) => (focused ? s.live[liveKey(focused.m, focused.chat)]?.usage : undefined));
  if (!focused || !usage) return null;
  const cost = usage.cost ? formatCost(usage.cost, locale) : undefined;
  const pct = contextPercent(usage);
  const limit = tightest(usage.limits);
  if (cost === undefined && pct === undefined && !limit) return null;
  const parts = [
    cost,
    pct !== undefined ? t('chat.usage.context', { pct: Math.round(pct) }) : undefined,
    limit ? t('chat.usage.limit', { window: limitName(limit), pct: Math.round(limit.usedPercent) }) : undefined,
  ].filter((x): x is string => !!x);
  const agent = agentName(focused.kind);
  const Icon = focused.kind ? kindIcon(focused.kind) : undefined;
  const level = limit && limit.usedPercent >= 90 ? 'out' : limit && limit.usedPercent >= 75 ? 'warn' : undefined;
  return (
    <span
      className={`chat-usage-item ${level ?? ''}`}
      role="status"
      aria-label={t('chat.usage.label', { agent, usage: parts.join(', ') })}
      title={t('chat.usage.label', { agent, usage: parts.join(', ') })}
    >
      {Icon && <Icon />}
      {parts.map((p, i) => (
        <span key={i} className="chat-usage-part">
          {p}
        </span>
      ))}
    </span>
  );
}
