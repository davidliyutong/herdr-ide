// Extensible per-kind hooks for ACP agents (adapter.ts, session.ts).
// Keeps vendor-specific quirks (such as Antigravity's on-disk subagent
// transcript observation or Grok's client-enforced permission mode) isolated
// here so adding a new ACP agent requires zero branches in AcpSession/Adapter.
import type * as chat from '#shared/proto/chatproto/index.ts';
import type { HistoryParams, StartParams } from '../adapter.ts';
import type { ObserverSink, SessionObserver } from '../observer.ts';
import {
  AgySubagentTracker,
  DEFAULT_POLL_MS,
  agyDataDirs,
  agySubagentInput,
  isAgySubagentCall,
  loadAgySubagentHistory,
  normalizeAgySubagentCall,
} from './agysubagents.ts';
import { UPDATE_TOOL, UPDATE_TOOL_CALL } from './items.ts';
import { str, type Obj } from './state.ts';

/** Per-kind history replay interceptor created during ACP session/load. */
export interface AcpHistoryHook {
  /** Intercepts a replayed tool update; return normalized update to substitute,
   * or null to pass the raw update through unchanged. */
  onUpdate(sessionUpdate: string, raw: Obj): Obj | null;
  /** Called after session/load finishes cleanly to emit supplementary events
   * (e.g. replaying on-disk subagent transcripts). */
  afterReplay(emit: (ev: chat.Event) => void): void;
}

/** Vendor-specific hook bundle for a single ACP agent kind. */
export interface AcpKindExtension {
  /** Whether the host should synthesize a client-enforced permission mode
   * option before the agent starts (for ACP agents with no native mode option). */
  readonly needsClientMode?: boolean;
  /** Creates a read-only SessionObserver attached to a live AcpSession. */
  createObserver?(p: StartParams, sink: ObserverSink, pollMs: number | undefined): SessionObserver;
  /** Creates a history replay hook for session/load imports. */
  createHistoryHook?(p: HistoryParams): AcpHistoryHook;
}

const agyExtension: AcpKindExtension = {
  createObserver(p, sink, pollMs) {
    return new AgySubagentTracker(
      {
        emit: (ev) => sink.emit(ev),
        updateTasks: (tasks) => sink.updateTasks?.(tasks),
        logf: (line) => sink.logf(line),
      },
      { dirs: agyDataDirs(p.argv, p.env, p.cwd), pollMs: pollMs ?? DEFAULT_POLL_MS },
    );
  },
  createHistoryHook(p) {
    const calls: Array<{ toolCallId: string; raw: Obj }> = [];
    const seen = new Set<string>();
    return {
      onUpdate(sessionUpdate, raw) {
        if ((sessionUpdate !== UPDATE_TOOL_CALL && sessionUpdate !== UPDATE_TOOL) || !isAgySubagentCall(raw)) return null;
        const id = str(raw.toolCallId);
        if (!id) return null;
        if (!seen.has(id)) {
          seen.add(id);
          calls.push({ toolCallId: id, raw: { ...raw } });
        }
        const { typeName, role } = agySubagentInput(raw);
        const status = str(raw.status) || 'completed';
        return normalizeAgySubagentCall(raw, { status, role, typeName });
      },
      afterReplay(emit) {
        if (p.after === '' && calls.length > 0) {
          loadAgySubagentHistory(p.sessionId, calls, agyDataDirs(p.argv, p.env, p.cwd), emit);
        }
      },
    };
  },
};

const grokExtension: AcpKindExtension = {
  needsClientMode: true,
};

const ACP_EXTENSIONS: Readonly<Record<string, AcpKindExtension>> = {
  agy: agyExtension,
  grok: grokExtension,
};

/** Returns the ACP vendor extension for kind, if any. */
export function acpExtension(kind: string): AcpKindExtension | undefined {
  return Object.hasOwn(ACP_EXTENSIONS, kind) ? ACP_EXTENSIONS[kind] : undefined;
}
