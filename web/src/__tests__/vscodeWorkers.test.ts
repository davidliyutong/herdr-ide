// @vitest-environment jsdom
//
// Service workers VS Code's content registered on the UI's origin do not
// outlast VS Code's switch: while it is off for this client (once the core
// told the settings) the page unregisters every one; while it is on, none.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettings } from '../settings';
import { allPlugins, definePlugins, enableSetting } from '../plugins/registry';
import { vscodePlugin } from '../plugins/vscode';
import { dropServiceWorkers, followVSCodeSwitch } from '../plugins/vscode/workers';

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeWorkers() {
  const regs: { scope: string; gone: boolean }[] = [];
  const add = (scope: string) => regs.push({ scope, gone: false });
  const sw = {
    getRegistrations: async () =>
      regs
        .filter((r) => !r.gone)
        .map((r) => ({
          scope: r.scope,
          unregister: async () => {
            r.gone = true;
            return true;
          },
        })) as unknown as readonly ServiceWorkerRegistration[],
  };
  const left = () => regs.filter((r) => !r.gone).map((r) => r.scope);
  return { sw, add, left };
}

describe('service workers and VS Code', () => {
  const saved = [...allPlugins()];
  beforeEach(() => {
    definePlugins([vscodePlugin]);
    useSettings.setState({ loaded: false, values: {}, client: 'browser' });
  });
  afterEach(() => definePlugins(saved));

  it('unregisters every worker of the origin', async () => {
    const w = fakeWorkers();
    w.add('http://127.0.0.1:7780/');
    w.add('http://127.0.0.1:7780/m/a/code/');
    expect(await dropServiceWorkers(w.sw)).toBe(2);
    expect(w.left()).toEqual([]);
    expect(await dropServiceWorkers(undefined)).toBe(0);
  });

  it('follows the switch of this kind of client', async () => {
    const w = fakeWorkers();
    w.add('http://127.0.0.1:7780/m/a/code/');
    const off = followVSCodeSwitch(w.sw);
    await flush();
    // The settings not loaded yet: nothing is known, nothing dropped.
    expect(w.left()).toHaveLength(1);
    const key = enableSetting(vscodePlugin, 'browser')!;
    useSettings.setState({ loaded: true, values: { [key]: { value: true, source: 'global' } } });
    await flush();
    expect(w.left()).toHaveLength(1);
    // Off for this client: dropped, and again after it was on and off.
    useSettings.setState({ values: { [key]: { value: false, source: 'global' } } });
    await flush();
    expect(w.left()).toEqual([]);
    useSettings.setState({ values: { [key]: { value: true, source: 'global' } } });
    w.add('http://127.0.0.1:7780/m/a/code/');
    await flush();
    expect(w.left()).toHaveLength(1);
    // The desktop app's switch does not count in a browser.
    useSettings.setState({ values: { [enableSetting(vscodePlugin, 'desktop')!]: { value: true, source: 'global' } } });
    await flush();
    expect(w.left()).toEqual([]);
    off();
  });
});
