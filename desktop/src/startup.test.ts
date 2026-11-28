import assert from 'node:assert/strict';
import test from 'node:test';
import { sameBindings, startupGate } from './startup';

test('startupGate shows once both hubReady and windowReady fire (hub first)', () => {
  let shown = 0;
  const g = startupGate(() => shown++);
  g.hubReady();
  assert.equal(shown, 0);
  g.windowReady();
  assert.equal(shown, 1);
  // Duplicate signals never re-show.
  g.hubReady();
  g.windowReady();
  assert.equal(shown, 1);
});

test('startupGate shows once both hubReady and windowReady fire (window first)', () => {
  let shown = 0;
  const g = startupGate(() => shown++);
  g.windowReady();
  assert.equal(shown, 0);
  g.hubReady();
  assert.equal(shown, 1);
});

test('startupGate abort suppresses reveal regardless of subsequent signals', () => {
  let shown = 0;
  const g = startupGate(() => shown++);
  g.windowReady();
  g.abort();
  g.hubReady();
  assert.equal(shown, 0);

  let shown2 = 0;
  const g2 = startupGate(() => shown2++);
  g2.abort();
  g2.hubReady();
  g2.windowReady();
  assert.equal(shown2, 0);
});

test('sameBindings detects unchanged keybinding lists', () => {
  const a = [
    { key: 'cmd+t', command: 'tab.new', when: 'terminal' },
    { key: 'cmd+,', command: 'app.settings', when: 'always' },
  ];
  assert.equal(sameBindings([], []), true);
  assert.equal(
    sameBindings(a, [
      { key: 'cmd+t', command: 'tab.new', when: 'terminal' },
      { key: 'cmd+,', command: 'app.settings', when: 'always' },
    ]),
    true,
  );
  assert.equal(sameBindings(a, a.slice(0, 1)), false);
  assert.equal(sameBindings(a, [a[0], { ...a[1], key: 'cmd+.' }]), false);
  assert.equal(sameBindings(a, [a[0], { ...a[1], command: 'app.quit' }]), false);
  assert.equal(sameBindings(a, [a[0], { ...a[1], when: 'shell' }]), false);
});
