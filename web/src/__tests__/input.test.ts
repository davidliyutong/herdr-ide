// @vitest-environment jsdom
//
// Input contract: what a pane receives for each keystroke, through the real
// SurfaceController and keymap. Events follow the browser's order: a
// keydown, then a keypress only if the keydown was not cancelled and the key
// produces a character, then a keyup. Each row lists the pane input events
// sent to the core (key releases aside); TestIntegrationKeyParity in
// internal/agent/integration_test.go sends the same events to herdr and
// checks the bytes it makes of them.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import table from './testdata/keys.json';

const sent: Array<{ pane: string; ev: Array<Record<string, any>> }> = [];

vi.mock('../lib/conn', () => ({
  conn: {
    sendNow: (msg: { t: string; pane: string; ev: Array<Record<string, any>> }) => {
      if (msg.t === 'in') sent.push({ pane: msg.pane, ev: msg.ev });
    },
    send: () => {},
    api: () => Promise.resolve({}),
    setSurfaceHandler: () => {},
    setTheme: () => {},
  },
}));

interface KeyInit {
  key: string;
  code: string;
  keyCode: number;
  charCode?: number;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
}

function keyEvent(type: string, k: KeyInit, code: number): KeyboardEvent {
  const ev = new KeyboardEvent(type, { ...k, bubbles: true, cancelable: true });
  // jsdom ignores the legacy codes in the init dictionary.
  Object.defineProperty(ev, 'keyCode', { value: code });
  Object.defineProperty(ev, 'which', { value: code });
  Object.defineProperty(ev, 'charCode', { value: type === 'keypress' ? code : 0 });
  return ev;
}

/** Dispatches one keystroke; returns whether the keydown was cancelled. */
function press(target: HTMLElement, k: KeyInit): boolean {
  const down = keyEvent('keydown', k, k.keyCode);
  target.dispatchEvent(down);
  if (!down.defaultPrevented && k.charCode && !k.metaKey && !k.isComposing) target.dispatchEvent(keyEvent('keypress', k, k.charCode));
  target.dispatchEvent(keyEvent('keyup', k, k.keyCode));
  return down.defaultPrevented;
}

let textarea: HTMLTextAreaElement;
let ctl: import('../surface/controller').SurfaceController;

/** Events sent so far, without key releases. */
function pressesSent() {
  return sent.flatMap((s) => s.ev).filter((e) => !(e.t === 'key' && e.key.kind === 2));
}

beforeAll(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= (() => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  // jsdom has no canvas: a context that measures a fixed-size font.
  HTMLCanvasElement.prototype.getContext = (() => ({
    measureText: () => ({ width: 8, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 }),
    fillRect() {},
    fillText() {},
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const { SurfaceController } = await import('../surface/controller');
  const { useSurface } = await import('../surface/session');
  const { handleKey } = await import('../keymap');
  const { appearanceOf } = await import('../appearance');
  const { getPrefs } = await import('../prefs');
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  textarea = document.createElement('textarea');
  host.append(canvas, textarea);
  document.body.appendChild(host);
  useSurface.setState({ ownership: 'owner' });
  ctl = new SurfaceController(
    host,
    canvas,
    textarea,
    {
      m: () => 'local',
      focusedPane: () => 'w1:p1',
      focusPane: () => {},
      appKey: (ev) => handleKey(ev),
      readOnly: () => false,
      linkContext: () => ({ m: 'local' }),
      onSize: () => {},
      setTitle: () => {},
    },
    { ...appearanceOf(getPrefs()), optionIsMeta: false },
  );
  const r = { x: 0, y: 0, w: 80, h: 24 };
  ctl.setMeta({
    m: 'local',
    gen: 1,
    w: 80,
    h: 24,
    panes: [{ id: 'w1:p1', rect: r, inner: r, focused: true, mouse: false, alt: false }],
    splits: [],
    links: [],
  });
  // The keymap sends literals to the focused pane.
  const { actions } = await import('../actions');
  const { getTerm } = await import('../terminal/registry');
  vi.spyOn(actions, 'sendLiteral').mockImplementation((text) => getTerm('local', 'w1:p1').input(text));
});

afterEach(() => {
  sent.length = 0;
});

describe('pane input contract (testdata/keys.json)', () => {
  for (const row of table as Array<{ name: string; keys: KeyInit[]; events: unknown[]; browserDefault?: boolean }>) {
    it(row.name, () => {
      const cancelled = row.keys.map((k) => press(textarea, k));
      expect(pressesSent()).toEqual(row.events);
      if (row.browserDefault) expect(cancelled).not.toContain(true);
      if (row.events.length) expect(sent.every((s) => s.pane === 'w1:p1')).toBe(true);
    });
  }

  it('reports the release of keys that type no text', () => {
    press(textarea, { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 });
    expect(sent.map((s) => s.ev[0].key)).toEqual([
      { code: 'Up', mods: 0, kind: 0, tracksRelease: true },
      { code: 'Up', mods: 0, kind: 2, tracksRelease: true },
    ]);
  });

  it('pastes once, without paste markers', () => {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', {
      value: { files: [], getData: (t: string) => (t === 'text/plain' ? 'x\ny\x1b[201~' : '') },
    });
    textarea.dispatchEvent(ev);
    expect(pressesSent()).toEqual([{ t: 'paste', text: 'x\ry' }]);
  });

  it('commits composed text once', () => {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    press(textarea, { key: 'n', code: 'KeyN', keyCode: 229, isComposing: true });
    textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '你好' }));
    expect(pressesSent()).toEqual([{ t: 'text', text: '你好' }]);
  });
});
