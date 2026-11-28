// @vitest-environment jsdom
// Startup optimization regression tests: parallel bootstrap deduplication,
// reconnect-only update checks, and lazyPlugin lifecycle & message buffering.
import { createElement, Suspense } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Puzzle } from 'lucide-react';
import { cachedFontWeight, rememberFontWeight, resetBootstrapForTests, retryFailedBootstrap, startBootstrap } from '../bootstrap';
import { initUpdateCheck } from '../update';
import { FileTitle } from '../components/PluginPane';
import { lazyPlugin } from '../plugins/lazy';
import { allPlugins, definePlugins, ensurePluginLoaded, isPluginPending, pluginMessage } from '../plugins/registry';
import { quickDiff } from '../plugins/files/quickDiff';
import type { PluginDef } from '../plugins/api';
import { useSettings } from '../settings';
import { useStore } from '../state/store';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const savedPlugins = [...allPlugins()];
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  resetBootstrapForTests();
  useStore.setState({ connected: false, readOnly: false, sshLogin: true, toasts: [] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  definePlugins(savedPlugins);
  resetBootstrapForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('startBootstrap', () => {
  it('starts settings, keybindings and config fetches in parallel once per page', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (url === '/api/config') return new Response(JSON.stringify({ read_only: true, ssh_login: false }), { status: 200 });
        if (url === '/api/settings')
          return new Response(JSON.stringify({ defs: [], sections: [], values: {}, problems: [] }), { status: 200 });
        if (url === '/api/keybindings')
          return new Response(JSON.stringify({ commands: [], user: [], effective: {}, problems: [] }), { status: 200 });
        return new Response('{}', { status: 404 });
      }),
    );

    const first = startBootstrap();
    const second = startBootstrap();
    expect(second).toBe(first);
    await Promise.all([first.settings, first.keybindings, first.config]);

    expect(urls.sort()).toEqual(['/api/config', '/api/keybindings', '/api/settings']);
    expect(useStore.getState().readOnly).toBe(true);
    expect(useStore.getState().sshLogin).toBe(false);

    // When all bootstrap requests succeeded, retryFailedBootstrap makes zero extra requests.
    urls.length = 0;
    await retryFailedBootstrap(first);
    expect(urls).toEqual([]);
  });

  it('retries only transient bootstrap failures when /ws connects', async () => {
    const urls: string[] = [];
    let attempt = 0;
    useSettings.setState({ loaded: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (url === '/api/keybindings')
          return new Response(JSON.stringify({ commands: [], user: [], effective: {}, problems: [] }), { status: 200 });
        attempt++;
        // First pass: /api/settings and /api/config fail transiently.
        if (attempt <= 2) return new Response('unavailable', { status: 503 });
        if (url === '/api/config') return new Response(JSON.stringify({ read_only: true, ssh_login: false }), { status: 200 });
        return new Response(JSON.stringify({ definitions: [], sections: [], values: {}, problems: [] }), { status: 200 });
      }),
    );

    const boot = startBootstrap();
    expect(await Promise.all([boot.settings, boot.keybindings, boot.config])).toEqual([false, true, false]);
    expect(useSettings.getState().loaded).toBe(false);

    urls.length = 0;
    await retryFailedBootstrap(boot);
    expect(urls.sort()).toEqual(['/api/config', '/api/settings']);
    expect(useSettings.getState().loaded).toBe(true);
    expect(useStore.getState().readOnly).toBe(true);
  });

  it('remembers and restores cached terminal font weight', () => {
    rememberFontWeight(500);
    expect(cachedFontWeight()).toBe(500);
    rememberFontWeight(400);
    expect(cachedFontWeight()).toBe(400);
  });
});

describe('initUpdateCheck', () => {
  it('skips fetching / on initial connect and checks only on reconnect', async () => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = '/assets/index-old.js';
    document.head.append(script);
    const fetches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetches.push(url);
        return new Response('<!doctype html><script type="module" src="/assets/index-new.js"></script>', { status: 200 });
      }),
    );

    try {
      initUpdateCheck();
      // First connection: page was just loaded with this script -> no fetch.
      useStore.setState({ connected: true });
      await Promise.resolve();
      expect(fetches).toEqual([]);

      // Disconnect then reconnect: hub may have upgraded -> check / once.
      useStore.setState({ connected: false });
      useStore.setState({ connected: true });
      await vi.waitFor(() => expect(fetches).toEqual(['/']));
      await vi.waitFor(() => expect(useStore.getState().toasts.length).toBe(1));
    } finally {
      script.remove();
    }
  });
});

describe('lazyPlugin', () => {
  it('exposes metadata synchronously, loads once on demand, replaces itself, and replays buffered messages in order', async () => {
    const received: Array<{ m: string; data: unknown }> = [];
    let loads = 0;
    let release!: (p: PluginDef) => void;
    const realLoaded = new Promise<PluginDef>((r) => (release = r));

    const stub = lazyPlugin(
      {
        id: 'lazydemo',
        title: 'files.title',
        icon: Puzzle,
        settings: { section: 'lazydemo', hasExtra: true },
        panels: [{ id: 'lazydemo', title: 'files.title', icon: Puzzle, command: 'view.panel.lazydemo' }],
        paneViews: {
          doc: {
            icon: Puzzle,
            title: (_m, v) => String(v.name ?? 'doc'),
            path: (_m, v) => (typeof v.path === 'string' ? v.path : undefined),
          },
        },
        newTabItems: [{ id: 'lazydemo', title: 'files.title', icon: Puzzle }],
        receivesMessages: true,
      },
      () => {
        loads++;
        return realLoaded;
      },
    );

    definePlugins([stub]);
    expect(allPlugins()[0]).toBe(stub);
    expect(stub.settings?.section).toBe('lazydemo');
    expect(stub.settings?.extra).toBeDefined();
    expect(stub.paneViews?.doc.title('m1', { plugin: 'lazydemo', kind: 'doc', id: '1', name: 'readme.md' })).toBe('readme.md');
    expect(loads).toBe(0);

    // Two messages arrive before the module loads: both buffer and trigger one load.
    pluginMessage('lazydemo', 'm1', { seq: 1 });
    pluginMessage('lazydemo', 'm1', { seq: 2 });
    expect(loads).toBe(1);
    expect(received).toEqual([]);

    const PanelBody = () => createElement('div', { className: 'lazy-panel-loaded' }, 'ready');
    const real: PluginDef = {
      id: 'lazydemo',
      title: 'files.title',
      icon: Puzzle,
      panels: [{ id: 'lazydemo', title: 'files.title', icon: Puzzle, component: PanelBody }],
      onMessage(m, data) {
        received.push({ m, data });
      },
    };
    release(real);
    await ensurePluginLoaded('lazydemo');

    expect(loads).toBe(1);
    expect(allPlugins()[0]).toBe(real);
    expect(received).toEqual([
      { m: 'm1', data: { seq: 1 } },
      { m: 'm1', data: { seq: 2 } },
    ]);

    const Panel = stub.panels![0].component;
    await act(async () => {
      root.render(createElement(Suspense, { fallback: null }, createElement(Panel)));
    });
    expect(host.querySelector('.lazy-panel-loaded')?.textContent).toBe('ready');
  });

  it('runs a synchronous stub onMessage immediately without clobbering replaced test plugins', async () => {
    const syncCalls: unknown[] = [];
    const realCalls: unknown[] = [];
    let release!: (p: PluginDef) => void;
    const realLoaded = new Promise<PluginDef>((r) => (release = r));

    const stub = lazyPlugin(
      {
        id: 'syncdemo',
        title: 'files.title',
        icon: Puzzle,
        onMessage(_m, data) {
          syncCalls.push(data);
        },
      },
      () => realLoaded,
    );

    definePlugins([stub]);
    pluginMessage('syncdemo', 'm1', { kind: 'urgent' });
    expect(syncCalls).toEqual([{ kind: 'urgent' }]);

    // Another test swaps the plugin list before the async import resolves.
    const replacement: PluginDef = { id: 'syncdemo', title: 'files.title', icon: Puzzle };
    definePlugins([replacement]);
    release({
      id: 'syncdemo',
      title: 'files.title',
      icon: Puzzle,
      onMessage(_m, data) {
        realCalls.push(data);
      },
    });
    await ensurePluginLoaded('syncdemo');

    // Must not overwrite replacement and must not replay already-handled sync message.
    expect(allPlugins()[0]).toBe(replacement);
    expect(realCalls).toEqual([]);
  });

  it('triggers loading the lazy files plugin when FileTitle mounts for a PreviewPane', async () => {
    let loads = 0;
    let release!: (p: PluginDef) => void;
    const realLoaded = new Promise<PluginDef>((r) => (release = r));
    const filesStub = lazyPlugin(
      {
        id: 'files',
        title: 'files.title',
        icon: Puzzle,
      },
      () => {
        loads++;
        return realLoaded;
      },
    );
    definePlugins([filesStub]);

    await act(async () => {
      root.render(
        <FileTitle m="m1" path="/tmp/a.txt" className="tab-label" tooltip={(gone) => (gone ? `a.txt · ${gone}` : 'a.txt')}>
          a.txt
        </FileTitle>,
      );
    });
    expect(loads).toBe(1);
    expect(host.querySelector('.is-gone')).toBeNull();

    release({
      id: 'files',
      title: 'files.title',
      icon: Puzzle,
      useFileGone: () => 'deleted',
    });
    await act(async () => {
      await ensurePluginLoaded('files');
    });
    const el = host.querySelector<HTMLElement>('.tab-label');
    expect(el?.classList.contains('is-gone')).toBe(true);
    expect(el?.title).toBe('a.txt · deleted');
  });

  it('loads git alongside files so decorations and quickDiff are registered before files resolves', async () => {
    await import('../plugins');
    expect(isPluginPending('files')).toBe(true);
    expect(isPluginPending('git')).toBe(true);

    await ensurePluginLoaded('files');

    expect(isPluginPending('files')).toBe(false);
    expect(isPluginPending('git')).toBe(false);
    expect(quickDiff()).toBeDefined();
    expect(allPlugins().find((p) => p.id === 'git')?.statusItems?.length).toBeGreaterThan(0);
  });
});
