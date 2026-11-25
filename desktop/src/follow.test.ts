import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingsOf, followHub, settingsOf, type HubLink, type ShellSettings } from './follow';
import type { Binding } from './menu';

test('the bindings of the platform, well-formed ones only', () => {
  const reply = {
    effective: {
      mac: [
        { key: 'cmd+t', command: 'tab.new', when: 'terminal' },
        { key: 'cmd+x', command: 'bad command', when: 'terminal' },
        { key: 1, command: 'tab.new', when: 'terminal' },
      ],
      pc: [{ key: 'ctrl+shift+t', command: 'tab.new', when: 'terminal' }],
    },
  };
  assert.deepEqual(bindingsOf(reply, 'mac'), [{ key: 'cmd+t', command: 'tab.new', when: 'terminal' }]);
  for (const bad of [null, {}, { effective: {} }, { effective: { mac: 'x' } }]) assert.equal(bindingsOf(bad, 'mac'), undefined);
});

test('the theme, language, zoom and UI font size settings, defaults for anything else', () => {
  const values = (theme: unknown, language: unknown, zoom?: unknown, uiFontSize?: unknown) => ({
    values: {
      'appearance.theme': { value: theme },
      'appearance.language': { value: language },
      'window.zoom': { value: zoom },
      'appearance.uiFontSize': { value: uiFontSize },
    },
  });
  assert.deepEqual(settingsOf(values('dark', 'zh-CN', 125, 15)), { theme: 'dark', language: 'zh-CN', zoom: 1.25, uiFontSize: 15 });
  assert.deepEqual(settingsOf(values('light', 'auto')), { theme: 'light', language: 'auto', zoom: 1, uiFontSize: 13 });
  for (const theme of ['Dark', 'auto', 1, null, { toString: () => 'dark' }])
    assert.deepEqual(settingsOf(values(theme, 3)), { theme: 'system', language: 'auto', zoom: 1, uiFontSize: 13 });
  // Zooms Chromium does not take, and anything that is not a number.
  for (const zoom of [0, 10, 501, -100, '150', null, NaN, Infinity])
    assert.equal(settingsOf(values('dark', 'en', zoom))?.zoom, 1, String(zoom));
  for (const fs of [0, 10, 21, '14', null, NaN, Infinity])
    assert.equal(settingsOf(values('dark', 'en', 100, fs))?.uiFontSize, 13, String(fs));
  assert.deepEqual(settingsOf({ values: {} }), { theme: 'system', language: 'auto', zoom: 1, uiFontSize: 13 });
  assert.equal(settingsOf(null), undefined);
});

/** A stand-in for the hub: its event channel and its API. */
function fakeHub(replies: Record<string, unknown>) {
  type On = Parameters<HubLink['channel']>[1];
  const sockets: Array<{ path: string; on: On; closed: boolean; push(m: unknown): void }> = [];
  const fetched: string[] = [];
  const hub: HubLink = {
    channel(path, on) {
      const s = {
        path,
        on,
        closed: false,
        push: (m: unknown) => on.message(JSON.stringify(m)),
      };
      sockets.push(s);
      return { close: () => (s.closed = true) };
    },
    fetch: async (path) => {
      fetched.push(path);
      return { ok: true, json: async () => replies[path] };
    },
  };
  return { hub, sockets, fetched };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('reads the state once the channel is open, then follows its messages', async () => {
  const { hub, sockets, fetched } = fakeHub({
    '/api/settings': { values: { 'appearance.theme': { value: 'dark' } } },
    '/api/keybindings': { commands: [], effective: { mac: [{ key: 'cmd+t', command: 'tab.new', when: 'terminal' }] } },
  });
  const got: { bindings: Binding[][]; settings: ShellSettings[] } = { bindings: [], settings: [] };
  const stop = followHub(hub, 'mac', { bindings: (b) => got.bindings.push(b), settings: (s) => got.settings.push(s) });
  assert.equal(sockets[0].path, '/ws');
  assert.deepEqual(fetched, []);
  sockets[0].on.open();
  await settle();
  assert.deepEqual(fetched.sort(), ['/api/keybindings', '/api/settings']);
  assert.deepEqual(got.settings, [{ theme: 'dark', language: 'auto', zoom: 1, uiFontSize: 13 }]);
  assert.deepEqual(got.bindings, [[{ key: 'cmd+t', command: 'tab.new', when: 'terminal' }]]);

  // A rebinding arrives as a push, with the bindings of every platform.
  sockets[0].push({ t: 'keybindings', effective: { mac: [{ key: 'cmd+shift+t', command: 'tab.new', when: 'terminal' }], pc: [] } });
  sockets[0].push({ t: 'settings', values: { 'appearance.language': { value: 'zh-CN' }, 'window.zoom': { value: 90 } } });
  sockets[0].push({ t: 'machines', list: [] });
  sockets[0].on.message('not json');
  sockets[0].on.message(new Uint8Array([1]));
  assert.deepEqual(got.bindings.at(-1), [{ key: 'cmd+shift+t', command: 'tab.new', when: 'terminal' }]);
  assert.deepEqual(got.settings.at(-1), { theme: 'system', language: 'zh-CN', zoom: 0.9, uiFontSize: 13 });
  assert.equal(got.bindings.length, 2);

  stop();
  assert.ok(sockets[0].closed);
  sockets[0].on.close();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sockets.length, 1, 'no reconnection after stop');
});

test('opens the channel again when it drops', async () => {
  const { hub, sockets } = fakeHub({});
  const stop = followHub(hub, 'mac', { bindings: () => {}, settings: () => {} });
  sockets[0].on.close();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sockets.length, 2);
  stop();
});
