// Bounded hub-side TTL + LRU cache with per-key in-flight request coalescing.
// Multiple concurrent callers for the same key share one upstream probe; each
// caller may abort its own wait without cancelling the probe for other waiters,
// and when all waiters abort, the shared upstream signal aborts immediately so
// remote slots and child processes are freed.

export interface CacheOptions {
  /** Default TTL in ms (0 = in-flight coalescing only, no post-completion cache). */
  ttlMs: number;
  /** Maximum cached entries kept (LRU eviction). */
  maxEntries: number;
  /** Clock function (injectable for tests). */
  now?: () => number;
}

export interface CacheGetOptions {
  signal: AbortSignal;
  /** Per-call TTL override in ms (defaults to the cache's ttlMs). */
  ttlMs?: number;
  /** Optional upper bound on the shared upstream call, in ms. */
  timeoutMs?: number;
  /** Bypass any cached entry and start a fresh probe. */
  refresh?: boolean;
}

interface Entry<T> {
  value: T;
  at: number;
}

interface InFlight<T> {
  promise: Promise<T>;
  waiters: number;
  ac: AbortController;
  stale: boolean;
}

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

/** Bounded TTL + LRU cache with per-key in-flight coalescing. */
export class CoalesceCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, InFlight<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(o: CacheOptions) {
    this.ttlMs = o.ttlMs;
    this.maxEntries = o.maxEntries;
    this.now = o.now ?? Date.now;
  }

  /** Returns a fresh cached value, coalesces onto an active in-flight probe,
   * or invokes fetch(sharedSignal) once and caches the result. Never caches
   * errors. */
  async get(key: string, o: CacheGetOptions, fetch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (o.signal.aborted) throw o.signal.reason;
    const ttl = o.ttlMs ?? this.ttlMs;
    if (!o.refresh) {
      if (ttl > 0) {
        const hit = this.entries.get(key);
        if (hit) {
          if (this.now() - hit.at < ttl) {
            this.entries.delete(key);
            this.entries.set(key, hit);
            return hit.value;
          }
          this.entries.delete(key);
        }
      }
      const pending = this.inflight.get(key);
      if (pending) {
        pending.waiters++;
        return waitWithSignal(pending.promise, o.signal, () => this.dropWaiter(key, pending));
      }
    }

    const ac = new AbortController();
    const sharedSignal = o.timeoutMs !== undefined ? AbortSignal.any([ac.signal, AbortSignal.timeout(o.timeoutMs)]) : ac.signal;
    const flight: InFlight<T> = {
      promise: undefined as unknown as Promise<T>,
      waiters: 1,
      ac,
      stale: false,
    };
    flight.promise = fetch(sharedSignal).then(
      (value) => {
        if (!flight.stale && ttl > 0) this.put(key, value);
        if (this.inflight.get(key) === flight) this.inflight.delete(key);
        return value;
      },
      (err) => {
        if (this.inflight.get(key) === flight) this.inflight.delete(key);
        throw err;
      },
    );
    flight.promise.catch(() => {});
    if (!o.refresh) this.inflight.set(key, flight);
    return waitWithSignal(flight.promise, o.signal, () => this.dropWaiter(key, flight));
  }

  private dropWaiter(key: string, flight: InFlight<T>): void {
    flight.waiters--;
    if (flight.waiters <= 0) {
      if (this.inflight.get(key) === flight) this.inflight.delete(key);
      flight.ac.abort();
    }
  }

  put(key: string, value: T): void {
    if (this.maxEntries <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { value, at: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drops key from the cache and detaches any in-flight probe so it will not
   * repopulate stale data when it resolves. */
  invalidate(key: string, o: { abort?: boolean } = {}): void {
    this.entries.delete(key);
    const f = this.inflight.get(key);
    if (f) {
      f.stale = true;
      this.inflight.delete(key);
      if (o.abort) f.ac.abort();
    }
  }

  /** Drops every entry and detaches every in-flight probe whose key starts
   * with prefix. */
  invalidatePrefix(prefix: string, o: { abort?: boolean } = {}): void {
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
    for (const [k, f] of [...this.inflight.entries()]) {
      if (k.startsWith(prefix)) {
        f.stale = true;
        this.inflight.delete(k);
        if (o.abort) f.ac.abort();
      }
    }
  }

  clear(o: { abort?: boolean } = {}): void {
    this.entries.clear();
    for (const f of this.inflight.values()) {
      f.stale = true;
      if (o.abort) f.ac.abort();
    }
    this.inflight.clear();
  }
}
