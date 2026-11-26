// Bounded LRU cache of loaded text files and in-flight load deduplication for
// the file explorer's editor panes. Switching back and forth between open file
// tabs hydrates immediately from cache (no repeated "Loading..." flash) and
// silently revalidates with a lightweight stat check when stale.

import { useStore } from '../../state/store';
import type { Loaded, Version } from './EditorPane';

export interface CachedFile {
  text: string;
  version: Version;
  /** Epoch ms when this text/version was last fetched, saved or stat-verified. */
  verifiedAt: number;
}

export const MAX_CACHED_FILES = 64;
export const MAX_CACHED_BYTES = 32 << 20;
/** How long a cached file is trusted before a silent background stat revalidation. */
export const REVALIDATE_MS = 1500;

interface Entry extends CachedFile {
  bytes: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Loaded>>();
let totalBytes = 0;

const cacheKey = (m: string, path: string) => `${m}\n${path}`;

// When a machine leaves or returns to 'ready' (offline, disabled, reconnecting),
// mark its cached files stale so reopening revalidates once back, and drop any
// stale in-flight cold loads so reconnect retries never attach to an offline fetch.
let lastStatuses: Record<string, string> = {};
useStore.subscribe((s) => {
  const next: Record<string, string> = {};
  for (const [id, st] of Object.entries(s.machines)) {
    next[id] = st.status;
    if (lastStatuses[id] === 'ready' && st.status !== 'ready') {
      invalidateMachineCache(id);
      dropMachineInflight(id);
    } else if (lastStatuses[id] !== undefined && lastStatuses[id] !== 'ready' && st.status === 'ready') {
      dropMachineInflight(id);
    }
  }
  for (const id of Object.keys(lastStatuses)) {
    if (!next[id]) {
      dropMachineCache(id);
      dropMachineInflight(id);
    }
  }
  lastStatuses = next;
});

function evictOne(key: string) {
  const e = cache.get(key);
  if (!e) return;
  totalBytes -= e.bytes;
  cache.delete(key);
}

/** Returns a cached file (refreshing its LRU order), or undefined. */
export function getCachedFile(m: string, path: string): CachedFile | undefined {
  const k = cacheKey(m, path);
  const e = cache.get(k);
  if (!e) return undefined;
  cache.delete(k);
  cache.set(k, e);
  return e;
}

/** Stores or updates a file in the cache, evicting the oldest entries if over budget. */
export function putCachedFile(m: string, path: string, text: string, version: Version, verifiedAt = Date.now()) {
  const k = cacheKey(m, path);
  evictOne(k);
  const bytes = text.length * 2;
  if (bytes > MAX_CACHED_BYTES) return;
  cache.set(k, { text, version, verifiedAt, bytes });
  totalBytes += bytes;
  while (cache.size > MAX_CACHED_FILES || totalBytes > MAX_CACHED_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === k) break;
    evictOne(oldest);
  }
}

/** Updates a cached file's verification timestamp after a matching stat check. */
export function touchCachedFile(m: string, path: string, verifiedAt = Date.now()) {
  const e = cache.get(cacheKey(m, path));
  if (e) e.verifiedAt = verifiedAt;
}

/** Removes one file from the cache (e.g. deleted or replaced with binary). */
export function dropCachedFile(m: string, path: string) {
  evictOne(cacheKey(m, path));
}

/** Marks all cached entries of machine m as needing background revalidation. */
export function invalidateMachineCache(m: string) {
  const prefix = `${m}\n`;
  for (const [k, e] of cache) {
    if (k.startsWith(prefix)) e.verifiedAt = 0;
  }
}

/** Drops all cached entries of machine m. */
export function dropMachineCache(m: string) {
  const prefix = `${m}\n`;
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) evictOne(k);
  }
}

/** Drops a single in-flight load so a fresh retry will not reuse a stale request. */
export function dropInflightFile(m: string, path: string) {
  inflight.delete(cacheKey(m, path));
}

/** Drops all in-flight loads of machine m. */
export function dropMachineInflight(m: string) {
  const prefix = `${m}\n`;
  for (const k of [...inflight.keys()]) {
    if (k.startsWith(prefix)) inflight.delete(k);
  }
}

/** Deduplicates concurrent cold loads of the same (machine, path). */
export function dedupLoad(m: string, path: string, load: () => Promise<Loaded>): Promise<Loaded> {
  const k = cacheKey(m, path);
  const existing = inflight.get(k);
  if (existing) return existing;
  const p = load().finally(() => {
    if (inflight.get(k) === p) inflight.delete(k);
  });
  inflight.set(k, p);
  return p;
}

/** Clears the cache and in-flight map (tests). */
export function resetFileCache() {
  cache.clear();
  inflight.clear();
  totalBytes = 0;
}
