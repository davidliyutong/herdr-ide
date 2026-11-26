// The coding agent in the focused pane, which the status bar's usage items
// follow (SessionItem.tsx, StatusItem.tsx).
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import { useSettings } from '../../settings';
import * as L from '../../term/layout';
import { agentOf, agentStatus, type AgentStatus } from '../../lib/machine';
import { rememberedSession } from '../../restore';
import { usageProvider } from '../../conversation/kinds';
import { useUsage } from './state';
import { sessionKey } from './session';

/** The coding agent in the focused terminal of the machine shown: its
 * machine, kind, service, session (none when the machine only guessed it:
 * the directory's newest transcript may be another program's, whose
 * numbers would be shown as this agent's), status, and the model of its
 * session's latest request once the session was read; undefined without
 * one or while its service is off. */
export function useFocusedAgent():
  { m: string; kind: string; provider: string; session?: string; status?: AgentStatus; model?: string } | undefined {
  const m = useStore((s) => s.machineId);
  const record = useTerms((s) => {
    const mt = m ? s.machines[m] : undefined;
    const terminal = mt?.layout ? L.focusedTerminal(mt.layout) : undefined;
    return terminal ? mt?.terminals[terminal] : undefined;
  });
  const kind = agentOf(record);
  const session = rememberedSession(record);
  const provider = usageProvider(kind);
  const on = useSettings((s) => !!provider && s.values[`usage.providers.${provider}`]?.value !== false);
  const model = useUsage((s) => {
    const e = m && kind && session ? s.sessions[sessionKey(m, kind, session)] : undefined;
    return e && !e.code ? e.usage?.model : undefined;
  });
  const status = agentStatus(record);
  if (!m || !kind || !provider || !on) return undefined;
  return { m, kind, provider, session, status, model };
}
