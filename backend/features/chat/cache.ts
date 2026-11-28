// Bounded hub-side TTL + in-flight coalescing cache for expensive chat host
// probes (Op.Sessions and Op.Agents). Prevents repeated subprocess spawns on
// remote machines when panels mount, directories switch back and forth, or
// multiple browser tabs request the same listing concurrently.
import * as chat from '#shared/proto/chatproto/index.ts';

/** How long a cached session listing page stays fresh on the hub. */
export const SESSIONS_CACHE_TTL_MS = 60_000;
/** How long a machine's agent availability list stays fresh on the hub. */
export const AGENTS_CACHE_TTL_MS = 30_000;
/** Maximum cached session listing pages kept across all machines. */
export const SESSIONS_CACHE_MAX = 256;

export interface CachedSessions {
  sessions: chat.Session[];
  nextCursor: string;
}

export interface CachedAgent {
  kind: string;
  available: boolean;
  version?: string;
  reason?: string;
}

interface Entry<T> {
  value: T;
  at: number;
}

interface InFlight<T> {
  key: string;
  promise: Promise<T>;
  waiters: number;
  ac: AbortController;
  stale: boolean;
}

/** Waits for p unless signal aborts first, letting callers cancel their wait
 * without cancelling a shared in-flight probe needed by other waiters. */
function waitWithSignal<T>(p: Promise<T>, signal: AbortSignal, onCancel: () => void): Promise<T> {
  if (signal.aborted) {
    onCancel();
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      onCancel();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Bounded TTL + LRU cache with per-key in-flight request deduplication. */
export class ProbeCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, InFlight<T>>();
  /** Tracks every active flight (including refresh: true) so invalidation aborts
   * all in-flight probes and prevents stale completions from repopulating entries. */
  private readonly active = new Set<InFlight<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(o: { ttlMs: number; maxEntries: number; now: () => number }) {
    this.ttlMs = o.ttlMs;
    this.maxEntries = o.maxEntries;
    this.now = o.now;
  }

  /** Returns a cached value when fresh, coalesces onto an active in-flight
   * probe when one exists, or runs fetch(sharedSignal) once and caches the
   * result. When refresh is true, bypasses the cached entry and starts a fresh
   * probe (replacing the cache on success). Never caches errors. */
  async get(
    key: string,
    o: { refresh?: boolean; signal: AbortSignal; timeoutMs: number },
    fetch: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!o.refresh) {
      const hit = this.entries.get(key);
      if (hit) {
        if (this.now() - hit.at <= this.ttlMs) {
          // Refresh LRU position.
          this.entries.delete(key);
          this.entries.set(key, hit);
          return hit.value;
        }
        this.entries.delete(key);
      }
      const pending = this.inflight.get(key);
      if (pending) {
        pending.waiters++;
        return waitWithSignal(pending.promise, o.signal, () => this.dropWaiter(key, pending));
      }
    } else {
      // Any earlier flight for this key must not overwrite the newer refresh.
      for (const f of this.active) {
        if (f.key === key) f.stale = true;
      }
      this.inflight.delete(key);
    }

    const ac = new AbortController();
    const sharedSignal = AbortSignal.any([ac.signal, AbortSignal.timeout(o.timeoutMs)]);
    const flight: InFlight<T> = {
      key,
      promise: undefined as unknown as Promise<T>,
      waiters: 1,
      ac,
      stale: false,
    };
    this.active.add(flight);
    flight.promise = fetch(sharedSignal).then(
      (value) => {
        this.active.delete(flight);
        if (!flight.stale) this.put(key, value);
        if (this.inflight.get(key) === flight) this.inflight.delete(key);
        return value;
      },
      (err) => {
        this.active.delete(flight);
        if (this.inflight.get(key) === flight) this.inflight.delete(key);
        throw err;
      },
    );
    // Avoid unhandled rejection if all waiters abort before the upstream fails.
    flight.promise.catch(() => {});
    if (!o.refresh) this.inflight.set(key, flight);
    return waitWithSignal(flight.promise, o.signal, () => this.dropWaiter(key, flight));
  }

  private dropWaiter(key: string, flight: InFlight<T>): void {
    flight.waiters--;
    if (flight.waiters <= 0) {
      flight.stale = true;
      this.active.delete(flight);
      if (this.inflight.get(key) === flight) this.inflight.delete(key);
      flight.ac.abort();
    }
  }

  put(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drops every cached entry and cancels in-flight probes whose key starts with prefix. */
  invalidatePrefix(prefix: string): void {
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
    for (const f of [...this.active]) {
      if (f.key.startsWith(prefix)) {
        f.stale = true;
        this.active.delete(f);
        if (this.inflight.get(f.key) === f) this.inflight.delete(f.key);
        f.ac.abort();
      }
    }
  }

  clear(): void {
    this.entries.clear();
    for (const f of [...this.active]) {
      f.stale = true;
      f.ac.abort();
    }
    this.active.clear();
    this.inflight.clear();
  }
}

export const sessionsCacheKey = (m: string, kind: string, cwd: string, cursor: string): string => `${m}\0${kind}\0${cwd}\0${cursor}`;

export const machinePrefix = (m: string): string => `${m}\0`;

/** Overlays live watched chat states onto a cached sessions page so newly
 * created, imported, or deleted chats stay accurate even on a cache hit. */
export function overlaySessionChats(
  sessions: readonly chat.Session[],
  kind: string,
  states: readonly chat.ChatState[] | undefined,
): chat.Session[] {
  if (!states) return sessions.map((s) => ({ ...s }));
  const bySession = new Map<string, string>();
  const existingIds = new Set<string>();
  for (const st of states) {
    existingIds.add(st.id);
    if (st.kind === kind && st.sessionId && st.state !== chat.State.Deleted) {
      bySession.set(st.sessionId, st.id);
    }
  }
  return sessions.map((s) => {
    const out: chat.Session = { ...s };
    const matched = bySession.get(s.sessionId);
    if (matched) {
      out.chat = matched;
    } else if (out.chat && !existingIds.has(out.chat)) {
      delete out.chat;
    }
    return out;
  });
}
