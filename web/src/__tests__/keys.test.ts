// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, api: () => Promise.resolve({}) } }));

import parseVectors from '../../../spec/vectors/keys/parse.json';
import eventVectors from '../../../spec/vectors/keys/events.json';
import sequenceVectors from '../../../spec/vectors/keys/sequences.json';
import defaultVectors from '../../../spec/vectors/keys/defaults.json';
import registry from '../../../spec/generated/registry.json';
import { altOnly, KeyError, keyLabel, normalizeKeys, strokeOf } from '../keys';
import {
  commandEnabled,
  feedStroke,
  handleKey,
  handlePaneLeaveKey,
  keyHint,
  REPEATING_COMMANDS,
  withKey,
  type KeyContext,
} from '../keymap';
import { commands } from '../commands';
import { actions } from '../actions';
import { useStore } from '../state/store';
import { keysOf, platform, resetRules, rulesFor, useKeys, type Binding, type Platform } from '../keybindings';
import { conflictsOf } from '../components/KeyboardShortcuts';

// The vectors of spec/vectors/keys; backend/kernel/config/keybindings runs parse.json
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
    for (const p of ['mac', 'mac-browser', 'windows', 'windows-browser', 'linux', 'linux-browser'] as Platform[]) {
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
    expect(keyLabel('ctrl+b shift+slash', false)).toBe('Ctrl+B ?');
    expect(keyLabel('ctrl+b comma', false)).toBe('Ctrl+B ,');
    expect(keyLabel('ctrl+b minus', false)).toBe('Ctrl+B -');
    expect(keyLabel('ctrl+b shift+g', false)).toBe('Ctrl+B Shift+G');
    expect(keyLabel('ctrl+shift+equal', false)).toBe('Ctrl++');
    expect(keyLabel('ctrl+b space', false)).toBe('Ctrl+B Space');
    expect(keyLabel('ctrl+shift+tab', false)).toBe('Ctrl+Shift+Tab');
    expect(keyLabel('alt+1', false)).toBe('Alt+1');
    // macOS shows its menus' symbols, modifiers in their order.
    expect(keyLabel('cmd+shift+bracketright', true)).toBe('⌘}');
    expect(keyLabel('cmd+shift+p', true)).toBe('⇧⌘P');
    expect(keyLabel('cmd+alt+left', true)).toBe('⌥⌘←');
    expect(keyLabel('cmd+ctrl+down', true)).toBe('⌃⌘↓');
    expect(keyLabel('cmd+shift+enter', true)).toBe('⇧⌘↩');
    expect(keyLabel('ctrl+k ctrl+s', true)).toBe('⌃K ⌃S');
    expect(altOnly('alt+t')).toBe(true);
    expect(altOnly('cmd+alt+t')).toBe(false);
  });
});

describe('keybindings', () => {
  afterEach(() => useKeys.setState({ effective: registry.keybindings['linux-browser'] as Binding[], user: [] }));

  it('takes its platform’s defaults', () => {
    expect(platform('mac', true)).toBe('mac');
    expect(platform('mac', false)).toBe('mac-browser');
    expect(platform('windows', true)).toBe('windows');
    expect(platform('windows', false)).toBe('windows-browser');
    expect(platform('linux', true)).toBe('linux');
    expect(platform('linux', false)).toBe('linux-browser');
    expect(platform(true, true)).toBe('mac');
    expect(platform(false, false)).toBe('linux-browser');
    // jsdom: a browser on Linux by default.
    expect(keyHint('app.keyboardShortcuts')).toBe('Ctrl+?');
    expect(keyHint('find.open')).toBe('Ctrl+Shift+F');
    expect(keyHint('pane.leave')).toBe('Ctrl+B');
    // Unbound commands show no key.
    expect(keyHint('tab.new')).toBe('');
    expect(keyHint('code.open')).toBe('');
    expect(keyHint('app.commandPalette')).toBe('');
    expect(withKey('Find', 'find.open')).toBe('Find (Ctrl+Shift+F)');
    expect(withKey('New tab', 'tab.new')).toBe('New tab');
  });

  it('runs pane.leave on ctrl+b outside terminals and leaves every key without a binding to the terminal on every platform', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });
    for (const p of ['mac', 'mac-browser', 'windows', 'windows-browser', 'linux', 'linux-browser'] as Platform[]) {
      useKeys.setState({ effective: (registry.keybindings as Record<Platform, Binding[]>)[p] });
      const leaveEv = key({ key: 'b', code: 'KeyB', ctrlKey: true });
      expect(handleKey(leaveEv, 'terminal'), `${p} ctrl+b`).toBe(true);
      expect(leaveEv.defaultPrevented, `${p} ctrl+b`).toBe(true);
      // In a terminal ctrl+b is its program's (tmux).
      const inTerminal = key({ key: 'b', code: 'KeyB', ctrlKey: true });
      expect(handleKey(inTerminal, 'shell'), `${p} ctrl+b in a terminal`).toBe(false);
      expect(inTerminal.defaultPrevented).toBe(false);
      for (const init of [
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

  it('runs pane.leave in a terminal when the user binds it there (when: terminal)', () => {
    useKeys.setState({ effective: [{ key: 'ctrl+b', command: 'pane.leave', when: 'terminal' }] });
    const leaveSpy = vi.spyOn(commands['pane.leave'], 'run').mockImplementation(() => {});
    try {
      const ev = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, cancelable: true });
      expect(handleKey(ev, 'shell')).toBe(true);
      expect(leaveSpy).toHaveBeenCalledTimes(1);
    } finally {
      leaveSpy.mockRestore();
    }
  });

  it('escapes focus from pane inputs via handlePaneLeaveKey unless a dialog is open', () => {
    useKeys.setState({ effective: registry.keybindings.mac as Binding[] });
    const leaveSpy = vi.spyOn(commands['pane.leave'], 'run').mockImplementation(() => {});
    try {
      const ev = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, cancelable: true });
      expect(handlePaneLeaveKey(ev)).toBe(true);
      expect(ev.defaultPrevented).toBe(true);
      expect(leaveSpy).toHaveBeenCalledTimes(1);

      // Non-escape keys (like Cmd+[ in Monaco) are left alone.
      const outdent = new KeyboardEvent('keydown', { key: '[', code: 'BracketLeft', metaKey: true, cancelable: true });
      expect(handlePaneLeaveKey(outdent)).toBe(false);
      expect(outdent.defaultPrevented).toBe(false);

      // Dialogs keep Ctrl+B.
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      document.body.append(backdrop);
      const inDialog = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, cancelable: true });
      expect(handlePaneLeaveKey(inDialog)).toBe(false);
      backdrop.remove();
    } finally {
      leaveSpy.mockRestore();
    }
  });

  it('switches focus from an active pane or Monaco editor to its pane header on Ctrl+B and returns cleanly', () => {
    useKeys.setState({ effective: registry.keybindings.mac as Binding[] });
    const pane = document.createElement('div');
    pane.className = 'pane';
    const header = document.createElement('div');
    header.className = 'pane-header';
    header.tabIndex = 0;
    header.dataset.m = 'm';
    header.dataset.pane = 'view:e1';
    const monaco = document.createElement('div');
    monaco.className = 'monaco-editor';
    const ta = document.createElement('textarea');
    monaco.append(ta);
    pane.append(header, monaco);
    document.body.append(pane);
    const focusPane = vi.spyOn(actions, 'focusPane').mockImplementation(() => ta.focus());
    try {
      ta.focus();
      expect(document.activeElement).toBe(ta);
      const ev = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, cancelable: true, bubbles: true });
      Object.defineProperty(ev, 'target', { value: ta });
      expect(handlePaneLeaveKey(ev)).toBe(true);
      expect(document.activeElement).toBe(header);

      // On the pane header, Ctrl+B again returns focus to the pane.
      const backEv = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, cancelable: true, bubbles: true });
      expect(handleKey(backEv, 'terminal')).toBe(true);
      expect(focusPane).toHaveBeenCalledWith('m', 'view:e1');
      expect(document.activeElement).toBe(ta);
    } finally {
      focusPane.mockRestore();
      pane.remove();
    }
  });

  it('leaves the zoom keys to browsers, where the zoom commands do not run', () => {
    for (const p of ['mac-browser', 'windows-browser', 'linux-browser'] as Platform[]) {
      useKeys.setState({ effective: (registry.keybindings as Record<Platform, Binding[]>)[p] });
      for (const init of [
        { key: '=', code: 'Equal', metaKey: true },
        { key: '+', code: 'Equal', metaKey: true, shiftKey: true },
        { key: '-', code: 'Minus', ctrlKey: true },
        { key: '0', code: 'Digit0', ctrlKey: true },
      ]) {
        const ev = new KeyboardEvent('keydown', { cancelable: true, ...init });
        expect(handleKey(ev, 'terminal'), `${p} ${init.code}`).toBe(false);
        expect(ev.defaultPrevented).toBe(false);
      }
    }
    // A page without the desktop app's shell has no zoom to change.
    for (const id of ['view.zoomIn', 'view.zoomOut', 'view.zoomReset']) expect(commandEnabled(id), id).toBe(false);
  });

  it('handles only declared commands, and every one no plugin brings', () => {
    const declared = registry.commands.map((c) => c.id);
    for (const id of Object.keys(commands)) expect(declared, id).toContain(id);
    const plugins = /^(agents|browser|chat|code|git|view\.panel)\./;
    for (const id of declared) if (!plugins.test(id)) expect(commands[id], id).toBeDefined();
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
    // A dialog's keys are its own.
    expect(handleKey(key({ key: 'k', code: 'KeyK', ctrlKey: true }), 'dialog')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('repeats tabs and panes while a key is held, toggles and dialogs once', () => {
    const tab = vi.spyOn(actions, 'switchTab').mockImplementation(() => {});
    const palette = vi.fn();
    useStore.setState({ setPalette: palette } as never);
    useKeys.setState({
      effective: [
        { key: 'ctrl+shift+n', command: 'tab.next', when: 'terminal' },
        { key: 'ctrl+shift+o', command: 'app.commandPalette', when: 'terminal' },
      ],
    });
    const key = (code: string, repeat: boolean) =>
      new KeyboardEvent('keydown', { cancelable: true, key: code.slice(3).toLowerCase(), code, ctrlKey: true, shiftKey: true, repeat });
    for (const repeat of [false, true, true]) {
      expect(handleKey(key('KeyN', repeat), 'terminal')).toBe(true);
      expect(handleKey(key('KeyO', repeat), 'terminal')).toBe(true);
    }
    expect(tab).toHaveBeenCalledTimes(3);
    expect(palette).toHaveBeenCalledTimes(1);
    expect(REPEATING_COMMANDS.has('tab.new') && REPEATING_COMMANDS.has('pane.close')).toBe(true);
    tab.mockRestore();
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
