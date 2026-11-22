// @vitest-environment jsdom
//
// The AI usage panel reads the cost report again when the user's prices or
// the providers shown change, not only at its next refresh (the e2e test
// tests/usage.spec.ts runs the same against a core).

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useSettings, type SettingValue } from '../settings';
import { UsagePanel } from '../plugins/usage/UsagePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const fetches: string[] = [];

beforeEach(() => {
  fetches.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetches.push(String(url));
      const body = String(url).includes('/cost')
        ? { generatedAt: Math.floor(Date.now() / 1000), days: 90, rows: [], machines: {} }
        : { accounts: [], machines: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const costReads = () => fetches.filter((u) => u.startsWith('/api/p/usage/cost')).length;

function setValue(key: string, value: SettingValue) {
  useSettings.setState((s) => ({ values: { ...s.values, [key]: { value, source: 'global' } } }));
}

it('reads the cost again when usage.prices or a provider changes', async () => {
  await act(async () => root.render(createElement(UsagePanel)));
  await act(async () => {});
  const first = costReads();
  expect(first).toBe(1);

  // Another setting: nothing to read again.
  await act(async () => setValue('usage.statusBar', false));
  expect(costReads()).toBe(first);

  await act(async () => setValue('usage.prices', ['claude-opus-5-5 1 0.5 10']));
  expect(costReads()).toBe(first + 1);
  await act(async () => setValue('usage.providers.codex', false));
  expect(costReads()).toBe(first + 2);
});
