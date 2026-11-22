import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotificationTarget } from '../../web/src/shell';
import {
  createNotifications,
  MAX_ACTIVE_NOTIFICATIONS,
  MAX_NOTIFY_BODY,
  MAX_NOTIFY_TITLE,
  parseNotificationOptions,
  parseNotificationTarget,
  sanitizeTag,
  type NativeNotificationHandle,
} from './notifications';

test('parseNotificationOptions validates and sanitizes title, body, tag, silent, urgency and target', () => {
  assert.deepEqual(
    parseNotificationOptions({
      title: '  Claude\nneeds\tinput\x07  ',
      body: 'gpu · 1\r\nfix tests\x00',
      tag: 'm|t1',
      silent: true,
      urgency: 'critical',
      target: { kind: 'pane', machine: 'm', pane: 't1' },
    }),
    {
      title: 'Claude needs input',
      body: 'gpu · 1\nfix tests',
      tag: 'm|t1',
      silent: true,
      urgency: 'critical',
      target: { kind: 'pane', machine: 'm', pane: 't1' },
    },
  );

  // Bounded lengths.
  const long = parseNotificationOptions({ title: 'a'.repeat(500), body: 'b'.repeat(2000) });
  assert.equal(long?.title.length, MAX_NOTIFY_TITLE);
  assert.equal(long?.body?.length, MAX_NOTIFY_BODY);

  // Empty/invalid options rejected.
  for (const bad of [
    null,
    'title',
    [],
    {},
    { title: '   \n\t  ' },
    { title: 123 },
    { title: 'ok', extra: 'nope' },
    { title: 'ok', silent: 'yes' },
    { title: 'ok', urgency: 'urgent' },
    { title: 'ok', tag: 'bad\ntag' },
    { title: 'ok', tag: '' },
    { title: 'ok', body: 42 },
    { title: 'ok', target: { kind: 'unknown' } },
  ]) {
    assert.equal(parseNotificationOptions(bad), undefined, JSON.stringify(bad));
  }
});

test('parseNotificationTarget accepts only valid pane, chat and panel targets and returns fresh copies', () => {
  const paneIn = { kind: 'pane', machine: 'm1', pane: 't1' };
  const paneOut = parseNotificationTarget(paneIn);
  assert.deepEqual(paneOut, paneIn);
  assert.notEqual(paneOut, paneIn);

  assert.deepEqual(parseNotificationTarget({ kind: 'chat', machine: 'm1', chat: 'c123', agent: 'claude' }), {
    kind: 'chat',
    machine: 'm1',
    chat: 'c123',
    agent: 'claude',
  });
  assert.deepEqual(parseNotificationTarget({ kind: 'chat', machine: 'm1', chat: 'c123' }), {
    kind: 'chat',
    machine: 'm1',
    chat: 'c123',
  });
  assert.deepEqual(parseNotificationTarget({ kind: 'panel', panel: 'usage' }), { kind: 'panel', panel: 'usage' });

  for (const bad of [
    null,
    'pane',
    { kind: 'pane', machine: '', pane: 't1' },
    { kind: 'pane', machine: 'm1', pane: 't1', extra: 1 },
    { kind: 'pane', machine: 'm\n1', pane: 't1' },
    { kind: 'chat', machine: 'm1', chat: '' },
    { kind: 'chat', machine: 'm1', chat: 'c1', extra: 1 },
    { kind: 'chat', machine: 'm1', chat: 'c1', agent: '   ' },
    { kind: 'panel', panel: '' },
    { kind: 'panel', panel: 'usage', extra: 1 },
  ]) {
    assert.equal(parseNotificationTarget(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(sanitizeTag('x'.repeat(300)), undefined);
});

interface FakeHandle extends NativeNotificationHandle {
  shown: number;
  closed: number;
  opts: { title: string; body?: string; silent?: boolean; urgency?: string };
  emit(ev: 'click' | 'close' | 'failed'): void;
}

function fakeFactory() {
  const created: FakeHandle[] = [];
  let supported = true;
  let mainShown = 0;
  const manager = createNotifications({
    isSupported: () => supported,
    create: (opts) => {
      const listeners = new Map<string, Array<() => void>>();
      const handle: FakeHandle = {
        shown: 0,
        closed: 0,
        opts,
        on(ev, fn) {
          const list = listeners.get(ev) ?? [];
          list.push(fn);
          listeners.set(ev, list);
          return handle;
        },
        show() {
          handle.shown++;
        },
        close() {
          handle.closed++;
        },
        emit(ev) {
          for (const fn of listeners.get(ev) ?? []) fn();
        },
      };
      created.push(handle);
      return handle;
    },
    showMain: () => {
      mainShown++;
    },
  });
  return {
    manager,
    created,
    setSupported: (v: boolean) => {
      supported = v;
    },
    mainShown: () => mainShown,
  };
}

test('createNotifications shows notifications, replaces duplicates by tag, and closes by tag or all', () => {
  const f = fakeFactory();
  assert.equal(f.manager.supported(), true);
  assert.equal(
    f.manager.show({
      title: 'Claude needs input',
      body: 'gpu · 1',
      tag: 'm|t1',
      silent: true,
      urgency: 'critical',
    }),
    true,
  );
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].shown, 1);
  assert.deepEqual(f.created[0].opts, { title: 'Claude needs input', body: 'gpu · 1', silent: true, urgency: 'critical' });
  assert.equal(f.manager.activeCount(), 1);

  // Showing with same tag closes the previous one first.
  assert.equal(f.manager.show({ title: 'Updated', tag: 'm|t1' }), true);
  assert.equal(f.created[0].closed, 1);
  assert.equal(f.created[1].shown, 1);
  assert.equal(f.manager.activeCount(), 1);

  // Emitting close on the superseded handle does not remove the newer handle.
  f.created[0].emit('close');
  assert.equal(f.manager.activeCount(), 1);

  f.manager.close('m|t1');
  assert.equal(f.created[1].closed, 1);
  assert.equal(f.manager.activeCount(), 0);

  f.manager.show({ title: 'One', tag: 'a' });
  f.manager.show({ title: 'Two', tag: 'b' });
  assert.equal(f.manager.activeCount(), 2);
  f.manager.closeAll();
  assert.equal(f.manager.activeCount(), 0);
  assert.equal(f.created[2].closed, 1);
  assert.equal(f.created[3].closed, 1);
});

test('clicking a notification focuses main window and queues/delivers target once the page subscribes', () => {
  const f = fakeFactory();
  const target: NotificationTarget = { kind: 'chat', machine: 'm', chat: 'c00000000000000a1', agent: 'claude' };
  assert.equal(f.manager.show({ title: 'Chat done', tag: 'm|chat:c00000000000000a1', target }), true);

  // Click while no page is listening (e.g. macOS main window was closed and is reopening).
  f.created[0].emit('click');
  assert.equal(f.mainShown(), 1);
  assert.equal(f.manager.activeCount(), 0);

  const delivered: NotificationTarget[] = [];
  const collect = (t: NotificationTarget) => {
    delivered.push(t);
  };
  f.manager.takenBy(collect);
  assert.deepEqual(delivered, [target]);

  // Subsequent clicks while page listens deliver immediately.
  assert.equal(f.manager.show({ title: 'Pane blocked', target: { kind: 'pane', machine: 'm', pane: 't2' } }), true);
  f.created[1].emit('click');
  assert.equal(f.mainShown(), 2);
  assert.deepEqual(delivered, [target, { kind: 'pane', machine: 'm', pane: 't2' }]);

  // Page navigating away stops delivery until new page subscribes.
  f.manager.takenBy(undefined);
  assert.equal(f.manager.show({ title: 'Panel alert', target: { kind: 'panel', panel: 'usage' } }), true);
  f.created[2].emit('click');
  assert.equal(delivered.length, 2);
  f.manager.takenBy(collect);
  assert.deepEqual(delivered.at(-1), { kind: 'panel', panel: 'usage' });
});

test('bounds active notifications and handles unsupported OS cleanly', () => {
  const f = fakeFactory();
  for (let i = 0; i < MAX_ACTIVE_NOTIFICATIONS + 10; i++) {
    assert.equal(f.manager.show({ title: `Item ${i}` }), true);
  }
  assert.equal(f.manager.activeCount(), MAX_ACTIVE_NOTIFICATIONS);
  assert.equal(f.created[0].closed, 1);

  f.setSupported(false);
  assert.equal(f.manager.supported(), false);
  assert.equal(f.manager.show({ title: 'Ignored' }), false);
});
