// @vitest-environment jsdom
//
// Trees and lists of panels (components/tree, lib/windowed.ts): selection
// by clicks and keys over ordered ids, what each key does (arrows, pages,
// Home, End, ← →, Shift, ⌘/Ctrl+A, type-ahead), the row (indent guides,
// twisty, highlight, decoration, actions), collapsible sections kept per
// browser, and which rows a windowed list draws.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Section,
  TreeRow,
  TypeAhead,
  clickSelection,
  navigationKey,
  rangeOf,
  selectAll,
  selectOnly,
  selectRange,
  selectToggle,
  stepId,
  type KeyLike,
  type NavRow,
} from '../components/tree';
import { revealTop, rowOffsets, visibleRange, visibleRows } from '../lib/windowed';
import { loadPref } from '../state/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ids = ['a', 'b', 'c', 'd', 'e'];

describe('selection', () => {
  it('selects one, toggles, extends from the anchor and selects all', () => {
    let s = selectOnly('b');
    expect(s).toEqual({ selection: ['b'], cursor: 'b', anchor: 'b' });
    s = selectToggle(s, 'd');
    expect(s).toEqual({ selection: ['b', 'd'], cursor: 'd', anchor: 'd' });
    s = selectRange(s, ids, 'a');
    expect(s).toEqual({ selection: ['a', 'b', 'c', 'd'], cursor: 'a', anchor: 'd' });
    // A toggled row is where the next range starts.
    s = selectToggle(s, 'b');
    expect(s).toEqual({ selection: ['a', 'c', 'd'], cursor: 'b', anchor: 'b' });
    expect(selectRange({ selection: [] }, ids, 'c')).toEqual(selectOnly('c'));
    expect(selectAll({ selection: [], cursor: 'c' }, ids)).toEqual({ selection: ids, cursor: 'c', anchor: 'a' });
    expect(rangeOf(ids, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeOf(ids, 'gone', 'b')).toEqual(['b']);
  });

  it('reads modifiers of a click per platform', () => {
    const click = (o: Partial<MouseEventInit>) => ({ shiftKey: false, metaKey: false, ctrlKey: false, ...o });
    expect(clickSelection(click({}), true)).toBe('only');
    expect(clickSelection(click({ metaKey: true }), true)).toBe('toggle');
    expect(clickSelection(click({ ctrlKey: true }), true)).toBe('only');
    expect(clickSelection(click({ ctrlKey: true }), false)).toBe('toggle');
    expect(clickSelection(click({ shiftKey: true, metaKey: true }), true)).toBe('range');
  });

  it('steps within the rows', () => {
    expect(stepId(ids, 'b', 1)).toBe('c');
    expect(stepId(ids, 'b', -10)).toBe('a');
    expect(stepId(ids, 'b', 10)).toBe('e');
    expect(stepId(ids, undefined, 1)).toBe('a');
    expect(stepId(ids, 'gone', -1)).toBe('e');
    expect(stepId([], 'a', 1)).toBeUndefined();
  });
});

describe('keys of a tree', () => {
  // src/ (expanded): lib/ (collapsed), main.go; README; a name being typed in src.
  const rows: NavRow[] = [
    { id: '/src', expanded: true, label: 'src' },
    { id: '/src', parent: '/', label: '', skip: true },
    { id: '/src/lib', parent: '/src', expanded: false, label: 'lib' },
    { id: '/src/main.go', parent: '/src', label: 'main.go' },
    { id: '/README', parent: '/', label: 'README' },
    { id: '/empty', parent: '/', expanded: true, label: 'empty' },
  ];
  const k = (key: string, o: Partial<KeyLike> = {}): KeyLike => ({
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...o,
  });
  const nav = (key: KeyLike, cursor?: string, page = 2) => navigationKey(key, rows, cursor, { multi: true, page, mac: true });

  it('moves with arrows, pages, Home and End, extending with Shift', () => {
    expect(nav(k('ArrowDown'))).toEqual({ kind: 'move', to: '/src', extend: false });
    expect(nav(k('ArrowDown'), '/src')).toEqual({ kind: 'move', to: '/src/lib', extend: false });
    expect(nav(k('ArrowUp'), '/src/lib')).toEqual({ kind: 'move', to: '/src', extend: false });
    expect(nav(k('ArrowDown', { shiftKey: true }), '/src/lib')).toEqual({ kind: 'move', to: '/src/main.go', extend: true });
    expect(nav(k('PageDown'), '/src')).toEqual({ kind: 'move', to: '/src/main.go', extend: false });
    expect(nav(k('PageUp'), '/README')).toEqual({ kind: 'move', to: '/src/lib', extend: false });
    expect(nav(k('Home', { shiftKey: true }), '/README')).toEqual({ kind: 'move', to: '/src', extend: true });
    expect(nav(k('End'), '/src')).toEqual({ kind: 'move', to: '/empty', extend: false });
    // Without several rows, Shift does not extend.
    expect(navigationKey(k('ArrowDown', { shiftKey: true }), rows, '/src', { mac: true })).toEqual({
      kind: 'move',
      to: '/src/lib',
      extend: false,
    });
  });

  it('expands, goes into a folder, collapses and goes to the parent', () => {
    expect(nav(k('ArrowRight'), '/src/lib')).toEqual({ kind: 'expand', id: '/src/lib' });
    expect(nav(k('ArrowRight'), '/src')).toEqual({ kind: 'move', to: '/src/lib', extend: false });
    expect(nav(k('ArrowRight'), '/empty')).toEqual({ kind: 'none' });
    expect(nav(k('ArrowRight'), '/README')).toEqual({ kind: 'none' });
    expect(nav(k('ArrowLeft'), '/src')).toEqual({ kind: 'collapse', id: '/src' });
    expect(nav(k('ArrowLeft'), '/src/main.go')).toEqual({ kind: 'move', to: '/src', extend: false });
    // The root is no row.
    expect(nav(k('ArrowLeft'), '/README')).toEqual({ kind: 'none' });
  });

  it('selects all with ⌘A (Ctrl+A elsewhere), and leaves the page its shortcuts', () => {
    expect(nav(k('a', { metaKey: true }))).toEqual({ kind: 'selectAll' });
    expect(navigationKey(k('a', { ctrlKey: true }), rows, undefined, { multi: true, mac: false })).toEqual({ kind: 'selectAll' });
    expect(nav(k('a', { ctrlKey: true }))).toBeUndefined();
    expect(navigationKey(k('a', { metaKey: true }), rows, undefined, { mac: true })).toBeUndefined();
    expect(nav(k('ArrowDown', { altKey: true }), '/src')).toBeUndefined();
    expect(nav(k('Enter'), '/src')).toBeUndefined();
    expect(nav(k('F2'), '/src')).toBeUndefined();
  });

  it('goes to a row by typing its name', () => {
    const typeahead = new TypeAhead(500);
    const go = (ch: string, cursor: string | undefined, now: number) => typeahead.next(ch, rows, cursor, now);
    expect(go('m', '/src', 0)).toBe('/src/main.go');
    // Typing on: the name so far, from the cursor on.
    expect(go('a', '/src/main.go', 100)).toBe('/src/main.go');
    expect(go('x', '/src/main.go', 200)).toBeUndefined();
    // After a pause it starts afresh; the same letter again goes to the next row.
    expect(go('r', '/src', 1000)).toBe('/README');
    expect(go('e', '/README', 1100)).toBe('/README');
    expect(go('l', '/README', 2000)).toBe('/src/lib');
    expect(go('l', '/src/lib', 2100)).toBe('/src/lib');
    expect(go('s', '/src/lib', 3000)).toBe('/src');
    // Through navigationKey: Space types only while a name is being typed.
    const t2 = new TypeAhead(60_000);
    expect(navigationKey(k(' '), rows, '/src', { typeahead: t2 })).toBeUndefined();
    expect(navigationKey(k('R'), rows, '/src', { typeahead: t2 })).toEqual({ kind: 'move', to: '/README', extend: false });
    expect(navigationKey(k(' '), rows, '/README', { typeahead: t2 })).toEqual({ kind: 'none' });
  });
});

describe('windowed rows', () => {
  it('draws the rows in view and a few around them', () => {
    const offsets = rowOffsets([20, 20, 40, 20, 20, 20]);
    expect(offsets).toEqual([0, 20, 40, 80, 100, 120, 140]);
    expect(visibleRows(offsets, 45, 40, 0)).toEqual([2, 4]);
    expect(visibleRows(offsets, 0, 30, 1)).toEqual([0, 3]);
    expect(visibleRows([0], 0, 100)).toEqual([0, 0]);
    expect(visibleRange(10_000, 24, 2400, 240, 2)).toEqual([98, 112]);
    expect(visibleRange(0, 24, 0, 240)).toEqual([0, 0]);
    expect(revealTop(100, 200, 50, 70)).toBe(50);
    expect(revealTop(100, 200, 310, 330)).toBe(130);
    expect(revealTop(100, 200, 150, 170)).toBe(100);
  });
});

describe('tree rows and sections', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('draws guides to its depth, a twisty for branches, the match and the decoration', async () => {
    const toggle = vi.fn();
    const click = vi.fn();
    await act(async () =>
      root.render(
        createElement('div', { className: 'tree' }, [
          createElement(TreeRow, {
            key: 1,
            depth: 2,
            expanded: false,
            onToggle: toggle,
            onClick: click,
            label: 'components',
            highlight: [[0, 4]],
            description: '3 files',
            decoration: { badge: 'M', color: 'var(--ds-git-modified)' },
            actions: createElement('button', { className: 'act' }, 'x'),
            selected: true,
            cursor: true,
            ...({ 'data-path': '/a/b/components' } as object),
          }),
          createElement(TreeRow, { key: 2, depth: 0, label: 'leaf', dimmed: true, guides: false }),
        ]),
      ),
    );
    const [branch, leaf] = [...host.querySelectorAll<HTMLElement>('.tree-row')];
    expect(branch.className).toBe('tree-row selected cursor');
    expect(branch.dataset.path).toBe('/a/b/components');
    expect(branch.getAttribute('role')).toBe('treeitem');
    expect(branch.getAttribute('aria-level')).toBe('3');
    expect(branch.getAttribute('aria-expanded')).toBe('false');
    expect(branch.getAttribute('aria-selected')).toBe('true');
    expect(branch.querySelectorAll('.tree-guide')).toHaveLength(2);
    expect(branch.querySelector('mark')?.textContent).toBe('comp');
    expect(branch.querySelector('.tree-description')?.textContent).toBe('3 files');
    const badge = branch.querySelector<HTMLElement>('.tree-badge')!;
    expect(badge.textContent).toBe('M');
    expect(badge.style.color).toBe('var(--ds-git-modified)');
    expect(branch.querySelector<HTMLElement>('.tree-label')!.style.color).toBe('var(--ds-git-modified)');
    // The twisty toggles without the row's click; the actions keep their clicks.
    await act(async () => branch.querySelector<HTMLElement>('.tree-twisty')!.click());
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
    await act(async () => branch.querySelector<HTMLElement>('.act')!.click());
    expect(click).not.toHaveBeenCalled();
    await act(async () => branch.click());
    expect(click).toHaveBeenCalledTimes(1);
    expect(leaf.className).toBe('tree-row dimmed');
    expect(leaf.hasAttribute('aria-expanded')).toBe(false);
    expect(leaf.querySelector('.tree-twisty svg')).toBeNull();
  });

  it('collapses a section, remembers it per browser, and keeps sections of one id together', async () => {
    const draw = () =>
      root.render(
        createElement('div', null, [
          createElement(
            Section,
            { key: 1, id: 'test.changes', title: 'Changes', count: 12, actions: createElement('button', { className: 'stage' }, '+') },
            'body one',
          ),
          createElement(Section, { key: 2, id: 'test.changes', title: 'Again' }, 'body two'),
        ]),
      );
    await act(async () => draw());
    const toggles = () => [...host.querySelectorAll<HTMLButtonElement>('.section-toggle')];
    expect(toggles().map((b) => b.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    expect(host.querySelector('.section-count')?.textContent).toBe('12');
    expect(host.textContent).toContain('body one');
    expect(toggles()[0].getAttribute('aria-controls')).toBe(host.querySelector('.section-body')!.id);
    await act(async () => toggles()[0].click());
    expect(toggles().map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    expect(host.textContent).not.toContain('body');
    expect(loadPref('section.test.changes', true)).toBe(false);
    await act(async () => toggles()[1].click());
    expect(loadPref('section.test.changes', false)).toBe(true);
    expect(host.textContent).toContain('body two');
  });
});
