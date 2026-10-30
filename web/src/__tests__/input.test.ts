// @vitest-environment jsdom
//
// Input contract: what a pane receives for each keystroke, through the real
// TermController, keymap and xterm.js. Events follow the browser's order: a
// keydown, then a keypress only if the keydown was not cancelled and the key
// produces a character, then a keyup. The table is shared with the herdr
// parity check in internal/agent/integration_test.go.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import table from './testdata/keys.json';

const sent: string[] = [];
let open: (() => void) | undefined;

vi.mock('../lib/conn', () => ({
  conn: {
    attach: (_p: unknown, h: { onEvent(ev: unknown): void }) => {
      open = () => h.onEvent({ ev: 'open', mode: 'control', cols: 80, rows: 24 });
      return 1;
    },
    detach: () => {},
    updateAttach: () => {},
    stream: (_sid: number, msg: { t: string; d?: string; b?: string }) => {
      if (msg.t === 'in') sent.push(msg.d!);
      if (msg.t === 'inb') sent.push(atob(msg.b!));
    },
    api: () => Promise.resolve({}),
  },
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      throw new Error('no WebGL in tests');
    }
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
  const { TermController } = await import('../terminal/TermController');
  const { handleKey } = await import('../keymap');
  const el = document.createElement('div');
  document.body.appendChild(el);
  const tc = new TermController(el, { m: 'local', pane: 'w1:p1', mode: 'auto', onKey: handleKey });
  // The keymap sends literals to the focused pane, which is this one.
  const { actions } = await import('../actions');
  vi.spyOn(actions, 'sendLiteral').mockImplementation((text) => tc.input(text));
  open!();
  textarea = tc.term.textarea!;
});

afterEach(() => {
  sent.length = 0;
});

describe('pane input contract (testdata/keys.json)', () => {
  for (const row of table as Array<{ name: string; keys: KeyInit[]; bytes: string; browserDefault?: boolean }>) {
    it(row.name, () => {
      const cancelled = row.keys.map((k) => press(textarea, k));
      expect(JSON.stringify(sent.join(''))).toBe(JSON.stringify(row.bytes));
      if (row.browserDefault) expect(cancelled).not.toContain(true);
    });
  }

  it('pastes once, as bracketed paste', () => {
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: { files: [], getData: (t: string) => (t === 'text/plain' ? 'x\ny' : '') } });
    textarea.dispatchEvent(ev);
    expect(sent).toEqual(['\x1b[200~x\ry\x1b[201~']);
  });
});
