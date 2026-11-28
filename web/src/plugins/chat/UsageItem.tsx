// The status bar's item of the chat in the focused pane (chat.usage): what
// its session cost so far and the share of the context window in use, as the
// chat states them (source.ts). Rate-limit windows live in the AI Usage
// plugin's own status bar item instead. Nothing shows while the focused pane
// is no chat or its chat told neither.
import { contextPercent, formatCost } from '../../conversation/format';
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

export function ChatUsageItem() {
  const focused = useFocusedChat();
  const usage = useChats((s) => (focused ? s.live[liveKey(focused.m, focused.chat)]?.usage : undefined));
  if (!focused || !usage) return null;
  const cost = usage.cost ? formatCost(usage.cost, locale) : undefined;
  const pct = contextPercent(usage);
  if (cost === undefined && pct === undefined) return null;
  const parts = [cost, pct !== undefined ? t('chat.usage.context', { pct: Math.round(pct) }) : undefined].filter((x): x is string => !!x);
  const agent = agentName(focused.kind);
  const Icon = focused.kind ? kindIcon(focused.kind) : undefined;
  return (
    <span
      className="chat-usage-item"
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
