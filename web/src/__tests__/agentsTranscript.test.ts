// @vitest-environment jsdom
//
// The agents plugin's transcripts (plugins/agents/transcript.ts): one read
// in flight per machine for every session the page shows, first reads back
// from the end and answered at once, then forward reads from the cursor
// each reply gives, waiting on the machine; a feed that starts over when
// its file changes, from the new file's end; reads given up when the
// sessions shown change, none while nothing is shown or the page is
// hidden, waits that grow after failures and end when the machine or the
// page is back, and a first page that does not come leaving the terminal
// shown. The source's messages are typed into the terminal as a paste and
// an Enter, only while the terminal runs the session's agent and it does
// not wait for an answer, and confirmed by the transcript.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { APP_SLUG } from '../brand';
import { NOTICES, type ChatEvent, type SourceEvent } from '../conversation/model';
import { registerPane, type PaneHandle } from '../state/panes';
import { useStore } from '../state/store';
import { useTerms } from '../state/terms';
import {
  CONFIRM_MS,
  ENTER_DELAY_MS,
  feedFor,
  feedStatus,
  FIRST_PAGE_MS,
  hold,
  MAX_TEXT_BYTES,
  resetFeeds,
  RETRY_MAX_MS,
  SendError,
  sourceOf,
  TranscriptSource,
  WAIT_MS,
} from '../plugins/agents/transcript';
import { FakeCore } from './fakeTerms';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

/** A read the page made, answered by the test. */
interface Read {
  refs: string[];
  wait: number;
  machine: string;
  aborted: boolean;
  settled: boolean;
  answer(body: unknown, status?: number): void;
}

let reads: Read[];
const open = () => reads.filter((r) => !r.settled && !r.aborted);

function fakeFetch() {
  reads = [];
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://core');
    return new Promise<Response>((resolve, reject) => {
      const r: Read = {
        refs: url.searchParams.getAll('s'),
        wait: Number(url.searchParams.get('wait')),
        machine: decodeURIComponent(url.pathname.split('/')[3]),
        aborted: false,
        settled: false,
        answer(body, status = 200) {
          r.settled = true;
          resolve(new Response(JSON.stringify(body), { status }));
        },
      };
      init?.signal?.addEventListener('abort', () => {
        r.aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
      reads.push(r);
    });
  });
}

const text = (s: string) => ({ type: 'text' as const, text: s });
const say = (seq: number, s: string): ChatEvent => ({
  seq,
  t: 'update',
  update: { sessionUpdate: 'agent_message_chunk', content: text(s) },
});
const prompt = (seq: number, s: string): ChatEvent => ({ seq, t: 'user', content: [text(s)] });
const tail = (session: string, o: Record<string, unknown> = {}) => ({ kind: 'claude', session, file: 'f1', first: 0, next: 0, ...o });

/** Lets microtasks, the fake fetch and what follows a reply run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
};

/** What a source gave its subscriber. */
function listen(source: TranscriptSource): SourceEvent[] {
  const got: SourceEvent[] = [];
  source.subscribe((ev) => got.push(ev));
  return got;
}

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.useFakeTimers();
  fakeFetch();
  resetFeeds();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  useStore.getState().setReadOnly(false);
  useTerms.setState({
    connected: true,
    machines: {
      a: { terminals: { t1: { address: 't1', state: 'live', agent: 'claude', agent_status: 'idle' } } },
    },
  });
});
afterEach(() => {
  resetFeeds();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reading transcripts', () => {
  it('reads every session a machine shows in one read at a time: first back from the end at once, then forward', async () => {
    const off1 = hold(feedFor('a', 'claude', S1));
    const off2 = hold(feedFor('a', 'claude', S2));
    const offB = hold(feedFor('b', 'codex', S1));
    await flush();
    // One read per machine, the sessions of both panes of a together.
    expect(reads).toHaveLength(2);
    const a = reads.find((r) => r.machine === 'a')!;
    expect(a.refs).toEqual([`claude~${S1}~0~b`, `claude~${S2}~0~b`]);
    expect(a.wait).toBe(0);
    expect(reads.find((r) => r.machine === 'b')!.refs).toEqual([`codex~${S1}~0~b`]);
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'loading' });

    a.answer({ tails: [tail(S1, { first: 256, next: 5120, events: [say(256, 'hi')], more: true }), tail(S2, { first: 0, next: 0 })] });
    await flush();
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'ok' });
    // The next read goes on from the cursors given, waiting on the machine.
    const next = open().filter((r) => r.machine === 'a');
    expect(next).toHaveLength(1);
    expect(next[0].refs).toEqual([`claude~${S1}~5120`, `claude~${S2}~0`]);
    expect(next[0].wait).toBe(WAIT_MS);

    next[0].answer({ tails: [tail(S1, { first: 5120, next: 9000, events: [say(5120, 'more')] }), tail(S2, { first: 0, next: 0 })] });
    await flush();
    expect(open().filter((r) => r.machine === 'a')[0].refs).toEqual([`claude~${S1}~9000`, `claude~${S2}~0`]);
    off1();
    off2();
    offB();
  });

  it('gives a source the events read, earlier ones on request, and starts over when the file changes', async () => {
    const feed = feedFor('a', 'claude', S1);
    const off = hold(feed);
    const source = new TranscriptSource(feed, 'a', 't1');
    await flush();
    reads[0].answer({ tails: [tail(S1, { first: 512, next: 2048, more: true, events: [say(512, 'one'), say(768, 'two')] })] });
    await flush();
    // A view that subscribes later gets what was read.
    const got = listen(source);
    expect(got.map((e) => (e as ChatEvent).seq)).toEqual([512, 768]);
    expect(source.loadEarlier).toBeDefined();

    // Earlier events: a back read before the first one, beside the long poll.
    const earlier = source.loadEarlier!();
    await flush();
    const back = open().find((r) => r.refs[0].endsWith('~b'))!;
    expect(back.refs).toEqual([`claude~${S1}~512~b`]);
    expect(back.wait).toBe(0);
    back.answer({ tails: [tail(S1, { first: 0, next: 512, more: false, events: [say(0, 'zero')] })] });
    await expect(earlier).resolves.toBe(false);
    expect(got.map((e) => (e as ChatEvent).seq)).toEqual([512, 768, 0]);
    expect(source.loadEarlier).toBeUndefined();

    // Another file answers the forward read: what it gave starts where the
    // old cursor fell, so the views start over with the new file's last page.
    const poll = open().find((r) => !r.refs[0].endsWith('~b'))!;
    expect(poll.refs).toEqual([`claude~${S1}~2048`]);
    poll.answer({ tails: [tail(S1, { file: 'f2', first: 2048, next: 4096, events: [say(2048, 'middle of the new file')] })] });
    await flush();
    expect(got.slice(3)).toEqual([{ t: 'reset' }]);
    expect(source.loadEarlier).toBeUndefined();
    expect(open()[0].refs).toEqual([`claude~${S1}~0~b`]);
    expect(open()[0].wait).toBe(0);
    open()[0].answer({ tails: [tail(S1, { file: 'f2', first: 256, next: 1024, more: true, events: [say(256, 'new')] })] });
    await flush();
    expect(got.slice(4)).toEqual([say(256, 'new')]);
    expect(source.loadEarlier).toBeDefined();
    expect(open()[0].refs).toEqual([`claude~${S1}~1024`]);
    // A forward cursor the file no longer has is answered as a first read: also a start over.
    open()[0].answer({ tails: [tail(S1, { file: 'f2', first: 0, next: 512, events: [say(0, 'shorter')] })] });
    await flush();
    expect(got.slice(5)).toEqual([{ t: 'reset' }, say(0, 'shorter')]);
    off();
  });

  it('keeps one source for each terminal that shows a session', () => {
    const feed = feedFor('a', 'claude', S1);
    expect(sourceOf(feed, 't1')).toBe(sourceOf(feed, 't1'));
    expect(sourceOf(feed, 't1')).not.toBe(sourceOf(feed, 't2'));
    expect(sourceOf(feed, 't2').terminal).toBe('t2');
  });

  it('says why there is nothing to show, and waits on the machine for a transcript to appear', async () => {
    const off = hold(feedFor('a', 'claude', S1));
    const offC = hold(feedFor('a', 'claude', S2));
    await flush();
    reads[0].answer({ tails: [tail(S1, { code: 'not_found' }), tail(S2, { code: 'compressed' })] });
    await flush();
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'not_found' });
    expect(feedStatus('a', 'claude', S2)).toEqual({ state: 'compressed' });
    // A compressed transcript is not read again; one not found is, from its
    // start, with the long wait (the machine looks for it meanwhile).
    expect(open()[0].refs).toEqual([`claude~${S1}~0~b`]);
    expect(open()[0].wait).toBe(WAIT_MS);
    open()[0].answer({ tails: [tail(S1, { next: 256, events: [prompt(0, 'first')] })] });
    await flush();
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'ok' });
    off();
    offC();
  });

  it('gives up the read when the sessions shown change, and reads nothing once none is shown', async () => {
    const off1 = hold(feedFor('a', 'claude', S1));
    await flush();
    reads[0].answer({ tails: [tail(S1, { next: 256 })] });
    await flush();
    const long = open()[0];
    expect(long.wait).toBe(WAIT_MS);
    // A second pane shows another session: the read in flight is given up for one with both.
    const off2 = hold(feedFor('a', 'claude', S2));
    await flush();
    expect(long.aborted).toBe(true);
    expect(open()).toHaveLength(1);
    expect(open()[0].refs).toEqual([`claude~${S1}~256`, `claude~${S2}~0~b`]);
    expect(open()[0].wait).toBe(0);
    // The last surface unmounts: nothing in flight, nothing next.
    off1();
    off2();
    await flush();
    expect(open()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(open()).toEqual([]);
  });

  it('pauses while the page is hidden', async () => {
    const off = hold(feedFor('a', 'claude', S1));
    await flush();
    reads[0].answer({ tails: [tail(S1, { next: 256 })] });
    await flush();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    open()[0].answer({ tails: [tail(S1, { next: 256 })] });
    await flush();
    expect(open()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(open()).toEqual([]);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(open()).toHaveLength(1);
    expect(open()[0].refs).toEqual([`claude~${S1}~256`]);
    off();
  });

  it('waits longer after each failure, up to its limit, and keeps what it showed', async () => {
    const off = hold(feedFor('a', 'claude', S1));
    await flush();
    reads[0].answer({ error: 'offline' }, 409);
    await flush();
    // Nothing read yet: the surface says so (and shows the terminal).
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'error' });
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = reads.length;
      let waited = 0;
      while (reads.length === before && waited < 60_000) {
        await vi.advanceTimersByTimeAsync(250);
        waited += 250;
      }
      waits.push(waited);
      open()[0].answer({ error: 'offline' }, 409);
      await flush();
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, RETRY_MAX_MS, RETRY_MAX_MS]);
    // Read again: the next read comes at once.
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    open()[0].answer({ tails: [tail(S1, { next: 256, events: [say(0, 'hi')] })] });
    await flush();
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'ok' });
    expect(open()).toHaveLength(1);
    // A failure after that leaves the conversation shown, marked not current.
    open()[0].answer({}, 502);
    await flush();
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'ok', stale: true });
    off();
  });

  it('shows the terminal when the first page does not come, reading on', async () => {
    const off = hold(feedFor('a', 'claude', S1));
    await flush();
    // The machine is busy: twice is not enough to give up.
    reads[0].answer({ error: 'busy' }, 429);
    await flush();
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'loading' });
    await vi.advanceTimersByTimeAsync(1000);
    open()[0].answer({ error: 'busy' }, 429);
    await flush();
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'loading' });
    await vi.advanceTimersByTimeAsync(2000);
    open()[0].answer({ error: 'busy' }, 429);
    await flush();
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'error' });
    // Still read: the conversation once it can be.
    await vi.advanceTimersByTimeAsync(4000);
    open()[0].answer({ tails: [tail(S1, { next: 256, events: [say(0, 'hi')] })] });
    await flush();
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'ok' });
    off();

    // A first read that is not answered at all.
    const off2 = hold(feedFor('a', 'claude', S2));
    await flush();
    await vi.advanceTimersByTimeAsync(FIRST_PAGE_MS - 1);
    expect(feedStatus('a', 'claude', S2)).toEqual({ state: 'loading' });
    await vi.advanceTimersByTimeAsync(1);
    expect(feedStatus('a', 'claude', S2)).toEqual({ state: 'error' });
    off2();
  });

  it('reads at once after failures when the page is shown again or the machine is back', async () => {
    const core = new FakeCore();
    core.machine('a', [FakeCore.term('t1', { agent: 'claude', agent_status: 'idle' })]);
    core.install();
    core.model.subscribe('a');
    await flush();
    const off = hold(feedFor('a', 'claude', S1));
    await flush();
    reads[0].answer({ tails: [tail(S1, { next: 256 })] });
    await flush();
    // Failures: the next read waits 1, 2, 4, 8 s.
    for (const wait of [1000, 2000, 4000]) {
      open()[0].answer({}, 502);
      await flush();
      await vi.advanceTimersByTimeAsync(wait);
    }
    open()[0].answer({}, 502);
    await flush();
    expect(open()).toEqual([]);
    // The machine's terminals come again (it was away): read now.
    core.push({ t: 'snapshot', m: 'a', terminals: core.machines.get('a')!.terminals });
    await flush();
    expect(open()).toHaveLength(1);
    expect(open()[0].refs).toEqual([`claude~${S1}~256`]);
    // And the waits start over from the shortest.
    open()[0].answer({}, 502);
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(open()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(open()).toHaveLength(1);
    // Shown again after a failure: read now too.
    open()[0].answer({}, 502);
    await flush();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(open()).toHaveLength(1);
    off();
  });

  it('times out a read the machine does not answer', async () => {
    const off = hold(feedFor('a', 'claude', S1));
    await flush();
    reads[0].answer({ tails: [tail(S1, { next: 256 })] });
    await flush();
    const long = open()[0];
    await vi.advanceTimersByTimeAsync(WAIT_MS + 10_000);
    expect(long.aborted).toBe(true);
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'ok', stale: true });
    off();
  });

  it('treats cursors as the numbers they are, also above 32 bits', async () => {
    const off = hold(feedFor('a', 'claude', S1));
    await flush();
    const big = 2 ** 40 + 256;
    reads[0].answer({ tails: [tail(S1, { first: big, next: big + 512, events: [say(big, 'far')] })] });
    await flush();
    expect(open()[0].refs).toEqual([`claude~${S1}~${big + 512}`]);
    off();
  });

  it('does not ask again at once for a reply it cannot take', async () => {
    const off = hold(feedFor('a', 'claude', S1));
    await flush();
    // Another session's part, then one without its cursors.
    reads[0].answer({ tails: [tail(S2, { next: 256 })] });
    await flush();
    expect(open()).toEqual([]);
    expect(feedStatus('a', 'claude', S1)).toEqual({ state: 'error' });
    await vi.advanceTimersByTimeAsync(1000);
    open()[0].answer({ tails: [{ kind: 'claude', session: S1 }] });
    await flush();
    expect(open()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(open()).toHaveLength(1);
    off();
  });

  it('keeps a few sessions no surface shows, for a pane shown again', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const kept = hold(feedFor('a', 'claude', ids[0]));
    for (const id of ids.slice(1)) hold(feedFor('a', 'claude', id))();
    await flush();
    // The one shown and the newest eight let go of.
    const known = ids.filter((id) => feedStatus('a', 'claude', id));
    expect(known).toEqual([ids[0], ...ids.slice(3)]);
    kept();
  });
});

describe('a message from the composer', () => {
  /** The terminal t1 on screen, recording what is pasted and typed. */
  function terminal() {
    const got: string[] = [];
    const h: PaneHandle = {
      focus: () => {},
      type: (s) => got.push(`type:${s}`),
      paste: (s) => got.push(`paste:${s}`),
      openFind: () => {},
      screenText: () => '',
    };
    return { got, off: registerPane('a', 't1', h) };
  }

  /** A source of t1's session whose first page was read. */
  async function shown() {
    const feed = feedFor('a', 'claude', S1);
    const off = hold(feed);
    await flush();
    reads[0].answer({ tails: [tail(S1, { next: 1024, events: [say(512, 'ready')] })] });
    await flush();
    return { source: new TranscriptSource(feed, 'a', 't1'), off };
  }

  it('is pasted, then sent with Enter after a pause, and done once the transcript has it', async () => {
    const t = terminal();
    const { source, off } = await shown();
    let done = false;
    const sent = source.send([text('two\nlines  ')]).then(() => (done = true));
    // One paste of both lines, without the white space after them: no Enter yet.
    expect(t.got).toEqual(['paste:two\nlines']);
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS - 1);
    expect(t.got).toEqual(['paste:two\nlines']);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.got).toEqual(['paste:two\nlines', 'type:\r']);
    await flush();
    expect(done).toBe(false);
    // An earlier prompt of the same text does not count; the new one does.
    open()[0].answer({ tails: [tail(S1, { first: 1024, next: 2048, events: [prompt(1024, 'two\nlines')] })] });
    await flush();
    await sent;
    expect(done).toBe(true);
    t.off();
    off();
  });

  it('fails when the transcript does not have it in time', async () => {
    const t = terminal();
    const { source, off } = await shown();
    const sent = source.send([text('hello')]);
    const failed = expect(sent).rejects.toEqual(new SendError('unconfirmed'));
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS);
    // Another prompt arrives: not this one.
    open()[0].answer({ tails: [tail(S1, { first: 1024, next: 2048, events: [prompt(1024, 'something else')] })] });
    await flush();
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    await failed;
    t.off();
    off();
  });

  it('is confirmed for a command by the first command notice after it', async () => {
    const t = terminal();
    const { source, off } = await shown();
    const command = (seq: number, name: string, args?: string): ChatEvent => ({
      seq,
      t: 'notice',
      method: NOTICES.command,
      params: { name, args },
    });
    let compacted = false;
    const sent = source.send([text('/compact')]).then(() => (compacted = true));
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS);
    expect(t.got).toEqual(['paste:/compact', 'type:\r']);
    open()[0].answer({ tails: [tail(S1, { first: 1024, next: 2048, events: [command(1024, '/compact')] })] });
    await flush();
    await sent;
    expect(compacted).toBe(true);
    // A shell command (!), and a prompt a command's notice does not confirm.
    let ran = false;
    const shell = source.send([text('  !ls -la')]).then(() => (ran = true));
    let said = false;
    const prose = source.send([text('hello')]).then(
      () => (said = true),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS);
    open()[0].answer({ tails: [tail(S1, { first: 2048, next: 3072, events: [command(2048, '!', 'ls -la')] })] });
    await flush();
    await shell;
    expect(ran).toBe(true);
    expect(said).toBe(false);
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    await prose;
    t.off();
    off();
  });

  it('is confirmed by the start of a prompt too long for the transcript to keep', async () => {
    const t = terminal();
    const { source, off } = await shown();
    const long = `start of it\r\n${'word '.repeat(MAX_TEXT_BYTES / 4)}end`;
    let done = false;
    const sent = source.send([text(long)]).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS);
    // The transcript keeps its first MAX_TEXT_BYTES, marked as cut.
    const kept = { ...text(long.replace(/\r\n/g, '\n').slice(0, MAX_TEXT_BYTES)), _meta: { [APP_SLUG]: { truncated: true } } };
    open()[0].answer({ tails: [tail(S1, { first: 1024, next: 2048, events: [{ seq: 1024, t: 'user', content: [kept] }] })] });
    await flush();
    await sent;
    expect(done).toBe(true);
    t.off();
    off();
  });

  it('is pasted but not sent with Enter when the agent began to wait, left, or its pane went during the pause', async () => {
    const t = terminal();
    const { source, off } = await shown();
    const record = (o: Record<string, unknown>) =>
      useTerms.setState({
        machines: { a: { terminals: { t1: { address: 't1', state: 'live', agent: 'claude', agent_status: 'idle', ...o } } } },
      });
    // The agent asks for a permission meanwhile: Enter would give its default answer.
    const blocked = expect(source.send([text('do it')])).rejects.toEqual(new SendError('pasted'));
    record({ agent_status: 'blocked' });
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS);
    await blocked;
    expect(t.got).toEqual(['paste:do it']);
    // The agent exits meanwhile: Enter would run the text in the shell.
    record({});
    const gone = expect(source.send([text('rm -rf build')])).rejects.toEqual(new SendError('pasted'));
    record({ agent: undefined, agent_status: undefined });
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS);
    await gone;
    expect(t.got).toEqual(['paste:do it', 'paste:rm -rf build']);
    // The pane goes meanwhile.
    record({});
    const unmounted = expect(source.send([text('later')])).rejects.toEqual(new SendError('pasted'));
    t.off();
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS);
    await unmounted;
    expect(t.got).toEqual(['paste:do it', 'paste:rm -rf build', 'paste:later']);
    // Nothing waits to be confirmed.
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    off();
  });

  it('is refused before it is pasted when the terminal does not run the session’s agent', async () => {
    const t = terminal();
    const { source, off } = await shown();
    for (const r of [
      { address: 't1', state: 'live' },
      { address: 't1', state: 'live', agent: 'codex', agent_status: 'idle' },
      { address: 't1', state: 'exited', agent: 'claude', agent_status: 'idle' },
    ]) {
      useTerms.setState({ machines: { a: { terminals: { t1: r } } } } as never);
      await expect(source.send([text('hi')])).rejects.toEqual(new SendError('detached'));
    }
    useTerms.setState({ machines: { a: { terminals: {} } } });
    await expect(source.send([text('hi')])).rejects.toEqual(new SendError('detached'));
    expect(t.got).toEqual([]);
    t.off();
    off();
  });

  it('is refused at once while the agent waits for an answer, on a read-only page, and without its terminal', async () => {
    const { source, off } = await shown();
    // No terminal on screen.
    await expect(source.send([text('hi')])).rejects.toEqual(new SendError('detached'));
    const t = terminal();
    useTerms.setState({
      machines: { a: { terminals: { t1: { address: 't1', state: 'live', agent: 'claude', agent_status: 'blocked' } } } },
    });
    await expect(source.send([text('hi')])).rejects.toEqual(new SendError('blocked'));
    useTerms.setState({
      machines: { a: { terminals: { t1: { address: 't1', state: 'live', agent: 'claude', agent_status: 'idle' } } } },
    });
    useStore.getState().setReadOnly(true);
    expect(source.capabilities.input).toBe('none');
    await expect(source.send([text('hi')])).rejects.toEqual(new SendError('read_only'));
    expect(t.got).toEqual([]);
    useStore.getState().setReadOnly(false);
    expect(source.capabilities).toEqual({ input: 'terminal', permissions: false, streaming: false });
    t.off();
    off();
  });

  it('stops the agent’s turn with Escape', async () => {
    const t = terminal();
    const { source, off } = await shown();
    source.cancel();
    expect(t.got).toEqual(['type:\x1b']);
    useStore.getState().setReadOnly(true);
    source.cancel();
    expect(t.got).toEqual(['type:\x1b']);
    t.off();
    off();
  });
});
