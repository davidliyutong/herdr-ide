// @vitest-environment jsdom
//
// Formulas the agents write with LaTeX's delimiters (format.ts latexMath):
// \[ … \] as display math (in a paragraph, over several lines, in a list
// item or a quote, between text), \( … \) as inline math, as the renderer
// knows them (dollars); code blocks, code spans, an escaped backslash and
// a delimiter without its pair (a message still arriving) as written. The
// conversation shows them so in messages, plans and question previews.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Conversation } from '../conversation/Conversation';
import { displayMath, latexMath } from '../conversation/format';
import type { ChatEvent, SourceEvent } from '../conversation/model';
import type { ChatSource } from '../conversation/source';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Text as written, backslashes and all (not tagged md: a formatter
 * would format it as Markdown). */
const r = String.raw;

describe('LaTeX delimiters', () => {
  it('make a display formula of a paragraph a formula block', () => {
    expect(
      latexMath(r`The quadratic formula gives the roots:

\[ x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a} \]

where $a \neq 0$.`),
    ).toBe(r`The quadratic formula gives the roots:

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

where $a \neq 0$.`);
  });

  it('make one over several lines a formula block, its lines as written', () => {
    expect(
      latexMath(r`Expanding the square:
\[
\begin{aligned}
(a+b)^2 &= (a+b)(a+b) \\
        &= a^2 + 2ab + b^2
\end{aligned}
\]
So the cross term is $2ab$.`),
    ).toBe(r`Expanding the square:
$$
\begin{aligned}
(a+b)^2 &= (a+b)(a+b) \\
        &= a^2 + 2ab + b^2
\end{aligned}
$$
So the cross term is $2ab$.`);
    // Its first and last lines with the formula on them.
    expect(
      latexMath(r`\[ \sum_{i=1}^{n} i
= \frac{n(n+1)}{2} \]`),
    ).toBe(r`$$
\sum_{i=1}^{n} i
= \frac{n(n+1)}{2}
$$`);
  });

  it('put a display formula within a line of text between the text before and after it', () => {
    expect(latexMath(r`The energy of a body at rest is \[E = mc^2\] where $c$ is the speed of light.`))
      .toBe(r`The energy of a body at rest is
$$
E = mc^2
$$
where $c$ is the speed of light.`);
    expect(latexMath(r`\[a\] and \[b\]`)).toBe('$$\na\n$$\nand\n$$\nb\n$$');
  });

  it('make an inline formula of one on a line, with $$ beside a dollar of the line', () => {
    expect(latexMath(r`Since \(a^2 + b^2 = c^2\), the triangle is right-angled; the hypotenuse \( c \) is longest.`)).toBe(
      r`Since $a^2 + b^2 = c^2$, the triangle is right-angled; the hypotenuse $c$ is longest.`,
    );
    expect(latexMath(r`It costs $5 per \(n\) items.`)).toBe(r`It costs $5 per $$n$$ items.`);
    // Over two lines: as written.
    const twoLines = r`The term \(x +` + '\n' + r`y\) grows.`;
    expect(latexMath(twoLines)).toBe(twoLines);
  });

  it('keep a list item’s indentation and a quote’s markers', () => {
    expect(
      latexMath(r`1. Expand the square:
   \[
   (a+b)^2 = a^2 + 2ab + b^2
   \]
2. Then take \(ab\) out.
- \[\bar{x} = \frac{1}{n}\sum_i x_i\]
- The mean is \[\bar{x}\] here.`),
    ).toBe(r`1. Expand the square:
   $$
   (a+b)^2 = a^2 + 2ab + b^2
   $$
2. Then take $ab$ out.
- $$
  \bar{x} = \frac{1}{n}\sum_i x_i
  $$
- The mean is
  $$
  \bar{x}
  $$
  here.`);
    expect(
      latexMath(r`> Recall \[ e^{i\pi} + 1 = 0 \]
> and \(i^2 = -1\).`),
    ).toBe(r`> Recall
> $$
> e^{i\pi} + 1 = 0
> $$
> and $i^2 = -1$.`);
  });

  it('leave code blocks and code spans as written', () => {
    for (const text of [
      'In LaTeX:\n\n```latex\n' + r`\[ x = 1 \]` + '\n' + r`inline \(y\) here` + '\n```',
      '~~~~\n' + r`\[a\]` + '\n~~~\n' + r`\(b\)` + '\n~~~~',
      '1. Code:\n   ```\n' + r`   \[a\]` + '\n   ```',
      'Write `' + r`\[x\]` + '` for display math and ``' + r`\(y\)` + '`` inline.',
    ])
      expect(latexMath(text)).toBe(text);
    // After the code block closes, a formula is one again.
    expect(latexMath('```\n' + r`\[a\]` + '\n```\n' + r`\[b\]`)).toBe('```\n' + r`\[a\]` + '\n```\n$$\nb\n$$');
  });

  it('take only whole pairs: an \\[ without its \\] (a message still arriving), or an escaped backslash, as written', () => {
    for (const text of [
      r`The sum is
\[
\sum_{i=1}^{n} i =`,
      r`An unclosed \[ x = 1 here.

And the next paragraph \] is another.`,
      r`A literal \\[ and \\] and \\(no\\).`,
      r`\[ \]`,
      r`Before \( \) after`,
      r`Over a fence \[ a` + '\n```\n' + r`\]` + '\n```',
    ])
      expect(latexMath(text)).toBe(text);
    // Once its end came, the formula is one.
    expect(
      latexMath(r`The sum is
\[
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
\]`),
    ).toBe(r`The sum is
$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$`);
    // An \[ without its end leaves the rest of its paragraph as written,
    // a later one in another paragraph is one.
    expect(latexMath(r`A \[ b \( c \) d` + '\n\n' + r`\[e\]`)).toBe(r`A \[ b $c$ d` + '\n\n$$\ne\n$$');
  });

  it('leave text without them as it is, and the $$ formulas as displayMath makes them', () => {
    const text = 'Plain *text* with [a link](https://example.com) and (parentheses).';
    expect(latexMath(text)).toBe(text);
    expect(displayMath('Roots:\n\n$$x = \\frac{1}{2}$$\n\nDone.')).toBe('Roots:\n\n$$\nx = \\frac{1}{2}\n$$\n\nDone.');
    expect(displayMath(r`Then \[x\] and` + '\n\n$$y$$')).toBe('Then\n$$\nx\n$$\nand\n\n$$\ny\n$$');
    const crlf = 'a\r\n```\r\n' + r`\[x\]` + '\r\n```\r\n';
    expect(displayMath(crlf)).toBe(crlf);
  });
});

class FakeSource implements ChatSource {
  events: SourceEvent[] = [];
  subscribe(fn: (ev: SourceEvent) => void) {
    for (const ev of this.events) fn(ev);
    return () => {};
  }
  send = vi.fn(async () => {});
  cancel = vi.fn(async () => {});
  respond = vi.fn(async () => {});
  answer = vi.fn(async () => {});
  setConfig = vi.fn(async () => {});
  cancelQueued = vi.fn(async () => {});
  compact = vi.fn(async () => {});
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

const qa = (sel: string) => Array.from(host.querySelectorAll<HTMLElement>(sel));
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function until(fn: () => unknown) {
  await vi.waitFor(
    async () => {
      await settle();
      expect(fn()).toBeTruthy();
    },
    { timeout: 5000 },
  );
}
/** The TeX a rendered formula was made of. */
const texOf = (el: Element) => el.querySelector('annotation')?.textContent;

describe('the conversation', () => {
  it('shows an agent’s LaTeX delimiters as formulas in messages, plans and question previews', async () => {
    const s = new FakeSource();
    const say = (text: string): ChatEvent => ({
      seq: next(),
      t: 'update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId: 'm1' },
    });
    const message =
      r`For a right triangle \(a^2 + b^2 = c^2\), so
\[
c = \sqrt{a^2 + b^2}
\]
- and in a list: \[ r = 2 \]

Code stays: ` +
      '`' +
      r`\(z\)` +
      '`';
    s.events.push(
      { seq: next(), t: 'state', state: 'working' },
      say(message),
      {
        seq: next(),
        t: 'permission',
        id: 'pl1',
        kind: 'plan',
        toolCall: { toolCallId: 'x', title: 'Plan', kind: 'switch_mode', rawInput: { plan: r`Show that \(p\) holds.` } },
        options: [{ optionId: 'plan:default', name: 'Approve', kind: 'allow_once' }],
      },
      {
        seq: next(),
        t: 'question',
        id: 'q1',
        questions: [{ id: 'f', question: 'Which form?', options: [{ label: 'Closed', preview: r`\[ q = 1 \]` }] }],
      },
    );
    await act(async () => root.render(createElement(Conversation, { source: s, kind: 'claude' })));
    await until(() => qa('.conv-agent .katex').length >= 3);
    expect(qa('.conv-agent .md-math-display').map(texOf)).toEqual([r`c = \sqrt{a^2 + b^2}`, 'r = 2']);
    expect(qa('.conv-agent p .md-math:not(.md-math-display)').map(texOf)).toEqual(['a^2 + b^2 = c^2']);
    expect(qa('.conv-agent li .md-math-display')).toHaveLength(1);
    expect(qa('.conv-agent p code').map((c) => c.textContent)).toContain(r`\(z\)`);
    await until(() => qa('.conv-ask-plan .katex').length === 1);
    expect(qa('.conv-ask-plan .md-math').map(texOf)).toEqual(['p']);
    // A question's preview shows once its option is chosen.
    await act(async () => qa('.conv-ask[data-request="q1"] input')[0].click());
    await until(() => qa('.conv-q-preview .katex').length === 1);
    expect(qa('.conv-q-preview .md-math-display').map(texOf)).toEqual(['q = 1']);
  });
});
