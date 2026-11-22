// @vitest-environment jsdom
//
// The composer of a chat: images attached by pasting, dropping or picking
// them, within the host's limits, shown and removable, sent first; files
// named with @ from the source's suggestions, linked in the message; the
// agent's commands with / (and compact, sent as compact); the model,
// effort and mode selectors from the chat's options; a message sent while
// a turn runs queued, shown in the queue and withdrawn; a message whose
// outcome is not known kept, under its id, until the conversation shows it;
// read-only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { placeConfigMenu } from '../conversation/Composer';
import { errorText } from '../conversation/parts';
import { Conversation } from '../conversation/Conversation';
import { MAX_IMAGE, type ChatEvent, type ContentBlock, type SourceEvent } from '../conversation/model';
import type { ChatSource, FileSuggestion } from '../conversation/source';
import { setLocale, t } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSource implements ChatSource {
  readOnly?: boolean;
  events: SourceEvent[] = [];
  subs = new Set<(ev: SourceEvent) => void>();
  send = vi.fn(async (_content: ContentBlock[], _clientId: string) => {});
  cancel = vi.fn(async () => {});
  respond = vi.fn(async () => {});
  answer = vi.fn(async () => {});
  setConfig = vi.fn(async (_id: string, _value: string) => {});
  cancelQueued = vi.fn(async (_message: string) => {});
  compact = vi.fn(async () => {});
  suggestFiles?: (query: string) => Promise<FileSuggestion[]>;
  subscribe(fn: (ev: SourceEvent) => void) {
    this.subs.add(fn);
    for (const ev of this.events) fn(ev);
    return () => void this.subs.delete(fn);
  }
  emit(...evs: SourceEvent[]) {
    for (const ev of evs) {
      this.events.push(ev);
      for (const fn of this.subs) fn(ev);
    }
  }
}

let seq = 0;
const next = () => ++seq;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  seq = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setLocale('en');
});

const q = <E extends Element = HTMLElement>(sel: string) => host.querySelector<E>(sel as never) as E | null;
const qa = <E extends Element = HTMLElement>(sel: string) => Array.from(host.querySelectorAll<E>(sel as never)) as E[];
const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
async function show(source: ChatSource, readOnly?: boolean, allowFull?: boolean) {
  await act(async () => root.render(createElement(Conversation, { source, kind: 'claude', readOnly, allowFull })));
  await settle();
}
async function emit(source: FakeSource, ...evs: SourceEvent[]) {
  await act(async () => source.emit(...evs));
  await settle();
}
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click());
const field = () => q<HTMLTextAreaElement>('textarea')!;
async function type(value: string) {
  await act(async () => {
    const ta = field();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(init: KeyboardEventInit) {
  let ev!: KeyboardEvent;
  await act(async () => {
    ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    field().dispatchEvent(ev);
  });
  await settle();
  return ev;
}
const options = () => qa('[role="option"]').map((o) => o.querySelector('.conv-menu-label')?.textContent);
const caps = (c: Partial<Record<string, boolean>>) => ({
  images: false,
  compact: false,
  queue: false,
  plan: false,
  questions: false,
  effort: false,
  model: false,
  cancelQueued: false,
  ...c,
});
const info = (chat: Record<string, unknown>): ChatEvent => ({ seq: next(), t: 'info', chat: { state: 'idle', ...chat } });

/** A PNG of n bytes (its content does not matter here). */
const png = (name: string, n = 8) => new File([new Uint8Array(n)], name, { type: 'image/png' });

async function paste(files: File[], types = ['Files']) {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { files, types } });
  await act(async () => void field().dispatchEvent(ev));
  return ev;
}
async function drop(files: File[]) {
  const box = q('.conv-box')!;
  const data = { files, types: ['Files'], dropEffect: 'none' };
  const over = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(over, 'dataTransfer', { value: data });
  await act(async () => void box.dispatchEvent(over));
  expect(over.defaultPrevented).toBe(true);
  expect(box.hasAttribute('data-drop')).toBe(true);
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: data });
  await act(async () => void box.dispatchEvent(ev));
}
/** Waits for the files to be read and drawn. */
async function until(fn: () => unknown) {
  await vi.waitFor(
    async () => {
      await settle();
      expect(fn()).toBeTruthy();
    },
    { timeout: 3000 },
  );
}

describe('images', () => {
  it('are attached by pasting, dropping or picking them, shown, removable, and sent before the text', async () => {
    const s = new FakeSource();
    s.emit(info({ capabilities: caps({ images: true }) }));
    await show(s);
    const pasted = await paste([png('shot.png')]);
    expect(pasted.defaultPrevented).toBe(true);
    await until(() => qa('.conv-attachment').length === 1);
    await drop([png('dropped.png')]);
    await until(() => qa('.conv-attachment').length === 2);
    const input = q<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('image/png,image/jpeg,image/gif,image/webp');
    Object.defineProperty(input, 'files', { configurable: true, value: [png('picked.png')] });
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })));
    await until(() => qa('.conv-attachment').length === 3);
    expect(qa<HTMLImageElement>('.conv-attachment img').map((i) => i.alt)).toEqual(['shot.png', 'dropped.png', 'picked.png']);
    expect(q<HTMLImageElement>('.conv-attachment img')!.src).toMatch(/^data:image\/png;base64,/);
    await click(q(`[aria-label="${t('conversation.attach.remove', { name: 'dropped.png' })}"]`));
    expect(qa('.conv-attachment')).toHaveLength(2);
    await type('what is this?');
    await key({ key: 'Enter' });
    const [content] = s.send.mock.calls[0];
    expect(content.map((b) => b.type)).toEqual(['image', 'image', 'text']);
    expect(content[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'AAAAAAAAAAA=' });
    expect(qa('.conv-attachment')).toHaveLength(0);
    // Images alone are a message too.
    await paste([png('alone.png')]);
    await until(() => qa('.conv-attachment').length === 1);
    expect(q<HTMLButtonElement>('.conv-send')!.disabled).toBe(false);
  });

  it('keep to the host’s limits and its types; text pasted with them stays the field’s', async () => {
    const s = new FakeSource();
    s.emit(info({ capabilities: caps({ images: true }) }));
    await show(s);
    await paste([png('big.png', MAX_IMAGE + 1)]);
    await until(() => q('[role="alert"]'));
    expect(q('[role="alert"]')?.textContent).toContain(t('conversation.attach.tooLarge', { name: 'big.png', max: '5 MB' }));
    expect(qa('.conv-attachment')).toHaveLength(0);
    await paste([new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    await until(() => q('[role="alert"]')?.textContent?.includes('notes.txt'));
    expect(q('[role="alert"]')?.textContent).toContain(t('conversation.attach.notImage', { name: 'notes.txt' }));
    const withText = await paste([png('a.png')], ['Files', 'text/plain']);
    expect(withText.defaultPrevented).toBe(false);
    await until(() => qa('.conv-attachment').length === 1);
  });

  it('are refused by an agent that takes none', async () => {
    const s = new FakeSource();
    s.emit(info({ capabilities: caps({}) }));
    await show(s);
    expect(q('input[type="file"]')).toBeNull();
    await paste([png('a.png')]);
    expect(q('[role="alert"]')?.textContent).toContain(t('conversation.attach.noImages', { agent: 'Claude Code' }));
  });
});

describe('the list at the caret', () => {
  it('names files with @ from the source’s suggestions, and links them in the message', async () => {
    const s = new FakeSource();
    s.suggestFiles = vi.fn(async (query: string) =>
      [
        { path: '/w/src/app.ts', label: 'src/app.ts' },
        { path: '/w/src/api.ts', label: 'src/api.ts' },
      ].filter((f) => f.label.includes(query)),
    );
    await show(s);
    await type('look at @src/a');
    await until(() => options().length === 2);
    expect(s.suggestFiles).toHaveBeenLastCalledWith('src/a');
    expect(options()).toEqual(['src/app.ts', 'src/api.ts']);
    const ta = field();
    expect(ta.getAttribute('aria-activedescendant')).toBe(qa('[role="option"]')[0].id);
    await key({ key: 'ArrowDown' });
    expect(qa('[role="option"]')[1].getAttribute('aria-selected')).toBe('true');
    await key({ key: 'Enter' });
    expect(ta.value).toBe('look at @src/api.ts ');
    expect(q('[role="listbox"]')).toBeNull();
    expect(s.send).not.toHaveBeenCalled();
    await key({ key: 'Enter' });
    expect(s.send.mock.calls[0][0]).toEqual([
      { type: 'resource_link', uri: 'file:///w/src/api.ts', name: 'src/api.ts' },
      { type: 'text', text: 'look at @src/api.ts' },
    ]);
  });

  it('offers the agent’s commands after /, and compact where the agent can; Escape closes it', async () => {
    const s = new FakeSource();
    s.emit(
      info({
        capabilities: caps({ compact: true }),
        commands: [{ name: 'review', description: 'Review a PR', argumentHint: '[pr]' }, { name: 'init' }],
      }),
    );
    await show(s);
    await type('/');
    expect(options()).toEqual(['/review', '/init', '/compact']);
    expect(q('.conv-menu-hint')?.textContent).toBe('[pr]');
    await type('/re');
    expect(options()).toEqual(['/review']);
    const esc = await key({ key: 'Escape' });
    expect(esc.defaultPrevented).toBe(true);
    expect(q('[role="listbox"]')).toBeNull();
    // Closed until the word ends.
    await type('/rev');
    expect(q('[role="listbox"]')).toBeNull();
    await type('');
    await type('/r');
    await click(qa('[role="option"]')[0]);
    expect(field().value).toBe('/review ');
    // Compact, chosen: sent as compact.
    await type('/comp');
    await key({ key: 'Tab' });
    expect(field().value).toBe('/compact ');
    await key({ key: 'Enter' });
    expect(s.compact).toHaveBeenCalledTimes(1);
    expect(s.send).not.toHaveBeenCalled();
    expect(field().value).toBe('');
  });
});

describe('the chat’s options', () => {
  const config = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'claude-haiku-5-5',
      options: [
        { value: 'claude-haiku-5-5', name: 'Haiku' },
        { value: 'claude-opus-5-5', name: 'Opus' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [{ value: 'high', name: 'High' }],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: ['default', 'acceptEdits', 'plan', 'full', 'custom'].map((value) => ({ value, name: `agent ${value}` })),
    },
  ];

  const menuOf = (cat: string) => document.body.querySelector<HTMLElement>(`.conv-select-menu[data-config="${cat}"]`);
  const menuOptions = (cat: string) => Array.from(menuOf(cat)?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);

  it.each([
    { locale: 'en', names: ['Plan mode', 'Auto mode', 'Full access', 'agent custom'] },
    { locale: 'zh-CN', names: ['计划模式', '自动模式', '完全访问', 'agent custom'] },
  ] as const)('localizes provider mode names in $locale while keeping their protocol values', async ({ locale, names }) => {
    setLocale(locale);
    const s = new FakeSource();
    const modeConfig = {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'auto',
      options: ['plan', 'auto', 'bypassPermissions', 'custom'].map((value) => ({
        value,
        name: `agent ${value}`,
        full: value === 'bypassPermissions',
      })),
    };
    s.emit(info({ config: [modeConfig] }));
    await show(s, false, true);
    const mode = q<HTMLButtonElement>('button.conv-select')!;
    expect(mode.textContent).toBe(names[1]);
    await click(mode);
    expect(menuOptions('mode').map((o) => o.textContent)).toEqual(names);
    await click(menuOptions('mode')[2]);
    expect(s.setConfig).toHaveBeenCalledWith('mode', 'bypassPermissions');
    await emit(s, info({ config: [{ ...modeConfig, currentValue: 'bypassPermissions' }] }));
    expect(mode.textContent).toBe(names[2]);
    expect(t('settings.chat.permissionMode.plan')).toBe(names[0]);
  });

  it('are chosen with custom selectors: the model, the effort where there is a choice, the mode in the view’s words', async () => {
    const s = new FakeSource();
    s.emit(info({ config }));
    await show(s);
    const selects = qa<HTMLButtonElement>('button.conv-select');
    expect(selects.map((x) => x.getAttribute('aria-label'))).toEqual([t('conversation.config.model'), t('conversation.config.mode')]);
    const [model, mode] = selects;
    expect(model.dataset.value).toBe('claude-haiku-5-5');
    expect(model.textContent).toBe('Haiku');
    await click(model);
    expect(menuOptions('model').map((o) => o.textContent)).toEqual(['Haiku', 'Opus']);
    await click(model); // close
    await click(mode);
    expect(menuOptions('mode').map((o) => o.textContent)).toEqual([
      t('conversation.mode.default'),
      t('conversation.mode.acceptEdits'),
      t('conversation.mode.plan'),
      t('conversation.mode.full'),
      'agent custom',
    ]);
    await click(mode); // close

    let done!: () => void;
    s.setConfig.mockImplementationOnce(() => new Promise<void>((r) => (done = r)));
    await click(model);
    await click(menuOptions('model')[1]);
    expect(s.setConfig).toHaveBeenCalledWith('model', 'claude-opus-5-5');
    expect(menuOf('model')).toBeNull();
    // Shown as asked, and not changed again until the host took it.
    expect(model.dataset.value).toBe('claude-opus-5-5');
    expect(model.disabled).toBe(true);
    await emit(
      s,
      info({
        config: [
          { ...config[0], currentValue: 'claude-opus-5-5' },
          {
            ...config[1],
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
          },
          config[2],
        ],
      }),
    );
    await act(async () => done());
    await settle();
    expect(model.disabled).toBe(false);
    expect(model.dataset.value).toBe('claude-opus-5-5');
    // The new model has a choice of effort.
    expect(qa('button.conv-select')).toHaveLength(3);
    s.setConfig.mockImplementationOnce(async () => {
      throw Object.assign(new Error('x'), { code: 'busy' });
    });
    await click(mode);
    await click(menuOptions('mode').find((o) => o.dataset.value === 'plan'));
    await settle();
    expect(q('[role="alert"]')?.textContent).toContain(t('conversation.error.busy', { agent: 'Claude Code' }));
    expect(mode.dataset.value).toBe('default');
  });

  it('support keyboard navigation and upward popover positioning near the bottom', async () => {
    const s = new FakeSource();
    s.emit(info({ config }));
    await show(s);
    const model = q<HTMLButtonElement>('button.conv-select[data-config="model"]')!;
    vi.spyOn(model, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      right: 220,
      top: 710,
      bottom: 734,
      width: 120,
      height: 24,
      x: 100,
      y: 710,
      toJSON: () => ({}),
    });
    await act(async () => {
      model.focus();
      model.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    await settle();
    const popup = menuOf('model')!;
    expect(popup).not.toBeNull();
    expect(popup.dataset.placement).toBe('top');
    expect(popup.style.bottom).toBeTruthy();
    expect(document.activeElement).toBe(popup);
    await act(async () => {
      popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(menuOptions('model')[1].classList.contains('active')).toBe(true);
    await act(async () => {
      popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(menuOf('model')).toBeNull();
    expect(document.activeElement).toBe(model);
    // Open again and pick with Enter.
    await act(async () => {
      model.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    const popup2 = menuOf('model')!;
    await act(async () => {
      popup2.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    });
    await act(async () => {
      popup2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await settle();
    expect(s.setConfig).toHaveBeenCalledWith('model', 'claude-opus-5-5');
    expect(placeConfigMenu({ left: 10, top: 20, right: 150, bottom: 44 }, 160, { width: 1024, height: 768 }).placement).toBe('bottom');
    expect(placeConfigMenu({ left: 10, top: 700, right: 150, bottom: 724 }, 160, { width: 1024, height: 768 }).placement).toBe('top');
  });

  it('that give full access are unavailable, saying why, while the machine does not allow it and read-only', async () => {
    const modes = {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'full', name: 'Full', full: true },
        { value: 'yolo', name: 'YOLO', full: true },
      ],
    };
    const s = new FakeSource();
    s.emit(info({ config: [modes] }));
    const shown = async () => {
      const mode = q<HTMLButtonElement>('button.conv-select[data-config="mode"]')!;
      if (!mode.disabled) await click(mode);
      const opts = menuOptions('mode').map((o) => [o.dataset.value, o.textContent, o.getAttribute('aria-disabled') === 'true']);
      if (menuOf('mode')) await click(mode);
      return { mode, options: opts };
    };
    await show(s, false, false);
    let { mode, options } = await shown();
    const fullName = t('conversation.mode.full');
    expect(options).toEqual([
      ['default', t('conversation.mode.default'), false],
      ['full', t('conversation.config.fullOff', { name: fullName }), true],
      ['yolo', t('conversation.config.fullOff', { name: 'YOLO' }), true],
    ]);
    expect(mode.title).toContain(t('conversation.config.fullOffHint'));
    expect(mode.disabled).toBe(false);
    // Disabled options cannot be clicked.
    await click(mode);
    await click(menuOptions('mode')[1]);
    expect(s.setConfig).not.toHaveBeenCalled();
    await click(mode);
    // Allowed: offered as any other.
    await show(s, false, true);
    ({ mode, options } = await shown());
    expect(options).toEqual([
      ['default', t('conversation.mode.default'), false],
      ['full', fullName, false],
      ['yolo', 'YOLO', false],
    ]);
    expect(mode.title).not.toContain(t('conversation.config.fullOffHint'));
    // Read-only: nothing is chosen.
    await show(s, true, true);
    ({ mode } = await shown());
    expect(mode.disabled).toBe(true);
  });
});

describe('a message sent while a turn runs', () => {
  it('is queued, shown in the queue and withdrawn where the agent can', async () => {
    const s = new FakeSource();
    s.emit(info({ state: 'working', capabilities: caps({ queue: true, cancelQueued: true }) }));
    await show(s);
    const send = q<HTMLButtonElement>('.conv-send')!;
    expect(send.getAttribute('aria-label')).toBe(t('conversation.queue'));
    expect(field().placeholder).toBe(t('conversation.composer.queuePlaceholder', { agent: 'Claude Code' }));
    await type('and also this');
    await key({ key: 'Enter' });
    const [content, clientId] = s.send.mock.calls[0];
    expect(content).toEqual([{ type: 'text', text: 'and also this' }]);
    await emit(s, { seq: next(), t: 'queued', message: 'q1', clientId, state: 'queued', content });
    const items = qa('.conv-queued-item');
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('.conv-queued-text')?.textContent).toBe('and also this');
    await click(items[0].querySelector('button'));
    expect(s.cancelQueued).toHaveBeenCalledWith('q1');
    await emit(s, { seq: next(), t: 'queued', message: 'q1', state: 'cancelled' });
    expect(qa('.conv-queued-item')).toHaveLength(0);
    // Taken: a prompt in the list.
    await emit(
      s,
      { seq: next(), t: 'queued', message: 'q2', clientId: 'c2', state: 'queued', content: [{ type: 'text', text: 'next' }] },
      { seq: next(), t: 'queued', message: 'q2', state: 'taken' },
    );
    expect(qa('.conv-queued-item')).toHaveLength(0);
    expect(qa('.conv-user-text').map((x) => x.textContent)).toEqual(['next']);
  });

  it('waits for the turn where the agent takes none, and cannot be withdrawn where it cannot', async () => {
    const s = new FakeSource();
    s.emit(info({ state: 'working', capabilities: caps({}) }), {
      seq: next(),
      t: 'queued',
      message: 'q1',
      state: 'queued',
      content: [{ type: 'text', text: 'x' }],
    });
    await show(s);
    await type('more');
    expect(q<HTMLButtonElement>('.conv-send')!.disabled).toBe(true);
    expect(q('.conv-queued-item button')).toBeNull();
    // Compact waits for the turn's end too.
    await emit(s, info({ state: 'idle', capabilities: caps({ compact: true }) }));
    await type('/compact');
    expect(q<HTMLButtonElement>('.conv-send')!.disabled).toBe(false);
  });
});

describe('a message whose outcome is not known', () => {
  const unsure = (code: string) => Object.assign(new Error(code), { code, unsure: true });

  it('stays in the field, is sent again under its id, and goes once the conversation shows it', async () => {
    const s = new FakeSource();
    s.emit(info({ capabilities: caps({}) }));
    s.send.mockRejectedValueOnce(unsure('lost'));
    await show(s);
    await type('hello');
    await key({ key: 'Enter' });
    expect(s.send).toHaveBeenCalledTimes(1);
    const id = s.send.mock.calls[0][1];
    expect(field().value).toBe('hello');
    expect(q('.conv-banner.error')).toBeNull();
    expect(q('[data-unsure]')?.textContent).toBe(t('conversation.sendUnsure', { agent: 'Claude Code' }));
    // Sent again, under the same id; refused again, unsure.
    s.send.mockRejectedValueOnce(unsure('timeout'));
    await key({ key: 'Enter' });
    expect(s.send.mock.calls[1][1]).toBe(id);
    expect(field().value).toBe('hello');
    // The host had it: the message is in the conversation, the draft goes.
    await emit(s, { seq: next(), t: 'user', clientId: id, content: [{ type: 'text', text: 'hello' }] });
    expect(field().value).toBe('');
    expect(q('[data-unsure]')).toBeNull();
    // A new message has an id of its own.
    await type('again');
    await key({ key: 'Enter' });
    expect(s.send.mock.calls[2][1]).not.toBe(id);
  });

  it('that the user changed is a new message; a queued one counts as shown; a definite refusal is said', async () => {
    const s = new FakeSource();
    s.emit(info({ capabilities: caps({ queue: true }) }));
    s.send.mockRejectedValueOnce(unsure('offline'));
    await show(s);
    await type('one');
    await key({ key: 'Enter' });
    const first = s.send.mock.calls[0][1];
    await type('one more');
    expect(q('[data-unsure]')).toBeNull();
    s.send.mockRejectedValueOnce(unsure('lost'));
    await key({ key: 'Enter' });
    const second = s.send.mock.calls[1][1];
    expect(second).not.toBe(first);
    // The first arriving changes nothing of the draft that is another.
    await emit(s, { seq: next(), t: 'user', clientId: first, content: [{ type: 'text', text: 'one' }] });
    expect(field().value).toBe('one more');
    expect(q('[data-unsure]')).not.toBeNull();
    await emit(s, {
      seq: next(),
      t: 'queued',
      message: 'q1',
      state: 'queued',
      clientId: second,
      content: [{ type: 'text', text: 'one more' }],
    });
    expect(field().value).toBe('');
    expect(q('[data-unsure]')).toBeNull();
    // A refusal that is sure is an error, and the text stays.
    s.send.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'busy' }));
    await type('three');
    await key({ key: 'Enter' });
    expect(q('.conv-banner.error')?.textContent).toContain(t('conversation.error.busy', { agent: 'Claude Code' }));
    expect(field().value).toBe('three');
  });
});

describe('a failed agent', () => {
  it.each([
    ['en', 'Claude Code could not start: its program or saved session could not be found.'],
    ['zh-CN', '无法启动 Claude Code：未找到所需的程序或已保存的会话。'],
  ] as const)('explains a missing session without suggesting another window answered (%s)', async (locale, message) => {
    setLocale(locale);
    const s = new FakeSource();
    const error = { code: 'not_found', message: 'claude: no such session', stderr: 'No conversation found with session ID: missing' };
    s.emit(info({}), { seq: next(), t: 'state', state: 'failed', error });
    await show(s);
    const banner = q('.conv-banner.error')!;
    expect(banner.textContent).toContain(message);
    expect(banner.textContent).not.toContain(t('conversation.error.not_found'));
    expect(banner.querySelector('span')!.title).toBe(error.stderr);
    expect(errorText(error, 'Claude Code', 'conversation.commandFailed')).toBe(t('conversation.error.not_found'));
  });
});

describe('a read-only composer', () => {
  it('has every control disabled', async () => {
    const s = new FakeSource();
    s.emit(
      info({
        state: 'working',
        capabilities: caps({ images: true, queue: true, cancelQueued: true }),
        config: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'a',
            options: [
              { value: 'a', name: 'A' },
              { value: 'b', name: 'B' },
            ],
          },
        ],
      }),
      { seq: next(), t: 'queued', message: 'q1', state: 'queued', content: [{ type: 'text', text: 'x' }] },
    );
    await show(s, true);
    expect(field().disabled).toBe(true);
    expect(q<HTMLButtonElement>('button.conv-select')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>('.conv-attach')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>('.conv-send')!.disabled).toBe(true);
    expect(q('.conv-stop')).toBeNull();
    expect(q('.conv-queued-item button')).toBeNull();
    await paste([png('a.png')]);
    await settle(20);
    expect(qa('.conv-attachment')).toHaveLength(0);
  });
});
