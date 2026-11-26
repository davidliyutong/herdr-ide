// The coding agent in the focused pane, which the status bar's usage items
// follow (SessionItem.tsx, StatusItem.tsx).
import { useStore } from '../../state/store';
import { useTerms } from '../../state/terms';
import { useSettings } from '../../settings';
import * as L from '../../term/layout';
import { directoryOf, isLive, type TerminalRecord } from '../../term/protocol';
import { agentOf, agentStatus, type AgentStatus } from '../../lib/machine';
import { rememberedSession } from '../../restore';
import { chatAdapter, usageProvider } from '../../conversation/kinds';
import { useUsage } from './state';
import { targetKey } from './session';

/** Agent kinds whose session usage can be matched by working directory when
 * the detector has no confirmed UUID session (Grok, Kimi Code, OpenCode,
 * Antigravity, plus Codex for extra Codex homes / resumed sessions). */
const CWD_SESSION_KINDS = new Set(['grok', 'kimi', 'opencode', 'agy', 'codex']);
const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9_-]{4,128}$/;
const CONFIRMED_SOURCES: ReadonlySet<string> = new Set(['argv', 'pid', 'fd', 'start', 'hook']);

const cleanDir = (p: string) => p.replace(/\/+$/, '') || '/';

function confirmedUsageSession(kind: string | undefined, r: TerminalRecord | undefined): string | undefined {
  const uuid = rememberedSession(r);
  if (uuid) return uuid;
  if (
    kind === 'opencode' &&
    typeof r?.agent_session === 'string' &&
    OPENCODE_SESSION_ID.test(r.agent_session) &&
    typeof r.agent_session_source === 'string' &&
    CONFIRMED_SOURCES.has(r.agent_session_source)
  ) {
    return r.agent_session;
  }
  return undefined;
}

function foregroundPid(r: TerminalRecord | undefined): number | undefined {
  const fg = r?.foreground as { pid?: unknown } | null | undefined;
  return typeof fg?.pid === 'number' && Number.isInteger(fg.pid) && fg.pid > 0 && fg.pid <= 0x7fffffff ? fg.pid : undefined;
}

function peerCount(terminals: Record<string, TerminalRecord> | undefined, self: string, kind: string, cwd: string): number {
  if (!terminals) return 0;
  const want = cleanDir(cwd);
  let n = 0;
  for (const [addr, rec] of Object.entries(terminals)) {
    if (addr === self) continue;
    if (rec.state !== undefined && !isLive(rec)) continue;
    if (agentOf(rec) !== kind) continue;
    const c = directoryOf(rec);
    if (c && cleanDir(c) === want) n++;
  }
  return n;
}

export interface FocusedAgent {
  m: string;
  kind: string;
  provider: string;
  session?: string;
  cwd?: string;
  pid?: number;
  terminal?: string;
  status?: AgentStatus;
  model?: string;
  source: 'terminal' | 'chat';
}

/** The coding agent in the focused pane of the machine shown (a terminal, or
 * a chat pane for the status bar's window indicator): its machine, kind,
 * service, confirmed session (never a guessed or malformed session id) or
 * unambiguous cwd target for agents without UUID transcripts, status, and
 * the model of its session's latest request once read; undefined without one
 * or while its service is off. */
export function useFocusedAgent(): FocusedAgent | undefined {
  const m = useStore((s) => s.machineId);
  const layout = useTerms((s) => (m ? s.machines[m]?.layout : undefined));
  const terminals = useTerms((s) => (m ? s.machines[m]?.terminals : undefined));

  let record: TerminalRecord | undefined;
  let chatKind: string | undefined;
  if (layout) {
    const term = L.focusedTerminal(layout);
    if (term) {
      record = terminals?.[term];
    } else {
      const pane = L.focusedPane(layout);
      const leaf = pane ? L.findLeaf(layout, pane) : null;
      if (leaf && L.isPluginLeaf(leaf) && leaf.view.plugin === 'chat' && leaf.view.kind === 'chat') {
        const agent = typeof leaf.view.agent === 'string' && chatAdapter(leaf.view.agent) ? leaf.view.agent : undefined;
        if (agent) chatKind = agent;
      }
    }
  }

  const kind = chatKind ?? agentOf(record);
  const rawSession = record?.agent_session;
  const hasRawSession = rawSession !== undefined && rawSession !== null && rawSession !== '';
  const session = hasRawSession ? confirmedUsageSession(kind, record) : undefined;
  const rawCwd = !hasRawSession && record && kind && CWD_SESSION_KINDS.has(kind) ? directoryOf(record) : undefined;
  const cwd = rawCwd && rawCwd.startsWith('/') && peerCount(terminals, record!.address, kind!, rawCwd) === 0 ? rawCwd : undefined;
  const pid = cwd ? foregroundPid(record) : undefined;
  const terminal = record?.address;
  const provider = usageProvider(kind);
  const on = useSettings((s) => !!provider && s.values[`usage.providers.${provider}`]?.value !== false);
  const key = m && kind && (session || cwd) ? targetKey({ m, kind, session, cwd, pid, terminal }) : undefined;
  const model = useUsage((s) => {
    const e = key ? s.sessions[key] : undefined;
    return e && !e.code ? e.usage?.model : undefined;
  });
  const status = agentStatus(record);
  if (!m || !kind || !provider || !on || (!record && !chatKind)) return undefined;
  if (chatKind) return { m, kind, provider, source: 'chat' };
  return { m, kind, provider, session, cwd, pid, terminal, status, model, source: 'terminal' };
}
