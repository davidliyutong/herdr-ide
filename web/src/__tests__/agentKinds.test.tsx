// @vitest-environment jsdom
//
// The command palette's commands that start an agent come from the agent
// kinds' registry (conversation/kinds.ts): the kinds, labels and command
// lines the palette offered from its own list before, in that order, each
// started split to the right of the focused pane, or in a new tab when no
// pane is focused.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));

import { useStore } from '../state/store';
import { FakeHub, settle } from './fakeTerms';
import type { MachineState } from '../lib/machine';
import { agentStartItems, Palette } from '../components/Palette';
import { setLocale } from '../i18n';
import * as L from '../term/layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PINNED = [
  { id: 'start:claude', label: 'New Agent: claude (Split Right)', argv: ['claude'] },
  { id: 'start:codex', label: 'New Agent: codex (Split Right)', argv: ['codex'] },
  { id: 'start:gemini', label: 'New Agent: gemini (Split Right)', argv: ['gemini'] },
  { id: 'start:opencode', label: 'New Agent: opencode (Split Right)', argv: ['opencode'] },
  { id: 'start:kimi', label: 'New Agent: kimi (Split Right)', argv: ['kimi'] },
  { id: 'start:grok', label: 'New Agent: grok (Split Right)', argv: ['grok'] },
  { id: 'start:cursor', label: 'New Agent: cursor (Split Right)', argv: ['cursor'] },
  { id: 'start:copilot', label: 'New Agent: copilot (Split Right)', argv: ['copilot'] },
  { id: 'start:qwen', label: 'New Agent: qwen (Split Right)', argv: ['qwen'] },
  { id: 'start:amp', label: 'New Agent: amp (Split Right)', argv: ['amp'] },
];

beforeAll(() => setLocale('en'));

let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = root = undefined;
});

/** A machine "m" whose one workspace holds tabs, shown in a palette. */
async function setup(tabs: L.Tab[]) {
  const hub = new FakeHub();
  const terminals = tabs.flatMap((tab) => L.tabPanes(tab).map((a) => FakeHub.term(a)));
  hub.machine('m', terminals, {
    version: 2,
    workspaces: [{ id: 'xxxxxxxx', name: 'x', cwd: '', tabs, selected: 0 }],
    selected: 0,
  });
  const model = hub.install();
  useStore.getState().setMachines([{ id: 'm', label: 'box', kind: 'local', status: 'ready' } as unknown as MachineState]);
  useStore.getState().selectMachine('m');
  model.subscribe('m');
  await settle();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Palette)));
  return { hub, model };
}

/** Opens the palette, types label and runs the first item, which must be it. */
async function choose(label: string) {
  await act(async () => useStore.getState().setPalette('commands'));
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  const input = host!.querySelector<HTMLInputElement>('.palette input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, label);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(host!.querySelector('.palette-item.sel .ellipsis')?.textContent).toBe(label);
  await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  await act(settle);
  await act(settle);
}

describe('the palette’s agents', () => {
  it('are the kinds, labels and command lines it offered before, in that order', () => {
    expect(agentStartItems()).toEqual(PINNED);
  });

  it('start the registry’s command line split to the right of the focused pane', async () => {
    const { hub, model } = await setup([{ root: { terminal: 'a' }, focused: 'a' }]);
    for (const item of PINNED) {
      const before = hub.calls.length;
      await choose(item.label);
      expect(host!.querySelector('.palette')).toBeNull();
      const runs = hub.calls.slice(before).filter((c) => c.method === 'terminal.run');
      expect(runs.map((c) => c.params.argv)).toEqual([item.argv]);
    }
    // One tab, its panes the first terminal and one per agent, in order.
    const ws = model.layout('m')!.workspaces[0];
    expect(ws.tabs).toHaveLength(1);
    expect(L.tabPanes(ws.tabs[0])).toEqual(['a', ...PINNED.map((_, i) => `t${i + 1}`)]);
  });

  it('start in a new tab when no pane is focused', async () => {
    const { hub, model } = await setup([]);
    await choose('New Agent: codex (Split Right)');
    expect(hub.calls.filter((c) => c.method === 'terminal.run').map((c) => c.params.argv)).toEqual([['codex']]);
    const ws = model.layout('m')!.workspaces[0];
    expect(ws.tabs.map((tab) => L.tabPanes(tab))).toEqual([['t1']]);
  });
});
