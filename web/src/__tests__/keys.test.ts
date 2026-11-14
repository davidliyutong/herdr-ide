// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, api: () => Promise.resolve({}) } }));

import parseVectors from '../../../design/testdata/keys/parse.json';
import eventVectors from '../../../design/testdata/keys/events.json';
import sequenceVectors from '../../../design/testdata/keys/sequences.json';
import registry from '../../../design/generated/registry.json';
import { altOnly, KeyError, keyLabel, normalizeKeys, strokeOf } from '../keys';
import { feedStroke, handleKey, keyHint, type KeyContext } from '../keymap';
import { keysOf, platform, resetRules, rulesFor, useKeys, type Binding } from '../keybindings';
import { conflictsOf } from '../components/KeyboardShortcuts';

// The vectors of design/testdata/keys, which internal/keybindings and the
// macOS application run too.
describe('key sequences', () => {
  it('normalizes as the core does', () => {
    expect(parseVectors.cases.length).toBeGreaterThan(30);
    for (const c of parseVectors.cases as { input: string; key?: string; error?: string }[]) {
      if (c.error) {
        let code = '';
        try {
          normalizeKeys(c.input);
        } catch (e) {
          code = e instanceof KeyError ? e.code : String(e);
        }
        expect(code, c.input).toBe(c.error);
      } else {
        expect(normalizeKeys(c.input), c.input).toBe(c.key);
        expect(normalizeKeys(c.key!), c.key).toBe(c.key);
      }
    }
  });

  it('names pressed keys', () => {
    for (const c of eventVectors.cases) {
      const ev = {
        key: c.key,
        code: c.code,
        metaKey: c.mods.includes('cmd'),
        ctrlKey: c.mods.includes('ctrl'),
        altKey: c.mods.includes('alt'),
        shiftKey: c.mods.includes('shift'),
      };
      expect(strokeOf(ev) ?? null, c.description).toBe(c.stroke);
    }
  });

  it('runs strokes against bindings, chords included', () => {
    const bindings = sequenceVectors.bindings as Binding[];
    for (const c of sequenceVectors.cases) {
      let pending = '';
      const got = c.strokes.map((s) => {
        const step = feedStroke(bindings, pending, s, c.context as KeyContext);
        pending = step.pending;
        return step.result.kind === 'run' ? `run:${step.result.command}` : step.result.kind;
      });
      expect(got, c.description).toEqual(c.results);
    }
  });

  it('shows keys as they are typed', () => {
    expect(keyLabel('ctrl+b shift+slash')).toBe('ctrl+b ?');
    expect(keyLabel('ctrl+b comma')).toBe('ctrl+b ,');
    expect(keyLabel('ctrl+b minus')).toBe('ctrl+b -');
    expect(keyLabel('cmd+shift+bracketright')).toBe('cmd+}');
    expect(keyLabel('ctrl+b shift+g')).toBe('ctrl+b shift+g');
    expect(keyLabel('ctrl+shift+equal')).toBe('ctrl++');
    expect(keyLabel('ctrl+b space')).toBe('ctrl+b space');
    expect(altOnly('alt+t')).toBe(true);
    expect(altOnly('cmd+alt+t')).toBe(false);
  });
});

describe('keybindings', () => {
  afterEach(() => useKeys.setState({ effective: registry.keybindings['pc-browser'] as Binding[], user: [] }));

  it('takes its platform’s defaults', () => {
    expect(platform(true, true)).toBe('mac');
    expect(platform(true, false)).toBe('mac-browser');
    expect(platform(false, true)).toBe('pc');
    expect(platform(false, false)).toBe('pc-browser');
    // jsdom: a browser on another system.
    expect(keyHint('tab.new')).toBe('ctrl+b c');
    expect(keyHint('find.open')).toBe('ctrl+shift+f');
    expect(keyHint('view.toggleCode')).toBe('');
  });

  it('turns key changes into the user’s rules', () => {
    const defaults = registry.keybindings.mac as Binding[];
    const user = [{ key: 'ctrl+k x', command: 'pane.close' }];
    expect(rulesFor(user, defaults, 'tab.new', ['ctrl+b c', 'cmd+shift+t'])).toEqual([
      { key: 'ctrl+k x', command: 'pane.close' },
      { key: 'cmd+t', command: '-tab.new' },
      { key: 'cmd+shift+t', command: 'tab.new' },
    ]);
    expect(resetRules([...user, { key: 'cmd+t', command: '-tab.new' }], 'tab.new')).toEqual(user);
    expect(keysOf(defaults, 'tab.new')).toEqual(['ctrl+b c', 'cmd+t']);
    expect(conflictsOf([{ key: 'ctrl+b x', commands: ['pane.close', 'tab.close'] }], 'tab.close', 'ctrl+b x')).toEqual(['pane.close']);
    expect(conflictsOf([{ key: 'ctrl+b', commands: ['a', 'b'], prefix: true }], 'b', 'ctrl+b c')).toEqual(['a']);
  });

  it('runs chords from the page’s keys', () => {
    const run = vi.fn();
    useKeys.setState({ effective: [{ key: 'ctrl+k ctrl+x', command: 'nothing.here', when: 'terminal' }] });
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });
    const first = key({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(handleKey(first, 'terminal')).toBe(true);
    expect(first.defaultPrevented).toBe(true);
    expect(handleKey(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), 'terminal')).toBe(true);
    expect(handleKey(key({ key: 'x', code: 'KeyX', ctrlKey: true }), 'terminal')).toBe(true);
    // Unknown commands do nothing; plain keys go on to the pane.
    expect(handleKey(key({ key: 'x', code: 'KeyX' }), 'terminal')).toBe(false);
    expect(handleKey(key({ key: 'k', code: 'KeyK', ctrlKey: true }), 'vscode')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
