// @vitest-environment jsdom
//
// Searchable dropdowns (components/Picker.tsx): the matcher and its
// highlights, rows with groups and the create row, placement within the
// window, the button form (single and multiple choice) and pick() /
// pickMany(): typing filters, the keys, Escape and presses outside,
// disabled items, focus going back, and long lists drawn in part.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { match, matchScore } from '../lib/match';
import { Picker, pick, pickMany, pickerRows, placeList, selectionSummary, type PickerItem } from '../components/Picker';
import { t } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items: PickerItem[] = [
  { value: 'main', label: 'main', description: 'origin/main', group: 'Branches' },
  { value: 'dev', label: 'dev', group: 'Branches' },
  { value: 'feature/split-right', label: 'feature/split-right', group: 'Branches' },
  { value: 'origin/main', label: 'origin/main', group: 'origin', detail: 'Merge pull request #1' },
  { value: 'origin/old', label: 'origin/old', group: 'origin', disabled: true },
];

const popup = () => document.body.querySelector<HTMLElement>('.picker');
const search = () => popup()!.querySelector<HTMLInputElement>('.picker-search')!;
const shownRows = () => [...document.body.querySelectorAll<HTMLElement>('.picker-row, .picker-group')].map((r) => r.textContent);
const active = () => document.body.querySelector<HTMLElement>('.picker-row.active')?.textContent;
const key = (k: string, o: KeyboardEventInit = {}) =>
  act(async () => {
    (document.activeElement ?? search()).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
  });
const type = (text: string) =>
  act(async () => {
    const input = search();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const flush = () => act(async () => {});

afterEach(async () => {
  // Whatever list is still open closes.
  if (popup()) await key('Escape');
  await flush();
  document.body.innerHTML = '';
});

describe('matching', () => {
  it('marks a word that starts with the query, then the query anywhere, then its letters', () => {
    expect(match('right', 'Split Right')).toEqual({ score: 3, ranges: [[6, 11]] });
    expect(match('ight', 'Split Right')).toEqual({ score: 2, ranges: [[7, 11]] });
    expect(match('spri', 'Split Right')).toEqual({
      score: 1,
      ranges: [
        [0, 2],
        [6, 8],
      ],
    });
    // A later occurrence at a word's start wins over an earlier one inside a word.
    expect(match('ma', 'automatic main')).toEqual({ score: 3, ranges: [[10, 12]] });
    expect(match('zz', 'Split Right')).toBeUndefined();
    expect(match('  ', 'anything')).toEqual({ score: 3, ranges: [] });
    expect(matchScore('nwt', 'New Tab')).toBe(0);
  });
});

describe('picker rows', () => {
  it('lists groups under headers, in the order of their first item', () => {
    expect(pickerRows(items, '').map((r) => (r.kind === 'group' ? `# ${r.label}` : r.kind === 'item' ? r.item.value : r.kind))).toEqual([
      '# Branches',
      'main',
      'dev',
      'feature/split-right',
      '# origin',
      'origin/main',
      'origin/old',
    ]);
  });

  it('keeps the matches, the best first within each group, and drops empty groups', () => {
    const rows = pickerRows(items, 'main');
    expect(rows.map((r) => (r.kind === 'item' ? r.item.value : r.kind))).toEqual(['group', 'main', 'group', 'origin/main']);
    const ranked = pickerRows(
      [
        { value: 'a', label: 'contains xsplit' },
        { value: 'b', label: 'split here' },
        { value: 'c', label: 'other', description: 'split in the description' },
      ],
      'split',
    );
    // Label matches before description matches; a word start before the middle of one.
    expect(ranked.map((r) => r.kind === 'item' && r.item.value)).toEqual(['b', 'a', 'c']);
    const c = ranked[2];
    expect(c.kind === 'item' && c.descriptionRanges).toEqual([[0, 5]]);
    expect(
      pickerRows(
        [
          { value: 'a', label: 'xsplit' },
          { value: 'b', label: 'split' },
        ],
        'split',
        { keepOrder: true },
      ).map((r) => r.kind === 'item' && r.item.value),
    ).toEqual(['a', 'b']);
  });

  it('offers to create what the query names, unless an item has that name', () => {
    const create = (q: string) => (q.includes(' ') ? undefined : `Create branch '${q}'`);
    expect(pickerRows(items, 'topic', { create })[0]).toEqual({ kind: 'create', label: "Create branch 'topic'", query: 'topic' });
    expect(pickerRows(items, 'dev', { create })[0].kind).not.toBe('create');
    expect(pickerRows(items, 'a b', { create }).some((r) => r.kind === 'create')).toBe(false);
  });

  it('says how many are chosen', () => {
    expect(selectionSummary(items, [], 'Any branch')).toBe('Any branch');
    expect(selectionSummary(items, ['dev'])).toBe('dev');
    expect(selectionSummary(items, ['dev', 'main'])).toBe(t('picker.selected', { count: 2 }));
    expect(selectionSummary(items, ['main', 'dev', 'feature/split-right', 'origin/main'])).toBe(t('picker.all'));
  });
});

describe('placement', () => {
  const view = { width: 1000, height: 800 };
  it('goes below its anchor, as wide as it within bounds', () => {
    expect(placeList({ left: 100, top: 100, right: 400, bottom: 120 }, 300, view)).toEqual({
      left: 100,
      width: 300,
      top: 122,
      maxHeight: 670,
    });
    expect(placeList({ left: 100, top: 100, right: 120, bottom: 120 }, 300, view).width).toBe(260);
    expect(placeList({ left: 0, top: 0, right: 900, bottom: 20 }, 300, view).width).toBe(480);
  });

  it('flips above when it does not fit below and there is more room there', () => {
    const p = placeList({ left: 100, top: 700, right: 400, bottom: 720 }, 300, view);
    expect(p).toEqual({ left: 100, width: 300, bottom: 102, maxHeight: 690 });
    // Little room either way: the larger side.
    expect(placeList({ left: 100, top: 300, right: 400, bottom: 320 }, 1000, view)).toEqual({
      left: 100,
      width: 300,
      top: 322,
      maxHeight: 470,
    });
  });

  it("stays inside the window, and fills a phone's width less the gutters", () => {
    expect(placeList({ left: 900, top: 10, right: 950, bottom: 30 }, 100, view).left).toBe(1000 - 260 - 8);
    expect(placeList({ left: 40, top: 10, right: 90, bottom: 30 }, 100, { width: 360, height: 640 })).toMatchObject({
      left: 8,
      width: 344,
    });
  });
});

describe('the picker button', () => {
  let host: HTMLDivElement;
  let root: Root;
  let changes: unknown[];

  function Single() {
    const [v, setV] = useState<string | undefined>('dev');
    return createElement(Picker<string>, {
      items,
      value: v,
      'aria-label': 'Branch',
      onChange: (x: string) => {
        changes.push(x);
        setV(x);
      },
    });
  }
  function Multi() {
    const [v, setV] = useState<string[]>([]);
    return createElement(Picker<string>, {
      items,
      multiple: true,
      value: v,
      noneLabel: 'Any branch',
      onChange: (x: string[]) => {
        changes.push(x);
        setV(x);
      },
    });
  }

  beforeEach(() => {
    changes = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
  });
  const button = () => host.querySelector<HTMLButtonElement>('.picker-button')!;

  it('shows the value, opens a searchable list, and chooses with the keyboard', async () => {
    await act(async () => root.render(createElement(Single)));
    expect(button().textContent).toBe('dev');
    expect(button().getAttribute('aria-haspopup')).toBe('listbox');
    button().focus();
    await act(async () => button().click());
    expect(popup()).not.toBeNull();
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(search());
    // The current value is the keyboard's row first.
    expect(active()).toBe('dev');
    await type('spri');
    expect(shownRows()).toEqual(['Branches', 'feature/split-right']);
    expect([...popup()!.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['sp', 'ri']);
    const input = search();
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-activedescendant')).toBe(popup()!.querySelector('.picker-row.active')!.id);
    await key('Enter');
    expect(changes).toEqual(['feature/split-right']);
    expect(popup()).toBeNull();
    expect(button().textContent).toBe('feature/split-right');
    expect(document.activeElement).toBe(button());
  });

  it('skips disabled items, closes on Escape with the focus back, and on a press outside', async () => {
    await act(async () => root.render(createElement(Single)));
    await act(async () => button().click());
    await key('End');
    expect(active()).toContain('origin/main');
    await key('ArrowDown');
    expect(active()).toContain('origin/main');
    const disabled = [...document.body.querySelectorAll<HTMLElement>('.picker-row.disabled')];
    expect(disabled.map((r) => r.getAttribute('aria-disabled'))).toEqual(['true']);
    await act(async () => disabled[0].click());
    expect(changes).toEqual([]);
    await key('Escape');
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(button());
    await act(async () => button().click());
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(popup()).toBeNull();
    expect(changes).toEqual([]);
  });

  it('toggles several with Space and clicks, and offers select shown, clear and done', async () => {
    await act(async () => root.render(createElement(Multi)));
    expect(button().textContent).toBe('Any branch');
    await act(async () => button().click());
    expect(popup()!.querySelector('[role="listbox"]')!.getAttribute('aria-multiselectable')).toBe('true');
    // With no query Space toggles the keyboard's row.
    await key(' ');
    expect(changes.at(-1)).toEqual(['main']);
    await key('ArrowDown');
    await key(' ');
    expect(changes.at(-1)).toEqual(['main', 'dev']);
    expect(button().textContent).toBe(t('picker.selected', { count: 2 }));
    expect(popup()!.querySelector('.picker-footer')!.textContent).toContain(t('picker.selected', { count: 2 }));
    // Typing: Space is part of the query until an arrow moves.
    await type('origin');
    // main matches by its description, ranked after origin/main's label.
    expect(shownRows()).toEqual(['Branches', 'mainorigin/main', 'origin', 'origin/mainMerge pull request #1', 'origin/old']);
    await act(async () => [...document.body.querySelectorAll<HTMLElement>('.picker-row')][1].click());
    expect(changes.at(-1)).toEqual(['main', 'dev', 'origin/main']);
    const footer = (label: string) =>
      [...popup()!.querySelectorAll<HTMLButtonElement>('.picker-footer button')].find((b) => b.textContent === label)!;
    await act(async () => footer(t('picker.clear')).click());
    expect(changes.at(-1)).toEqual([]);
    await act(async () => footer(t('picker.selectShown')).click());
    // Only what the query shows, never the disabled one.
    expect(changes.at(-1)).toEqual(['main', 'origin/main']);
    await act(async () => footer(t('picker.done')).click());
    expect(popup()).toBeNull();
  });
});

describe('pick()', () => {
  let anchor: HTMLButtonElement;
  beforeEach(() => {
    anchor = document.createElement('button');
    document.body.append(anchor);
    anchor.focus();
  });

  it('resolves with the item chosen, and gives the focus back', async () => {
    let result: Promise<string | undefined>;
    await act(async () => {
      result = pick(anchor, { items, value: 'main', placeholder: 'Switch to…' });
    });
    expect(search().placeholder).toBe('Switch to…');
    expect(active()).toContain('main');
    await key('ArrowDown');
    await key('Enter');
    await expect(result!).resolves.toBe('dev');
    await flush();
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(anchor);
  });

  it('resolves with the query of the create row, and undefined when dismissed', async () => {
    let result: Promise<string | { create: string } | undefined>;
    await act(async () => {
      result = pick(anchor, { items, create: (q) => `Create branch '${q}'` });
    });
    await type('topic');
    expect(shownRows()).toEqual(["Create branch 'topic'"]);
    await key('Enter');
    await expect(result!).resolves.toEqual({ create: 'topic' });
    await flush();
    // A match is the keyboard's row; the create row stays on top.
    await act(async () => {
      result = pick(anchor, { items, create: (q) => `Create branch '${q}'` });
    });
    await type('ma');
    expect(shownRows()[0]).toBe("Create branch 'ma'");
    expect(active()).toContain('main');
    await key('Escape');
    await expect(result!).resolves.toBeUndefined();
  });

  it('opens at a point, and a second list cancels the first', async () => {
    let first: Promise<string | undefined>;
    let second: Promise<string | undefined>;
    await act(async () => {
      first = pick({ x: 10, y: 20 }, { items });
    });
    await act(async () => {
      second = pick({ x: 10, y: 20 }, { items, emptyText: 'Nothing here' });
    });
    await expect(first!).resolves.toBeUndefined();
    await flush();
    expect(document.body.querySelectorAll('.picker')).toHaveLength(1);
    await type('zzz');
    expect(popup()!.textContent).toContain('Nothing here');
    await key('Enter');
    await key('Escape');
    await expect(second!).resolves.toBeUndefined();
  });

  it('draws only the rows in view of a long list', async () => {
    const many: PickerItem[] = Array.from({ length: 5000 }, (_, i) => ({ value: `b${i}`, label: `branch-${i}` }));
    let result: Promise<string | undefined>;
    await act(async () => {
      result = pick(anchor, { items: many });
    });
    expect(document.body.querySelectorAll('.picker-row').length).toBeLessThan(40);
    expect(popup()!.querySelector('[role="option"]')!.getAttribute('aria-setsize')).toBe('5000');
    await key('End');
    expect(active()).toBe('branch-4999');
    expect(document.body.querySelectorAll('.picker-row').length).toBeLessThan(40);
    await key('PageUp');
    expect(Number(active()!.slice(7))).toBeLessThan(4999);
    await type('branch-4321');
    expect(shownRows()).toEqual(['branch-4321']);
    await key('Enter');
    await expect(result!).resolves.toBe('b4321');
  });
});

describe('pickMany()', () => {
  it('resolves with the values checked when accepted', async () => {
    let result: Promise<string[] | undefined>;
    await act(async () => {
      result = pickMany({ x: 0, y: 0 }, { items, value: ['dev'] });
    });
    expect(document.body.querySelectorAll('.picker-check.on')).toHaveLength(1);
    await key(' ');
    await key('Enter');
    await expect(result!).resolves.toEqual(['main', 'dev']);
    await flush();
    await act(async () => {
      result = pickMany({ x: 0, y: 0 }, { items });
    });
    await key(' ');
    await key('Escape');
    await expect(result!).resolves.toBeUndefined();
  });
});
