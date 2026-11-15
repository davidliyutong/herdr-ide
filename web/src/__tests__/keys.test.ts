// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, api: () => Promise.resolve({}) } }));

import parseVectors from '../../../design/testdata/keys/parse.json';
import eventVectors from '../../../design/testdata/keys/events.json';
import sequenceVectors from '../../../design/testdata/keys/sequences.json';
import defaultVectors from '../../../design/testdata/keys/defaults.json';
import registry from '../../../design/generated/registry.json';
import { altOnly, KeyError, keyLabel, normalizeKeys, strokeOf } from '../keys';
import { feedStroke, handleKey, keyHint, withKey, type KeyContext } from '../keymap';
import { keysOf, platform, resetRules, rulesFor, useKeys, type Binding, type Platform } from '../keybindings';
import { conflictsOf } from '../components/KeyboardShortcuts';

// The vectors of design/testdata/keys; internal/keybindings runs parse.json
// too.
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

  it('runs strokes against every platform’s defaults: no key waits for another', () => {
    const defaults = registry.keybindings as Record<Platform, Binding[]>;
    for (const p of ['mac', 'mac-browser', 'pc', 'pc-browser'] as Platform[]) {
      expect(defaults[p].length, p).toBeGreaterThan(0);
      for (const b of defaults[p]) expect(b.key, `${p} ${b.command}`).not.toContain(' ');
    }
    expect(defaultVectors.cases.length).toBeGreaterThan(4);
    for (const c of defaultVectors.cases) {
      for (const p of c.platforms as Platform[]) {
        let pending = '';
        const got = c.strokes.map((s) => {
          const step = feedStroke(defaults[p], pending, s, c.context as KeyContext);
          pending = step.pending;
          return step.result.kind === 'run' ? `run:${step.result.command}` : step.result.kind;
        });
        expect(got, `${p}: ${c.description}`).toEqual(c.results);
      }
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
    expect(keyHint('app.keyboardShortcuts')).toBe('ctrl+?');
    expect(keyHint('find.open')).toBe('ctrl+shift+f');
    // Unbound commands show no key.
    expect(keyHint('tab.new')).toBe('');
    expect(keyHint('view.toggleCode')).toBe('');
    expect(keyHint('app.commandPalette')).toBe('');
    expect(withKey('Find', 'find.open')).toBe('Find (ctrl+shift+f)');
    expect(withKey('New tab', 'tab.new')).toBe('New tab');
  });

  it('leaves ctrl+b and every key without a binding to the terminal on every platform', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });
    for (const p of ['mac', 'mac-browser', 'pc', 'pc-browser'] as Platform[]) {
      useKeys.setState({ effective: (registry.keybindings as Record<Platform, Binding[]>)[p] });
      for (const init of [
        { key: 'b', code: 'KeyB', ctrlKey: true },
        { key: 'b', code: 'KeyB', ctrlKey: true },
        { key: 'c', code: 'KeyC' },
        { key: 'a', code: 'KeyA', ctrlKey: true },
        { key: 'k', code: 'KeyK', ctrlKey: true },
        { key: 'b', code: 'KeyB', altKey: true },
        { key: 'F1', code: 'F1' },
      ]) {
        const ev = key(init);
        expect(handleKey(ev, 'terminal'), `${p} ${init.code}`).toBe(false);
        expect(ev.defaultPrevented, `${p} ${init.code}`).toBe(false);
      }
    }
  });

  it('turns key changes into the user’s rules', () => {
    const defaults = registry.keybindings.mac as Binding[];
    const user = [{ key: 'ctrl+k x', command: 'pane.close' }];
    expect(rulesFor(user, defaults, 'tab.new', ['ctrl+b c', 'cmd+shift+t'])).toEqual([
      { key: 'ctrl+k x', command: 'pane.close' },
      { key: 'cmd+t', command: '-tab.new' },
      { key: 'ctrl+b c', command: 'tab.new' },
      { key: 'cmd+shift+t', command: 'tab.new' },
    ]);
    expect(resetRules([...user, { key: 'cmd+t', command: '-tab.new' }], 'tab.new')).toEqual(user);
    expect(keysOf(defaults, 'tab.new')).toEqual(['cmd+t']);
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

  it('lets the second press of a chord’s first stroke through to the terminal’s encoder', () => {
    // A user's chords on a first stroke other than ctrl+letter: the second
    // press is not cancelled, so the pane encodes it as any other key.
    useKeys.setState({ effective: [{ key: 'ctrl+shift+space z', command: 'pane.zoom', when: 'terminal' }] });
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });
    const first = key({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    expect(handleKey(first, 'terminal')).toBe(true);
    expect(first.defaultPrevented).toBe(true);
    const again = key({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    expect(handleKey(again, 'terminal')).toBe(false);
    expect(again.defaultPrevented).toBe(false);
    // The chord is over: the next key is the terminal's too.
    const next = key({ key: 'z', code: 'KeyZ' });
    expect(handleKey(next, 'terminal')).toBe(false);
  });
});
