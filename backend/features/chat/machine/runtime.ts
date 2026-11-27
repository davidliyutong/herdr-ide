// Shared runtime helpers for chat adapters and Host:
//   - LiveSessions<S>: tracks live sessions per adapter, auto-removes on done,
//     and propagates refreshed model lists uniformly to every live session.
//   - resolveAdapterCommand(): single binary/availability resolver supporting
//     both external-process ('process') and in-process ('embedded') runtimes.
//   - markUsageStale(): uniform context-usage invalidation on compact / rewind.
import type { ChatSpec } from '#shared/agents/kinds.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import type { Adapter, Session } from './adapter.ts';
import { lookPath } from './host/env.ts';

/** Tracks live sessions of an adapter, removing each automatically once its
 * `done` promise settles, and broadcasting refreshed model lists to all live
 * sessions (optionally filtered by kind). */
export class LiveSessions<S extends Session> {
  private readonly items = new Set<S>();

  add(sess: S): S {
    this.items.add(sess);
    void sess.done.then(() => this.items.delete(sess));
    return sess;
  }

  delete(sess: S): void {
    this.items.delete(sess);
  }

  [Symbol.iterator](): IterableIterator<S> {
    return this.items[Symbol.iterator]();
  }

  get size(): number {
    return this.items.size;
  }

  /** Propagates a refreshed model list to every live session (or those matching
   * `match`) that implements `updateModels`. */
  notifyModels(models: readonly chat.ModelOption[], match?: (sess: S) => boolean): void {
    if (models.length === 0) return;
    for (const s of this.items) {
      if (match && !match(s)) continue;
      s.updateModels?.(models);
    }
  }
}

/** Whether an adapter + spec runs in-process inside the chat host (no external
 * binary in PATH, pid = 0). */
export function isEmbeddedRuntime(adapter: Adapter, spec: ChatSpec): boolean {
  return adapter.meta?.runtime === 'embedded' || spec.runtime === 'embedded';
}

export type ResolvedCommand = { ok: true; argv: string[]; embedded: boolean } | { ok: false; missing: string };

/** Resolves how to invoke an adapter for a given kind spec & user environment.
 * For external-process runtimes, resolves spec.argv[0] on PATH; for embedded
 * runtimes, skips PATH lookup and queries optional adapter.available(). */
export async function resolveAdapterCommand(
  adapter: Adapter,
  spec: ChatSpec,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<ResolvedCommand> {
  if (isEmbeddedRuntime(adapter, spec)) {
    if (adapter.available) {
      const ok = await adapter.available(env, signal);
      if (!ok) return { ok: false, missing: spec.adapter };
    }
    return { ok: true, argv: [], embedded: true };
  }
  const cmd = spec.argv[0] ?? '';
  if (!cmd) return { ok: false, missing: spec.adapter };
  const path = await lookPath(cmd, env);
  if (!path) return { ok: false, missing: cmd };
  return { ok: true, argv: [path, ...spec.argv.slice(1)], embedded: false };
}

/** Marks a chat's context usage as stale (zeroing used tokens & percentage while
 * keeping window size, cost, and rate limits) after compaction or rewind until
 * the agent reports fresh token usage. */
export function markUsageStale(usage: chat.Usage | undefined): chat.Usage | undefined {
  if (!usage) return undefined;
  return {
    ...usage,
    used: 0,
    percentage: 0,
    stale: true,
    ...(usage.cost ? { cost: { ...usage.cost } } : {}),
    ...(usage.limits ? { limits: usage.limits.map((l) => ({ ...l })) } : {}),
  };
}
