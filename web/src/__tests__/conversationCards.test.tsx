// @vitest-environment jsdom
//
// The cards with which the user answers the agent: a permission of each
// kind (a command with its directory and reason, files with their diff, a
// tool with its input), answered here (also with number keys), elsewhere
// (another window, or before a reload: only this page's answers are the
// user's own), or cancelled with the turn; one of an ended turn or a read-only
// view that cannot be answered; a plan approved to go on in a mode or
// planned on; questions with single and multiple choices, the user's own
// words, a secret, previews, answered or skipped; the banner that shows
// the card that waits; and a subagent's call with its items nested.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Conversation, type ConversationProps } from '../conversation/Conversation';
import { CHAT_NOTICES, type ChatEvent, type SourceEvent } from '../conversation/model';
import type { ChatSource, PermissionReply, QuestionReply } from '../conversation/source';
import { APP_SLUG } from '../brand';
import { t } from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSource implements ChatSource {
  id?: string;
  readOnly?: boolean;
  events: SourceEvent[] = [];
  subs = new Set<(ev: SourceEvent) => void>();
  send = vi.fn(async () => {});
  cancel = vi.fn(async () => {});
  respond = vi.fn(async (_p: string, _r: PermissionReply) => {});
  answer = vi.fn(async (_q: string, _r: QuestionReply) => {});
  setConfig = vi.fn(async () => {});
  cancelQueued = vi.fn(async () => {});
  compact = vi.fn(async () => {});
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
});

const q = <E extends Element = HTMLElement>(sel: string, from: ParentNode = host) => from.querySelector<E>(sel as never) as E | null;
const qa = <E extends Element = HTMLElement>(sel: string, from: ParentNode = host) =>
  Array.from(from.querySelectorAll<E>(sel as never)) as E[];
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
async function show(source: ChatSource, extra: Partial<ConversationProps> = {}) {
  await act(async () => root.render(createElement(Conversation, { source, kind: 'claude', ...extra })));
  await settle();
}
async function emit(source: FakeSource, ...evs: SourceEvent[]) {
  await act(async () => source.emit(...evs));
  await settle();
}
const click = (el: Element | null | undefined) => act(async () => void (el as HTMLElement).click());
const buttons = (card: Element) => qa<HTMLButtonElement>('.conv-ask-actions button', card);
const labels = (card: Element) => buttons(card).map((b) => b.textContent);
const card = (request: string) => q(`.conv-ask[data-request="${request}"]`)!;

const working = (): ChatEvent => ({ seq: next(), t: 'state', state: 'working' });
const HOST_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
] as const;
const permission = (id: string, extra: Partial<ChatEvent>): ChatEvent => ({
  seq: next(),
  t: 'permission',
  id,
  options: [...HOST_OPTIONS],
  ...extra,
});
const done = (id: string, optionId: string | undefined, by = 'user'): ChatEvent => ({
  seq: next(),
  t: 'permission_done',
  id,
  outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
  by,
});

describe('a permission', () => {
  it('to run a command shows it, its directory and reason, and takes the answer chosen', async () => {
    const s = new FakeSource();
    s.emit(
      working(),
      permission('p1', {
        kind: 'command',
        toolCall: { toolCallId: 'b1', title: 'List the files', kind: 'execute', rawInput: { command: 'ls -la /tmp', cwd: '/home/u/p' } },
      }),
    );
    await show(s);
    const c = card('p1');
    expect(c.dataset.state).toBe('waiting');
    expect(q('.conv-ask-title', c)?.textContent).toBe(t('conversation.ask.command', { agent: 'Claude Code' }));
    expect(q('.conv-ask-command', c)?.textContent).toBe('ls -la /tmp');
    expect(q('.conv-ask-reason', c)?.textContent).toBe('List the files');
    expect(c.textContent).toContain(t('conversation.ask.inDirectory', { cwd: '/home/u/p' }));
    expect(labels(c)).toEqual([t('conversation.ask.allowOnce'), t('conversation.ask.allowSession'), t('conversation.ask.reject')]);
    expect(buttons(c)[0].className).toContain('primary');
    expect(buttons(c).map((b) => b.getAttribute('aria-keyshortcuts'))).toEqual(['1', '2', '3']);
    await click(buttons(c)[1]);
    expect(s.respond).toHaveBeenCalledWith('p1', { option: 'allow_session' });
    await emit(s, done('p1', 'allow_session'));
    expect(c.dataset.state).toBe('done');
    expect(buttons(c)).toHaveLength(0);
    expect(q('.conv-ask-outcome', c)?.textContent).toBe(t('conversation.ask.youChose', { option: t('conversation.ask.allowSession') }));
  });

  it('answered not by this page says only that it was answered; one cancelled with the turn or ended says so', async () => {
    const s = new FakeSource();
    s.emit(working(), permission('p1', { kind: 'command', toolCall: { toolCallId: 'x', rawInput: { command: 'make' } } }));
    await show(s);
    await emit(s, done('p1', 'allow_once'));
    expect(q('.conv-ask-outcome', card('p1'))?.textContent).toBe(
      t('conversation.ask.answered', { option: t('conversation.ask.allowOnce') }),
    );
    await emit(
      s,
      permission('p2', { kind: 'command' }),
      done('p2', undefined, 'cancel'),
      permission('p3', { kind: 'command' }),
      done('p3', undefined, 'ended'),
    );
    expect(q('.conv-ask-outcome', card('p2'))?.textContent).toBe(t('conversation.ask.cancelled'));
    expect(q('.conv-ask-outcome', card('p3'))?.textContent).toBe(t('conversation.ask.ended'));
  });

  it('whose answer came too late (another window was first) waits for the outcome; one that failed says why', async () => {
    const s = new FakeSource();
    s.emit(working(), permission('p1', { kind: 'command' }));
    await show(s);
    s.respond.mockImplementationOnce(async () => {
      throw Object.assign(new Error('gone'), { code: 'not_found' });
    });
    await click(buttons(card('p1'))[0]);
    await settle();
    expect(q('.conv-ask-error')).toBeNull();
    expect(buttons(card('p1'))[0].disabled).toBe(false);
    s.respond.mockImplementationOnce(async () => {
      throw Object.assign(new Error('x'), { code: 'offline' });
    });
    await click(buttons(card('p1'))[2]);
    await settle();
    expect(q('.conv-ask-error')?.textContent).toBe(t('conversation.error.offline'));
  });

  it('is answered with number keys while the card has the keyboard', async () => {
    const s = new FakeSource();
    s.emit(working(), permission('p1', { kind: 'command' }));
    await show(s);
    const c = card('p1');
    await act(async () => void c.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true, cancelable: true })));
    expect(s.respond).toHaveBeenCalledWith('p1', { option: 'reject_once' });
    // Not with a modifier, nor beyond the options.
    await act(async () => void c.dispatchEvent(new KeyboardEvent('keydown', { key: '9', bubbles: true })));
    await act(async () => void c.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true })));
    expect(s.respond).toHaveBeenCalledTimes(1);
  });

  it('to change files shows the files and the diff', async () => {
    const s = new FakeSource();
    s.emit(
      working(),
      permission('f1', {
        kind: 'file',
        toolCall: {
          toolCallId: 'e1',
          title: 'Edit a.txt',
          kind: 'edit',
          locations: [{ path: '/p/a.txt' }],
          content: [{ type: 'diff', path: '/p/a.txt', oldText: 'one\ntwo\n', newText: 'one\n2\n' }],
        },
      }),
    );
    const onOpenFile = vi.fn();
    await show(s, { onOpenFile });
    const c = card('f1');
    expect(q('.conv-ask-title', c)?.textContent).toBe(t('conversation.ask.file', { agent: 'Claude Code' }));
    expect(qa('.conv-dl', c).map((l) => `${l.dataset.op}${l.textContent}`)).toEqual([' one', '-two', '+2']);
    await click(q('button.conv-path', c));
    expect(onOpenFile).toHaveBeenCalledWith('/p/a.txt', undefined);
  });

  it('to use a tool shows its input in a few lines, the whole on request; an agent’s own options by their names', async () => {
    const s = new FakeSource();
    s.emit(
      working(),
      permission('m1', {
        kind: 'mcp',
        toolCall: { toolCallId: 'x', title: 'mcp__github__search', rawInput: { q: 'repo:x', n: 3 } },
        options: [
          { optionId: 'proceed', name: 'Yes, go', kind: 'allow_once' },
          { optionId: 'no', name: '', kind: 'reject_once' },
        ],
      }),
    );
    await show(s);
    const c = card('m1');
    expect(q('.conv-ask-title', c)?.textContent).toBe(t('conversation.ask.mcp', { agent: 'Claude Code' }));
    expect(qa('.conv-kv dt', c).map((d) => d.textContent)).toEqual(['q', 'n']);
    expect(qa('.conv-kv dd', c).map((d) => d.textContent)).toEqual(['repo:x', '3']);
    await click(q('.conv-ask-input .conv-link', c));
    expect(q('.conv-ask-input .conv-pre', c)?.textContent).toBe(JSON.stringify({ q: 'repo:x', n: 3 }, null, 2));
    expect(labels(c)).toEqual(['Yes, go', t('conversation.ask.kind.reject_once')]);
    await emit(s, permission('t1', { kind: 'tool', toolCall: { toolCallId: 'y', title: 'WebFetch' } }));
    expect(q('.conv-ask-title', card('t1'))?.textContent).toBe(t('conversation.ask.toolNamed', { agent: 'Claude Code', tool: 'WebFetch' }));
  });

  it('of an earlier turn cannot be answered, its answer never seen', async () => {
    const s = new FakeSource();
    s.emit(
      working(),
      { seq: next(), t: 'turn', state: 'start' },
      permission('p1', { kind: 'command' }),
      { seq: next(), t: 'turn', state: 'start' },
      permission('p2', { kind: 'command' }),
    );
    await show(s);
    expect(card('p1').dataset.state).toBe('stale');
    expect(buttons(card('p1'))).toHaveLength(0);
    expect(card('p2').dataset.state).toBe('waiting');
  });

  it('cannot be answered once the turn ended, nor read-only', async () => {
    const s = new FakeSource();
    s.emit(permission('p1', { kind: 'command' }), { seq: next(), t: 'state', state: 'idle' });
    await show(s);
    expect(card('p1').dataset.state).toBe('stale');
    expect(buttons(card('p1'))).toHaveLength(0);
    expect(q('.conv-ask-outcome')?.textContent).toBe(t('conversation.ask.stale'));
    expect(q('.conv-banner')).toBeNull();
    const ro = new FakeSource();
    ro.emit(working(), permission('p1', { kind: 'command' }));
    await show(ro, { readOnly: true });
    expect(buttons(card('p1'))).toHaveLength(0);
    expect(q('.conv-ask-outcome')?.textContent).toBe(t('conversation.ask.readOnly'));
  });

  it('that waits is told of above the composer, whose button shows it and gives it the keyboard', async () => {
    const s = new FakeSource();
    s.emit(working(), permission('p1', { kind: 'command' }));
    await show(s);
    const banner = q('.conv-banner')!;
    expect(banner.textContent).toContain(t('conversation.waiting', { agent: 'Claude Code' }));
    expect(q('.conv-sr[aria-live="polite"]')?.textContent).toBe(t('conversation.waiting', { agent: 'Claude Code' }));
    await click(q('button', banner));
    expect(document.activeElement).toBe(buttons(card('p1'))[0]);
    await emit(s, done('p1', 'allow_once'));
    expect(q('.conv-banner')).toBeNull();
  });
});

describe('a plan', () => {
  const plan = (id: string): ChatEvent =>
    permission(id, {
      kind: 'plan',
      toolCall: { toolCallId: 'x', title: 'Plan', kind: 'switch_mode', rawInput: { plan: '## Steps\n\n1. **Read** it\n2. Change it' } },
      options: [
        { optionId: 'plan:default', name: 'Approve', kind: 'allow_once' },
        { optionId: 'plan:acceptEdits', name: 'Approve, edits', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Keep planning', kind: 'reject_once' },
      ],
    });

  it('shows the plan and is approved to go on in a mode, or planned on', async () => {
    const s = new FakeSource();
    s.emit(working(), plan('pl1'));
    await show(s);
    const c = card('pl1');
    expect(c.dataset.ask).toBe('plan');
    expect(q('.conv-ask-title', c)?.textContent).toBe(t('conversation.plan.heading', { agent: 'Claude Code' }));
    await vi.waitFor(async () => {
      await settle();
      expect(q('.conv-ask-plan strong', c)?.textContent).toBe('Read');
    });
    expect(labels(c)).toEqual([
      t('conversation.plan.approve.default'),
      t('conversation.plan.approve.acceptEdits'),
      t('conversation.plan.keepPlanning'),
    ]);
    await click(buttons(c)[1]);
    expect(s.respond).toHaveBeenCalledWith('pl1', { option: 'plan:acceptEdits' });
    await emit(s, done('pl1', 'plan:acceptEdits'));
    expect(q('.conv-ask-outcome', c)?.textContent).toBe(
      t('conversation.ask.youChose', { option: t('conversation.plan.approve.acceptEdits') }),
    );
    await emit(s, plan('pl2'));
    await click(buttons(card('pl2'))[2]);
    expect(s.respond).toHaveBeenLastCalledWith('pl2', { option: 'reject_once' });
  });
});

describe('questions', () => {
  const asked = (id: string): ChatEvent => ({
    seq: next(),
    t: 'question',
    id,
    questions: [
      {
        id: 'color',
        header: 'Color',
        question: 'Which color?',
        options: [
          { label: 'Red', description: 'warm', preview: '**red** preview' },
          { label: 'Blue', description: 'cool' },
        ],
        allowOther: true,
      },
      { id: 'tools', question: 'Which tools?', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Test' }, { label: 'Build' }] },
      { id: 'token', question: 'Your token?', secret: true },
    ],
  });
  const field = (c: Element, i: number) => qa('fieldset.conv-q', c)[i];
  const check = (el: HTMLInputElement | null) => click(el);
  async function typeInto(el: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('are answered together: one choice or several, the user’s own words, a secret hidden; previews shown', async () => {
    const s = new FakeSource();
    s.emit(working(), asked('q1'));
    await show(s);
    const c = card('q1');
    expect(q('.conv-ask-title', c)?.textContent).toBe(t('conversation.question.headingMany', { agent: 'Claude Code', n: 3 }));
    expect(qa('legend', c).map((l) => l.textContent)).toEqual(['ColorWhich color?', 'Which tools?', 'Your token?']);
    const submit = q<HTMLButtonElement>('button[type="submit"]', c)!;
    expect(submit.disabled).toBe(true);
    // One choice: radios; the preview of the one chosen.
    const color = qa<HTMLInputElement>('input', field(c, 0));
    expect(color.map((i) => i.type)).toEqual(['radio', 'radio', 'radio', 'text']);
    await check(color[0]);
    await vi.waitFor(async () => {
      await settle();
      expect(q('.conv-q-preview strong', c)?.textContent).toBe('red');
    });
    // The user's own words instead.
    await typeInto(color[3], 'Green');
    expect(color[2].checked).toBe(true);
    expect(color[0].checked).toBe(false);
    // Several choices: check boxes.
    const tools = qa<HTMLInputElement>('input', field(c, 1));
    expect(tools.map((i) => i.type)).toEqual(['checkbox', 'checkbox', 'checkbox']);
    await check(tools[0]);
    await check(tools[2]);
    expect(submit.disabled).toBe(true);
    // A secret: not shown as typed.
    const token = q<HTMLInputElement>('input', field(c, 2))!;
    expect(token.type).toBe('password');
    await typeInto(token, 's3cret');
    expect(submit.disabled).toBe(false);
    await click(submit);
    expect(s.answer).toHaveBeenCalledWith('q1', { answers: { color: ['Green'], tools: ['Lint', 'Build'], token: ['s3cret'] } });
    await emit(s, {
      seq: next(),
      t: 'question_done',
      id: 'q1',
      answers: { color: ['Green'], tools: ['Lint', 'Build'], token: ['s3cret'] },
      by: 'user',
    });
    expect(c.dataset.state).toBe('done');
    expect(q('form', c)).toBeNull();
    expect(q('.conv-ask-outcome', c)?.textContent).toBe(t('conversation.question.youAnswered'));
    expect(qa('.conv-q-answer', c).map((a) => a.textContent)).toEqual(['Green', 'Lint, Build', t('conversation.question.secret')]);
    expect(c.textContent).not.toContain('s3cret');
  });

  it('are skipped, or answered elsewhere', async () => {
    const s = new FakeSource();
    s.emit(working(), asked('q1'));
    await show(s);
    await click(qa<HTMLButtonElement>('.conv-ask-actions button', card('q1'))[1]);
    expect(s.answer).toHaveBeenCalledWith('q1', { cancelled: true });
    await emit(s, { seq: next(), t: 'question_done', id: 'q1', by: 'user' });
    expect(q('.conv-ask-outcome', card('q1'))?.textContent).toBe(t('conversation.question.skipped'));
    await emit(s, asked('q2'));
    await emit(s, { seq: next(), t: 'question_done', id: 'q2', answers: { color: ['Red'] }, by: 'user' });
    expect(q('.conv-ask-outcome', card('q2'))?.textContent).toBe(t('conversation.question.answered'));
  });

  it('renders Codex async questions as non-blocking across turn end, handles superseded, optional, header-only, Markdown, allowOther focus, and Enter submit', async () => {
    const s = new FakeSource();
    s.emit(
      { seq: next(), t: 'turn', state: 'start' },
      {
        seq: next(),
        t: 'update',
        item: 'am-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Here are follow-up questions:' },
          _meta: {
            [APP_SLUG]: {
              delivery: 'final_answer',
              questions: [{ title: 'Should we **deploy** now?', options: ['Yes', 'Later'] }],
            },
          },
        } as ChatEvent['update'],
      },
      {
        seq: next(),
        t: 'question',
        id: 'aq1',
        async: true,
        item: 'am-1',
        questions: [
          {
            id: 'deploy',
            header: 'Deploy',
            question: 'Should we **deploy** now?',
            options: [{ label: 'Yes' }, { label: 'Later' }],
            allowOther: true,
          },
        ],
      },
      { seq: next(), t: 'turn', state: 'end', stopReason: 'end_turn' },
      { seq: next(), t: 'state', state: 'idle' },
    );
    await show(s, { kind: 'codex' });

    // Correlated QuestionCard suppresses duplicate inline follow-up block on AgentMessage.
    expect(q('.conv-followup')).toBeNull();

    const c = card('aq1');
    expect(c.dataset.state).toBe('waiting');
    expect(c.dataset.async).toBe('true');
    expect(q('.conv-ask-badge', c)?.textContent).toBe(t('conversation.question.async'));

    // Async question does NOT show the blocking waiting banner or disable composer.
    expect(q('.conv-banner')).toBeNull();
    expect(q<HTMLTextAreaElement>('textarea')!.disabled).toBe(false);

    // Question text renders compact Markdown.
    await vi.waitFor(async () => {
      await settle();
      expect(q('.conv-q legend strong', c)?.textContent).toBe('deploy');
    });

    // Detached allowOther: checking "Other" selects it and focuses the detached text input without interfering.
    const otherRow = q('.conv-q-other', c)!;
    const otherRadio = q<HTMLInputElement>('label.conv-q-other-toggle input[type="radio"]', otherRow)!;
    const otherText = q<HTMLInputElement>('input.conv-q-input', otherRow)!;
    expect(otherText.closest('label')).toBeNull();
    await check(otherRadio);
    await settle();
    expect(otherRadio.checked).toBe(true);
    expect(document.activeElement).toBe(otherText);
    await typeInto(otherText, 'Next Tuesday');
    expect(otherRadio.checked).toBe(true);

    // Enter submits a ready single-question card.
    await act(async () => {
      otherText.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await settle();
    expect(s.answer).toHaveBeenCalledWith('aq1', { answers: { deploy: ['Next Tuesday'] } });

    // Superseded resolution text + optional/header-only question.
    await emit(s, { seq: next(), t: 'question_done', id: 'aq1', by: 'superseded' });
    expect(q('.conv-ask-outcome', card('aq1'))?.textContent).toBe(t('conversation.ask.superseded'));

    await emit(s, {
      seq: next(),
      t: 'question',
      id: 'aq2',
      async: true,
      questions: [
        { id: 'req', header: 'Target env', question: '', options: [{ label: 'Staging' }] },
        { id: 'opt', question: 'Extra notes?', optional: true },
      ],
    });
    const c2 = card('aq2');
    expect(qa('legend', c2)[0].textContent).toContain('Target env');
    expect(q('.conv-q-optional', c2)?.textContent).toBe(t('conversation.question.optional'));
    const submit2 = q<HTMLButtonElement>('button[type="submit"]', c2)!;
    expect(submit2.disabled).toBe(true);
    await check(q<HTMLInputElement>('input[type="radio"]', field(c2, 0)));
    // Optional second question does not block submission.
    expect(submit2.disabled).toBe(false);
    await click(submit2);
    expect(s.answer).toHaveBeenCalledWith('aq2', { answers: { req: ['Staging'] } });
  });

  it('replays AgentMessage follow-up questions read-only when no interactive QuestionCard correlates to them', async () => {
    const s = new FakeSource();
    s.emit({
      seq: next(),
      t: 'update',
      item: 'am-replay',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done!' },
        _meta: {
          [APP_SLUG]: {
            questions: [{ title: 'Run **benchmarks**?', options: ['Quick', 'Full'] }],
          },
        },
      } as ChatEvent['update'],
    });
    await show(s, { kind: 'codex' });
    const fu = q('.conv-followup')!;
    expect(fu).not.toBeNull();
    expect(q('.conv-followup-head', fu)?.textContent).toContain(t('conversation.question.followUp'));
    expect(qa('.conv-followup-options .conv-badge', fu).map((b) => b.textContent)).toEqual(['Quick', 'Full']);
    await vi.waitFor(async () => {
      await settle();
      expect(q('.conv-followup-item strong', fu)?.textContent).toBe('benchmarks');
    });
  });
});

/** A plan to approve, and a question of one choice, for the cards of a
 * view drawn again. */
const planOf = (id: string): ChatEvent =>
  permission(id, {
    kind: 'plan',
    toolCall: { toolCallId: 'x', title: 'Plan', kind: 'switch_mode', rawInput: { plan: 'Do it' } },
    options: [
      { optionId: 'plan:default', name: 'Approve', kind: 'allow_once' },
      { optionId: 'plan:acceptEdits', name: 'Approve, edits', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Keep planning', kind: 'reject_once' },
    ],
  });
const colorAsked = (id: string): ChatEvent => ({
  seq: next(),
  t: 'question',
  id,
  questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Blue' }] }],
});

describe('cards this page did not answer (a reload, attaching again, another window)', () => {
  it('show the answer as given, claiming no one', async () => {
    const s = new FakeSource();
    s.emit(
      working(),
      permission('p1', { kind: 'command' }),
      done('p1', 'allow_once'),
      permission('p2', { kind: 'command' }),
      done('p2', undefined),
      {
        seq: next(),
        t: 'question',
        id: 'q1',
        questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Blue' }] }],
      },
      { seq: next(), t: 'question_done', id: 'q1', answers: { color: ['Blue'] }, by: 'user' },
    );
    await show(s);
    expect(q('.conv-ask-outcome', card('p1'))?.textContent).toBe(
      t('conversation.ask.answered', { option: t('conversation.ask.allowOnce') }),
    );
    expect(q('.conv-ask-outcome', card('p2'))?.textContent).toBe(t('conversation.ask.dismissed'));
    expect(q('.conv-ask-outcome', card('q1'))?.textContent).toBe(t('conversation.question.answered'));
  });

  it('show the answer as given when the replay has the card wait and its answer comes after', async () => {
    // After a reload the page attaches again: its replay draws the cards
    // waiting, then their answers come.
    const s = new FakeSource();
    s.id = 'c-reload';
    s.emit(working(), permission('p1', { kind: 'command' }), planOf('pl1'), colorAsked('q1'));
    await show(s);
    expect(card('p1').dataset.state).toBe('waiting');
    await emit(s, done('p1', 'allow_session'), done('pl1', 'plan:default'), {
      seq: next(),
      t: 'question_done',
      id: 'q1',
      answers: { color: ['Blue'] },
      by: 'user',
    });
    expect(q('.conv-ask-outcome', card('p1'))?.textContent).toBe(
      t('conversation.ask.answered', { option: t('conversation.ask.allowSession') }),
    );
    expect(q('.conv-ask-outcome', card('pl1'))?.textContent).toBe(
      t('conversation.ask.answered', { option: t('conversation.plan.approve.default') }),
    );
    expect(q('.conv-ask-outcome', card('q1'))?.textContent).toBe(t('conversation.question.answered'));
    expect(host.textContent).not.toContain('window');
  });

  it('show this page’s answers as the user’s in a new view of the chat (attached again), and no other chat’s', async () => {
    const a = new FakeSource();
    a.id = 'c-mine';
    a.emit(working(), permission('p1', { kind: 'command' }), planOf('pl1'), colorAsked('q1'), permission('p2', { kind: 'command' }));
    await show(a);
    await click(buttons(card('p1'))[1]);
    await click(buttons(card('pl1'))[1]);
    await click(q('input', card('q1')));
    await click(q('button[type="submit"]', card('q1')));
    expect(a.answer).toHaveBeenCalledWith('q1', { answers: { color: ['Blue'] } });
    // A new view of the chat, its cards waiting again in the replay; the
    // answers come after. p2 was answered elsewhere.
    await act(async () => root.unmount());
    root = createRoot(host);
    const b = new FakeSource();
    b.id = 'c-mine';
    b.emit(working(), permission('p1', { kind: 'command' }), planOf('pl1'), colorAsked('q1'), permission('p2', { kind: 'command' }));
    await show(b);
    expect(card('p1').dataset.state).toBe('waiting');
    await emit(
      b,
      done('p1', 'allow_session'),
      done('pl1', 'plan:acceptEdits'),
      { seq: next(), t: 'question_done', id: 'q1', answers: { color: ['Blue'] }, by: 'user' },
      done('p2', 'allow_once'),
    );
    expect(q('.conv-ask-outcome', card('p1'))?.textContent).toBe(
      t('conversation.ask.youChose', { option: t('conversation.ask.allowSession') }),
    );
    expect(q('.conv-ask-outcome', card('pl1'))?.textContent).toBe(
      t('conversation.ask.youChose', { option: t('conversation.plan.approve.acceptEdits') }),
    );
    expect(q('.conv-ask-outcome', card('q1'))?.textContent).toBe(t('conversation.question.youAnswered'));
    expect(q('.conv-ask-outcome', card('p2'))?.textContent).toBe(
      t('conversation.ask.answered', { option: t('conversation.ask.allowOnce') }),
    );
    // Another chat with cards of the same ids: not this page's answers.
    await act(async () => root.unmount());
    root = createRoot(host);
    const c = new FakeSource();
    c.id = 'c-other';
    c.emit(working(), permission('p1', { kind: 'command' }), done('p1', 'allow_session'));
    await show(c);
    expect(q('.conv-ask-outcome', card('p1'))?.textContent).toBe(
      t('conversation.ask.answered', { option: t('conversation.ask.allowSession') }),
    );
  });

  it('keep this page’s answer when its sending ended without an answer', async () => {
    const s = new FakeSource();
    s.emit(working(), permission('p1', { kind: 'command' }));
    await show(s);
    s.respond.mockImplementationOnce(async () => {
      throw Object.assign(new Error('lost'), { code: 'lost', unsure: true });
    });
    await click(buttons(card('p1'))[1]);
    await settle();
    expect(q('.conv-ask-error', card('p1'))?.textContent).toBe(t('conversation.error.lost'));
    await emit(s, done('p1', 'allow_session'));
    expect(q('.conv-ask-outcome', card('p1'))?.textContent).toBe(
      t('conversation.ask.youChose', { option: t('conversation.ask.allowSession') }),
    );
    expect(q('.conv-ask-error', card('p1'))).toBeNull();
  });
});

describe('questions named like an object’s members', () => {
  it('are not shown; the others are answered', async () => {
    const s = new FakeSource();
    s.emit(working(), {
      seq: next(),
      t: 'question',
      id: 'q1',
      questions: [
        { id: '__proto__', question: 'Proto?' },
        { id: 'constructor', question: 'Constructor?', options: [{ label: 'A' }] },
        { id: 'name', question: 'Your name?' },
      ],
    });
    await show(s);
    const c = card('q1');
    expect(qa('legend', c).map((l) => l.textContent)).toEqual(['Your name?']);
    await act(async () => {
      const el = q<HTMLInputElement>('input', c)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, 'Ada');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(q('button[type="submit"]', c));
    expect(s.answer).toHaveBeenCalledWith('q1', { answers: { name: ['Ada'] } });
  });
});

describe('a subagent’s call', () => {
  it('names its type and task, counts its items, and shows them nested when opened', async () => {
    const s = new FakeSource();
    s.emit(
      {
        seq: next(),
        t: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'task1',
          title: 'Find the tests',
          kind: 'think',
          status: 'in_progress',
          rawInput: { subagent_type: 'Explore', description: 'Find the tests', prompt: 'Look for test files' },
        },
      },
      {
        seq: next(),
        t: 'update',
        parent: 'task1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 's1',
          title: 'Grep',
          kind: 'search',
          status: 'completed',
          rawInput: { pattern: 'describe(' },
        },
      },
      {
        seq: next(),
        t: 'update',
        parent: 'task1',
        item: 'sm:0',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Found **three**.' } },
      },
    );
    await show(s);
    const row = q('.conv-subagent')!;
    expect(q('.conv-tool-label', row)?.textContent).toBe('Explore');
    expect(q('.conv-subagent-desc', row)?.textContent).toBe('Find the tests');
    expect(q('.conv-subagent-count', row)?.textContent).toBe(t('conversation.subagent.steps', { n: 2 }));
    expect(q('.conv-spin', row)).not.toBeNull();
    // Closed at first: its items are not drawn.
    expect(q('.conv-tool[data-kind="search"]')).toBeNull();
    await click(q('.conv-toggle', row));
    expect(q('.conv-prompt', row)?.textContent).toBe('Look for test files');
    expect(q('.conv-subagent-items .conv-tool[data-kind="search"] .conv-tool-subject', row)?.textContent).toBe('describe(');
    await vi.waitFor(async () => {
      await settle();
      expect(q('.conv-subagent-items .conv-agent strong', row)?.textContent).toBe('three');
    });
    await emit(s, {
      seq: next(),
      t: 'update',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'task1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Three test files.' } }],
      },
    });
    expect(q('.conv-spin', row)).toBeNull();
    expect(row.textContent).toContain('Three test files.');
  });
});

describe('a folder the agent started in without its project settings', () => {
  const untrusted = (): ChatEvent => ({ seq: next(), t: 'notice', method: CHAT_NOTICES.untrustedFolder, params: { cwd: '/home/u/p' } });
  const notice = () => q('.conv-notice')!;
  const trustButton = () => qa<HTMLButtonElement>('.conv-notice button').find((b) => b.textContent === t('conversation.notice.trust'));

  it('is said, with an action that trusts it through the source; after it, that the next start loads them', async () => {
    const s = new FakeSource();
    let done!: () => void;
    const trust = vi.fn(() => new Promise<void>((r) => (done = r)));
    Object.assign(s, { trust });
    s.emit(untrusted(), { seq: next(), t: 'notice', method: CHAT_NOTICES.fullAccessOff, params: { mode: 'full' } });
    await show(s);
    expect(notice().textContent).toContain(t('conversation.notice.untrustedFolder'));
    expect(qa('.conv-notice')[1].textContent).toBe(t('conversation.notice.fullAccessOff'));
    const b = trustButton()!;
    expect(b.title).toBe(t('conversation.notice.trustHint', { cwd: '/home/u/p' }));
    await click(b);
    expect(trust).toHaveBeenCalledTimes(1);
    expect(trustButton()!.disabled).toBe(true);
    await act(async () => done());
    await settle();
    expect(notice().textContent).toBe(t('conversation.notice.trusted'));
    expect(trustButton()).toBeUndefined();
  });

  it('says why trusting failed, and offers it again', async () => {
    const s = new FakeSource();
    const trust = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 'offline' });
    });
    Object.assign(s, { trust });
    s.emit(untrusted());
    await show(s);
    await click(trustButton());
    await settle();
    expect(q('.conv-notice-failed')?.textContent).toBe(t('conversation.error.offline', { agent: 'Claude Code' }));
    expect(trustButton()!.disabled).toBe(false);
  });

  it('once trusted from the notice, offers to take it back through the source, and then to trust it again', async () => {
    const s = new FakeSource();
    const trust = vi.fn(async () => {});
    let fail = true;
    const untrust = vi.fn(async () => {
      if (fail) throw Object.assign(new Error('x'), { code: 'offline' });
    });
    Object.assign(s, { trust, untrust });
    s.emit(untrusted());
    await show(s);
    const untrustButton = () =>
      qa<HTMLButtonElement>('.conv-notice button').find((b) => b.textContent === t('conversation.notice.untrust'));
    expect(untrustButton()).toBeUndefined();
    await click(trustButton());
    await settle();
    expect(q('.conv-notice-text')!.textContent).toBe(t('conversation.notice.trusted'));
    expect(trustButton()).toBeUndefined();
    expect(untrustButton()!.title).toBe(t('conversation.notice.untrustHint', { cwd: '/home/u/p' }));
    // It fails: said, still trusted, offered again.
    await click(untrustButton());
    await settle();
    expect(untrust).toHaveBeenCalledTimes(1);
    expect(q('.conv-notice-failed')?.textContent).toBe(t('conversation.error.offline', { agent: 'Claude Code' }));
    expect(q('.conv-notice-text')!.textContent).toBe(t('conversation.notice.trusted'));
    fail = false;
    await click(untrustButton());
    await settle();
    expect(untrust).toHaveBeenCalledTimes(2);
    expect(q('.conv-notice-failed')).toBeNull();
    expect(q('.conv-notice-text')!.textContent).toBe(t('conversation.notice.untrustedFolder'));
    expect(untrustButton()).toBeUndefined();
    expect(trustButton()!.disabled).toBe(false);
    expect(trust).toHaveBeenCalledTimes(1);
  });

  it('offers nothing read-only, nor from a source that cannot trust', async () => {
    const s = new FakeSource();
    s.emit(untrusted());
    await show(s);
    expect(trustButton()).toBeUndefined();
    Object.assign(s, { trust: vi.fn(async () => {}), untrust: vi.fn(async () => {}) });
    await show(s, { readOnly: true });
    expect(notice().textContent).toBe(t('conversation.notice.untrustedFolder'));
    expect(qa('.conv-notice button')).toHaveLength(0);
  });
});
