// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://example.test:5173/"}
//
// A loopback URL of the local machine, with the UI on another host (a LAN
// address, a name): a frame of localhost would show the viewer's own
// computer, so the link opens outside as before.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { useSettings } from '../settings';
import { definePlugins } from '../plugins/registry';
import { browserPlugin } from '../plugins/browser';
import { openLink } from '../terminal/links';
import { settle } from './fakeTerms';

beforeEach(() => {
  definePlugins([browserPlugin]);
  useSettings.setState((s) => ({ values: { ...s.values, 'plugins.browser.enabled': { value: true, source: 'global' } } }));
  useStore.getState().setMachines([{ id: 'l', label: 'l', kind: 'local', status: 'ready' } as unknown as MachineState]);
});
afterEach(() => {
  vi.restoreAllMocks();
  definePlugins([]);
});

describe('a link with the UI on another host', () => {
  it('opens a loopback URL of the local machine outside', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openLink({ kind: 'url', text: 'http://localhost:3000/' }, { m: 'l' });
    await settle();
    expect(open).toHaveBeenCalledWith('http://localhost:3000/', '_blank', 'noopener');
  });

  it('opens a loopback URL with the UI’s port: there localhost is the viewer’s computer, not the core', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openLink({ kind: 'url', text: 'http://localhost:5173/x' }, { m: 'l' });
    await settle();
    expect(open).toHaveBeenCalledWith('http://localhost:5173/x', '_blank', 'noopener');
    // The page's own origin stays refused.
    openLink({ kind: 'url', text: 'http://example.test:5173/api/x' }, { m: 'l' });
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
