// @vitest-environment jsdom
//
// The conversation view with a source of its own: the agent's Markdown
// (tables, formulas, a paragraph of one formula as display math), tool
// calls of each kind and status, diffs (compared when opened), the plan,
// notices, the composer's keys and states (why a message was not sent,
// stopping a turn, read-only), the empty state, the list's earlier items,
// and events of shapes no parser makes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Conversation, SHOWN_ITEMS, stickToEnd, type ConversationHandle, type ConversationProps } from '../conversation/Conversation';
import { MAX_DIFF_LINES } from '../conversation/diff';
import {
  CHAT_NOTICES,
  NOTICES,
  STOPPED,
  TOOL_KINDS,
  TOOL_STATUSES,
  type ChatEvent,
  type ContentBlock,
  type SourceEvent,
} from '../conversation/model';
import type { ChatSource } from '../conversation/source';
import { APP_SLUG } from '../brand';
import { t } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSource implements ChatSource {
  readOnly?: boolean;
  events: SourceEvent[] = [];
  subs = new Set<(ev: SourceEvent) => void>();
  send = vi.fn(async (_content: ContentBlock[], _clientId: string) => {});
  cancel = vi.fn(async () => {});
  respond = vi.fn(async () => {});
  answer = vi.fn(async () => {});
  setConfig = vi.fn(async () => {});
  cancelQueued = vi.fn(async () => {});
  compact = vi.fn(async () => {});
  loadEarlier?: () => Promise<boolean>;
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

const text = (s: string) => ({ type: 'text' as const, text: s });
let seq = 0;
const next = () => (seq += 256);
const update = (u: Record<string, unknown>): ChatEvent => ({ seq: next(), t: 'update', update: u as ChatEvent['update'] });
const say = (s: string, messageId?: string) => update({ sessionUpdate: 'agent_message_chunk', content: text(s), messageId });
const prompt = (s: string): ChatEvent => ({ seq: next(), t: 'user', content: [text(s)] });
const call = (u: Record<string, unknown>) => update({ sessionUpdate: 'tool_call', ...u });
const callUpdate = (u: Record<string, unknown>) => update({ sessionUpdate: 'tool_call_update', ...u });
const notice = (method: string, params?: unknown): ChatEvent => ({ seq: next(), t: 'notice', method, params });

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
});

const q = <E extends Element = HTMLElement>(sel: string) => host.querySelector<E>(sel as never) as E | null;
const qa = <E extends Element = HTMLElement>(sel: string) => Array.from(host.querySelectorAll<E>(sel as never)) as E[];
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

type Props = Omit<ConversationProps, 'source'> & { source: ChatSource };
async function show(source: ChatSource, extra: Partial<Props> = {}): Promise<Props> {
  const props: Props = { source, kind: 'claude', ...extra };
  await act(async () => root.render(createElement(Conversation, props)));
  await settle();
  return props;
}
async function emit(source: FakeSource, ...evs: SourceEvent[]) {
  await act(async () => source.emit(...evs));
  await settle();
}
/** Waits for fn to hold, letting React and lazy modules finish. */
async function until(fn: () => unknown) {
  await vi.waitFor(
    async () => {
      await settle();
      expect(fn()).toBeTruthy();
    },
    { timeout: 5000 },
  );
}
const click = (el: Element | null) => act(async () => void (el as HTMLElement).click());
/** The tool row's toggle of a call. */
const toggle = (kind: string) => q(`.conv-tool[data-kind="${kind}"] .conv-toggle`);

function setValue(ta: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, value);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
async function type(value: string) {
  await act(async () => setValue(q<HTMLTextAreaElement>('textarea')!, value));
}
async function key(init: KeyboardEventInit) {
  const ta = q<HTMLTextAreaElement>('textarea')!;
  let ev!: KeyboardEvent;
  await act(async () => {
    ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
    ta.dispatchEvent(ev);
  });
  await settle();
  return ev;
}

describe('stickToEnd', () => {
  it('holds at the end and a little short of it, not further up', () => {
    expect(stickToEnd(1000, 2000, 1000)).toBe(true);
    expect(stickToEnd(980, 2000, 1000)).toBe(true);
    expect(stickToEnd(900, 2000, 1000)).toBe(false);
    expect(stickToEnd(0, 500, 1000)).toBe(true);
    expect(stickToEnd(0, 0, 0)).toBe(true);
  });
});

describe('the conversation view’s messages', () => {
  it('shows the user’s text as typed and the agent’s as Markdown with tables and formulas', async () => {
    const s = new FakeSource();
    s.emit(
      prompt('a **table**\nand a formula'),
      say('| Name | Value |\n| --- | --- |\n| a | 1 |\n\nand $$E=mc^2$$ here\n\n$$\nx^2\n$$', 'm1'),
    );
    await show(s);
    const user = q('.conv-user-text')!;
    expect(user.textContent).toBe('a **table**\nand a formula');
    expect(user.querySelector('strong')).toBeNull();
    await until(() => q('.conv-agent table'));
    expect(qa('.conv-agent th').map((th) => th.textContent)).toEqual(['Name', 'Value']);
    expect(qa('.conv-agent td').map((td) => td.textContent)).toEqual(['a', '1']);
    await until(() => q('.conv-agent .katex'));
    expect(q('.md-math-display .katex-display')).not.toBeNull();
    expect(q('.conv-agent .katex annotation')?.textContent).toContain('E=mc^2');
  });

  it('shows a paragraph of one formula between $$ on one line as display math, and leaves code as written', async () => {
    const s = new FakeSource();
    const formula = String.raw`x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}`;
    s.emit(say(`The roots:\n\n$$${formula}$$\n\nand inline $$y$$ here.\n\n\`\`\`tex\n$$z$$\n\`\`\`\n\n\`$$w$$\``, 'm1'));
    await show(s);
    await until(() => qa('.conv-agent .katex').length >= 2);
    const display = qa('.conv-agent .md-math-display');
    expect(display).toHaveLength(1);
    expect(display[0].querySelector('.katex-display')).not.toBeNull();
    expect(display[0].querySelector('annotation')?.textContent).toBe(formula);
    // Within a line of text: inline; in a code block or a code span: as written.
    const inline = qa('.conv-agent p .md-math:not(.md-math-display)');
    expect(inline.map((el) => el.querySelector('annotation')?.textContent)).toEqual(['y']);
    expect(q('.conv-agent .md-code')?.textContent).toContain('$$z$$');
    expect(qa('.conv-agent p code').map((c) => c.textContent)).toContain('$$w$$');
  });

  it('reads the agent’s last message out, and nothing else', async () => {
    const s = new FakeSource();
    s.emit(prompt('hi'), say('**Hello** there', 'm1'));
    await show(s);
    expect(q('[role="log"]')?.getAttribute('aria-live')).toBe('off');
    const live = qa('[aria-live="polite"]');
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toBe('Hello there');
    await emit(s, prompt('more'));
    expect(live[0].textContent).toBe('');
  });

  it('shows a thought as one line that opens when it has text', async () => {
    const s = new FakeSource();
    s.emit(
      update({ sessionUpdate: 'agent_thought_chunk', content: text('') }),
      say('x'),
      update({ sessionUpdate: 'agent_thought_chunk', content: text('Let me see') }),
    );
    await show(s);
    const [hidden, shown] = qa('.conv-thought');
    expect(hidden.querySelector('button')).toBeNull();
    expect(hidden.textContent).toContain(t('conversation.thought'));
    const btn = shown.querySelector('button')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await click(btn);
    await until(() => shown.querySelector('.conv-thought-text')?.textContent?.includes('Let me see'));
  });

  it('says how many tokens a thought took that the agent keeps to itself, as it estimates them', async () => {
    const s = new FakeSource();
    const estimate = (n: unknown) => ({ _meta: { [APP_SLUG]: { estimatedTokens: n } } });
    s.emit(
      update({ sessionUpdate: 'agent_thought_chunk', content: text(''), ...estimate(1234) }),
      say('x'),
      update({ sessionUpdate: 'agent_thought_chunk', content: text('Let me see'), ...estimate(80) }),
      say('y'),
      update({ sessionUpdate: 'agent_thought_chunk', content: text(''), ...estimate('many') }),
    );
    await show(s);
    expect(qa('.conv-thought .conv-tool-label').map((l) => l.textContent)).toEqual([
      t('conversation.thoughtTokens', { tokens: '1.23k' }),
      t('conversation.thought'),
      t('conversation.thought'),
    ]);
  });

  it('shows the plan as a checklist', async () => {
    const s = new FakeSource();
    s.emit(
      update({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Write it', status: 'completed', priority: 'high' },
          { content: 'Test it', status: 'in_progress', priority: 'medium' },
          { content: 'Ship it', status: 'pending', priority: 'low' },
        ],
      }),
    );
    await show(s);
    expect(qa('.conv-plan li').map((li) => li.dataset.status)).toEqual(['completed', 'in_progress', 'pending']);
    expect(q('.conv-plan-count')?.textContent).toBe(t('conversation.planProgress', { done: 1, total: 3 }));
    expect(q('.conv-plan li')?.textContent).toContain(t('conversation.planStatus.completed'));
  });

  it('shows notices as separators: errors in the error color, a command’s output on request', async () => {
    const s = new FakeSource();
    s.emit(
      notice(NOTICES.compacted),
      notice(NOTICES.error, { message: 'API Error: overloaded' }),
      notice(NOTICES.command, { name: 'context', output: '\x1b[1mTokens\x1b[0m: 12k' }),
      notice(NOTICES.skipped),
      notice(STOPPED, { stopReason: 'max_tokens' }),
      notice(CHAT_NOTICES.imported, { lossy: true }),
      notice(CHAT_NOTICES.imported),
      notice(NOTICES.command, { name: '/compact' }),
      notice(CHAT_NOTICES.restarted, { mode: 'full' }),
      notice(CHAT_NOTICES.restarted, { mode: 'yolo' }),
      notice(CHAT_NOTICES.handedOff),
    );
    await show(s);
    expect(qa('.conv-notice-text').map((n) => n.textContent)).toEqual([
      t('conversation.notice.compacted'),
      'API Error: overloaded',
      '/context',
      t('conversation.notice.skipped'),
      t('conversation.notice.stopped.max_tokens'),
      t('conversation.notice.importedLossy'),
      t('conversation.notice.imported'),
      '/compact',
      t('conversation.notice.restartedFor', { mode: t('conversation.mode.full') }),
      t('conversation.notice.restartedFor', { mode: 'yolo' }),
      t('conversation.notice.handedOff'),
    ]);
    expect(qa('.conv-notice.error')).toHaveLength(1);
    expect(q('.conv-notice .conv-pre')).toBeNull();
    await click(q('.conv-notice .conv-link'));
    expect(q('.conv-notice .conv-pre')?.textContent).toBe('Tokens: 12k');
  });

  it('says how to start while there is no conversation, and that entries are not shown', async () => {
    const s = new FakeSource();
    await show(s);
    expect(q('.conv-empty-title')?.textContent).toBe('Claude Code');
    expect(q('.conv-empty')?.textContent).toContain(t('conversation.empty', { agent: 'Claude Code' }));
    expect(q('.conv-unknown')).toBeNull();
    await emit(s, update({ sessionUpdate: 'some_future_update' }), update({ sessionUpdate: 'another_one' }));
    expect(q('.conv-unknown')?.textContent).toBe(t('conversation.unknown', { n: 2 }));
    expect(q('.conv-unknown button')).toBeNull();
  });
});

describe('the conversation view’s tool calls', () => {
  it('draws a row for every kind and status, a spinner while running', async () => {
    const s = new FakeSource();
    TOOL_KINDS.forEach((kind, i) =>
      s.emit(call({ toolCallId: `c${i}`, title: `T ${kind}`, kind, status: TOOL_STATUSES[i % TOOL_STATUSES.length] })),
    );
    await show(s);
    const rows = qa('.conv-tool');
    expect(rows.map((r) => r.dataset.kind)).toEqual([...TOOL_KINDS]);
    rows.forEach((r, i) => {
      const status = TOOL_STATUSES[i % TOOL_STATUSES.length];
      expect(r.dataset.status).toBe(status);
      expect(r.querySelector('.conv-sr')?.textContent).toContain(t(`conversation.toolStatus.${status}`));
      expect(!!r.querySelector('.conv-spin')).toBe(status === 'in_progress');
    });
  });

  it('runs a command: its line, its exit code, its output without escapes on request', async () => {
    const s = new FakeSource();
    s.emit(
      call({
        toolCallId: 'b1',
        title: 'List the files',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'ls -la', description: 'List the files' },
      }),
      callUpdate({
        toolCallId: 'b1',
        status: 'failed',
        content: [{ type: 'content', content: text('\x1b[32mtotal 0\x1b[0m\nls: x: No such file\n') }],
        _meta: { [APP_SLUG]: { exitCode: 1 } },
      }),
    );
    await show(s);
    expect(q('.conv-tool-label')?.textContent).toBe('List the files');
    expect(q('.conv-tool-subject')?.textContent).toBe('ls -la');
    expect(q('.conv-meta .conv-bad')?.textContent).toBe(t('conversation.tool.exit', { code: 1 }));
    expect(q('.conv-term')).toBeNull();
    await click(toggle('execute'));
    expect(toggle('execute')?.getAttribute('aria-expanded')).toBe('true');
    expect(q('.conv-term')?.textContent).toBe('total 0\nls: x: No such file\n');
    expect(q('.conv-tool-body')?.textContent).toContain(t('conversation.tool.exitCode', { code: 1 }));
    await click(toggle('execute'));
    expect(q('.conv-term')).toBeNull();
  });

  it('names what a read, a search and a fetch act on in one line, and opens a location', async () => {
    const s = new FakeSource();
    s.emit(
      call({
        toolCallId: 'r',
        title: 'Read a.ts',
        kind: 'read',
        status: 'completed',
        locations: [{ path: '/home/u/p/src/a.ts', line: 3 }],
      }),
      callUpdate({ toolCallId: 'r', content: [{ type: 'content', content: text('const a = 1;') }] }),
      call({ toolCallId: 's', title: 'Grep', kind: 'search', status: 'completed', rawInput: { pattern: 'TODO', path: '/home/u/p' } }),
      call({ toolCallId: 'f', title: 'Fetch', kind: 'fetch', status: 'completed', rawInput: { url: 'https://example.com/doc' } }),
      callUpdate({ toolCallId: 'f', content: [{ type: 'content', content: text('# Doc\n\n| k | v |\n|---|---|\n| a | b |') }] }),
    );
    const onOpenFile = vi.fn();
    await show(s, { onOpenFile });
    const path = q<HTMLButtonElement>('.conv-tool[data-kind="read"] button.conv-path')!;
    expect(path.querySelector('.conv-path-name')?.textContent).toBe('a.ts:3');
    expect(path.querySelector('.conv-path-dir')?.textContent).toBe('…/p/src');
    await click(path);
    expect(onOpenFile).toHaveBeenCalledWith('/home/u/p/src/a.ts', 3);
    expect(q('.conv-tool[data-kind="search"] .conv-tool-subject')?.textContent).toBe('TODO');
    expect(q('.conv-tool[data-kind="fetch"] .conv-tool-subject')?.textContent).toBe('https://example.com/doc');
    await click(toggle('read'));
    expect(q('.conv-tool[data-kind="read"] .conv-pre')?.textContent).toBe('const a = 1;');
    await click(toggle('fetch'));
    await until(() => q('.conv-tool[data-kind="fetch"] table'));
  });

  it('groups a task with its prompt, and shows another tool’s input as JSON', async () => {
    const s = new FakeSource();
    s.emit(
      call({
        toolCallId: 'k',
        title: 'Explore the code',
        kind: 'think',
        status: 'completed',
        rawInput: { description: 'Explore the code', prompt: 'Find X' },
      }),
      callUpdate({ toolCallId: 'k', content: [{ type: 'content', content: text('Found **X**') }] }),
      call({ toolCallId: 'o', title: 'mcp__github__search', kind: 'other', status: 'completed', rawInput: { q: 'repo:x', n: 3 } }),
    );
    await show(s);
    expect(q('.conv-tool[data-kind="think"] .conv-tool-label')?.textContent).toBe('Explore the code');
    expect(q('.conv-tool[data-kind="think"] .conv-tool-subject')).toBeNull();
    await click(toggle('think'));
    expect(q('.conv-tool[data-kind="think"] .conv-prompt')?.textContent).toBe('Find X');
    await until(() => q('.conv-tool[data-kind="think"] strong')?.textContent === 'X');
    expect(q('.conv-tool[data-kind="other"] .conv-tool-label')?.textContent).toBe('mcp__github__search');
    await click(toggle('other'));
    expect(q('.conv-tool[data-kind="other"] .conv-pre')?.textContent).toBe(JSON.stringify({ q: 'repo:x', n: 3 }, null, 2));
  });

  it('draws an edit’s diff from its texts before and after', async () => {
    const s = new FakeSource();
    s.emit(
      call({ toolCallId: 'e', title: 'Edit', kind: 'edit', status: 'completed', locations: [{ path: '/p/a.txt' }] }),
      callUpdate({
        toolCallId: 'e',
        content: [{ type: 'diff', path: '/p/a.txt', oldText: 'one\ntwo\nthree\n', newText: 'one\n2\nthree\nfour\n' }],
      }),
    );
    await show(s);
    expect(q('.conv-stat')?.textContent).toBe('+2 −1');
    await click(toggle('edit'));
    expect(qa('.conv-dl').map((l) => `${l.dataset.op}${l.textContent}`)).toEqual([' one', '-two', '+2', ' three', '+four']);
    expect(qa('.conv-dl.add')).toHaveLength(2);
    expect(qa('.conv-dl.del')).toHaveLength(1);
  });

  it('draws a new file whole, and a patch by its lines', async () => {
    const s = new FakeSource();
    const patch = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n');
    s.emit(
      call({
        toolCallId: 'w',
        title: 'Write',
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', path: '/p/n.txt', oldText: null, newText: 'a\nb\n' }],
      }),
      call({
        toolCallId: 'p',
        title: 'Patch',
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', changes: [{ operation: 'modify', path: '/p/x.ts' }], patch: { format: 'git_patch', text: patch } }],
      }),
    );
    await show(s);
    const [write, pat] = qa('.conv-tool[data-kind="edit"]');
    // No locations: the diffs name the files.
    expect(write.querySelector('.conv-path-name')?.textContent).toBe('n.txt');
    expect(pat.querySelector('.conv-path-name')?.textContent).toBe('x.ts');
    expect(pat.querySelector('.conv-stat')?.textContent).toBe('+1 −1');
    await click(write.querySelector('.conv-toggle'));
    expect(write.textContent).toContain(t('conversation.diff.newFile'));
    expect(Array.from(write.querySelectorAll<HTMLElement>('.conv-dl')).map((l) => `${l.dataset.op}${l.textContent}`)).toEqual(['+a', '+b']);
    await click(pat.querySelector('.conv-toggle'));
    expect(Array.from(pat.querySelectorAll<HTMLElement>('.conv-dl')).map((l) => `${l.className.split(' ')[1]}:${l.textContent}`)).toEqual([
      'meta:diff --git a/x.ts b/x.ts',
      'meta:--- a/x.ts',
      'meta:+++ b/x.ts',
      'hunk:@@ -1,2 +1,2 @@',
      'ctx:keep',
      'del:old',
      'add:new',
    ]);
  });

  it('draws a patch’s lines outside hunks with their first character', async () => {
    const s = new FakeSource();
    const patch = [
      'note before',
      '*** Begin Patch',
      '*** Add File: n.txt',
      '+hi',
      '*** Update File: a.py',
      '@@ def f',
      ' keep',
      '-a',
      '+b',
      '*** End Patch',
    ];
    s.emit(
      call({
        toolCallId: 'p',
        title: 'Patch',
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', changes: [], patch: { format: 'apply_patch', text: patch.join('\n') } }],
      }),
    );
    await show(s);
    await click(toggle('edit'));
    expect(qa('.conv-dl').map((l) => l.textContent)).toEqual([
      'note before',
      '*** Begin Patch',
      '*** Add File: n.txt',
      'hi',
      '*** Update File: a.py',
      '@@ def f',
      'keep',
      'a',
      'b',
      '*** End Patch',
    ]);
  });

  it('compares a long text diff only when its call is opened', async () => {
    const s = new FakeSource();
    const lines = (p: string) => Array.from({ length: 1000 }, (_, i) => `${p}${i}`).join('\n');
    s.emit(
      call({
        toolCallId: 'w',
        title: 'Write',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: '/p/big.txt' }],
        content: [{ type: 'diff', path: '/p/big.txt', oldText: lines('old '), newText: lines('new ') }],
      }),
      call({
        toolCallId: 'x',
        title: 'Write',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: '/p/huge.txt' }],
        content: [
          {
            type: 'diff',
            path: '/p/huge.txt',
            oldText: 'a\n',
            newText: Array.from({ length: MAX_DIFF_LINES + 5 }, (_, i) => `l${i}`).join('\n'),
          },
        ],
      }),
    );
    await show(s);
    const [big, huge] = qa('.conv-tool[data-kind="edit"]');
    // 1000 × 1000 lines to compare: no count on the closed row.
    expect(big.querySelector('.conv-stat')).toBeNull();
    // Too long to compare at all: counted as all removed, then added.
    expect(huge.querySelector('.conv-stat')?.textContent).toBe(`+${MAX_DIFF_LINES + 5} −1`);
    await click(big.querySelector('.conv-toggle'));
    expect(big.querySelector('.conv-stat')?.textContent).toBe('+1000 −1000');
    // Nothing in common: the old lines removed, then the new ones added, the first 800 drawn.
    expect(big.querySelectorAll('.conv-dl.del')).toHaveLength(800);
    // Closed again, the count stays.
    await click(big.querySelector('.conv-toggle'));
    expect(big.querySelector('.conv-stat')?.textContent).toBe('+1000 −1000');
  });
});

describe('the conversation view’s composer', () => {
  it('sends on Enter and not on Shift+Enter, Alt+Enter or while composing', async () => {
    const s = new FakeSource();
    await show(s);
    await type('hello\n');
    expect((await key({ shiftKey: true })).defaultPrevented).toBe(false);
    await key({ isComposing: true });
    await key({ keyCode: 229 });
    expect(s.send).not.toHaveBeenCalled();
    const ta = q<HTMLTextAreaElement>('textarea')!;
    ta.setSelectionRange(5, 5);
    const alt = await key({ altKey: true });
    expect(alt.defaultPrevented).toBe(true);
    expect(ta.value).toBe('hello\n\n');
    expect(s.send).not.toHaveBeenCalled();
    await type('hello');
    await key({});
    expect(s.send).toHaveBeenCalledWith([text('hello')], expect.any(String));
    expect(ta.value).toBe('');
    // Each message has an id of its own.
    await type('again');
    await key({});
    expect(s.send.mock.calls[1][1]).not.toBe(s.send.mock.calls[0][1]);
    // Nothing to send.
    await type('  \n ');
    await key({});
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it('keeps the text greyed while sending, and says when it was not sent', async () => {
    const s = new FakeSource();
    let fail!: (e: Error) => void;
    s.send.mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = reject)));
    await show(s);
    await type('do it');
    await key({});
    const ta = q<HTMLTextAreaElement>('textarea')!;
    expect(ta.readOnly).toBe(true);
    expect(ta.classList.contains('pending')).toBe(true);
    expect(ta.value).toBe('do it');
    expect(q<HTMLButtonElement>('.conv-send')!.disabled).toBe(true);
    await act(async () => fail(new Error('no')));
    await settle();
    expect(ta.readOnly).toBe(false);
    expect(ta.value).toBe('do it');
    const alert = q('[role="alert"]')!;
    expect(alert.textContent).toContain(t('conversation.sendFailed'));
    // Dismissed, it goes.
    await click(alert.querySelector('button'));
    expect(q('[role="alert"]')).toBeNull();
    s.send.mockImplementationOnce(async () => {
      throw new Error('again');
    });
    await click(q('.conv-send'));
    expect(q('[role="alert"]')).not.toBeNull();
    // Sent the third time: the text goes, and so does the error.
    await click(q('.conv-send'));
    expect(s.send).toHaveBeenCalledTimes(3);
    expect(ta.value).toBe('');
    expect(q('[role="alert"]')).toBeNull();
  });

  it('says why a message was not sent, by the source’s code', async () => {
    const s = new FakeSource();
    const fail = (code?: string) =>
      s.send.mockImplementationOnce(async () => {
        throw Object.assign(new Error(code ?? 'x'), code ? { code } : {});
      });
    await show(s);
    for (const [code, message] of [
      ['busy', t('conversation.error.busy', { agent: 'Claude Code' })],
      ['offline', t('conversation.error.offline')],
      ['read_only', t('conversation.error.read_only')],
      ['too_large', t('conversation.error.too_large')],
      ['some_other', t('conversation.sendFailed')],
      [undefined, t('conversation.sendFailed')],
    ] as const) {
      fail(code);
      await type('do it');
      await key({});
      expect(q('[role="alert"] > span')!.textContent).toBe(message);
      // The text stays to be sent again.
      expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('do it');
    }
    expect(t('conversation.error.busy', { agent: 'Claude Code' })).toContain('Claude Code');
  });

  it('is read-only, every control disabled, when the view or the source says so', async () => {
    const s = new FakeSource();
    await show(s, { readOnly: true });
    const ta = q<HTMLTextAreaElement>('textarea')!;
    expect(ta.disabled).toBe(true);
    expect(ta.placeholder).toBe(t('conversation.composer.readOnly'));
    expect(q<HTMLButtonElement>('.conv-send')!.disabled).toBe(true);
    const ro = new FakeSource();
    ro.readOnly = true;
    await show(ro);
    expect(q<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
    await show(s);
    expect(q<HTMLTextAreaElement>('textarea')!.disabled).toBe(false);
  });

  it('says why the agent does not run: failed, handed off to a terminal, closed', async () => {
    const s = new FakeSource();
    s.emit({ seq: next(), t: 'state', state: 'failed', error: { code: 'auth_required', message: 'login' } });
    await show(s);
    expect(q('.conv-banner.error')?.textContent).toContain(t('conversation.error.auth_required', { agent: 'Claude Code' }));
    expect(q('.conv-notice.error')).not.toBeNull();
    await emit(s, { seq: next(), t: 'info', chat: { state: 'sleeping', handedOff: true } });
    expect(q('.conv-banner.error')).toBeNull();
    expect(q('.conv-banner')?.textContent).toBe(t('conversation.handedOff', { agent: 'Claude Code' }));
    await emit(s, { seq: next(), t: 'info', chat: { state: 'closed' } });
    expect(q('.conv-banner')?.textContent).toBe(t('conversation.closed'));
  });

  it('stops the agent’s turn while it works, with its button or Escape', async () => {
    const s = new FakeSource();
    await show(s);
    expect(q('.conv-stop')).toBeNull();
    await key({ key: 'Escape' });
    expect(s.cancel).not.toHaveBeenCalled();
    await emit(s, { seq: next(), t: 'state', state: 'working' });
    expect(q('.conv-working')?.textContent).toBe(t('conversation.working'));
    await click(q('.conv-stop'));
    expect(s.cancel).toHaveBeenCalledTimes(1);
    const esc = await key({ key: 'Escape' });
    expect(esc.defaultPrevented).toBe(true);
    expect(s.cancel).toHaveBeenCalledTimes(2);
    // A stop that failed says so.
    s.cancel.mockImplementationOnce(async () => {
      throw Object.assign(new Error('x'), { code: 'offline' });
    });
    await click(q('.conv-stop'));
    expect(q('[role="alert"]')?.textContent).toContain(t('conversation.error.offline'));
    await emit(s, { seq: next(), t: 'state', state: 'idle' });
    expect(q('.conv-stop')).toBeNull();
    expect(q('.conv-working')).toBeNull();
  });

  it('keeps a draft per source until it is sent', async () => {
    const s = new FakeSource();
    const other = new FakeSource();
    await show(s);
    await type('half a thought');
    await act(async () => root.render(null));
    await show(other);
    expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('');
    await show(s);
    expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('half a thought');
    await key({});
    await act(async () => root.render(null));
    await show(s);
    expect(q<HTMLTextAreaElement>('textarea')!.value).toBe('');
  });

  it('shows how much of the context the session uses, its cost and the tightest limit', async () => {
    const s = new FakeSource();
    s.emit(update({ sessionUpdate: 'usage_update', used: 50_000, size: 200_000 }));
    await show(s);
    const meter = q('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuenow')).toBe('25');
    expect(meter.getAttribute('title')).toBe(t('conversation.context', { used: '50k', size: '200k' }));
    expect(q('.conv-usage-cost')).toBeNull();
    const resets = Math.round(Date.now() / 1000) + 2 * 3600 + 60;
    await emit(s, {
      seq: next(),
      t: 'info',
      chat: {
        usage: {
          used: 1000,
          size: 0,
          cost: { amount: 1.5, currency: 'USD' },
          limits: [
            { id: 'five_hour', label: '5h', usedPercent: 40, resetsAt: resets },
            { id: 'seven_day', windowMinutes: 10080, usedPercent: 91, resetsAt: resets },
          ],
        },
      },
    });
    // No size: tokens.
    expect(q('[role="meter"]')).toBeNull();
    expect(q('.conv-usage-tokens')?.textContent).toBe(t('conversation.usage.tokens', { n: '1k' }));
    expect(q('.conv-usage-cost')?.textContent).toBe('$1.50');
    const limit = q('.conv-usage-limit')!;
    expect(limit.dataset.level).toBe('high');
    expect(limit.textContent).toContain(t('conversation.usage.limit', { window: '7d', pct: 91 }));
    expect(limit.textContent).toContain('in 2 hours');
    expect(limit.title).toContain(t('conversation.usage.limit', { window: '5h', pct: 40 }));
    // The agent's own measure.
    await emit(s, { seq: next(), t: 'info', chat: { usage: { used: 1000, size: 0, percentage: 12 } } });
    expect(q('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('12');
  });

  it('focuses the composer, or the list without one', async () => {
    const s = new FakeSource();
    const ref = createRef<ConversationHandle>();
    await show(s, { ref });
    act(() => ref.current!.focus());
    expect(document.activeElement).toBe(q('textarea'));
    await show(s, { ref, readOnly: true });
    act(() => ref.current!.focus());
    expect(document.activeElement).toBe(q('[role="log"]'));
  });
});

describe('the conversation view with events of shapes no parser makes', () => {
  it('draws what it can, never an object as text, and does not fail', async () => {
    const s = new FakeSource();
    const obj = { toString: 'no' };
    s.emit(
      null as unknown as SourceEvent,
      42 as unknown as SourceEvent,
      {
        seq: next(),
        t: 'user',
        content: [null, 7, { type: 'text', text: obj }, text('real prompt'), { type: 'image', data: obj, mimeType: obj }],
      } as never,
      { seq: next(), t: 'user', at: obj } as never,
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: obj } }),
      update({ sessionUpdate: 'agent_message_chunk', content: text('real answer'), messageId: 'm1' }),
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'resource_link', uri: obj, name: obj, title: obj },
      }),
      update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'resource_link', uri: 'file:///p/a.txt', name: obj, title: ['x'] },
      }),
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'resource', resource: obj } }),
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'resource', resource: 'x' } }),
      call({
        toolCallId: 'e',
        title: obj,
        kind: 'edit',
        status: obj,
        locations: [{ path: obj }, null, { path: '/p/b.txt', line: obj }],
        content: [
          { type: 'diff', path: obj, oldText: obj, newText: 'new\n' },
          { type: 'diff', changes: [{ operation: obj, path: '/p/c.txt' }, { operation: 'add', path: obj }, null], patch: obj },
          { type: 'diff', changes: 'x', patch: { text: obj } },
          { type: 'content', content: { type: 'text', text: obj } },
          { type: 'content', content: obj },
        ],
        rawInput: { command: obj, file_path: obj },
      }),
      call({ toolCallId: 'r', kind: 'execute', status: 'failed', rawInput: { command: [obj] }, rawOutput: { exitCode: obj }, _meta: obj }),
      call({ toolCallId: 'o', kind: 'other', title: 'Custom', rawInput: obj }),
      update({ sessionUpdate: 'plan', entries: [{ content: obj }, { content: 'step', status: obj, priority: obj }] }),
      update({ sessionUpdate: 'usage_update', used: obj, size: obj }),
      update({ sessionUpdate: 'session_info_update', title: obj }),
      notice(NOTICES.command, { name: obj, args: obj, output: obj }),
      notice(NOTICES.error, obj),
      notice(STOPPED, { stopReason: obj }),
      { seq: next(), t: 'turn', state: 'error', error: { message: obj } } as never,
      { seq: next(), t: 'turn', state: 'error', error: 'x' } as never,
    );
    await show(s);
    await until(() => q('.conv-agent')?.textContent?.includes('real answer'));
    for (const row of qa('.conv-toggle:not(.static)')) await click(row);
    await settle();
    expect(q('.conv-user-text')?.textContent).toBe('real prompt');
    // The image without its data is a chip; of the links, only the one with a URI as text.
    expect(qa('.conv-user .conv-chip').map((c) => c.textContent)).toEqual([t('conversation.image')]);
    expect(qa('.conv-agent .conv-chip').map((c) => c.getAttribute('title'))).toEqual(['file:///p/a.txt']);
    expect(host.innerHTML).not.toContain('[object Object]');
    expect(host.textContent).toContain('step');
  });
});

describe('the conversation view’s list', () => {
  it('draws the last items, then earlier ones, then asks the source for more', async () => {
    const s = new FakeSource();
    for (let i = 0; i < SHOWN_ITEMS + 10; i++) s.emit(prompt(`p${i}`));
    let more = true;
    s.loadEarlier = vi.fn(async () => {
      s.emit({ seq: 1, t: 'user', content: [text('the very first')] });
      return (more = false);
    });
    await show(s);
    expect(qa('.conv-item')).toHaveLength(SHOWN_ITEMS);
    expect(q('.conv-user-text')?.textContent).toBe('p10');
    await click(q('.conv-earlier button'));
    expect(qa('.conv-item')).toHaveLength(SHOWN_ITEMS + 10);
    expect(s.loadEarlier).not.toHaveBeenCalled();
    await click(q('.conv-earlier button'));
    await settle();
    expect(s.loadEarlier).toHaveBeenCalledTimes(1);
    expect(more).toBe(false);
    expect(q('.conv-user-text')?.textContent).toBe('the very first');
    expect(qa('.conv-item')).toHaveLength(SHOWN_ITEMS + 11);
    expect(q('.conv-earlier')).toBeNull();
  });

  it('offers the latest when the user scrolled away from it', async () => {
    const s = new FakeSource();
    s.emit(prompt('a'), say('b'));
    await show(s);
    const log = q('[role="log"]')!;
    let top = 0;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 2000 });
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 500 });
    Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
    await act(async () => void log.dispatchEvent(new Event('scroll')));
    expect(q('.conv-jump')).not.toBeNull();
    // New items do not move a list the user scrolled away from.
    await emit(s, say('c'));
    expect(top).toBe(0);
    await click(q('.conv-jump'));
    expect(top).toBe(2000);
    await act(async () => void log.dispatchEvent(new Event('scroll')));
    expect(q('.conv-jump')).toBeNull();
  });

  it('starts over when its source starts over', async () => {
    const s = new FakeSource();
    s.emit(prompt('old'));
    await show(s);
    await emit(s, { t: 'reset' }, prompt('new'));
    expect(qa('.conv-user-text').map((e) => e.textContent)).toEqual(['new']);
  });
});
