// @vitest-environment jsdom
//
// The command palette with many items (the keyboard's item kept in view,
// pages, how many more there are) and the keyboard given back when it or
// the settings dialog closes.

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
  it('keeps the keyboard’s item in view, pages, and says how many more there are', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    before.focus();
    await act(async () => useStore.getState().setPalette('workspaces'));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const items = () => [...host.querySelectorAll<HTMLElement>('.palette-item')];
    expect(items()).toHaveLength(200);
    expect(host.querySelector('.palette-list')?.textContent).toContain('50 more: type to narrow the list');
    await key('PageDown');
    expect(host.querySelector('.palette-item.sel')?.textContent).toContain('project 8');
    expect(scrolled).toHaveBeenCalled();
    await key('ArrowUp');
    expect(host.querySelector('.palette-item.sel')?.textContent).toContain('project 7');
    // Escape closes it, and the keyboard goes back where it was.
    await key('Escape');
    expect(host.querySelector('.palette')).toBeNull();
    expect(document.activeElement).toBe(before);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
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
