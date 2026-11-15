// Stands in for the core's settings API in tests: PUT /api/settings saves
// the value and answers with every value, as the core does.

import { vi } from 'vitest';
import { useSettings } from '../settings';

export function fakeSettingsApi() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/api/settings') && init?.method === 'PUT') {
      const { key, value } = JSON.parse(String(init.body));
      const values = { ...useSettings.getState().values, [key]: { value, source: 'global' } };
      return new Response(JSON.stringify({ values, problems: [] }), { status: 200 });
    }
    return new Response('{"error":"unknown"}', { status: 404 });
  });
}
