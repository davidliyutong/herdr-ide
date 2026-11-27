import { expect, test } from 'bun:test';
import { CoalesceCache } from './cache.ts';

test('caches fresh entries, evicts LRU, expires after TTL, and never caches errors', async () => {
  let now = 1000;
  const cache = new CoalesceCache<string>({ ttlMs: 500, maxEntries: 2, now: () => now });
  let calls = 0;
  const sig = new AbortController().signal;

  expect(await cache.get('a', { signal: sig }, async () => `v${++calls}`)).toBe('v1');
  expect(await cache.get('a', { signal: sig }, async () => `v${++calls}`)).toBe('v1');
  expect(calls).toBe(1);

  // Touching 'a' refreshes LRU so 'b' is evicted when 'c' arrives.
  expect(await cache.get('b', { signal: sig }, async () => `v${++calls}`)).toBe('v2');
  expect(await cache.get('a', { signal: sig }, async () => `v${++calls}`)).toBe('v1');
  expect(await cache.get('c', { signal: sig }, async () => `v${++calls}`)).toBe('v3');
  expect(await cache.get('a', { signal: sig }, async () => `v${++calls}`)).toBe('v1');
  expect(await cache.get('b', { signal: sig }, async () => `v${++calls}`)).toBe('v4');
  expect(calls).toBe(4);

  // TTL expiry.
  now += 500;
  expect(await cache.get('b', { signal: sig }, async () => `v${++calls}`)).toBe('v5');

  // Errors are never cached.
  await expect(
    cache.get('err', { signal: sig }, async () => {
      calls++;
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(await cache.get('err', { signal: sig }, async () => `ok${++calls}`)).toBe(`ok${calls}`);
});

test('coalesces concurrent callers, isolates single-caller abort, and aborts upstream when all waiters abort', async () => {
  const cache = new CoalesceCache<string>({ ttlMs: 1000, maxEntries: 8 });
  let calls = 0;
  let lastSignal: AbortSignal | undefined;
  let release!: (v: string) => void;

  const fetch = (signal: AbortSignal) => {
    calls++;
    lastSignal = signal;
    return new Promise<string>((resolve, reject) => {
      release = resolve;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };

  // Two callers share one upstream call; aborting one does not cancel the other.
  const ac1 = new AbortController();
  const ac2 = new AbortController();
  const p1 = cache.get('k', { signal: ac1.signal }, fetch);
  const p2 = cache.get('k', { signal: ac2.signal }, fetch);
  expect(calls).toBe(1);

  ac1.abort(new Error('c1'));
  await expect(p1).rejects.toThrow('c1');
  expect(lastSignal!.aborted).toBe(false);

  release('done');
  expect(await p2).toBe('done');

  // When all waiters abort, the shared upstream signal aborts too.
  cache.invalidate('k');
  const ac3 = new AbortController();
  const ac4 = new AbortController();
  const p3 = cache.get('k', { signal: ac3.signal }, fetch);
  const p4 = cache.get('k', { signal: ac4.signal }, fetch);
  const e3 = p3.catch((e) => e);
  const e4 = p4.catch((e) => e);
  expect(calls).toBe(2);
  ac3.abort(new Error('c3'));
  expect(lastSignal!.aborted).toBe(false);
  ac4.abort(new Error('c4'));
  expect(lastSignal!.aborted).toBe(true);
  expect((await e3).message).toBe('c3');
  expect((await e4).message).toBe('c4');
});

test('invalidatePrefix prevents an in-flight pre-write read from repopulating stale cache', async () => {
  const cache = new CoalesceCache<string>({ ttlMs: 5000, maxEntries: 8 });
  const sig = new AbortController().signal;
  let finishFirst!: (v: string) => void;
  const p1 = cache.get(
    'm1\0status',
    { signal: sig },
    () =>
      new Promise<string>((resolve) => {
        finishFirst = resolve;
      }),
  );
  // A write invalidates the machine's entries while p1 is still running.
  cache.invalidatePrefix('m1\0');
  // A new read starts fresh and populates the cache.
  expect(await cache.get('m1\0status', { signal: sig }, async () => 'fresh')).toBe('fresh');
  // The pre-write read resolves later but must not overwrite 'fresh'.
  finishFirst('stale');
  expect(await p1).toBe('stale');
  expect(await cache.get('m1\0status', { signal: sig }, async () => 'unexpected')).toBe('fresh');
});
