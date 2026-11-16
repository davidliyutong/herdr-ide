// @vitest-environment jsdom
//
// The command palette with many items (every one listed, those in view
// drawn, the keyboard's item kept in view, pages) and the keyboard given
// back when it or the settings dialog closes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));

import { useStore } from '../state/store';
import { FakeCore, settle } from './fakeTerms';
import type { MachineState } from '../lib/machine';
import { Palette } from '../components/Palette';
import { SettingsDialog } from '../components/SettingsDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let before: HTMLButtonElement;

beforeEach(async () => {
  const core = new FakeCore();
  const workspaces = Array.from({ length: 250 }, (_, i) => ({
    id: `ws${String(i).padStart(6, '0')}`,
    name: `project ${i}`,
    cwd: '',
    tabs: [],
    selected: 0,
  }));
  core.machine('m', [], { version: 2, workspaces, selected: 0 });
  core.install();
  useStore.getState().setMachines([{ id: 'm', label: 'box', kind: 'local', status: 'ready' } as unknown as MachineState]);
  core.model.subscribe('m');
  await settle();
  host = document.createElement('div');
  before = document.createElement('button');
  document.body.append(before, host);
  root = createRoot(host);
  await act(async () =>
    root.render(createElement(() => [createElement(Palette, { key: 'p' }), createElement(SettingsDialog, { key: 's' })])),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  before.remove();
});

const key = (k: string) =>
  act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

describe('palette', () => {
  it('lists every item, drawing those in view, and keeps the keyboard’s item in view', async () => {
    before.focus();
    await act(async () => useStore.getState().setPalette('workspaces'));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const items = () => [...host.querySelectorAll<HTMLElement>('.palette-item')];
    const list = host.querySelector<HTMLElement>('.palette-list')!;
    // 250 items in a box of their height; only those in view (and a few more) drawn.
    expect(host.querySelector<HTMLElement>('.palette-rows')!.style.height).toBe(`${250 * parseFloat(items()[1].style.top)}px`);
    expect(items().length).toBeGreaterThan(5);
    expect(items().length).toBeLessThan(60);
    expect(items()[0].getAttribute('aria-setsize')).toBe('250');
    const page = (n: number) => Array.from({ length: n }, () => key('PageDown')).reduce((a, b) => a.then(() => b), Promise.resolve());
    await page(1);
    const step = Number(host.querySelector('.palette-item.sel')!.getAttribute('aria-posinset')) - 1;
    expect(step).toBeGreaterThan(1);
    await key('ArrowUp');
    expect(host.querySelector('.palette-item.sel')?.textContent).toContain(`project ${step - 1}`);
    // The last item is reached and drawn: the list scrolled to it.
    for (let i = 0; i < 300 / step + 1; i++) await key('PageDown');
    expect(host.querySelector('.palette-item.sel')?.textContent).toContain('project 249');
    expect(list.scrollTop).toBeGreaterThan(0);
    // Escape closes it, and the keyboard goes back where it was.
    await key('Escape');
    expect(host.querySelector('.palette')).toBeNull();
    expect(document.activeElement).toBe(before);
  });
});

describe('settings dialog', () => {
  it('gives the keyboard back when it closes', async () => {
    before.focus();
    await act(async () => useStore.getState().openSettings({}));
    expect(document.activeElement).not.toBe(before);
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(host.querySelector('.settings')).toBeNull();
    expect(document.activeElement).toBe(before);
  });
});
