// @vitest-environment jsdom
//
// The keyboard of a terminal's pane with a surface over all of it
// (TerminalView covered, state/panes.ts useSurfaceFocus): the hidden
// terminal gives the keyboard up to the surface as it is covered, also
// when the pane mounts covered and focused; a terminal without a surface
// keeps it as before; closing find gives it to what covers the terminal.
// The terminal's pane (vt/pane.ts) is a stand-in that focuses its textarea.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {}, retry: () => {} } }));

const { shown } = vi.hoisted(() => ({ shown: [] as Array<[boolean, boolean]> }));
vi.mock('../vt/pane', () => ({
  TermPane: class {
    attached = true;
    constructor(
      _host: HTMLElement,
      _canvas: HTMLCanvasElement,
      private readonly textarea: HTMLTextAreaElement,
    ) {}
    focus() {
      this.textarea.focus({ preventScroll: true });
    }
    setShown(s: boolean, covered = false) {
      shown.push([s, covered]);
    }
    setAppearance() {}
    type() {}
    paste() {}
    openFind() {}
    screenText() {
      return '';
    }
    scrollTo() {}
    dispose() {}
  },
}));

import { TerminalView } from '../components/TerminalView';
import { FindBar } from '../components/FindBar';
import { registerPane, useSurfaceFocus, withView } from '../state/panes';
import { closeFind, openFind } from '../vt/find';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A surface with a field that takes the pane's focus, as the native view's composer does. */
function Composer({ m, terminal, takes = true }: { m: string; terminal: string; takes?: boolean }) {
  const field = useRef<HTMLTextAreaElement>(null);
  useSurfaceFocus(m, terminal, takes ? { focus: () => field.current?.focus() } : undefined);
  return createElement('textarea', { ref: field, className: 'composer' });
}

describe('a covered terminal’s keyboard', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    shown.length = 0;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    closeFind();
  });

  const draw = (covered: boolean, surface: boolean | 'no-focus', focused = true) =>
    act(async () =>
      root.render(
        createElement(
          'div',
          { className: 'pane' },
          createElement(TerminalView, { m: 'a', terminal: 't1', focused: focused && !covered, covered, onActivate: () => {} }),
          surface && createElement(Composer, { m: 'a', terminal: 't1', takes: surface === true }),
        ),
      ),
    );
  const terminalInput = () => host.querySelector<HTMLTextAreaElement>('.term-input')!;
  const composer = () => host.querySelector<HTMLTextAreaElement>('.composer')!;

  it('stays with a terminal no surface covers, as before', async () => {
    await draw(false, false);
    expect(document.activeElement).toBe(terminalInput());
    expect(shown).toEqual([[true, false]]);
  });

  it('goes to the surface when the terminal is covered while it has the keyboard', async () => {
    await draw(false, true);
    expect(document.activeElement).toBe(terminalInput());
    await draw(true, true);
    expect(document.activeElement).toBe(composer());
    expect(shown.at(-1)).toEqual([true, true]);
    // Nor does the Tab key reach the hidden terminal.
    expect(terminalInput().tabIndex).toBe(-1);
    // Uncovered, the focused terminal takes it back when nothing else on the page has it.
    composer().blur();
    await draw(false, true);
    expect(document.activeElement).toBe(terminalInput());
    expect(terminalInput().tabIndex).toBe(0);
  });

  it('leaves the hidden terminal, without a surface that takes it', async () => {
    await draw(false, 'no-focus');
    expect(document.activeElement).toBe(terminalInput());
    await draw(true, 'no-focus');
    expect(document.activeElement).not.toBe(terminalInput());
  });

  it('is not taken from elsewhere on the page', async () => {
    const other = document.createElement('input');
    document.body.append(other);
    try {
      await draw(false, true, false);
      other.focus();
      await draw(true, true, false);
      expect(document.activeElement).toBe(other);
    } finally {
      other.remove();
    }
  });

  it('is the surface’s when the pane mounts covered and focused (a new pane)', async () => {
    const got: string[] = [];
    // actions.ts focusDom: the new pane's view is focused once on screen.
    withView('a', 't1', (h) => {
      h.focus();
      got.push(document.activeElement === composer() ? 'surface' : 'other');
    });
    await draw(true, true);
    expect(got).toEqual(['surface']);
    expect(document.activeElement).toBe(composer());
    expect(shown).toEqual([[true, true]]);
  });

  it('goes to what covers the terminal when find closes', async () => {
    const focusTerminal = vi.fn();
    const off = registerPane('a', 't9', {
      focus: focusTerminal,
      type: () => {},
      paste: () => {},
      openFind: () => {},
      screenText: () => '',
    });
    try {
      openFind('a', 't9');
      await act(async () =>
        root.render(
          createElement(
            'div',
            null,
            createElement(FindBar, { m: 'a', terminal: 't9' }),
            createElement(Composer, { m: 'a', terminal: 't9' }),
          ),
        ),
      );
      const input = host.querySelector<HTMLInputElement>('.find-input')!;
      expect(document.activeElement).toBe(input);
      await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      expect(document.activeElement).toBe(composer());
      expect(focusTerminal).not.toHaveBeenCalled();
      // Without a surface, the terminal.
      await act(async () => root.render(createElement(FindBar, { m: 'a', terminal: 't9' })));
      openFind('a', 't9');
      const again = host.querySelector<HTMLInputElement>('.find-input')!;
      await act(async () => void again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      expect(focusTerminal).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});
