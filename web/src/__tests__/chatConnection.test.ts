// The chat plugin's WebSocket (plugins/chat/connection.ts) and the chat
// source on it (plugins/chat/source.ts): subscriptions multiplexed on one
// connection that opens with the first and closes when idle, commands
// answered by their acks, the bounds, what the hub sends checked, the
// connection coming back (attaching again after the last stored seq, a
// reattach before the replay), and the source's events (info first, the
// same for a subscriber that comes later), its commands, its end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import { ACK_TIMEOUT_MS, CommandError, IDLE_CLOSE_MS, RETRY_MIN_MS, type SubHandler } from '../plugins/chat/connection';
import { ChatSourceImpl, dropSources, holdSource, KEEP_MS } from '../plugins/chat/source';
import { liveKey, resetChats, useChats } from '../plugins/chat/state';
import { MAX_CLIENT_MESSAGE, MAX_SUBS, MAX_SUBS_PER_MACHINE } from '../plugins/chat/protocol';
import type { ChatEvent, SourceEvent } from '../conversation/model';
import { useStore } from '../state/store';
import { FakeChatHub } from './chatFake';

const A = 'c0000000000000001';
const B = 'c0000000000000002';
const chatId = (n: number) => `c${n.toString(16).padStart(16, '0')}`;

let hub: FakeChatHub;
beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  hub = new FakeChatHub();
  hub.install();
  useStore.getState().setReadOnly(false);
  resetChats();
});
afterEach(() => {
  dropSources();
  hub.conn.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function handler(from = 0) {
  const h = {
    seq: from,
    log: [] as unknown[][],
    from: () => h.seq,
    attached: vi.fn((chat: Record<string, unknown>, first: number | undefined, again: boolean) =>
      h.log.push(['attached', chat.id, first, again]),
    ),
    event: vi.fn((ev: ChatEvent) => {
      h.log.push(['event', ev.seq ?? ev.t]);
      if (typeof ev.seq === 'number') h.seq = ev.seq;
    }),
    detached: vi.fn((e: { code: string }) => h.log.push(['detached', e.code])),
    offline: vi.fn(() => h.log.push(['offline'])),
  };
  return h satisfies SubHandler;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the chat connection', () => {
  it('opens with the first subscription and multiplexes chats on it', async () => {
    expect(hub.sockets).toHaveLength(0);
    const a = handler();
    const b = handler(7);
    const sa = hub.conn.attach('m', A, a);
    hub.conn.attach('n', B, b);
    expect(hub.sockets).toHaveLength(1);
    expect(hub.sent).toEqual([]);
    hub.open();
    expect(hub.ops('attach')).toEqual([
      { op: 'attach', sub: sa.id, m: 'm', chat: A },
      { op: 'attach', sub: expect.any(String), m: 'n', chat: B, from: 7 },
    ]);
    const [, sb] = hub.ops('attach').map((m) => m.sub);
    hub.push({ t: 'attached', sub: sa.id, chat: { id: A }, first: 3 });
    hub.push({ t: 'event', sub: sa.id, ev: { seq: 4, t: 'turn', state: 'start' } });
    hub.push({ t: 'event', sub: sb, ev: { seq: 9, t: 'turn', state: 'start' } }); // before its attached: passed over
    hub.push({ t: 'attached', sub: sb, chat: { id: B } });
    hub.push({ t: 'event', sub: sb, ev: { seq: 10, t: 'user' } });
    expect(a.log).toEqual([
      ['attached', A, 3, false],
      ['event', 4],
    ]);
    expect(b.log).toEqual([
      ['attached', B, undefined, false],
      ['event', 10],
    ]);
    sa.detach();
    expect(hub.ops('detach')).toEqual([{ op: 'detach', sub: sa.id }]);
    hub.push({ t: 'event', sub: sa.id, ev: { seq: 5, t: 'user' } });
    expect(a.log).toHaveLength(2);
    hub.push({ t: 'detached', sub: sb, error: { code: 'offline', message: 'the machine left' } });
    expect(b.log.at(-1)).toEqual(['detached', 'offline']);
  });

  it('passes over what is no message of the protocol', async () => {
    const a = handler();
    const sa = hub.conn.attach('m', A, a);
    hub.open();
    for (const bad of ['not json', '[1]', 'null', '{"t":"nothing"}', { t: 'event', sub: 'other', ev: { t: 'user' } }]) hub.push(bad);
    hub.push({ t: 'attached', sub: sa.id, chat: 'no object', first: -1 });
    hub.push({ t: 'event', sub: sa.id, ev: 'text' });
    hub.push({ t: 'event', sub: sa.id, ev: { seq: 1 } });
    hub.push({ t: 'ack', id: 'k999' });
    expect(a.log).toEqual([['attached', undefined, undefined, false]]);
  });

  it('answers commands with their acks, and refuses what it cannot send', async () => {
    hub.open();
    const sa = hub.conn.attach('m', A, handler());
    hub.open();
    hub.push({ t: 'attached', sub: sa.id, chat: { id: A } });
    const ok = hub.conn.command('m', A, { op: 'cancel' });
    const refused = hub.conn.command('m', A, { op: 'compact' });
    const [c1, c2] = hub.ops('command');
    expect(c1).toEqual({ op: 'command', id: expect.any(String), m: 'm', chat: A, cmd: { op: 'cancel' } });
    hub.push({ t: 'ack', id: c2.id, error: { code: 'unsupported', message: 'no compact' } });
    hub.push({ t: 'ack', id: c1.id });
    await expect(ok).resolves.toBeUndefined();
    await expect(refused).rejects.toMatchObject({ code: 'unsupported' });
    // A prompt larger than the hub takes is not sent.
    const big = hub.conn.command('m', A, { op: 'prompt', content: [{ type: 'text', text: 'x'.repeat(MAX_CLIENT_MESSAGE) }] });
    await expect(big).rejects.toMatchObject({ code: 'too_large' });
    expect(hub.ops('command')).toHaveLength(2);
  });

  it('gives up a command the hub does not answer, saying whether it was sent', async () => {
    vi.useFakeTimers();
    const sa = hub.conn.attach('m', A, handler());
    hub.open();
    hub.push({ t: 'attached', sub: sa.id, chat: { id: A } });
    const p = hub.conn.command('m', A, { op: 'cancel' });
    const caught = p.catch((e: CommandError) => [e.code, e.unsure]);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
    expect(await caught).toEqual(['timeout', true]);
    // One that never left the page.
    hub.drop();
    const unsent = hub.conn.command('m', A, { op: 'cancel' }).catch((e: CommandError) => [e.code, e.unsure]);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
    expect(await unsent).toEqual(['offline', false]);
  });

  it('says which refusals leave a command’s outcome unknown', async () => {
    const sa = hub.conn.attach('m', A, handler());
    hub.open();
    hub.push({ t: 'attached', sub: sa.id, chat: { id: A } });
    const codes = ['lost', 'offline', 'not_attached', 'busy', 'read_only', 'bad_request'];
    const results = codes.map(() => hub.conn.command('m', A, { op: 'cancel' }).catch((e: CommandError) => [e.code, e.unsure]));
    hub.ops('command').forEach((c, i) => hub.push({ t: 'ack', id: c.id, error: { code: codes[i], message: '' } }));
    expect(await Promise.all(results)).toEqual([
      ['lost', true],
      ['offline', true],
      ['not_attached', true],
      ['busy', false],
      ['read_only', false],
      ['bad_request', false],
    ]);
  });

  it('keeps to the subscriptions a page may have', async () => {
    const list = Array.from({ length: MAX_SUBS_PER_MACHINE + 1 }, () => handler());
    list.forEach((h, i) => hub.conn.attach('m', chatId(i + 1), h));
    await flush();
    expect(list.at(-1)!.log).toEqual([['detached', 'too_many']]);
    expect(hub.conn.size).toBe(MAX_SUBS_PER_MACHINE);
    const more = Array.from({ length: MAX_SUBS - MAX_SUBS_PER_MACHINE + 1 }, () => handler());
    more.forEach((h, i) => hub.conn.attach(`m${i}`, chatId(100 + i), h));
    await flush();
    expect(more.at(-1)!.log).toEqual([['detached', 'too_many']]);
    expect(hub.conn.size).toBe(MAX_SUBS);
    const bad = handler();
    hub.conn.attach('m9', '../c0', bad);
    await flush();
    expect(bad.log).toEqual([['detached', 'bad_request']]);
  });

  it('connects again and attaches again after the last stored seq', async () => {
    vi.useFakeTimers();
    const a = handler();
    const sa = hub.conn.attach('m', A, a);
    hub.open();
    hub.push({ t: 'attached', sub: sa.id, chat: { id: A } });
    hub.push({ t: 'event', sub: sa.id, ev: { seq: 5, t: 'user' } });
    const pending = hub.conn.command('m', A, { op: 'cancel' }).catch((e: CommandError) => [e.code, e.unsure]);
    const ups: boolean[] = [];
    hub.conn.onConnection((up) => ups.push(up));
    hub.drop();
    expect(await pending).toEqual(['offline', true]);
    expect(a.log.at(-1)).toEqual(['offline']);
    expect(ups).toEqual([false]);
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(hub.sockets).toHaveLength(2);
    hub.open();
    expect(hub.ops('attach').at(-1)).toEqual({ op: 'attach', sub: sa.id, m: 'm', chat: A, from: 5 });
    hub.push({ t: 'attached', sub: sa.id, chat: { id: A } });
    expect(a.log.at(-1)).toEqual(['attached', A, undefined, true]);
    expect(ups).toEqual([false, true]);
    // A command sent while it is down waits for it.
    hub.drop();
    const queued = hub.conn.command('m', A, { op: 'compact' });
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(hub.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    hub.open();
    const cmd = hub.ops('command').at(-1)!;
    expect(cmd.cmd).toEqual({ op: 'compact' });
    hub.push({ t: 'ack', id: cmd.id });
    await expect(queued).resolves.toBeUndefined();
  });

  it('closes once nothing used it for a while', async () => {
    vi.useFakeTimers();
    const sa = hub.conn.attach('m', A, handler());
    hub.open();
    sa.detach();
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 10);
    expect(hub.socket!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(hub.socket!.closed).toBe(true);
    // Nothing connects it again until it is used.
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS * 4);
    expect(hub.sockets).toHaveLength(1);
    hub.conn.attach('m', A, handler());
    expect(hub.sockets).toHaveLength(2);
  });
});

describe('the chat source', () => {
  beforeEach(() => {
    hub.auto = true;
  });

  function collect(source: ChatSourceImpl) {
    const got: SourceEvent[] = [];
    const off = source.subscribe((ev) => got.push(ev));
    return { got, off };
  }
  const ts = (list: SourceEvent[]) =>
    list.map((e) => (e.t === 'reset' || e.t === 'reattach' ? e.t : `${e.t}${'seq' in e && e.seq ? e.seq : ''}`));

  it('says the chat first, then its events; a later subscriber hears the same', async () => {
    hub.chat(
      A,
      { kind: 'claude', state: 'idle', title: 'T', cwd: '/w', usage: { used: 10, size: 100, limits: [{ id: '5h', usedPercent: 40 }] } },
      [
        { seq: 1, t: 'user', content: [{ type: 'text', text: 'hi' }] },
        { seq: 2, t: 'turn', state: 'start' },
      ],
    );
    const source = new ChatSourceImpl('m', A);
    expect(source.id).toBe(A);
    const first = collect(source);
    await flush();
    expect(ts(first.got)).toEqual(['info', 'user1', 'turn2']);
    hub.event(A, {
      t: 'update',
      live: true,
      item: 'm1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'he' } },
    });
    hub.event(A, { seq: 2, t: 'turn', state: 'start' }); // again: passed over
    hub.event(A, {
      t: 'update',
      live: true,
      item: 'x',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'y' } },
    });
    hub.event(A, {
      seq: 3,
      t: 'update',
      item: 'x',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'yy' } },
    });
    expect(ts(first.got)).toEqual(['info', 'user1', 'turn2', 'update', 'update', 'update3']);
    const later = collect(source);
    // The live increments of the item that is whole now are not given again.
    expect(ts(later.got)).toEqual(['info', 'user1', 'turn2', 'update3', 'update']);
    expect((later.got.at(-1) as ChatEvent).item).toBe('m1');
    hub.event(A, { seq: 4, t: 'turn', state: 'end', stopReason: 'end_turn' });
    expect(ts(collect(source).got)).toEqual(['info', 'user1', 'turn2', 'update3', 'turn4']);
    // What the chat states is in the store.
    const live = useChats.getState().live[liveKey('m', A)];
    expect(live).toMatchObject({ link: 'attached', state: 'idle', info: { title: 'T', cwd: '/w' } });
    hub.event(A, {
      seq: 5,
      t: 'update',
      update: { sessionUpdate: 'usage_update', used: 20, size: 0, cost: { amount: 0.5, currency: 'USD' } },
    });
    hub.event(A, { seq: 6, t: 'state', state: 'failed', error: { code: 'ended', message: 'gone', stderr: 'boom' } });
    expect(useChats.getState().live[liveKey('m', A)]).toMatchObject({
      state: 'failed',
      error: { code: 'ended', stderr: 'boom' },
      usage: { used: 20, size: 100, cost: { amount: 0.5, currency: 'USD' }, limits: [{ id: '5h', usedPercent: 40 }] },
    });
  });

  it('attaches again after the last stored event, with a reattach first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    hub.chat(A, { kind: 'codex', state: 'idle' }, [{ seq: 1, t: 'user' }]);
    const source = new ChatSourceImpl('m', A);
    const { got } = collect(source);
    await vi.advanceTimersByTimeAsync(0);
    hub.event(A, { seq: 2, t: 'turn', state: 'start' });
    hub.drop();
    expect(useChats.getState().live[liveKey('m', A)].link).toBe('offline');
    hub.chats.get(A)!.events.push({ seq: 3, t: 'turn', state: 'end' });
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(hub.ops('attach').at(-1)).toMatchObject({ chat: A, from: 2 });
    expect(ts(got)).toEqual(['info', 'user1', 'turn2', 'reattach', 'info', 'turn3']);
    // The hub lost its connection to the host: at once, after the last.
    const sub = hub.ops('attach').at(-1)!.sub;
    hub.push({ t: 'detached', sub, error: { code: 'lost', message: '' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.ops('attach').at(-1)).toMatchObject({ chat: A, from: 3 });
    expect(ts(got).slice(-2)).toEqual(['reattach', 'info']);
  });

  it('starts over when the chat’s log went back below what it has', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    hub.chat(A, { kind: 'codex', state: 'idle', seq: 9 }, [{ seq: 9, t: 'user' }]);
    const source = new ChatSourceImpl('m', A);
    const { got } = collect(source);
    await vi.advanceTimersByTimeAsync(0);
    hub.chat(A, { kind: 'codex', state: 'idle', seq: 2 }, [
      { seq: 1, t: 'user' },
      { seq: 2, t: 'turn', state: 'start' },
    ]);
    hub.drop();
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(ts(got)).toEqual(['info', 'user9', 'reset', 'info', 'user1', 'turn2']);
    expect(hub.ops('attach').at(-1)).toEqual(expect.not.objectContaining({ from: expect.anything() }));
  });

  it('starts over when the stored events now begin after the next one it lacks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    hub.chat(A, { kind: 'codex', state: 'idle', seq: 3 }, [
      { seq: 1, t: 'user' },
      { seq: 2, t: 'turn', state: 'start' },
      { seq: 3, t: 'turn', state: 'end' },
    ]);
    const source = new ChatSourceImpl('m', A);
    const { got } = collect(source);
    await vi.advanceTimersByTimeAsync(0);
    // The host's limits removed the events up to 7 meanwhile.
    hub.chat(
      A,
      { kind: 'codex', state: 'idle', seq: 9 },
      [
        { seq: 8, t: 'user' },
        { seq: 9, t: 'turn', state: 'start' },
      ],
      8,
    );
    hub.drop();
    await vi.advanceTimersByTimeAsync(RETRY_MIN_MS);
    expect(ts(got)).toEqual(['info', 'user1', 'turn2', 'turn3', 'reset', 'info', 'user8', 'turn9']);
    expect(hub.ops('attach').map((a) => a.from)).toEqual([undefined, 3, undefined]);
    // What follows what it has needs no start over.
    hub.chats.get(A)!.events.push({ seq: 10, t: 'turn', state: 'end' });
    hub.drop();
    await vi.advanceTimersByTimeAsync(2 * RETRY_MIN_MS);
    expect(ts(got).slice(-3)).toEqual(['reattach', 'info', 'turn10']);
  });

  it('sends the view’s commands once the chat is attached', async () => {
    hub.chat(A, { kind: 'claude', state: 'idle' });
    const source = new ChatSourceImpl('m', A);
    const text = [{ type: 'text' as const, text: 'go' }];
    await Promise.all([
      source.send(text, 'u1'),
      source.cancel(),
      source.respond('p1', { option: 'allow_once' }),
      source.respond('p2', { cancelled: true }),
      source.answer('q1', { answers: { a: ['Yes'] } }),
      source.answer('q2', { cancelled: true }),
      source.setConfig('model', 'm2'),
      source.cancelQueued('q9'),
      source.compact(),
      source.rename('Title'),
    ]);
    expect(hub.ops('command').map((c) => c.cmd)).toEqual([
      { op: 'prompt', content: text, clientId: 'u1' },
      { op: 'cancel' },
      { op: 'permission', request: 'p1', option: 'allow_once' },
      { op: 'permission', request: 'p2', cancelled: true },
      { op: 'answer', request: 'q1', answers: { a: ['Yes'] } },
      { op: 'answer', request: 'q2', cancelled: true },
      { op: 'set_config', config: 'model', value: 'm2' },
      { op: 'cancel_queued', message: 'q9' },
      { op: 'compact' },
      { op: 'rename', title: 'Title' },
    ]);
    expect(hub.ops('command').every((c) => c.m === 'm' && c.chat === A)).toBe(true);
    hub.refuse.set('prompt', { code: 'busy', message: 'a turn runs' });
    await expect(source.send(text, 'u2')).rejects.toMatchObject({ code: 'busy' });
  });

  it('refuses commands on a read-only page without sending them', async () => {
    hub.chat(A, { kind: 'claude', state: 'idle' });
    const source = new ChatSourceImpl('m', A);
    useStore.getState().setReadOnly(true);
    expect(source.readOnly).toBe(true);
    await expect(source.send([], 'u')).rejects.toMatchObject({ code: 'read_only' });
    await expect(source.respond('p', { option: 'allow_once' })).rejects.toBeInstanceOf(CommandError);
    expect(hub.ops('command')).toEqual([]);
  });

  it('tells that a chat is no more', async () => {
    const source = new ChatSourceImpl('m', B);
    await flush();
    expect(useChats.getState().live[liveKey('m', B)]).toMatchObject({ link: 'gone', linkError: { code: 'unknown_chat' } });
    await expect(source.cancel()).rejects.toMatchObject({ code: 'unknown_chat' });
  });

  it('suggests the files of the chat’s directory after @', async () => {
    hub.chat(A, { kind: 'claude', state: 'idle', cwd: '/w/p' });
    const fetch = vi.fn(async (url: string) => {
      const path = new URL(url, 'http://x').searchParams.get('path');
      const entries =
        path === '/w/p'
          ? [
              { name: 'src', is_dir: true },
              { name: 'README.md', is_dir: false },
              { name: 'my notes.txt', is_dir: false },
              { name: '.env', is_dir: false },
              { name: 'resrc', is_dir: false },
            ]
          : [{ name: 'main.ts', is_dir: false }];
      return new Response(JSON.stringify({ dir: { name: '' }, entries }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const source = new ChatSourceImpl('m', A);
    await flush();
    expect(await source.suggestFiles!('src')).toEqual([
      { path: '/w/p/src', label: 'src/', isDir: true },
      { path: '/w/p/resrc', label: 'resrc' },
    ]);
    expect(await source.suggestFiles!('src/ma')).toEqual([{ path: '/w/p/src/main.ts', label: 'src/main.ts' }]);
    expect(String(fetch.mock.calls.at(-1)![0])).toContain(encodeURIComponent('/w/p/src'));
    expect((await source.suggestFiles!('.e')).map((f) => f.label)).toEqual(['.env']);
    expect(await source.suggestFiles!('a b')).toEqual([]);
  });

  it('uses recursive /p/files/find for @ queries when available and sends steer/stopTask/rewind commands', async () => {
    hub.chat(A, { kind: 'claude', state: 'idle', cwd: '/w/p' });
    const fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/p/files/find')) {
        return new Response(
          JSON.stringify({
            matches: [
              { path: '/w/p/web/src/Composer.tsx', rel: 'web/src/Composer.tsx', name: 'Composer.tsx' },
              { path: '/w/p/web/src', rel: 'web/src', name: 'src', is_dir: true },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ dir: { name: '' }, entries: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const source = new ChatSourceImpl('m', A);
    const seen: unknown[] = [];
    source.subscribe((ev) => seen.push(ev));
    await flush();
    expect(await source.suggestFiles!('Composer')).toEqual([
      { path: '/w/p/web/src/Composer.tsx', label: 'web/src/Composer.tsx' },
      { path: '/w/p/web/src', label: 'web/src/', isDir: true },
    ]);
    await source.send([{ type: 'text', text: 'now' }], 'c1', 'steer');
    await source.steerQueued('q1', 'interrupt');
    await source.stopTask('t9');
    await source.compact('focus on errors');
    await source.rewind(4, { content: [{ type: 'text', text: 'edited' }], clientId: 'c2', restoreFiles: true });
    expect(hub.ops('command').map((c) => c.cmd)).toEqual([
      { op: 'prompt', content: [{ type: 'text', text: 'now' }], clientId: 'c1', delivery: 'steer' },
      { op: 'steer_queued', message: 'q1', delivery: 'interrupt' },
      { op: 'stop_task', task: 't9' },
      { op: 'compact', instructions: 'focus on errors' },
      { op: 'rewind', seq: 4, content: [{ type: 'text', text: 'edited' }], clientId: 'c2', restoreFiles: true },
    ]);
    // Reset event broadcast from rewind clears local log and re-attaches cleanly.
    hub.event(A, { seq: 3, live: true, t: 'reset' as never });
    await flush();
    expect(seen.some((e) => (e as { t?: string }).t === 'reset')).toBe(true);
    expect(hub.ops('attach').length).toBeGreaterThanOrEqual(2);
  });

  it('defers reset detach until an in-flight rewind command receives its ack', async () => {
    hub.auto = false;
    const source = new ChatSourceImpl('m', A);
    const seen: unknown[] = [];
    source.subscribe((ev) => seen.push(ev));
    hub.open();
    const firstAttach = hub.ops('attach')[0];
    hub.push({ t: 'attached', sub: firstAttach.sub, chat: { id: A, kind: 'claude', state: 'idle' }, first: 1 });
    hub.push({ t: 'event', sub: firstAttach.sub, ev: { seq: 1, t: 'user', content: [{ type: 'text', text: 'first' }] } });
    hub.push({ t: 'event', sub: firstAttach.sub, ev: { seq: 2, t: 'user', content: [{ type: 'text', text: 'second' }] } });
    await flush();

    const rewinding = source.rewind(2, { content: [{ type: 'text', text: 'edited' }], clientId: 'c2' });
    await flush();
    const cmd = hub.ops('command')[0];
    expect(cmd.cmd).toMatchObject({ op: 'rewind', seq: 2 });

    // Server broadcasts EventType.Reset BEFORE acknowledging the rewind command.
    hub.push({ t: 'event', sub: firstAttach.sub, ev: { seq: 1, live: true, t: 'reset' } });
    await flush();
    // Must not detach yet while rewind is still awaiting its ack.
    expect(hub.ops('detach')).toEqual([]);
    expect(seen.some((e) => (e as { t?: string }).t === 'reset')).toBe(false);

    // Ack arrives: rewind resolves cleanly, then source emits reset, detaches, and re-attaches from 0.
    hub.push({ t: 'ack', id: cmd.id });
    await expect(rewinding).resolves.toBeUndefined();
    await flush();
    expect(seen.some((e) => (e as { t?: string }).t === 'reset')).toBe(true);
    expect(hub.ops('detach')).toEqual([{ op: 'detach', sub: firstAttach.sub }]);
    expect(hub.ops('attach')).toHaveLength(2);
    expect(hub.ops('attach')[1].from).toBeUndefined();
    source.stop();
  });

  it('clears cached usage on reset and resolves userTurns previews for Codex Queued(taken) without content', async () => {
    hub.chat(A, { kind: 'codex', state: 'idle', usage: { used: 4200, size: 200_000 } }, [
      { seq: 1, t: 'user', content: [{ type: 'text', text: 'first turn' }] },
      { seq: 2, t: 'queued', state: 'waiting', message: 'q-steer', content: [{ type: 'text', text: 'queued follow-up' }] },
      { seq: 3, t: 'queued', state: 'taken', message: 'q-steer' },
    ]);
    const source = new ChatSourceImpl('m', A);
    await flush();
    expect(useChats.getState().live[liveKey('m', A)]?.usage).toMatchObject({ used: 4200, size: 200_000 });
    expect(source.userTurns()).toEqual([
      { seq: 1, text: 'first turn' },
      { seq: 3, text: 'queued follow-up' },
    ]);

    // After rewind reset to a fresh chat with no usage, live usage MUST be cleared (never stuck at 4200).
    hub.chat(A, { kind: 'codex', state: 'idle' }, []);
    hub.event(A, { seq: 0, live: true, t: 'reset' as never });
    await flush();
    await flush();
    expect(useChats.getState().live[liveKey('m', A)]?.usage).toBeUndefined();
    source.stop();
  });

  it('is kept a while after the last pane let go of it, then detached', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    hub.chat(A, { kind: 'claude', state: 'idle' });
    const release = holdSource('m', A);
    await vi.advanceTimersByTimeAsync(0);
    const sub = hub.ops('attach')[0].sub;
    release();
    await vi.advanceTimersByTimeAsync(KEEP_MS - 100);
    expect(hub.ops('detach')).toEqual([]);
    // Held again meanwhile: the same subscription.
    const again = holdSource('m', A);
    await vi.advanceTimersByTimeAsync(KEEP_MS);
    expect(hub.ops('attach')).toHaveLength(1);
    again();
    await vi.advanceTimersByTimeAsync(KEEP_MS);
    expect(hub.ops('detach')).toEqual([{ op: 'detach', sub }]);
    expect(useChats.getState().live[liveKey('m', A)]).toBeUndefined();
  });
});
