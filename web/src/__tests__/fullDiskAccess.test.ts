// @vitest-environment jsdom
// Full Disk Access in the settings: shown only in the desktop app on macOS,
// in the user's Terminal page (and its search), with the state the hub
// reports for terminals and for the app, read again when the window comes
// back to the front; its buttons ask the shell, and what to restart comes
// with the matching action after asking. The command opens System Settings
// and the row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopShell } from '../shell';

const bridge = vi.hoisted(() => ({ shell: undefined as DesktopShell | undefined }));
vi.mock('../shell', () => ({
  get desktopShell() {
    return bridge.shell;
  },
}));
vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, api: () => Promise.resolve({}), retry: () => {} } }));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsDialog } from '../components/SettingsDialog';
import { builtinDefaults, useSettings, type SettingDef, type SettingState } from '../settings';
import { useStore } from '../state/store';
import { useDialog } from '../dialog';
import { useKeys } from '../keybindings';
import { commandEnabled, commandShown, runCommand } from '../keymap';
import '../commands';
import type { MachineState } from '../lib/machine';
import type { PrivacyState } from '../fullDiskAccess';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: DesktopShell = {
  onCommand: () => () => {},
  pathForFile: () => '',
  onOpenFolders: () => () => {},
  setDisabledCommands: () => {},
  setUnsaved: () => {},
  onCloseRequest: () => () => {},
  answerClose: () => {},
};
const asked: string[] = [];
const mac: DesktopShell = {
  ...base,
  privacy: {
    openFullDiskAccess: () => asked.push('open'),
    revealTerminalCore: () => asked.push('reveal'),
    relaunch: () => asked.push('relaunch'),
  },
};

const defs: SettingDef[] = [
  { key: 'terminal.fontSize', type: 'number', default: 13, min: 6, max: 40, scope: 'app', section: 'terminal', group: 'text', order: 20 },
  { key: 'terminal.cursorBlink', type: 'bool', default: true, scope: 'app', section: 'terminal', group: 'cursor', order: 60 },
  { key: 'notifications.sound', type: 'bool', default: true, scope: 'app', section: 'notifications', order: 10 },
  {
    key: 'codeServer.install',
    type: 'enum',
    enum: ['push', 'existing'],
    default: 'push',
    scope: 'machine',
    section: 'codeServer',
    order: 10,
  },
];
const machines: MachineState[] = [
  { id: 'local', label: 'mac', kind: 'local', status: 'ready', enabled: true, updated_at: 0 },
  { id: 'gpu', label: 'gpu-box', kind: 'ssh', target: 'u@gpu', status: 'ready', enabled: true, updated_at: 0 },
];

let host: HTMLElement;
let root: Root;
let requests: { method: string; url: string }[];
let privacy: PrivacyState;

beforeEach(async () => {
  asked.length = 0;
  requests = [];
  privacy = { files: 'granted', terminals: 'denied', hc: '/Users/u/.veldr-desktop/hc/herdr-core' };
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? 'GET', url: String(url) });
    if (String(url) === '/api/m/local/privacy') return new Response(JSON.stringify(privacy), { status: 200 });
    if (String(url) === '/api/m/local/hc/restart') return new Response('{"running":true}', { status: 200 });
    return new Response('{"error":"unknown"}', { status: 404 });
  });
  const values: Record<string, SettingState> = {};
  for (const [k, v] of Object.entries(builtinDefaults)) values[k] = { value: v, source: 'default' };
  useSettings.setState({
    loaded: true,
    defs,
    sections: [
      { id: 'terminal', order: 30 },
      { id: 'notifications', order: 50 },
      { id: 'codeServer', order: 60, advanced: true },
    ],
    values,
    problems: [],
    file: '/u/settings.json',
  });
  useStore.getState().setMachines(machines);
  useStore.setState({ readOnly: false, hcBusy: {}, toasts: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(SettingsDialog)));
});

afterEach(async () => {
  await act(async () => useStore.getState().openSettings(false));
  await act(async () => root.unmount());
  host.remove();
  useDialog.setState({ current: undefined });
  vi.unstubAllGlobals();
  bridge.shell = undefined;
});

const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
const row = () => q('.setting[data-key="fullDiskAccess"]');
const button = (text: string) => [...(row()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text);
const states = () => qa('.fda-access .fda-state').map((s) => s.getAttribute('data-access'));
const privacyReads = () => requests.filter((r) => r.url === '/api/m/local/privacy').length;
const open = async (view: Parameters<ReturnType<typeof useStore.getState>['openSettings']>[0]) => {
  await act(async () => useStore.getState().openSettings(view));
  await act(async () => {});
};
/** Answers the confirmation shown and returns its title. */
const reply = async (ok: boolean) => {
  await vi.waitFor(() => expect(useDialog.getState().current?.kind).toBe('confirm'));
  const req = useDialog.getState().current!;
  useDialog.setState({ current: undefined });
  if (req.kind !== 'confirm') throw new Error(req.kind);
  req.resolve(ok);
  await act(async () => {});
  return req.title;
};

describe('Full Disk Access in the settings', () => {
  it('is not shown in a browser, nor in the desktop app on Windows and Linux', async () => {
    for (const shell of [undefined, base]) {
      bridge.shell = shell;
      await open({ page: 'terminal' });
      expect(q('.settings-page-title')?.textContent).toBe('Terminal');
      expect(row()).toBeNull();
      expect(qa('.settings-group').map((h) => h.textContent)).toEqual(['Text', 'Cursor']);
      expect(commandEnabled('app.fullDiskAccess')).toBe(false);
      expect(commandShown('app.fullDiskAccess')).toBe(false);
      await open(false);
    }
    expect(privacyReads()).toBe(0);
  });

  it("ends the user's Terminal page on macOS, with the hub's state of terminals and the app", async () => {
    bridge.shell = mac;
    await open({ page: 'terminal' });
    expect(qa('.settings-group').map((h) => h.textContent)).toEqual(['Text', 'Cursor', 'Permissions']);
    expect(row()?.querySelector('.setting-title')?.textContent).toBe('Full Disk Access');
    expect(row()?.textContent).toContain('other apps’ data');
    expect(qa('.fda-access code').map((c) => c.textContent)).toEqual(['herdr-core', 'veldr']);
    expect(states()).toEqual(['denied', 'granted']);
    expect(qa('.fda-state').map((s) => s.textContent)).toEqual(['Not granted', 'Granted']);
    expect(commandShown('app.fullDiskAccess')).toBe(true);
    // Not in a machine's scope, nor on another page.
    await open({ machine: 'local', page: 'codeServer' });
    expect(row()).toBeNull();
    await open({ page: 'notifications' });
    expect(row()).toBeNull();
  });

  it('asks the shell to open System Settings and to show herdr-core in Finder', async () => {
    bridge.shell = mac;
    await open({ page: 'terminal' });
    await act(async () => button('Open System Settings…')!.click());
    await act(async () => button('Show herdr-core in Finder')!.click());
    expect(asked).toEqual(['open', 'reveal']);
  });

  it('reads the state again when the window comes back, and says what to restart while one lacks it', async () => {
    bridge.shell = mac;
    await open({ page: 'terminal' });
    const reads = privacyReads();
    expect(row()?.textContent).toContain('restart the terminal service and open new terminals');
    expect(button('Quit and Reopen…')).toBeUndefined();

    // Granted to herdr-core only after the terminal service restarted; the
    // app was turned off.
    privacy = { ...privacy, files: 'denied' };
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(privacyReads()).toBe(reads + 1);
    expect(states()).toEqual(['denied', 'denied']);
    await act(async () => button('Restart Terminal Service…')!.click());
    privacy = { ...privacy, terminals: 'granted' };
    expect(await reply(true)).toBe('Restart the terminal service of mac?');
    await vi.waitFor(() => expect(requests.some((r) => r.method === 'POST' && r.url === '/api/m/local/hc/restart')).toBe(true));
    await vi.waitFor(() => expect(states()).toEqual(['granted', 'denied']));
    expect(button('Show herdr-core in Finder')).toBeUndefined();
    expect(button('Restart Terminal Service…')).toBeUndefined();

    // Quitting and reopening the app is asked first.
    await act(async () => button('Quit and Reopen…')!.click());
    expect(await reply(false)).toBe('Quit and reopen veldr?');
    expect(asked).toEqual([]);
    await act(async () => button('Quit and Reopen…')!.click());
    await reply(true);
    expect(asked).toEqual(['relaunch']);
  });

  it('only shows the state and System Settings once both have it', async () => {
    bridge.shell = mac;
    privacy = { ...privacy, terminals: 'granted' };
    await open({ page: 'terminal' });
    expect(states()).toEqual(['granted', 'granted']);
    expect([...row()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Open System Settings…']);
    expect(row()?.textContent).not.toContain('In the list');
  });

  it('shows unknown when the hub cannot tell, and nothing to restart', async () => {
    bridge.shell = mac;
    privacy = { files: 'unknown', terminals: 'unknown', hc: '' };
    await open({ page: 'terminal' });
    expect(states()).toEqual(['unknown', 'unknown']);
    expect(qa('.fda-state').map((s) => s.textContent)).toEqual(['Unknown', 'Unknown']);
    expect(row()?.querySelectorAll('.fda-after').length).toBe(0);
    expect(button('Open System Settings…')).toBeDefined();
  });

  it('is found by a search of the user settings', async () => {
    bridge.shell = mac;
    await open({ page: 'notifications' });
    const search = q('.settings-search input') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      set.call(search, 'full disk');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
    expect(row()).not.toBeNull();
    expect(host.textContent).not.toContain('No settings match');
  });

  it('opens from the command, which macOS alone offers', async () => {
    bridge.shell = mac;
    useKeys.setState({ commands: [...useKeys.getState().commands] });
    expect(commandEnabled('app.fullDiskAccess')).toBe(true);
    runCommand('app.fullDiskAccess');
    await act(async () => {});
    expect(asked).toEqual(['open']);
    expect(useStore.getState().settings).toEqual({ page: 'terminal', row: 'fullDiskAccess' });
    expect(row()).not.toBeNull();
  });
});
