// Shared by the browser plugin's tests: a machine with a layout holding a
// browser pane, the pane and the frame layer rendered as the app does, and
// the core's routes scripted.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { useStore } from '../state/store';
import { useTerms } from '../state/terms';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { definePlugins } from '../plugins/registry';
import { browserPlugin } from '../plugins/browser';
import { PluginPane } from '../components/PluginPane';
import { BrowserLayer } from '../plugins/browser/BrowserLayer';
import { resetFrames } from '../plugins/browser/frames';
import { grantForward, resetGrants, useForwards } from '../plugins/browser/api';
import { FakeCore, settle } from './fakeTerms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** What the core answers; a function may return a promise or throw. */
export interface Routes {
  forward?: (body: { port: number }) => Response | Promise<Response>;
  listening?: () => Response;
  forwards?: () => Response;
  stop?: () => Response;
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

export function fakeBrowserApi(routes: Routes = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), body });
    if (url.endsWith('/p/browser/forwards') && method === 'POST')
      return routes.forward ? routes.forward(body) : json({ m: 'a', port: body.port, local: body.port, created: '', connections: 0 });
    if (url.includes('/p/browser/forwards/') && method === 'DELETE') return routes.stop ? routes.stop() : json({ ok: true });
    if (url.includes('/p/browser/listening')) return routes.listening ? routes.listening() : json({ ports: [] });
    if (url.endsWith('/p/browser/forwards')) return routes.forwards ? routes.forwards() : json({ forwards: [], available: true });
    return json({ error: 'unknown' }, 404);
  });
  return calls;
}

export interface Harness {
  core: FakeCore;
  host: HTMLElement;
  root: Root;
  view(): L.PluginView;
  /** The layout of machine a. */
  layout(): L.Layout;
  unmount(): void;
}

/** The pane while its tab is the one shown, as the workspace draws it, and
 * the frame layer, which is always there. */
function Host() {
  const layout = useTerms((s) => s.machines.a?.layout);
  const leaf = layout && L.findLeaf(layout, 'view:p1');
  const tab = layout && L.selectedTab(layout);
  const on = leaf && L.isPluginLeaf(leaf) && tab && L.panesOf(tab.root).includes('view:p1');
  return createElement(
    'div',
    null,
    on ? createElement(PluginPane, { m: 'a', pane: 'view:p1', view: leaf.view, focused: true }) : null,
    createElement(BrowserLayer),
  );
}

/** Machine a (an ssh machine called Box) whose only tab, after a
 * terminal's, is a browser pane with these fields; rendered. The view is
 * one found in the layout, which the user did not ask for in this page;
 * with `asked` the user did (as after typing its port), so the pane makes
 * its forward. */
export async function mountPane(fields: Record<string, unknown>, opts: { asked?: boolean } = {}): Promise<Harness> {
  resetFrames();
  resetGrants();
  if (opts.asked && typeof fields.m === 'string' && typeof fields.port === 'number') grantForward(fields.m, fields.port);
  useForwards.setState({ forwards: [], available: undefined });
  definePlugins([browserPlugin]);
  const core = new FakeCore();
  core.machine('a', [FakeCore.term('s1')], {
    version: 1,
    workspaces: [
      {
        id: 'w1',
        name: '',
        cwd: '',
        tabs: [
          { root: { terminal: 's1' }, focused: 's1' },
          { root: { view: { id: 'p1', plugin: 'browser', kind: 'page', ...fields } }, focused: 'view:p1' },
        ],
        selected: 1,
      },
    ],
    selected: 0,
  });
  core.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([{ id: 'a', label: 'Box', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  s.selectMachine('a');
  core.model.subscribe('a');
  await settle();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Host)));
  return {
    core,
    host,
    root,
    layout: () => core.model.layout('a')!,
    view: () => {
      const leaf = L.findLeaf(core.model.layout('a')!, 'view:p1');
      return (leaf as L.PluginLeaf).view;
    },
    unmount() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Lets promises and the model's writes settle. */
export const flush = () => act(async () => void (await settle()));

/** Types into the address field and presses Enter. */
export async function typeAddress(host: HTMLElement, text: string) {
  const input = host.querySelector<HTMLInputElement>('.browser-address')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  await flush();
}

export const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click());
