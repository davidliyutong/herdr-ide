// @vitest-environment jsdom
// The settings dialog as a user meets it: scopes (the user's, a machine's),
// controls per type that save through the API without losing the page,
// terminal colors from schemes, and the keyboard shortcuts page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, api: () => Promise.resolve({}), retry: () => {} } }));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import registry from '../../../design/generated/registry.json';
import { SettingsDialog, formatNumber, machineScoped } from '../components/SettingsDialog';
import { applySettings, builtinDefaults, useSettings, type SettingDef, type SettingState } from '../settings';
import { colors } from '../prefs';
import { schemeColors, schemes } from '../terminal/schemes';
import { useStore } from '../state/store';
import type { MachineState } from '../lib/machine';
import { matchScore } from '../components/Palette';
import { pickMonospace } from '../terminal/localFonts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Definitions as the core serves them, for the settings the tests use. */
const defs: SettingDef[] = [
  {
    key: 'terminal.fontSize',
    type: 'number',
    default: 13,
    min: 6,
    max: 40,
    step: 1,
    scope: 'app',
    section: 'terminal',
    group: 'text',
    order: 20,
  },
  { key: 'terminal.cursorBlink', type: 'bool', default: true, scope: 'app', section: 'terminal', group: 'cursor', order: 60 },
  {
    key: 'terminal.scrollback',
    type: 'number',
    default: 10000,
    min: 0,
    max: 100000,
    step: 1000,
    integer: true,
    scope: 'app',
    section: 'terminal',
    group: 'behavior',
    order: 70,
  },
  {
    key: 'notifications.mutedAgents',
    type: 'list',
    item: 'string',
    options: ['claude', 'codex', 'droid'],
    default: ['droid'],
    scope: 'app',
    section: 'notifications',
    order: 20,
  },
  {
    key: 'codeServer.install',
    type: 'enum',
    enum: ['push', 'download', 'existing'],
    default: 'push',
    scope: 'machine',
    section: 'codeServer',
    order: 10,
  },
  { key: 'gui.enabled', type: 'bool', default: true, scope: 'remote-machine', section: 'gui', order: 10 },
];

const state = (over: Record<string, Partial<SettingState>> = {}): Record<string, SettingState> => {
  const out: Record<string, SettingState> = {};
  for (const [k, v] of Object.entries(builtinDefaults)) out[k] = { value: v, source: 'default' };
  for (const [k, v] of Object.entries(over)) out[k] = { ...out[k], ...v } as SettingState;
  return out;
};

const machines: MachineState[] = [
  { id: 'local', label: 'mac', kind: 'local', status: 'ready', enabled: true, updated_at: 0 },
  { id: 'gpu', label: 'gpu-box', kind: 'ssh', target: 'u@gpu', status: 'ready', enabled: true, updated_at: 0 },
];

let host: HTMLElement;
let root: Root;
let requests: { method: string; url: string; body?: unknown }[];

beforeEach(async () => {
  requests = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method ?? 'GET', url: String(url), body });
    const values = { ...useSettings.getState().values };
    if (init?.method === 'PUT' && body) {
      const cur = values[body.key];
      values[body.key] = body.machine
        ? { ...cur, machines: { ...cur.machines, [body.machine]: body.value } }
        : { ...cur, value: body.value, source: 'global' };
    }
    return new Response(JSON.stringify({ values, problems: [] }), { status: 200 });
  });
  useSettings.setState({
    loaded: true,
    defs,
    sections: [
      { id: 'terminal', order: 30 },
      { id: 'notifications', order: 50 },
      { id: 'codeServer', order: 60, advanced: true },
      { id: 'gui', order: 70, advanced: true },
    ],
    values: state(),
    problems: [],
    file: '/home/u/.config/app/settings.json',
  });
  useStore.getState().setMachines(machines);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(SettingsDialog)));
});

afterEach(async () => {
  await act(async () => useStore.getState().openSettings(false));
  await act(async () => root.unmount());
  host.remove();
  applySettings({ values: state(), problems: [] });
  vi.unstubAllGlobals();
});

const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const qa = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const byText = (sel: string, text: string) => qa(sel).find((e) => e.textContent === text)!;

describe('settings dialog', () => {
  it('lists sections, the advanced ones last, and one scope per machine', async () => {
    await act(async () => useStore.getState().openSettings({ page: 'terminal' }));
    expect(qa('.settings-nav button').map((b) => b.textContent)).toEqual([
      'Terminal',
      'Notifications',
      'Keyboard Shortcuts',
      'VS Code',
      'Program Windows',
    ]);
    expect(q('.settings-nav-heading')?.textContent).toBe('Advanced');
    expect(qa('.settings-scopes button').map((b) => b.textContent)).toEqual(['User', 'mac', 'gpu-box']);
    // Groups head their settings; no setting shows its id.
    expect(qa('.settings-group').map((h) => h.textContent)).toEqual(['Text', 'Cursor', 'Behavior']);
    expect(host.textContent).not.toContain('terminal.fontSize');
  });

  it('steps a number, keeps the field focused and marks the setting modified', async () => {
    await act(async () => useStore.getState().openSettings({ page: 'terminal' }));
    const row = q('.setting[data-key="terminal.scrollback"]')!;
    expect(row.textContent).toContain('lines');
    expect(row.textContent).toContain(`${formatNumber(0)}–${formatNumber(100000)}`);
    expect(row.textContent).not.toContain('e+');
    const plus = row.querySelectorAll('button')[2];
    plus.focus();
    await act(async () => plus.click());
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { key: 'terminal.scrollback', value: 11000 } });
    expect(q('.setting[data-key="terminal.scrollback"]')?.classList.contains('modified')).toBe(true);
    // The same element keeps the keyboard: the page was not rebuilt.
    expect(document.activeElement).toBe(plus);
    // A typed value out of range is brought into it.
    const input = row.querySelector<HTMLInputElement>('input')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      set.call(input, '5000000');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(requests.at(-1)?.body, JSON.stringify(requests)).toMatchObject({ key: 'terminal.scrollback', value: 100000 });
  });

  it('edits a list with its offered values and free ones', async () => {
    await act(async () => useStore.getState().openSettings({ page: 'notifications' }));
    const boxes = qa('.list-option input') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, false, true]);
    await act(async () => boxes[1].click());
    expect(requests.at(-1)?.body).toMatchObject({ key: 'notifications.mutedAgents', value: ['droid', 'codex'] });
    const field = q<HTMLInputElement>('.list-add input')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      set.call(field, 'my-agent');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(requests.at(-1)?.body).toMatchObject({ value: ['droid', 'codex', 'my-agent'] });
    expect(qa('.list-chip').map((c) => c.textContent)).toEqual(['my-agent']);
  });

  it("shows a machine's own settings, which follow the user's until set", async () => {
    await act(async () => useStore.getState().openSettings({ machine: 'gpu' }));
    expect(q('.settings-scopes button.on')?.textContent).toBe('gpu-box');
    expect(qa('.settings-nav button').map((b) => b.textContent)).toEqual(['Overview', 'VS Code', 'Program Windows']);
    expect(q('.settings-body')?.textContent).toContain('u@gpu');
    await act(async () => byText('.settings-nav button', 'VS Code').click());
    const select = q<HTMLSelectElement>('.setting[data-key="codeServer.install"] select')!;
    expect(select.options[0].textContent).toBe('Same as User (Upload from this computer)');
    await act(async () => {
      select.value = 'existing';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { key: 'codeServer.install', value: 'existing', machine: 'gpu' } });
    // Back to the user's value: the machine's own is removed.
    await act(async () => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/settings?key=codeServer.install&machine=gpu' });
    // The local machine has no program windows of its own.
    expect(machineScoped(defs[5], machines[0])).toBe(false);
    expect(machineScoped(defs[4], machines[0])).toBe(true);
  });
});

describe('terminal colors', () => {
  afterEach(() => applySettings({ values: state(), problems: [] }));
  it('come from the scheme, each replaced by the user’s own', () => {
    expect(colors('dark').background).toBe(builtinDefaults['terminal.colors.dark.background']);
    applySettings({ values: state({ 'terminal.colorScheme.dark': { value: 'dracula', source: 'global' } }), problems: [] });
    expect(colors('dark')).toMatchObject({ background: '#282a36', foreground: '#f8f8f2' });
    applySettings({
      values: state({
        'terminal.colorScheme.dark': { value: 'dracula', source: 'global' },
        'terminal.colors.dark.foreground': { value: '#ff0000', source: 'global' },
      }),
      problems: [],
    });
    expect(colors('dark')).toMatchObject({ background: '#282a36', foreground: '#ff0000' });
  });
  it('has every scheme the core offers, with 16 colors', () => {
    const offered = (registry.i18n as string[])
      .filter((k) => k.startsWith('settings.terminal.colorScheme.dark.'))
      .map((k) => k.split('.').pop()!);
    expect(offered.length).toBeGreaterThan(5);
    for (const id of offered) {
      const c = schemeColors(id, 'dark');
      expect(c.palette, id).toHaveLength(16);
      for (const v of [c.background, c.foreground, c.cursor, c.selection, ...c.palette]) expect(v, id).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(Object.keys(schemes).sort()).toEqual(offered.filter((id) => id !== 'default').sort());
  });
});

describe('command palette', () => {
  it('ranks words that start with the query before letters in order', () => {
    expect(matchScore('spl', 'Split Right')).toBe(3);
    expect(matchScore('right', 'Split Right')).toBe(3);
    expect(matchScore('ight', 'Split Right')).toBe(2);
    expect(matchScore('spl', 'Focus Pane Left · gpu')).toBe(0);
    expect(matchScore('fpl', 'Focus Pane Left')).toBe(1);
    expect(matchScore('spri', 'Split Right')).toBe(1);
    expect(matchScore('nwt', 'New Tab')).toBe(0);
  });
});

describe('local fonts', () => {
  it('lists the monospace families, each once, with readable names', () => {
    const mono = new Set(['Menlo', 'Fira Code', '???®™??-', '楷体']);
    expect(pickMonospace(['Menlo', 'Menlo', 'Helvetica', '???®™??-', 'Fira Code', '楷体'], (f) => mono.has(f))).toEqual([
      'Fira Code',
      'Menlo',
      '楷体',
    ]);
  });
});
