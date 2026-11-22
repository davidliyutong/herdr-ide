// @vitest-environment jsdom
//
// The conversation view draws an item again only when it changed: a new
// chunk of the agent's last message renders that message's Markdown, not
// the earlier ones', and a change of the view's state renders none.

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
import type { AgentSource } from '../conversation/source';

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

const say = (seq: number, text: string, messageId: string): ChatEvent => ({
  seq,
  t: 'update',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
});

it('draws only the message a chunk changed', async () => {
  let emit: (ev: SourceEvent) => void = () => {};
  const source: AgentSource = {
    capabilities: { input: 'terminal', permissions: false, streaming: true },
    subscribe(fn) {
      emit = fn;
      return () => {};
    },
    send: async () => {},
  };
  const props = { source, kind: 'codex', status: 'working' as const, onShowTerminal: () => {} };
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
  await act(async () => root.render(createElement(Conversation, { ...props, status: 'idle' })));
  expect(rendered).toHaveLength(3);
  expect(Array.from(host.querySelectorAll('.md-mock')).map((e) => e.textContent)).toEqual(['first', 'second and more']);
});
