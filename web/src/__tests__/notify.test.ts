// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { badgeCount, notifyAgent, requestNotifyPermission, showsNotification, updateBadge } from '../notify';
import { builtinDefaults, useSettings, type SettingValue } from '../settings';
import { useStore } from '../state/store';
import { useTerms } from '../state/terms';
import type { MachineState } from '../lib/machine';
import type { TerminalRecord } from '../term/protocol';

const set = (key: string, value: SettingValue) =>
  useSettings.setState({ values: { ...useSettings.getState().values, [key]: { value, source: 'global' } } });

describe('which notifications show', () => {
  it('defaults to sounds, notifications and the badge, droid silent', () => {
    expect(builtinDefaults['notifications.sound']).toBe(true);
    expect(builtinDefaults['notifications.system']).toBe(true);
    expect(builtinDefaults['notifications.badge']).toBe(true);
    expect(builtinDefaults['notifications.mutedAgents']).toEqual(['droid']);
  });

  it('shows a system notification for blocked and done in the background, when on and allowed', () => {
    const c = { enabled: true, granted: true, visible: false };
    expect(showsNotification({ agent_status: 'blocked' }, c)).toBe(true);
    expect(showsNotification({ agent_status: 'done' }, c)).toBe(true);
    expect(showsNotification({ agent_status: 'working' }, c)).toBe(false);
    expect(showsNotification({ agent_status: 'blocked' }, { ...c, visible: true })).toBe(false);
    expect(showsNotification({ agent_status: 'blocked' }, { ...c, granted: false })).toBe(false);
    expect(showsNotification({ agent_status: 'blocked' }, { ...c, enabled: false })).toBe(false);
  });

  it('counts blocked agents on the badge unless it is off', () => {
    expect(badgeCount(3, true)).toBe(3);
    expect(badgeCount(3, false)).toBe(0);
    expect(badgeCount(0, true)).toBe(0);
  });
});

describe('the page', () => {
  const shown: Array<{ title: string; body?: string }> = [];
  const badge: Array<number | 'clear'> = [];
  let permission = 'granted';
  let asked = 0;

  beforeEach(() => {
    class FakeNotification {
      static get permission() {
        return permission;
      }
      static requestPermission() {
        asked++;
        return Promise.resolve('granted');
      }
      onclick: (() => void) | null = null;
      constructor(title: string, o?: { body?: string }) {
        shown.push({ title, body: o?.body });
      }
      close() {}
    }
    vi.stubGlobal('Notification', FakeNotification);
    Object.assign(navigator, {
      setAppBadge: (n: number) => (badge.push(n), Promise.resolve()),
      clearAppBadge: () => (badge.push('clear'), Promise.resolve()),
    });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const s = useStore.getState();
    s.setMachines([{ id: 'm', label: 'gpu', kind: 'ssh', status: 'ready' } as unknown as MachineState]);
    const rec = (address: string, agent_status: string) =>
      ({ address, state: 'live', agent: 'claude', agent_status }) as unknown as TerminalRecord;
    useTerms.setState({ machines: { m: { terminals: { t1: rec('t1', 'blocked'), t2: rec('t2', 'blocked'), t3: rec('t3', 'working') } } } });
  });
  afterEach(() => {
    shown.length = 0;
    badge.length = 0;
    asked = 0;
    for (const k of ['notifications.system', 'notifications.badge', 'notifications.sound'])
      useSettings.setState({ values: { ...useSettings.getState().values, [k]: { value: true, source: 'default' } } });
    vi.unstubAllGlobals();
  });

  it('shows the system notification only while it is on', () => {
    notifyAgent('m', { terminal: 't1', agent: 'claude', agent_status: 'blocked', title: 'fix tests' }, false);
    expect(shown).toEqual([{ title: 'claude needs your input', body: 'gpu\nfix tests' }]);
    set('notifications.system', false);
    notifyAgent('m', { terminal: 't1', agent: 'claude', agent_status: 'done' }, false);
    expect(shown.length).toBe(1);
    // Silent agents are silent only: their notifications follow the setting.
    set('notifications.system', true);
    notifyAgent('m', { terminal: 't2', agent: 'droid', agent_status: 'done' }, true);
    expect(shown.length).toBe(2);
  });

  it('asks for the permission only when notifications are on', () => {
    permission = 'default';
    set('notifications.system', false);
    requestNotifyPermission();
    expect(asked).toBe(0);
    set('notifications.system', true);
    requestNotifyPermission();
    expect(asked).toBe(1);
    permission = 'granted';
  });

  it('puts the count on the badge and in the title, and takes it off when the badge is turned off', () => {
    updateBadge();
    expect(badge.at(-1)).toBe(2);
    expect(document.title).toMatch(/^\(2\) /);
    set('notifications.badge', false);
    expect(badge.at(-1)).toBe('clear');
    expect(document.title).not.toMatch(/^\(/);
    set('notifications.badge', true);
    expect(badge.at(-1)).toBe(2);
  });
});
