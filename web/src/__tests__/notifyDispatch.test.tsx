// @vitest-environment jsdom
//
// Unified notification dispatcher tests: Electron native notification routing
// and click-to-focus, Web Notification permission UX & fallbacks, suppression
// when focused, tag deduplication, unopened chat notifications & badge counts,
// usage alert routing, and SettingsDialog permission controls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));

import {
  closeNotification,
  dispatchNotification,
  focusNotificationTarget,
  initNotifications,
  notificationPermission,
  notifyAgent,
  requestNotifyPermission,
  resetNotifyForTests,
  updateBadge,
} from '../notify';
import * as shellMod from '../shell';
import { useSettings, type SettingValue } from '../settings';
import { useStore } from '../state/store';
import { allPlugins, definePlugins } from '../plugins/registry';
import { applySnapshot, useUsage } from '../plugins/usage/state';
import { SettingsDialog } from '../components/SettingsDialog';
import { setLocale, t } from '../i18n';
import type { MachineState } from '../lib/machine';
import * as L from '../term/layout';
import { FakeHub, settle } from './fakeTerms';
import { dummyPlugin, resetViewStatuses, thing } from './viewStatusPlugin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const savedPlugins = [...allPlugins()];
const set = (key: string, value: SettingValue) =>
  useSettings.setState({ values: { ...useSettings.getState().values, [key]: { value, source: 'global' } } });

describe('unified notification dispatcher', () => {
  let hub: FakeHub;
  let hasFocus = false;
  const shownWeb: Array<{ title: string; body?: string; tag?: string; silent?: boolean | null; closed: number; n: FakeNotification }> = [];
  let webPermission: NotificationPermission = 'granted';
  let requestCalls = 0;

  class FakeNotification {
    static get permission() {
      return webPermission;
    }
    static requestPermission() {
      requestCalls++;
      webPermission = 'granted';
      return Promise.resolve('granted' as NotificationPermission);
    }
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    closed = 0;
    constructor(title: string, o?: NotificationOptions) {
      shownWeb.push({ title, body: o?.body, tag: o?.tag, silent: o?.silent, closed: 0, n: this });
    }
    close() {
      this.closed++;
      const entry = shownWeb.find((x) => x.n === this);
      if (entry) entry.closed = this.closed;
      this.onclose?.();
    }
  }

  const setPageVisible = (visible: boolean) => {
    hasFocus = visible;
    Object.defineProperty(document, 'visibilityState', { value: visible ? 'visible' : 'hidden', configurable: true });
  };

  beforeEach(async () => {
    setLocale('en');
    resetNotifyForTests();
    resetViewStatuses();
    definePlugins([dummyPlugin]);
    useSettings.setState({ values: {}, loaded: true, sections: [{ id: 'notifications', order: 1 }], defs: [] });
    webPermission = 'granted';
    requestCalls = 0;
    shownWeb.length = 0;
    vi.stubGlobal('Notification', FakeNotification);
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    vi.spyOn(document, 'hasFocus').mockImplementation(() => hasFocus);
    setPageVisible(false);

    hub = new FakeHub();
    hub.machine('m', [FakeHub.term('t1', { agent: 'claude', agent_status: 'working' })], {
      version: 2,
      workspaces: [
        {
          id: 'aaaaaaaa',
          name: 'api',
          cwd: '',
          tabs: [
            { root: { terminal: 't1' }, focused: 't1' },
            { root: thing('v1', 'one'), focused: 'view:v1' },
          ],
          selected: 0,
        },
      ],
      selected: 0,
    });
    hub.install();
    const s = useStore.getState();
    s.setReadOnly(false);
    s.setMachines([{ id: 'm', label: 'gpu', kind: 'ssh', status: 'ready' } as unknown as MachineState]);
    s.selectMachine('m');
    hub.model.subscribe('m');
    await settle();
  });

  afterEach(() => {
    resetNotifyForTests();
    definePlugins(savedPlugins);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses Electron native notifications when desktopShell.notifications is present and routes click targets', async () => {
    const shownNative: shellMod.DesktopNotificationOptions[] = [];
    const closedNative: string[] = [];
    const badgeCounts: number[] = [];
    let clickCb: ((t: shellMod.NotificationTarget) => void) | undefined;
    const desktopNotifications: shellMod.DesktopNotifications = {
      supported: async () => true,
      show: async (opts) => {
        shownNative.push(opts);
        return true;
      },
      close: (tag) => closedNative.push(tag),
      setBadgeCount: (count) => badgeCounts.push(count),
      onClick: (fn) => {
        clickCb = fn;
        return () => {
          clickCb = undefined;
        };
      },
    };
    vi.spyOn(shellMod, 'desktopShell', 'get').mockReturnValue({ notifications: desktopNotifications } as shellMod.DesktopShell);

    const off = initNotifications();
    expect(badgeCounts.at(-1)).toBe(0);
    // In Electron desktop, requestNotifyPermission does not trigger browser prompt.
    expect(notificationPermission()).toBe('desktop');
    expect(await requestNotifyPermission({ force: true })).toBe('granted');
    expect(requestCalls).toBe(0);

    hub.event('m', 'agent', 't1', { agent_status: 'blocked' });
    await settle();
    expect(badgeCounts.at(-1)).toBe(1);

    notifyAgent('m', { terminal: 't1', agent: 'claude', agent_status: 'blocked', title: 'approve' }, false);
    await settle();
    expect(shownWeb).toEqual([]);
    expect(shownNative).toEqual([
      {
        title: 'claude needs your input',
        body: 'gpu · api · 1\napprove',
        tag: 'm|t1',
        silent: true,
        urgency: 'critical',
        target: { kind: 'pane', machine: 'm', pane: 't1' },
      },
    ]);

    // Muting the tab immediately clears the native dock badge and closes the active notification.
    hub.model.mutate('m', (l) => L.muteTab(l, 'aaaaaaaa', 0, true));
    await settle();
    expect(badgeCounts.at(-1)).toBe(0);
    expect(closedNative).toEqual(['m|t1']);

    // Unmuting the tab immediately restores the native dock badge count.
    hub.model.mutate('m', (l) => L.muteTab(l, 'aaaaaaaa', 0, false));
    await settle();
    expect(badgeCounts.at(-1)).toBe(1);

    // Focusing the notified pane when window becomes visible clears the next active notification.
    notifyAgent('m', { terminal: 't1', agent: 'claude', agent_status: 'blocked', title: 'approve again' }, false);
    await settle();
    setPageVisible(true);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(closedNative).toEqual(['m|t1']);

    // Clicking a native notification for a panel routes to that panel.
    clickCb!({ kind: 'panel', panel: 'usage' });
    expect(useStore.getState().panel).toBe('usage');
    off();
  });

  it('falls back to Web Notification if Electron native show returns false', async () => {
    const desktopNotifications: shellMod.DesktopNotifications = {
      supported: async () => false,
      show: async () => false,
      close: () => {},
      onClick: () => () => {},
    };
    vi.spyOn(shellMod, 'desktopShell', 'get').mockReturnValue({ notifications: desktopNotifications } as shellMod.DesktopShell);

    const ok = await dispatchNotification({
      title: 'Fallback test',
      body: 'body',
      tag: 't',
    });
    expect(ok).toBe(true);
    expect(shownWeb.map((x) => x.title)).toEqual(['Fallback test']);
  });

  it('routes unopened chat notifications through ViewStatusDef.openTarget and includes them in badge counts', async () => {
    const opened: unknown[] = [];
    const unopenedList = [{ id: 'c00000000000000a1', title: 'Unopened chat', status: 'blocked' as const, open: () => {} }];
    definePlugins([
      {
        ...dummyPlugin,
        id: 'chat',
        viewStatus: {
          ...dummyPlugin.viewStatus!,
          unopened: () => unopenedList,
          openTarget: (target) => {
            opened.push(target);
          },
        },
      },
    ]);

    updateBadge();
    expect(document.title).toMatch(/^\(1\) /);

    notifyAgent(
      'm',
      { terminal: '', chat: 'c00000000000000a1', agent: 'claude', display_agent: 'Claude Code', agent_status: 'blocked', title: 'Fix bug' },
      false,
    );
    await settle();
    expect(shownWeb).toHaveLength(1);
    expect(shownWeb[0].tag).toBe('m|chat:c00000000000000a1');
    expect(shownWeb[0].body).toBe('gpu\nFix bug');

    shownWeb[0].n.onclick!();
    expect(opened).toEqual([{ kind: 'chat', machine: 'm', chat: 'c00000000000000a1', agent: 'claude' }]);
  });

  it('deduplicates Web notifications by tag and closes via closeNotification', async () => {
    await dispatchNotification({ title: 'First', tag: 'dup' });
    await dispatchNotification({ title: 'Second', tag: 'dup' });
    expect(shownWeb).toHaveLength(2);
    expect(shownWeb[0].closed).toBe(1);
    expect(shownWeb[1].closed).toBe(0);

    closeNotification('dup');
    expect(shownWeb[1].closed).toBe(1);
  });

  it('suppresses toast when visible and already focused on the target pane', async () => {
    setPageVisible(true);
    const toast = vi.spyOn(useStore.getState(), 'toast');
    // t1 is currently focused on tab 0.
    notifyAgent('m', { terminal: 't1', agent: 'claude', agent_status: 'blocked', title: 'approve' }, false);
    await settle();
    expect(shownWeb).toEqual([]);
    expect(toast).not.toHaveBeenCalled();

    // view:v1 is on tab 1 (not focused): toast IS shown.
    focusNotificationTarget({ kind: 'pane', machine: 'm', pane: 't1' });
    await dispatchNotification({
      title: 'Other pane blocked',
      target: { kind: 'pane', machine: 'm', pane: 'view:v1' },
      visibleToast: 'Other pane blocked · gpu',
    });
    expect(toast).toHaveBeenCalledWith('Other pane blocked · gpu');
  });

  it('routes usage alerts through the unified dispatcher', async () => {
    useUsage.setState({ snapshot: undefined });
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    const desktopShown: shellMod.DesktopNotificationOptions[] = [];
    vi.spyOn(shellMod, 'desktopShell', 'get').mockReturnValue({
      notifications: {
        supported: async () => true,
        show: async (o: shellMod.DesktopNotificationOptions) => (desktopShown.push(o), true),
        close: () => {},
        onClick: () => () => {},
      },
    } as unknown as shellMod.DesktopShell);

    applySnapshot({
      accounts: [],
      refresh: '',
      interval: 60,
      polling: false,
      machines: {},
      status: {},
      alerts: [
        {
          id: 'a1',
          kind: 'threshold',
          key: 'k1',
          provider: 'anthropic',
          window: { kind: 'session', usedPct: 85 },
          threshold: 80,
          at: Date.now() / 1000,
        },
      ],
      updatedAt: Date.now() / 1000,
    });
    await settle();
    expect(desktopShown).toHaveLength(1);
    expect(desktopShown[0].tag).toBe('usage|a1');
    expect(desktopShown[0].target).toEqual({ kind: 'panel', panel: 'usage' });
  });

  it('handles browser permission UX without spamming and shows status in SettingsDialog', async () => {
    vi.spyOn(shellMod, 'desktopShell', 'get').mockReturnValue(undefined);
    webPermission = 'default';
    set('notifications.system', true);

    // Non-forced call asks at most once per session.
    expect(await requestNotifyPermission()).toBe('granted');
    expect(requestCalls).toBe(1);
    webPermission = 'default';
    expect(await requestNotifyPermission()).toBe('default');
    expect(requestCalls).toBe(1);

    // SettingsDialog shows Allow button when default & enabled, and denied hint when denied.
    useSettings.setState({
      loaded: true,
      sections: [{ id: 'notifications', order: 1 }],
      defs: [{ key: 'notifications.system', type: 'bool', default: true, scope: 'app', section: 'notifications', order: 20 }],
      values: { 'notifications.system': { value: true, source: 'default' } },
    });
    useStore.getState().openSettings({ page: 'notifications' });

    const host = document.createElement('div');
    document.body.append(host);
    const root: Root = createRoot(host);
    await act(async () => root.render(createElement(SettingsDialog)));

    const allowBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === t('settings.notifications.permission.allow'));
    expect(allowBtn).toBeTruthy();

    await act(async () => {
      allowBtn!.click();
    });
    expect(requestCalls).toBe(2);
    // Now granted: Allow button disappears.
    expect(
      [...host.querySelectorAll('button')].find((b) => b.textContent === t('settings.notifications.permission.allow')),
    ).toBeUndefined();

    // Denied shows guidance message.
    webPermission = 'denied';
    await act(async () => root.render(createElement(SettingsDialog)));
    expect(host.textContent).toContain(t('settings.notifications.permission.denied'));

    // Reset layout to clean up.
    await act(async () => root.unmount());
    host.remove();
    useStore.getState().openSettings(false);
    L.focusPane(hub.layout('m')!, 't1');
  });
});
