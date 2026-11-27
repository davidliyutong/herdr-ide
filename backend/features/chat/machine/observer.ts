// Read-only session/transcript observation contract, strictly separated from
// writable Session turn execution.
//
// Today this powers read-only sidecar observation such as Antigravity's on-disk
// subagent transcript tailing (acp/agysubagents.ts). Because an observer never
// owns writes or subprocess stdin, the same contract naturally hosts a future
// "Native CLI writes + Native UI tails & renders" mode where a terminal CLI
// owns the session and a read-only observer streams transcript updates into
// Chat's journal and live subscribers.
import type * as chat from '#shared/proto/chatproto/index.ts';

/** Destination where a read-only SessionObserver publishes observed events and
 * background task snapshots. */
export interface ObserverSink {
  emit(ev: chat.Event): void;
  updateTasks?(tasks: chat.BackgroundTask[]): void;
  logf(line: string): void;
}

/** A read-only observer attached to an agent session (or its subagents). */
export interface SessionObserver {
  /** Binds the observer to a resolved session id and begins observation. */
  setSession(sessionId: string): void;
  /** Optional hook allowing an observer to intercept/normalize a live tool
   * update from the parent protocol stream. Return null if not handled. */
  onToolUpdate?(raw: Record<string, unknown>): Record<string, unknown> | null;
  /** Whether a toolCallId is owned/settled by this observer independently of
   * parent turn completion (e.g. async subagents outliving their spawn call). */
  tracks?(toolCallId: string): boolean;
  /** Optional lifecycle hook when the observed turn completes or cancels. */
  onTurnEnd?(aborted?: boolean): void;
  /** Optional explicit poll tick (used in tests and on-demand catch-up). */
  poll?(): void;
  /** Stops all timers/watchers and settles any open observed tasks cleanly. */
  stop(): void;
}
