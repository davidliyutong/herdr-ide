// @vitest-environment jsdom
//
// Where a pane dragged by its header lands on the tab bar: a tab takes it
// beside its focused pane, and anywhere else on the bar (not only the
// new-tab button) gives it a tab of its own.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { FakeCore, settle } from './fakeTerms';
import { dropTargetAt } from '../paneDrag';

let core: FakeCore;

/** A tab bar as Workspace.tsx draws it, for machine m. */
function bar(m: string, withNewTab = true) {
  const el = document.createElement('div');
  el.className = 'tabbar';
  el.innerHTML = `
    <button class="icon sidebar-toggle"></button>
    <div class="tabs" data-m="${m}" data-ws="w1">
      <div class="tab" data-tab="0" data-ws="w1" data-m="${m}"><span class="tab-label">1</span></div>
      <div class="tab" data-tab="1" data-ws="w1" data-m="${m}"><span class="tab-label">2</span></div>
      ${withNewTab ? `<button class="icon new-tab" data-new-tab="w1" data-m="${m}"><svg></svg></button>` : ''}
    </div>`;
  document.body.append(el);
  return el;
}

/** The target of a drop on el. */
function dropOn(el: Element, skip: { pane?: string } = { pane: 's1' }) {
  document.elementFromPoint = () => el;
  return dropTargetAt('a', 0, 0, skip);
}

beforeEach(async () => {
  core = new FakeCore();
  core.machine('a', [FakeCore.term('s1'), FakeCore.term('s2'), FakeCore.term('s3')], {
    version: 2,
    workspaces: [
      {
        id: 'w1',
        name: '',
        cwd: '',
        tabs: [
          { root: { split: 'horizontal', ratio: 0.5, children: [{ terminal: 's1' }, { terminal: 's2' }] }, focused: 's1' },
          { root: { terminal: 's3' }, focused: 's3' },
        ],
        selected: 0,
      },
    ],
    selected: 0,
  });
  core.install();
  core.model.subscribe('a');
  await settle();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('dropping a pane on the tab bar', () => {
  it('opens a new tab from anywhere on the bar but a tab, marked at the new-tab button', () => {
    const el = bar('a');
    const add = el.querySelector('[data-new-tab]')!;
    for (const at of [el, el.querySelector('.tabs')!, el.querySelector('.sidebar-toggle')!, add, add.querySelector('svg')!]) {
      const tg = dropOn(at);
      expect(tg?.kind).toBe('newTab');
      expect(tg?.kind === 'newTab' && tg.ws).toBe('w1');
    }
  });

  it('moves it into another tab, and nowhere on its own tab', () => {
    const el = bar('a');
    const other = dropOn(el.querySelector('[data-tab="1"] .tab-label')!);
    expect(other?.kind === 'tab' && other.index).toBe(1);
    // The tab holding the pane is no target, and no new tab either.
    expect(dropOn(el.querySelector('[data-tab="0"]')!)).toBeUndefined();
  });

  it('takes nothing on another machine’s bar or a bar without a new-tab button', () => {
    expect(dropOn(bar('b'))).toBeUndefined();
    document.body.innerHTML = '';
    expect(dropOn(bar('a', false))).toBeUndefined();
  });
});
