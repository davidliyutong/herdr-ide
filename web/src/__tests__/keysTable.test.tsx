// @vitest-environment jsdom
//
// The keyboard shortcuts table draws only the rows in view of the
// settings' scrolling page, the others standing in as space, and all of
// them while a row records keys.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { KeyboardShortcuts } from '../components/KeyboardShortcuts';
import { useKeys } from '../keybindings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let body: HTMLDivElement;
let root: Root;
let scrollTop = 0;
const saved = useKeys.getState();

beforeEach(async () => {
  useKeys.setState({
    sections: [
      { id: 'app', order: 1 },
      { id: 'tab', order: 2 },
    ],
    commands: Array.from({ length: 300 }, (_, i) => ({ id: `x.c${i}`, section: i < 150 ? 'app' : 'tab', when: 'terminal' })),
    effective: [],
    user: [],
  } as never);
  // The settings' body: 300 pixels high, scrolled as the test says.
  body = document.createElement('div');
  body.className = 'settings-body';
  Object.defineProperty(body, 'clientHeight', { get: () => 300 });
  Object.defineProperty(body, 'scrollTop', { get: () => scrollTop });
  body.getBoundingClientRect = () => ({ top: 0, left: 0, right: 600, bottom: 300, width: 600, height: 300, x: 0, y: 0, toJSON() {} });
  document.body.append(body);
  root = createRoot(body);
  await act(async () => root.render(createElement(KeyboardShortcuts, { query: '', readOnly: false })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  body.remove();
  scrollTop = 0;
  useKeys.setState(saved);
});

const drawn = () => [...body.querySelectorAll<HTMLElement>('.keys-row[data-command]')].map((r) => r.dataset.command);

describe('keyboard shortcuts table', () => {
  it('draws the rows in view and a few more, and the others as they scroll into view', async () => {
    const rows = drawn();
    expect(rows[0]).toBe('x.c0');
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(40);
    // The space of the rows not drawn keeps the page's height.
    const spacer = body.querySelector<HTMLElement>('.keys-table > [aria-hidden]:last-of-type')!;
    expect(parseFloat(spacer.style.height)).toBeGreaterThan(5000);
    // The table's top is the page's (its rectangle moves up as the page scrolls).
    const table = body.querySelector<HTMLElement>('.keys-table')!;
    table.getBoundingClientRect = () => ({
      top: -scrollTop,
      left: 0,
      right: 600,
      bottom: 0,
      width: 600,
      height: 0,
      x: 0,
      y: 0,
      toJSON() {},
    });
    scrollTop = 6000;
    await act(async () => void body.dispatchEvent(new Event('scroll')));
    expect(drawn()).not.toContain('x.c0');
    expect(drawn().some((id) => Number(id!.slice(3)) > 150)).toBe(true);
    expect(body.querySelector('.keys-section')?.textContent).toBe('Tabs');
  });

  it('draws every row while one records keys', async () => {
    await act(
      async () => void body.querySelector('.keys-row[data-command="x.c0"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    expect(drawn()).toHaveLength(300);
  });
});
