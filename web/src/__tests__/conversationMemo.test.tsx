// @vitest-environment jsdom
//
// The conversation view draws an item again only when it changed: a new
// chunk of the agent's last message renders that message's Markdown, not
// the earlier ones', and a change of the view's state renders none; a
// message that streams draws only its last block for each frame of
// increments, and whole once its stored event came.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const rendered: string[] = [];
vi.mock('../markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => {
    rendered.push(text);
    return createElement('div', { className: 'md-mock' }, text);
  },
}));

import { Conversation } from '../conversation/Conversation';
import type { ChatEvent, SourceEvent } from '../conversation/model';
import type { ChatSource } from '../conversation/source';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  rendered.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function fakeSource(take: (fn: (ev: SourceEvent) => void) => void): ChatSource {
  const done = async () => {};
  return {
    subscribe(fn) {
      take(fn);
      return () => {};
    },
    send: done,
    cancel: done,
    respond: done,
    answer: done,
    setConfig: done,
    cancelQueued: done,
    compact: done,
  };
}

const say = (seq: number, text: string, messageId: string): ChatEvent => ({
  seq,
  t: 'update',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
});

it('draws only the message a chunk changed', async () => {
  let emit: (ev: SourceEvent) => void = () => {};
  const source = fakeSource((fn) => (emit = fn));
  const props = { source, kind: 'codex' };
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  await act(async () => root.render(createElement(Conversation, props)));
  await act(async () => {
    emit(say(1, 'first', 'a'));
    emit(say(2, 'second', 'b'));
  });
  await settle();
  expect(rendered).toEqual(['first', 'second']);
  await act(async () => emit(say(3, ' and more', 'b')));
  await settle();
  expect(rendered).toEqual(['first', 'second', 'second and more']);
  await act(async () => root.render(createElement(Conversation, { ...props, readOnly: true })));
  expect(rendered).toHaveLength(3);
  expect(Array.from(host.querySelectorAll('.md-mock')).map((e) => e.textContent)).toEqual(['first', 'second and more']);
});

it('draws a message that streams a block at a time, once a frame, and whole at its end', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask'] });
  try {
    let emit: (ev: SourceEvent) => void = () => {};
    const source = fakeSource((fn) => (emit = fn));
    await act(async () => root.render(createElement(Conversation, { source, kind: 'claude' })));
    const live = (text: string): ChatEvent => ({
      t: 'update',
      live: true,
      item: 'm:0',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    const frame = () => act(async () => void vi.advanceTimersToNextFrame());
    await act(async () => {
      emit(live('One.\n\nTw'));
      emit(live('o'));
    });
    // Nothing before the frame; then both increments at once.
    expect(rendered).toEqual([]);
    await frame();
    expect(rendered).toEqual(['One.', 'Two']);
    expect(host.querySelector('.conv-stream')).not.toBeNull();
    await act(async () => emit(live(' and')));
    await frame();
    // The first block is not drawn again.
    expect(rendered).toEqual(['One.', 'Two', 'Two and']);
    // Whole: one text.
    await act(async () => {
      emit({
        seq: 1,
        t: 'update',
        item: 'm:0',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'One.\n\nTwo and three.' } },
      });
      await vi.runAllTimersAsync();
    });
    expect(rendered.at(-1)).toBe('One.\n\nTwo and three.');
    expect(host.querySelector('.conv-stream')).toBeNull();
    expect(Array.from(host.querySelectorAll('.md-mock')).map((e) => e.textContent)).toEqual(['One.\n\nTwo and three.']);
  } finally {
    vi.useRealTimers();
  }
});
