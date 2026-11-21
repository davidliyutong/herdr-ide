// @vitest-environment jsdom
//
// Panels of the right sidebar as panes: the pane draws the panel, a drop
// places it where a pane would go (a pane's middle splits it), Open in
// Pane splits it beside the focused pane, Move to Sidebar takes it back,
// and a panel shows where the user has it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Files } from 'lucide-react';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeCore, settle } from './fakeTerms';
import { definePlugins, describeView, PANEL_VIEW } from '../plugins/registry';
import { PluginPane } from '../components/PluginPane';
import { droppedPanel, moveToSidebar, openPanelInPane, panelOfView, showPanel } from '../panelPanes';
import { paneMenu } from '../menus';
import { noteFocus, resetHistory } from '../paneHistory';
import { recentDirectory } from '../plugins/files/FilesPanel';
import type { PanelDef, PluginDef } from '../plugins/api';
import type { DropTarget } from '../paneDrag';
import { t } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const panel: PanelDef = {
  id: 'files',
  title: 'plugins.gui.title',
  icon: Files,
  component: () => createElement('div', { className: 'files-body' }, 'tree'),
};
const plugin: PluginDef = { id: 'files', title: 'plugins.gui.title', icon: Files, panels: [panel] };

let core: FakeCore;
const layout = () => core.model.layout('a')!;
const tab = (i = 0) => layout().workspaces[0].tabs[i];
const shape = (node: L.Node): unknown =>
  L.isSplit(node)
    ? [node.split, shape(node.children[0]), shape(node.children[1])]
    : L.isPluginLeaf(node)
      ? `${node.view.kind}:${String(node.view.panel)}`
      : L.paneKey(node);
const rect = new DOMRect(0, 0, 100, 100);

beforeEach(async () => {
  definePlugins([plugin]);
  core = new FakeCore();
  core.machine('a', [FakeCore.term('s1', { cwd: '/home/u' }), FakeCore.term('s2', { cwd: '/home/u/proj' })], {
    version: 2,
    workspaces: [
      {
        id: 'w1',
        name: '',
        cwd: '',
        tabs: [
          { root: { terminal: 's1' }, focused: 's1' },
          { root: { terminal: 's2' }, focused: 's2' },
        ],
        selected: 0,
      },
    ],
    selected: 0,
  });
  core.install();
  const s = useStore.getState();
  s.setReadOnly(false);
  s.setMachines([{ id: 'a', label: 'a', kind: 'ssh', status: 'ready', info: { home: '/home/u' } } as unknown as MachineState]);
  s.selectMachine('a');
  s.setPanel(undefined);
  core.model.subscribe('a');
  await settle();
});

afterEach(() => {
  definePlugins([]);
});

describe('a panel as a pane', () => {
  const leaf = (): L.PluginLeaf => ({ view: { id: 'p1', plugin: 'files', kind: PANEL_VIEW, panel: 'files' } });

  it('draws the panel and is named after it', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root: Root = createRoot(host);
    const view = leaf().view;
    await act(async () => root.render(createElement(PluginPane, { m: 'a', pane: 'view:p1', view, focused: false })));
    expect(host.querySelector('.panel-pane .files-body')?.textContent).toBe('tree');
    expect(describeView('a', view).title).toBe(t('plugins.gui.title'));
    expect(panelOfView(view)).toBe(panel);
    // A panel this version does not have says so.
    await act(async () =>
      root.render(createElement(PluginPane, { m: 'a', pane: 'view:p1', view: { ...view, panel: 'gone' }, focused: false })),
    );
    expect(host.textContent).toBe(t('plugins.panelUnknown'));
    act(() => root.unmount());
    host.remove();
  });

  it('is placed where it is dropped, a pane’s middle splitting it', () => {
    const at = (tg: DropTarget) => shape(L.selectedTab(droppedPanel(layout(), leaf(), tg))!.root);
    expect(at({ kind: 'pane', pane: 's1', zone: 'left', rect })).toEqual(['horizontal', 'panel:files', 's1']);
    expect(at({ kind: 'pane', pane: 's1', zone: 'bottom', rect })).toEqual(['vertical', 's1', 'panel:files']);
    expect(at({ kind: 'pane', pane: 's1', zone: 'center', rect })).toEqual(['horizontal', 's1', 'panel:files']);
    // Onto the other tab: beside its focused pane, which it shows.
    const onTab = droppedPanel(layout(), leaf(), { kind: 'tab', ws: 'w1', index: 1, rect });
    expect(shape(onTab.workspaces[0].tabs[1].root)).toEqual(['horizontal', 's2', 'panel:files']);
    expect(onTab.workspaces[0].selected).toBe(1);
    expect(onTab.workspaces[0].tabs[1].focused).toBe('view:p1');
    // The new-tab button: a tab of its own.
    const own = droppedPanel(layout(), leaf(), { kind: 'newTab', ws: 'w1', rect });
    expect(own.workspaces[0].tabs.map((x) => shape(x.root))).toEqual(['s1', 's2', 'panel:files']);
    // Its pane in the tab shown moves instead of a second one opening.
    const twice = droppedPanel(
      L.splitPane(layout(), 's1', 'horizontal', leaf()),
      leaf(),
      { kind: 'pane', pane: 's1', zone: 'top', rect },
      'view:p1',
    );
    expect(shape(twice.workspaces[0].tabs[0].root)).toEqual(['vertical', 'panel:files', 's1']);
  });

  it('opens in a pane beside the focused one, leaving the sidebar; Move to Sidebar takes it back', async () => {
    useStore.getState().setPanel('files');
    await openPanelInPane(panel);
    expect(shape(tab().root)).toEqual(['horizontal', 's1', 'panel:files']);
    expect(useStore.getState().panel).toBeUndefined();
    // Again: the same pane.
    core.model.mutate('a', (l) => L.focusPane(l, 's1'));
    await openPanelInPane(panel);
    expect(shape(tab().root)).toEqual(['horizontal', 's1', 'panel:files']);
    const key = tab().focused;
    expect(key).toMatch(/^view:/);
    // Shown where the user has it: its pane in the tab shown.
    core.model.mutate('a', (l) => L.focusPane(l, 's1'));
    showPanel('files');
    expect(tab().focused).toBe(key);
    expect(useStore.getState().panel).toBeUndefined();
    // Its pane's menu takes it back to the sidebar.
    const labels = paneMenu('a', key).map((e) => (e === 'sep' ? e : e.label));
    expect(labels[0]).toBe(t('plugins.moveToSidebar'));
    const view = (L.findLeaf(layout(), key) as L.PluginLeaf).view;
    await moveToSidebar('a', key, view);
    await settle();
    expect(shape(tab().root)).toBe('s1');
    expect(useStore.getState().panel).toBe('files');
    // Without a pane in the tab shown, the sidebar shows it.
    useStore.getState().setPanel(undefined);
    showPanel('files');
    expect(useStore.getState().panel).toBe('files');
  });

  it('follows the terminal focused last while a pane without a directory has the focus', async () => {
    resetHistory();
    expect(recentDirectory()).toBeUndefined();
    noteFocus({ m: 'a', pane: 's2' });
    noteFocus({ m: 'a', pane: 's1' });
    noteFocus({ m: 'b', pane: 'x' });
    expect(recentDirectory()).toBe('/home/u');
    noteFocus({ m: 'a', pane: 's2' });
    core.model.mutate('a', (l) => droppedPanel(l, leaf(), { kind: 'newTab', ws: 'w1', rect }));
    noteFocus({ m: 'a', pane: 'view:p1' });
    expect(recentDirectory()).toBe('/home/u/proj');
    resetHistory();
  });
});
