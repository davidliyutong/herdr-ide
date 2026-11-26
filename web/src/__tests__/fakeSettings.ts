// Stands in for the hub's settings API in tests: PUT /api/settings saves
// the value and answers with every value, as the hub does.

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

/** Turns VS Code on for this page, a browser (the hub's verdict until it
 * answers), as a user who accepted its risk did; it is off by default. */
export function vscodeOn() {
  useSettings.setState((s) => ({ values: { ...s.values, 'plugins.vscode.browser': { value: true, source: 'global' } } }));
}
