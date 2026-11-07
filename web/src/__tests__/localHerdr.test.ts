import { afterEach, describe, expect, it, vi } from 'vitest';
import { herdrError, herdrRequest, isNewer } from '../lib/localHerdr';
import { hasMessage } from '../i18n';

describe('isNewer', () => {
  it('compares major.minor.patch numerically', () => {
    expect(isNewer('0.9.6', '0.9.5')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.9.5', '0.9.5')).toBe(false);
    expect(isNewer('0.9.4', '0.9.5')).toBe(false);
    expect(isNewer('v1.0.0', '0.9.5')).toBe(true);
    expect(isNewer(undefined, '0.9.5')).toBe(false);
    expect(isNewer('0.9.6', undefined)).toBe(false);
  });
});

describe('herdrRequest', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts actions and reads the status', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ managed: true, running: true, version: '0.9.5' })));
    vi.stubGlobal('fetch', fetch);
    expect((await herdrRequest('local', 'start')).running).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/api/m/local/herdr/start', { method: 'POST' });
    await herdrRequest('lo cal');
    expect(fetch).toHaveBeenLastCalledWith('/api/m/lo%20cal/herdr', undefined);
  });

  it('turns failed requests into the transport code with their detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'transport', detail: 'machine not connected' }), { status: 502 })),
    );
    expect(await herdrRequest('local')).toMatchObject({ error: 'transport', output: 'transport: machine not connected' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    expect(await herdrRequest('local', 'stop')).toMatchObject({ error: 'transport', running: false });
  });

  it('has a message for every error code the agent sends', () => {
    for (const code of [
      'not_found',
      'start_failed',
      'stop_failed',
      'check_failed',
      'update_failed',
      'not_managed',
      'not_local',
      'transport',
    ]) {
      expect(hasMessage(`herdr.error.${code}`)).toBe(true);
    }
    expect(herdrError({ managed: false, running: false, error: 'stop_failed' })).toBe('The server did not stop.');
    expect(herdrError({ managed: false, running: false, error: 'mystery' })).toBe('The request failed.');
    expect(herdrError({ managed: false, running: true })).toBe('');
  });
});
