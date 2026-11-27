import { describe, expect, test } from 'bun:test';
import * as chat from '#shared/proto/chatproto/index.ts';
import { ProbeCache, overlaySessionChats } from './cache.ts';

describe('ProbeCache', () => {
  test('serves fresh hits within TTL, expires after TTL, and evicts oldest LRU entry', async () => {
    let clock = 1000;
    const cache = new ProbeCache<string>({ ttlMs: 5000, maxEntries: 2, now: () => clock });
    let fetches = 0;
    const get = (k: string, refresh = false) =>
      cache.get(k, { refresh, signal: AbortSignal.timeout(5000), timeoutMs: 5000 }, async () => `${k}#${++fetches}`);

    expect(await get('a')).toBe('a#1');
    expect(await get('a')).toBe('a#1');
    expect(fetches).toBe(1);

    expect(await get('b')).toBe('b#2');
    // Touch 'a' so 'b' becomes LRU.
    expect(await get('a')).toBe('a#1');
    expect(await get('c')).toBe('c#3');
    // 'b' was evicted; 'a' and 'c' stay.
    expect(await get('a')).toBe('a#1');
    expect(await get('b')).toBe('b#4');
    expect(fetches).toBe(4);

    // Refresh bypasses cache and updates it.
    expect(await get('b', true)).toBe('b#5');
    expect(await get('b')).toBe('b#5');

    // Expiry triggers a fresh fetch.
    clock += 6000;
    expect(await get('b')).toBe('b#6');
  });

  test('coalesces concurrent in-flight callers, never caches errors, and isolates caller aborts', async () => {
    const cache = new ProbeCache<string>({ ttlMs: 60_000, maxEntries: 8, now: () => 0 });
    let calls = 0;
    let release!: (v: string) => void;
    let upstreamSignal!: AbortSignal;
    const fetchSlow = (signal: AbortSignal) => {
      calls++;
      upstreamSignal = signal;
      return new Promise<string>((r) => (release = r));
    };

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = cache.get('k', { signal: ac1.signal, timeoutMs: 5000 }, fetchSlow);
    const p2 = cache.get('k', { signal: ac2.signal, timeoutMs: 5000 }, fetchSlow);
    expect(calls).toBe(1);

    // Aborting one waiter does not abort the shared upstream probe.
    ac1.abort(new Error('first cancelled'));
    await expect(p1).rejects.toThrow('first cancelled');
    expect(upstreamSignal.aborted).toBe(false);

    release('ok');
    expect(await p2).toBe('ok');

    // Aborting the ONLY waiter aborts the upstream probe.
    const ac3 = new AbortController();
    const p3 = cache.get('only', { signal: ac3.signal, timeoutMs: 5000 }, fetchSlow);
    ac3.abort(new Error('all gone'));
    await expect(p3).rejects.toThrow('all gone');
    expect(upstreamSignal.aborted).toBe(true);

    // Errors are never cached.
    let failOnce = true;
    await expect(
      cache.get('err', { signal: AbortSignal.timeout(5000), timeoutMs: 5000 }, async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('boom');
        }
        return 'recovered';
      }),
    ).rejects.toThrow('boom');
    expect(await cache.get('err', { signal: AbortSignal.timeout(5000), timeoutMs: 5000 }, async () => 'recovered')).toBe('recovered');
  });

  test('invalidatePrefix clears matching machine entries only', async () => {
    const cache = new ProbeCache<string>({ ttlMs: 60_000, maxEntries: 8, now: () => 0 });
    cache.put('m1\0claude\0/w\0', 'v1');
    cache.put('m2\0claude\0/w\0', 'v2');
    cache.invalidatePrefix('m1\0');
    let n = 0;
    expect(await cache.get('m1\0claude\0/w\0', { signal: AbortSignal.timeout(5000), timeoutMs: 5000 }, async () => `fresh${++n}`)).toBe(
      'fresh1',
    );
    expect(await cache.get('m2\0claude\0/w\0', { signal: AbortSignal.timeout(5000), timeoutMs: 5000 }, async () => `fresh${++n}`)).toBe(
      'v2',
    );
  });

  test('invalidatePrefix and clear abort in-flight refresh probes and prevent stale resurrection', async () => {
    const cache = new ProbeCache<string>({ ttlMs: 60_000, maxEntries: 8, now: () => 0 });
    let releaseRefresh!: (v: string) => void;
    let refreshSignal!: AbortSignal;
    const pRefresh = cache.get('m1\0k', { refresh: true, signal: AbortSignal.timeout(5000), timeoutMs: 5000 }, (sig) => {
      refreshSignal = sig;
      return new Promise<string>((r) => (releaseRefresh = r));
    });

    // Invalidate while refresh: true is in flight: upstream signal MUST abort and
    // even if upstream still resolves late, it must NOT repopulate the cache!
    cache.invalidatePrefix('m1\0');
    expect(refreshSignal.aborted).toBe(true);
    releaseRefresh('stale-from-dead-host');
    await pRefresh;

    const after = await cache.get('m1\0k', { signal: AbortSignal.timeout(5000), timeoutMs: 5000 }, async () => 'new-host-value');
    expect(after).toBe('new-host-value');

    // Earlier normal flight must not overwrite a newer refresh: true result.
    let releaseOld!: (v: string) => void;
    let releaseNew!: (v: string) => void;
    const pOld = cache.get(
      'm2\0k',
      { signal: AbortSignal.timeout(5000), timeoutMs: 5000 },
      () => new Promise<string>((r) => (releaseOld = r)),
    );
    const pNew = cache.get(
      'm2\0k',
      { refresh: true, signal: AbortSignal.timeout(5000), timeoutMs: 5000 },
      () => new Promise<string>((r) => (releaseNew = r)),
    );
    releaseNew('newer-refresh');
    expect(await pNew).toBe('newer-refresh');
    releaseOld('older-normal');
    expect(await pOld).toBe('older-normal');
    // Cache retains 'newer-refresh', NOT 'older-normal'.
    expect(await cache.get('m2\0k', { signal: AbortSignal.timeout(5000), timeoutMs: 5000 }, async () => 'unexpected')).toBe(
      'newer-refresh',
    );
  });
});

describe('overlaySessionChats', () => {
  test('reflects newly imported and deleted chats over cached sessions, including empty live states after last delete', () => {
    const cached: chat.Session[] = [
      { sessionId: 's1', cwd: '/w', title: 'first' },
      { sessionId: 's2', cwd: '/w', title: 'second', chat: 'c0000000000000002' },
    ];
    const states: chat.ChatState[] = [
      {
        id: 'c0000000000000001',
        kind: 'claude',
        title: 'first',
        cwd: '/w',
        state: chat.State.Idle,
        status: chat.Status.Idle,
        updated: '2026-01-01T00:00:00Z',
        seq: 1,
        sessionId: 's1',
      },
    ];
    const out = overlaySessionChats(cached, 'claude', states);
    expect(out[0]?.chat).toBe('c0000000000000001');
    expect(out[1]?.chat).toBeUndefined();

    // When the watch is known and the last chat was deleted (states = []), stale chat links MUST be cleared.
    const emptyOut = overlaySessionChats(cached, 'claude', []);
    expect(emptyOut[0]?.chat).toBeUndefined();
    expect(emptyOut[1]?.chat).toBeUndefined();

    // When the watch has not yet read states (states = undefined), cached chat links stay untouched.
    const unknownOut = overlaySessionChats(cached, 'claude', undefined);
    expect(unknownOut[1]?.chat).toBe('c0000000000000002');
  });
});
