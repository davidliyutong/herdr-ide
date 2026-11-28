// @vitest-environment jsdom
//
// Status bar widget show/hide (right-click menu, persistence,
// keeping non-widget plugin mounts active) and Monaco scrollBeyondLastLine.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Activity } from 'lucide-react';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { StatusBar } from '../App';
import { useMenu, isItem } from '../contextMenu';
import { useStore } from '../state/store';
import { useSettings } from '../settings';
import { allPlugins, definePlugins } from '../plugins/registry';
import { defaultEditorOptions } from '../plugins/monaco';
import { t } from '../i18n';
import type { PluginDef } from '../plugins/api';
import '../plugins';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AlwaysMounted = () => createElement('span', { className: 'always-mounted' });
const DemoWidget = () => createElement('button', { className: 'demo-widget' }, 'Demo');

const demoPlugin: PluginDef = {
  id: 'demo',
  title: 'monitor.title',
  icon: Activity,
  statusItems: [AlwaysMounted, { id: 'demo.widget', title: 'monitor.title', component: DemoWidget }],
};

describe('status bar widget visibility and editor scroll', () => {
  let host: HTMLDivElement;
  let root: Root;
  const saved = [...allPlugins()];

  beforeEach(() => {
    definePlugins([demoPlugin]);
    useSettings.setState({ values: {} });
    useMenu.setState({ menu: undefined });
    useStore.setState({
      order: ['local'],
      machineId: 'local',
      hiddenStatusWidgets: [],
      machines: {
        local: { id: 'local', label: 'Local', kind: 'local', status: 'ready', platform: 'darwin/arm64', enabled: true, updated_at: 0 },
      },
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    definePlugins(saved);
    useMenu.setState({ menu: undefined });
    useStore.setState({ hiddenStatusWidgets: [] });
  });

  it('hides and shows status bar widgets via context menu while keeping non-widget mounts active', async () => {
    await act(async () => {
      root.render(createElement(StatusBar, { connected: true, chord: false }));
    });

    expect(host.querySelector('.demo-widget')).not.toBeNull();
    expect(host.querySelector('.always-mounted')).not.toBeNull();
    expect(host.querySelector('[data-status-widget="app.machines"]')).not.toBeNull();

    // Right-clicking directly on the demo widget offers "Hide <widget>" and checklist items.
    const widget = host.querySelector<HTMLElement>('[data-status-widget="demo.widget"]')!;
    await act(async () => {
      widget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 600 }));
    });
    const menu1 = useMenu.getState().menu!;
    expect(menu1).toBeDefined();
    const hideEntry = menu1.entries.find((e) => isItem(e) && e.label === t('statusbar.hideWidget', { name: t('monitor.title') }));
    expect(hideEntry).toBeDefined();

    // Hide the widget: the widget unmounts, while the plain AlwaysMounted item stays mounted.
    await act(async () => {
      if (isItem(hideEntry)) hideEntry.run?.();
    });
    expect(host.querySelector('.demo-widget')).toBeNull();
    expect(host.querySelector('.always-mounted')).not.toBeNull();

    // Right-clicking the status bar opens the checklist including "Show All Widgets" (no trailing customize button).
    expect(host.querySelector('.status-widgets-btn')).toBeNull();
    const bar = host.querySelector<HTMLElement>('footer.statusbar')!;
    await act(async () => {
      bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 600 }));
    });
    const menu2 = useMenu.getState().menu!;
    const showAll = menu2.entries.find((e) => isItem(e) && e.label === t('statusbar.showAll'));
    expect(showAll).toBeDefined();

    await act(async () => {
      if (isItem(showAll)) showAll.run?.();
    });
    expect(host.querySelector('.demo-widget')).not.toBeNull();
  });

  it('enables scrolling beyond the last line in Monaco editors', () => {
    expect(defaultEditorOptions.scrollBeyondLastLine).toBe(true);
  });
});
