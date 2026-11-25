// Claude Code's transcripts read into events: the shared vectors
// (spec/vectors/transcript, which the Go agent's parser and the web UI's
// tests run too), and the bounds of a read on hostile lines.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SLUG } from '#shared/lib/brand.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { Transcript, TranscriptLimits, noticeMethod, type TranscriptEvent } from '#shared/proto/agentproto/index.ts';
import { MAX_LINE, claudeFrame, eachClaude, type Frame, type Limits, type ReadAt } from './index.ts';

const DIR = join(REPO_ROOT, 'spec/vectors/transcript');

interface Vector {
  note: string;
  kind: string;
  lines: string[];
  unknown: number;
  title?: string;
  events: unknown[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const own = (m: unknown): Obj => obj(obj(obj(m)._meta)[SLUG]);

/** A file in memory. */
const bytes = (b: Uint8Array): ReadAt => ({
  read: async (buf, offset, length, position) => {
    const n = Math.max(0, Math.min(length, b.length - position));
    buf.set(b.subarray(position, position + n), offset);
    return { bytesRead: n };
  },
});

const content = (lines: string[]) => Buffer.from(lines.map((l) => l + '\n').join(''));

/** What a reader of a whole transcript gathers of its Frames: the events
 * in their order (of the usage updates of one message only the last), the
 * lines that could not be read, and the session's title (the user's own
 * before one the agent made, the latest of each). */
async function readAll(data: Uint8Array, lim: Limits = {}): Promise<{ events: TranscriptEvent[]; unknown: number; title: string }> {
  const events: TranscriptEvent[] = [];
  let unknown = 0;
  let title = '';
  let custom = false;
  const usage = new Map<string, number>();
  const dropped = new Set<number>();
  await eachClaude(bytes(data), 0, data.length, lim, (_, f) => {
    unknown += f.unknown;
    if (f.title !== '' && (f.custom || !custom)) [title, custom] = [f.title, f.custom];
    for (const ev of f.events) {
      if (f.message !== '' && obj(ev.update).sessionUpdate === 'usage_update') {
        if (usage.has(f.message)) dropped.add(usage.get(f.message)!);
        usage.set(f.message, events.length);
      }
      events.push(ev);
    }
    return true;
  });
  return { events: events.filter((_, i) => !dropped.has(i)), unknown, title };
}

const plain = (evs: TranscriptEvent[]) => evs.map(({ at: _, ...rest }) => JSON.parse(JSON.stringify(rest)));

describe('vectors', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  test('are there', () => expect(files.length).toBeGreaterThanOrEqual(5));
  for (const file of files) {
    const v = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Vector;
    test(file, async () => {
      expect(v.note).not.toBe('');
      expect(v.kind).toBe('claude');
      const got = await readAll(content(v.lines));
      expect(plain(got.events)).toEqual(v.events);
      expect([got.unknown, got.title]).toEqual([v.unknown, v.title ?? '']);
      // No base64 of an image is forwarded.
      expect(JSON.stringify(got)).not.toMatch(/iVBORw0KGgo|;base64,/);
    });
    // Read from each line's start, and from inside each line, a vector
    // gives the Frames of the lines from there on, the same as each line on
    // its own.
    test(`${file}, from each line`, async () => {
      const data = content(v.lines);
      const offs = [0];
      for (const l of v.lines) offs.push(offs[offs.length - 1] + Buffer.byteLength(l) + 1);
      for (let i = 0; i < v.lines.length; i++) {
        const want = claudeFrame(v.lines[i]);
        for (const [first, from] of [
          [i, offs[i]],
          [i + 1, offs[i] + 1],
        ]) {
          const got: number[] = [];
          await eachClaude(bytes(data), from, data.length, {}, (o, f) => {
            if (got.length === 0 && o === offs[i]) expect(f).toEqual(want);
            got.push(o);
            return true;
          });
          expect(got).toEqual(offs.slice(first, v.lines.length));
        }
      }
    });
  }
});

// Claude Code's lines, as the tests need them.
const userLine = (c: unknown) =>
  JSON.stringify({ type: 'user', timestamp: '2026-11-21T10:00:00.000Z', message: { role: 'user', content: c } });
const textLine = (id: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-21T10:00:01.000Z',
    message: {
      id,
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: 5 },
    },
  });

// A line longer than the limit is skipped with a notice, and reading goes
// on after it; a long line under the limit (a pasted image) is read, its
// image left out.
test('long lines', async () => {
  const long = `{"type":"user","message":{"role":"user","content":"${'a'.repeat(9 << 20)}"}}`;
  const img = 'iVBORw0KGgo'.repeat(300_000);
  const pasted = userLine([
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } },
  ]);
  expect(pasted.length).toBeGreaterThan(3 << 20);
  for (const lines of [
    [userLine('before'), long, pasted],
    [long, userLine('before'), pasted],
    [userLine('before'), pasted, long],
  ]) {
    const p = await readAll(content(lines));
    for (const ev of p.events)
      if (ev.t === Transcript.Notice) expect([ev.method, obj(ev.params).bytes]).toEqual([noticeMethod('skipped'), long.length]);
    expect([p.events.length, p.unknown]).toEqual([5, 0]);
    const b = JSON.stringify(p);
    expect(b).not.toContain('iVBORw0KGgo');
    expect(b.length).toBeLessThan(4096);
  }
});

// Text, tool output and inputs are cut to the limits, at a character's
// start, and marked.
test('truncation', async () => {
  const text = 'é'.repeat(100); // 200 bytes
  const out = 'HEAD' + '-'.repeat(500) + 'TAIL';
  const data = content([
    textLine('msg_1', text),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_2',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/p', content: text } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: out }] },
      toolUseResult: { stdout: out, stderr: '', interrupted: true, isImage: false },
    }),
  ]);
  const p = await readAll(data, { text: 51, toolOutput: 100 });
  expect(p.events.length).toBe(4);
  const msg = obj(p.events[0].update);
  expect(obj(msg.content).text).toBe('é'.repeat(25));
  expect(own(msg).truncated).toBe(true);
  const call = obj(p.events[2].update);
  const input = obj(call.rawInput).content as string;
  expect(Buffer.byteLength(input)).toBe(50);
  expect(own(call).truncated).toBe(true);
  const res = obj(p.events[3].update);
  const s = obj(obj((res.content as unknown[])[0]).content).text as string;
  expect(s.startsWith('HEAD') && s.endsWith('TAIL') && s.includes('…')).toBe(true);
  expect(Buffer.byteLength(s)).toBeLessThanOrEqual(100);
  expect([own(res).truncated, own(res).interrupted]).toEqual([true, true]);
});

// A line makes at most maxLineEvents events; the line counts as unknown
// once when it would make more.
test('the events of a line are bounded', async () => {
  const results = Array.from({ length: 300 }, (_, i) => ({ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }));
  const p = await readAll(content([userLine(results), userLine('after')]));
  expect([p.events.length, p.unknown]).toEqual([TranscriptLimits.maxLineEvents + 2, 1]);
});

// Bytes that are no UTF-8 give valid JSON with valid text.
test('bytes that are no UTF-8', async () => {
  const bad = Buffer.from([0xff, 0xfe, 0x61, 0xc3]);
  const data = Buffer.concat([
    Buffer.from('{"type":"user","message":{"role":"user","content":"x'),
    bad,
    Buffer.from('y"}}\n{"type":"assistant","message":{"id":"m'),
    bad,
    Buffer.from('","role":"assistant","content":[{"type":"text","text":"'),
    bad,
    Buffer.from('"}]}}\n{"type":"user'),
    bad,
    Buffer.from('","message":1}\n'),
    bad,
    Buffer.from('\n'),
  ]);
  const p = await readAll(data);
  expect(p.events.length).toBe(3);
  const s = JSON.stringify(p);
  expect(() => JSON.parse(s)).not.toThrow();
  expect(s).not.toMatch(/[\uD800-\uDFFF]/);
});

/** An attachment line of Claude Code's for a message the user sent while
 * the agent worked; att is merged into its attachment. */
const queuedLine = (prompt: unknown, att: Obj = {}) =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    attachment: {
      type: 'queued_command',
      prompt,
      commandMode: 'prompt',
      origin: { kind: 'human' },
      humanTurn: true,
      timestamp: '2026-11-21T10:00:05.000Z',
      ...att,
    },
    type: 'attachment',
    timestamp: '2026-11-21T10:00:05.000Z',
    rendered: [{ content: '<system-reminder>queued_command</system-reminder>' }],
  });

// A message the user sent while Claude Code worked, recorded as a
// queued_command attachment, is the user's message (no turn's start: it
// joins the running one), with its line's time and the text limit, also
// one of no origin (an SDK client's); one that cannot be read counts as
// unknown, and attachments of other kinds, origins or modes give nothing.
test('queued prompts', async () => {
  const data = content([
    queuedLine('while you work'),
    queuedLine('x'.repeat(300)),
    queuedLine([{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgo' } }, { type: 'document' }]),
    queuedLine(42),
    queuedLine([1, { type: 'text', text: 'b' }]),
    queuedLine('flagged', { isMeta: true }),
    queuedLine('peer', { origin: { kind: 'peer' } }),
    queuedLine('no origin', { origin: null }),
    queuedLine('bash', { commandMode: 'bash' }),
    queuedLine('   '),
    // "queued_command" in another attachment's text, and an attachment of
    // no object.
    JSON.stringify({ type: 'attachment', attachment: { type: 'edited_text_file', snippet: 'the "queued_command" kind' } }),
    '{"type":"attachment","attachment":"queued_command"}',
  ]);
  const p = await readAll(data, { text: 100 });
  const got: string[] = [];
  for (const ev of p.events) {
    expect(ev.t).toBe(Transcript.User);
    expect(ev.at).toBe('2026-11-21T10:00:05Z');
    got.push(
      (ev.content as Obj[])
        .map((b) => (own(b).image ? '<image>' : `${Buffer.byteLength(b.text as string)}:${own(b).truncated === true}`))
        .join(','),
    );
  }
  expect(got).toEqual(['14:false', '100:true', '1:false,<image>', '1:false', '9:false']);
  // The document block, the prompt of a number, the block of a number.
  expect(p.unknown).toBe(3);
  expect(JSON.stringify(p)).not.toContain('iVBORw0KGgo');
});

// A line's Frame: its events, the block each was made of, the message and
// the index of its first block.
test('a line’s frame', () => {
  const line = JSON.stringify({
    type: 'assistant',
    apiBlockIndex: 2,
    message: {
      id: 'msg_1',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'done' },
      ],
    },
  });
  const f = claudeFrame(line);
  expect([f.message, f.first, f.count, f.events.length, f.blocks]).toEqual(['msg_1', 2, 2, 3, [0, 1, -1]]);
  expect([f.events[2].t, f.events[2].stopReason]).toEqual([Transcript.Turn, 'end_turn']);
  // The SDK protocol's frames: no apiBlockIndex, the tool's result as
  // tool_use_result; a response still running ends no turn.
  const sdk = claudeFrame(
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'msg_2',
        stop_reason: null,
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/p/a.go', old_string: 'a', new_string: 'b' } }],
      },
    }),
  );
  expect([sdk.first, sdk.events.length]).toEqual([-1, 1]);
  const u = obj(sdk.events[0].update);
  expect([u.sessionUpdate, (u.content as Obj[]).length, (u.content as Obj[])[0].type, (u.content as Obj[])[0].oldText]).toEqual([
    'tool_call',
    1,
    'diff',
    'a',
  ]);
  const res = claudeFrame(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: '[Subagent hand-back] preamble' }] },
      tool_use_result: { agentId: 'a1', status: 'completed', content: [{ type: 'text', text: 'the report' }] },
    }),
  );
  expect(res.events.length).toBe(1);
  const r = JSON.stringify(res.events[0].update);
  expect([r.includes('the report'), r.includes('preamble'), obj(res.events[0].update).status]).toEqual([true, false, 'completed']);
  const long = claudeFrame(new Uint8Array(MAX_LINE + 1).fill(0x78));
  expect([long.events.length, long.events[0].method]).toEqual([1, noticeMethod('skipped')]);
  const bad = claudeFrame('{"no":"type"}');
  expect([bad.unknown, bad.events.length]).toEqual([1, 0]);
});

// eachClaude reads every complete line from a line's start at or after
// from, until fn stops it or its signal ends.
test('reading forward', async () => {
  const data = Buffer.concat([content([userLine('one'), textLine('msg_1', 'a'), userLine('two')]), Buffer.from('{"type":"user"')]);
  const offs: number[] = [];
  let users = 0;
  await eachClaude(bytes(data), 0, data.length, {}, (o, f) => {
    offs.push(o);
    users += f.events.filter((e) => e.t === Transcript.User).length;
    return true;
  });
  expect([offs.length, users]).toEqual([3, 2]);
  const from: number[] = [];
  await eachClaude(bytes(data), 3, data.length, {}, (o) => (from.push(o), true));
  expect(from).toEqual(offs.slice(1));
  let n = 0;
  await eachClaude(bytes(data), 0, data.length, {}, () => (n++, false));
  expect(n).toBe(1);
  const ac = new AbortController();
  ac.abort();
  await expect(eachClaude(bytes(data), 0, data.length, {}, () => true, ac.signal)).rejects.toThrow();
});

/** A file of size bytes of zeros (no newline), but for head at its start
 * and tail at its end: one long line between them, without taking any
 * memory; counts what was read. */
function sparse(size: number, head: Buffer, tail: Buffer, onRead?: (n: number) => void): ReadAt {
  return {
    read: async (buf, offset, length, position) => {
      const n = Math.max(0, Math.min(length, size - position));
      buf.fill(0, offset, offset + n);
      for (let i = 0; i < n; i++) {
        const p = position + i;
        if (p < head.length) buf[offset + i] = head[p];
        else if (p >= size - tail.length) buf[offset + i] = tail[p - (size - tail.length)];
      }
      onRead?.(n);
      return { bytesRead: n };
    },
  };
}

// A transcript with a line of several times MAX_LINE gives the lines
// around it and the line's notice once, at the line's start; read from
// inside the line, the lines after it and no notice.
test('walking past a long line', async () => {
  const a = userLine('before');
  const b = userLine('after');
  const size = 3 * MAX_LINE;
  const f = sparse(size, Buffer.from(a + '\n'), Buffer.from('\n' + b + '\n'));
  const offs: number[] = [];
  let evs: TranscriptEvent[] = [];
  const skipped = (e: TranscriptEvent[]) => e.filter((x) => x.method === noticeMethod('skipped')).length;
  await eachClaude(f, 0, size, {}, (o, fr: Frame) => {
    offs.push(o);
    evs.push(...fr.events);
    return true;
  });
  const s = JSON.stringify(evs);
  expect([skipped(evs), evs.length, s.includes('before'), s.includes('after')]).toEqual([1, 5, true, true]);
  expect(offs).toEqual([0, a.length + 1, size - (b.length + 1)]);
  evs = [];
  await eachClaude(f, offs[1] + MAX_LINE, size, {}, (_, fr) => (evs.push(...fr.events), true));
  expect([evs.length, skipped(evs)]).toEqual([2, 0]);
}, 60_000);

// A read ends with its signal, within a block of reading.
test('a read that is cancelled', async () => {
  const size = 8 * 1024 * MAX_LINE;
  const ac = new AbortController();
  let read = 0;
  const f = sparse(size, Buffer.alloc(0), Buffer.alloc(0), (n) => {
    read += n;
    if (read > 1 << 20) ac.abort();
  });
  await expect(eachClaude(f, 0, size, {}, () => true, ac.signal)).rejects.toThrow();
  expect(read).toBeLessThanOrEqual((1 << 20) + MAX_LINE + 1);
});

/** head, elem repeated (comma-separated) to a line of about size bytes,
 * and tail. */
function repeated(head: string, elem: string, tail: string, size: number): string {
  const n = Math.max(0, Math.floor((size - head.length - tail.length) / (elem.length + 1)));
  return head + Array(n).fill(elem).join(',') + tail;
}

// Any one line just under MAX_LINE whose values are many small ones is
// read within its bounds: at most MAX_BLOCKS blocks and 32768 decoded
// values (the rest left out and marked), never decoded whole.
describe('a line of many small values', () => {
  const size = MAX_LINE - 64;
  for (const [name, line] of [
    ['text blocks', repeated('{"type":"assistant","message":{"id":"m","model":"x","content":[', '{"type":"text"}', ']}}', size)],
    [
      'tool input',
      repeated(
        '{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"X","input":{"a":[',
        '{"k":{}}',
        ']}}]}}',
        size,
      ),
    ],
    [
      'tool input keys',
      repeated(
        '{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"X","input":{',
        '"k":0',
        '}}]}}',
        size,
      ),
    ],
    [
      'todos',
      repeated(
        '{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"TodoWrite","input":{"todos":[',
        '{}',
        ']}}]}}',
        size,
      ),
    ],
    [
      'tool results',
      repeated('{"type":"user","message":{"content":[', '{"type":"tool_result","tool_use_id":"t","content":"x"}', ']}}', size),
    ],
    [
      'result blocks',
      repeated(
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":[',
        '{"type":"text","text":"a"}',
        ']}]}}',
        size,
      ),
    ],
    ['prompt blocks', repeated('{"type":"user","message":{"content":[', '{"type":"text","text":"a"}', ']}}', size)],
    [
      'result keys',
      repeated(
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"toolUseResult":{',
        '"k":{}',
        '}}',
        size,
      ),
    ],
    [
      'edits',
      repeated(
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"toolUseResult":{"filePath":"/p","edits":[',
        '{}',
        ']}}',
        size,
      ),
    ],
  ] as const)
    test(name, () => {
      const t = performance.now();
      const f = claudeFrame(line);
      expect(f.events.length).toBeLessThanOrEqual(TranscriptLimits.maxLineEvents);
      expect(performance.now() - t).toBeLessThan(10_000);
      if (name === 'tool input') {
        const u = obj(f.events[0].update);
        expect(own(u).truncated).toBe(true);
        expect(JSON.stringify(u.rawInput).length).toBeLessThan(1 << 20);
      }
    });
});
