import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Notice, noticeMethod, VERSION } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { hostFile, open } from '#shared/store/index.ts';
import { DB_NAME, MIGRATIONS } from './journal.ts';
import { Client, FAKE_KIND, TestHost, eventually, startHost, text } from './testing.ts';
import { extended } from '#shared/testdata/extended.ts';

setDefaultTimeout(30_000);

let hosts: TestHost[] = [];
async function host(change?: (h: TestHost) => void): Promise<TestHost> {
  const h = await startHost(change);
  hosts.push(h);
  return h;
}

afterEach(async () => {
  for (const h of hosts) {
    await h.stop();
    h.cleanup();
  }
  hosts = [];
});

describe('the chat host', () => {
  test('hello, then one request; bad requests are refused', async () => {
    const h = await host();
    const c = await Client.dial(h.sock);
    expect(c.hello).toEqual({ host: { proto: chat.PROTO, version: VERSION, pid: process.pid } });
    await c.send('{"op": 3}\n');
    expect(await c.next()).toEqual({ error: { code: 'bad_request', message: 'the request is not a JSON object of the protocol' } });
    expect(await c.closed()).toBe(true);
    expect((await h.request({ op: 'nope' })).error?.code).toBe('bad_request');
    expect((await h.request({ op: chat.Op.Chats })).chats).toEqual([]);
    // A line longer than the protocol takes.
    const big = await Client.dial(h.sock);
    void big.send('{"op":"' + 'x'.repeat(chat.MAX_LINE) + '"}\n').catch(() => {});
    expect((await big.next()).error).toMatchObject({ code: 'too_large' });
    big.close();
  });

  test("the socket and the files are the user's alone", async () => {
    const h = await host();
    expect(statSync(h.sock).mode & 0o777).toBe(0o600);
    const files = readdirSync(h.base);
    const db = files.find((f) => f.startsWith('chat-') && f.endsWith('.db'));
    expect(db).toBeDefined();
    expect(statSync(join(h.base, db!)).mode & 0o777).toBe(0o600);
    // A second host does not serve the same socket.
    const second = new TestHost();
    second.o = { ...h.o, onHost: () => {} };
    const err = await (await import('./host.ts')).serveHost({ ...second.o }).catch((e) => e);
    expect((err as Error).name).toBe('RunningError');
    second.cleanup();
  });

  test('a run directory that others may enter is refused', async () => {
    const h = new TestHost();
    hosts.push(h);
    chmodSync(h.run, 0o755);
    const err = await (await import('./host.ts')).serveHost(h.o).catch((e) => e);
    expect((err as Error).message).toContain('not a directory of the user alone');
  });

  test('agents: which kinds can start', async () => {
    const h = await host();
    const res = await h.request({ op: chat.Op.Agents, kinds: [FAKE_KIND, 'missing', 'nochat', 'noadapter'] });
    expect(res.agents).toEqual([
      { kind: FAKE_KIND, available: true },
      { kind: 'missing', available: false, reason: 'not_found' },
      { kind: 'nochat', available: false, reason: 'unsupported' },
      { kind: 'noadapter', available: false, reason: 'unsupported' },
    ]);
    expect((await h.request({ op: chat.Op.Agents, kinds: Array(65).fill('x') })).error?.code).toBe('bad_request');
  });

  test('new: what it checks', async () => {
    const h = await host();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: 'nochat', cwd: h.cwd }, 'unsupported'],
      [{ kind: 'noadapter', cwd: h.cwd }, 'unsupported'],
      [{ kind: FAKE_KIND, cwd: 'rel' }, 'bad_request'],
      [{ kind: FAKE_KIND, cwd: h.cwd + '/' }, 'bad_request'],
      [{ kind: FAKE_KIND, cwd: join(h.cwd, 'nothere') }, 'bad_request'],
      [{ kind: FAKE_KIND, cwd: h.cwd, resume: '-rf' }, 'bad_request'],
      [{ kind: FAKE_KIND, cwd: h.cwd, import: true }, 'bad_request'],
      [{ kind: FAKE_KIND, cwd: h.cwd, options: { mode: 'yolo' } }, 'bad_request'],
      [{ kind: FAKE_KIND, cwd: h.cwd, options: { model: 'a\nb' } }, 'bad_request'],
      [{ kind: FAKE_KIND, cwd: h.cwd, options: { mode: 'full' } }, 'not_allowed'],
      [{ kind: FAKE_KIND, cwd: h.cwd, options: 'x' }, 'bad_request'],
    ];
    for (const [req, code] of cases) expect([req, (await h.request({ op: chat.Op.New, ...req })).error?.code]).toEqual([req, code]);
    expect(h.fake.starts.length).toBe(0);
  });

  test('a new chat starts its agent in the login environment; a prompt is a turn', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    expect(c.state).toBe('starting');
    expect(chat.validChatID(c.id)).toBe(true);
    const p = h.fake.starts[0]!;
    expect(p.argv).toEqual(['/bin/sh', '--fake']);
    expect(p.env.FAKE_SPEC_VAR).toBe('spec');
    expect(p.env.PWD).toBe(h.cwd);
    expect(p.resume).toBe('');
    expect(p.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.options.mode).toBe('default');
    const a = await h.attach(c.id);
    await a.until((e) => e.t === 'info', 'the info');
    await a.until((e) => e.t === 'state' && e.state === 'idle', 'idle');
    expect(await a.command({ op: 'prompt', content: text('hello there\nmore'), clientId: 'k1' })).toBeUndefined();
    await s.expect('prompt:hello there\nmore');
    expect(s.prompts[0]!.recorded).toBe(true);
    const user = await a.until((e) => e.t === 'user');
    expect(user).toMatchObject({ content: text('hello there\nmore'), clientId: 'k1' });
    await a.until((e) => e.t === 'turn' && e.state === 'start');
    s.stream('m1', 'hel');
    const live = await a.event();
    expect(live).toMatchObject({ live: true, item: 'm1' });
    expect(live.seq).toBeUndefined();
    s.say('m1', 'hello');
    expect((await a.until((e) => e.t === 'update' && !e.live)).item).toBe('m1');
    s.endTurn('end_turn');
    await a.until((e) => e.t === 'turn' && e.state === 'end');
    await eventually('done', () => h.chat(c.id).snapshot().status === 'done');
    expect(h.chat(c.id).r.chat.title).toBe('hello there');
    a.close();
  });

  test('a prompt the host took already is not sent again', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    expect(await a.command({ op: 'prompt', content: text('one'), clientId: 'same' })).toBeUndefined();
    await s.expect('prompt:one');
    expect(await a.command({ op: 'prompt', content: text('one'), clientId: 'same' })).toBeUndefined();
    s.endTurn('end_turn');
    await a.until((e) => e.t === 'turn' && e.state === 'end');
    expect(s.calls.size).toBe(0);
    // ... also after the host started again: the journal knows the id.
    await h.restart();
    const b = await h.attach(c.id);
    expect(await b.command({ op: 'prompt', content: text('one'), clientId: 'same' })).toBeUndefined();
    expect(h.fake.starts.length).toBe(1);
    b.close();
    a.close();
  });

  test('prompts while a turn runs are queued by the adapter', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await a.command({ op: 'prompt', content: text('first') });
    await s.expect('prompt:first');
    expect(await a.command({ op: 'prompt', content: text('second'), clientId: 'k2' })).toBeUndefined();
    await s.expect('prompt:second');
    expect(s.prompts[1]!.recorded).toBe(false);
    const q = await a.until((e) => e.t === 'queued');
    expect(q).toMatchObject({ state: 'queued', clientId: 'k2' });
    a.close();
  });

  test('a permission: the first answer wins, and the answer reaches the agent', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await a.command({ op: 'prompt', content: text('go') });
    await s.expect('prompt:go');
    const answer = s.permission();
    const ev = await a.until((e) => e.t === 'permission');
    expect(ev.kind).toBe('command');
    expect(ev.options?.map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
    await eventually('waiting', () => h.chat(c.id).r.chat.state === 'waiting');
    expect(await a.command({ op: 'permission', request: ev.id, option: 'nope' })).toMatchObject({ code: 'bad_request' });
    expect(await a.command({ op: 'permission', request: ev.id, option: 'allow_once' })).toBeUndefined();
    expect(await a.command({ op: 'permission', request: ev.id, option: 'reject_once' })).toMatchObject({ code: 'not_found' });
    expect(await answer).toEqual({ option: 'allow_once' });
    const done = await a.until((e) => e.t === 'permission_done');
    expect(done).toMatchObject({ id: ev.id, by: 'user', outcome: { outcome: 'selected', optionId: 'allow_once' } });
    await eventually('working', () => h.chat(c.id).r.chat.state === 'working');
    a.close();
  });

  test('a question: answers checked, secret answers masked, the ids the adapter gave', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await a.command({ op: 'prompt', content: text('go') });
    const answer = s.question();
    const ev = await a.until((e) => e.t === 'question');
    expect(ev.questions?.map((q) => q.id)).toEqual(['color', 'q2']);
    expect(await a.command({ op: 'answer', request: ev.id, answers: { color: ['green'] } })).toMatchObject({ code: 'bad_request' });
    expect(await a.command({ op: 'answer', request: ev.id, answers: { color: ['red'], q2: ['because'] } })).toBeUndefined();
    expect(await answer).toEqual({ answers: { color: ['red'], '': ['because'] } });
    expect((await a.until((e) => e.t === 'question_done')).answers).toEqual({ color: ['red'], q2: ['because'] });
    a.close();
  });

  test('what waits is cancelled when the turn ends or is cancelled', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await a.command({ op: 'prompt', content: text('go') });
    const p1 = s.permission();
    await a.until((e) => e.t === 'permission');
    expect(await a.command({ op: 'cancel' })).toBeUndefined();
    await s.expect('prompt:go');
    await s.expect('cancel');
    expect(await p1).toEqual({ cancelled: true });
    expect(await a.until((e) => e.t === 'permission_done')).toMatchObject({ by: 'cancel', outcome: { outcome: 'cancelled' } });
    a.close();
  });

  test('an agent that ends: the chat fails with its error, its standard error never stored', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    s.crash();
    const st = await a.until((e) => e.t === 'state' && e.state === 'failed');
    expect(st.error).toMatchObject({ code: 'ended', stderr: 'boom' });
    a.close();
    // Replayed, it has none.
    await eventually('stored', () => h.chat(c.id).r.chat.seq >= (st.seq ?? 0));
    const b = await h.attach(c.id);
    expect(b.head.chat?.error?.stderr).toBe('boom');
    const again = await b.until((e) => e.t === 'state' && e.state === 'failed');
    expect(again.error?.stderr).toBeUndefined();
    b.close();
  });

  test('a start that fails fails the chat; a prompt starts it again', async () => {
    const h = await host((t) => (t.fake.startErr = { code: 'auth_required', message: 'sign in' }));
    const res = await h.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h.cwd });
    await eventually('failed', () => h.chat(res.chat!.id).r.chat.state === 'failed');
    expect(h.chat(res.chat!.id).r.chat.error).toMatchObject({ code: 'auth_required' });
    h.fake.startErr = null;
    const a = await h.attach(res.chat!.id);
    const p = a.command({ op: 'prompt', content: text('again') });
    const s = await h.fake.session();
    expect(await p).toBeUndefined();
    await s.expect('prompt:again');
    a.close();
  });

  test('close and delete', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    expect((await h.request({ op: chat.Op.Close, chat: c.id })).ok).toBe(true);
    await s.expect('close');
    expect(h.chat(c.id).r.chat.state).toBe('closed');
    expect(h.chat(c.id).r.chat.closed).toBeDefined();
    const w = await Client.dial(h.sock);
    await w.send({ op: chat.Op.Watch });
    expect((await w.next()).states).toHaveLength(1);
    expect((await h.request({ op: chat.Op.Delete, chat: c.id })).ok).toBe(true);
    expect(await w.next()).toMatchObject({ id: c.id, state: 'deleted', status: 'idle' });
    expect((await h.request({ op: chat.Op.Delete, chat: c.id })).error?.code).toBe('unknown_chat');
    expect((await h.request({ op: chat.Op.Chats })).chats).toEqual([]);
    w.close();
  });

  test('archive puts a chat away, seen; a prompt brings it back', async () => {
    const h = await host();
    const { chat: c } = await h.newChat();
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    expect((await h.request({ op: chat.Op.Archive, chat: c.id })).ok).toBe(true);
    const x = h.chat(c.id).snapshot();
    expect(x.state).toBe('closed');
    expect(x.archived).toBeDefined();
    expect(x.status).toBe('idle');
    expect((await h.request({ op: chat.Op.Unarchive, chat: c.id })).ok).toBe(true);
    expect(h.chat(c.id).snapshot().archived).toBeUndefined();
  });

  test('watch: every state, then each change', async () => {
    const h = await host();
    const w = await Client.dial(h.sock);
    await w.send({ op: chat.Op.Watch });
    expect(await w.next()).toEqual({ ok: true, states: [] });
    const { chat: c } = await h.newChat();
    expect(await w.next()).toMatchObject({ id: c.id, state: 'starting' });
    for (let st = await w.next(); st.state !== 'idle'; st = await w.next()) expect(st).toMatchObject({ id: c.id, state: 'starting' });
    w.close();
  });

  extended('shutdown is refused while a chat works', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await a.command({ op: 'prompt', content: text('go') });
    await s.expect('prompt:go');
    expect((await h.request({ op: chat.Op.Shutdown })).error?.code).toBe('busy');
    s.endTurn('end_turn');
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    expect((await h.request({ op: chat.Op.Shutdown })).ok).toBe(true);
    expect(await h.finished).toBeUndefined();
    await s.expect('close');
    a.close();
  });

  test('a host that starts again: a chat whose agent ran sleeps, what waited cancelled, the turn ended in an error', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await a.command({ op: 'prompt', content: text('go') });
    void s.permission();
    const perm = await a.until((e) => e.t === 'permission');
    a.close();
    // A host that ends without ending its chats (killed): its journal as it
    // was, the chat waiting.
    await h.stop();
    const db = open(hostFile(h.base, DB_NAME), { migrations: MIGRATIONS });
    db.exec(`UPDATE chats SET state = 'waiting' WHERE id = '${c.id}'`);
    db.exec(`DELETE FROM events WHERE chat = '${c.id}' AND t IN ('permission_done', 'turn') AND seq > ${perm.seq}`);
    db.close();
    await h.serve();
    expect(h.chat(c.id).r.chat.state).toBe('sleeping');
    const b = await h.attach(c.id, perm.seq);
    expect(await b.until((e) => e.t === 'permission_done')).toMatchObject({ id: perm.id, by: 'ended', outcome: { outcome: 'cancelled' } });
    expect(await b.until((e) => e.t === 'turn')).toMatchObject({
      state: 'error',
      error: { code: 'ended', message: 'the chat host ended' },
    });
    b.close();
  });

  extended('idle stop and resume: the next prompt resumes the session by its id', async () => {
    const h = await host((t) => (t.o.timing = { ...t.o.timing, minute: 50 }));
    const { chat: c, s } = await h.newChat();
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    // Idle stop is the settings' minutes (5 at least): 250 ms here.
    const a = await h.attach(c.id);
    await a.command({ op: 'prompt', content: text('go') });
    await s.expect('prompt:go');
    s.endTurn('end_turn');
    await s.expect('close');
    await eventually('sleeping', () => h.chat(c.id).r.chat.state === 'sleeping');
    const p = a.command({ op: 'prompt', content: text('again') });
    const s2 = await h.fake.session();
    expect(await p).toBeUndefined();
    expect(h.fake.starts[1]!.resume).toBe(s.id);
    await s2.expect('prompt:again');
    a.close();
  });

  test('a session that never had a turn is not resumed', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await h.request({ op: chat.Op.Close, chat: c.id });
    await s.expect('close');
    const a = await h.attach(c.id);
    const p = a.command({ op: 'prompt', content: text('hi') });
    await h.fake.session();
    expect(await p).toBeUndefined();
    expect(h.fake.starts[1]!.resume).toBe('');
    a.close();
  });

  test('maxLive: the agent idle the longest stops', async () => {
    const h = await host((t) => (t.o.settings = { ...chat.defaultHostSettings(), maxLive: 1 }));
    const one = await h.newChat();
    await eventually('idle', () => h.chat(one.chat.id).r.chat.state === 'idle');
    const two = await h.newChat();
    await one.s.expect('close');
    await eventually('the first sleeps', () => h.chat(one.chat.id).r.chat.state === 'sleeping');
    await eventually('the second idle', () => h.chat(two.chat.id).r.chat.state === 'idle');
  });

  test('handoff, and the catch-up of what the session did in a terminal', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    expect(await a.command({ op: 'handoff' })).toMatchObject({ code: 'not_found' });
    await a.command({ op: 'prompt', content: text('go') });
    s.say('m-1', 'done here');
    s.endTurn('end_turn');
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    expect(await a.command({ op: 'handoff' })).toBeUndefined();
    await s.expect('prompt:go');
    await s.expect('close');
    expect(h.chat(c.id).r.chat.handedOff).toBe(true);
    await a.until((e) => e.t === 'notice' && e.method === noticeMethod(Notice.HandedOff));
    // What the terminal did: after the log's last item.
    h.fake.past = [
      { t: 'update', item: 'm-1', update: { sessionUpdate: 'agent_message_chunk' } },
      { t: 'user', content: text('in the terminal') },
      { t: 'update', item: 'm-2', update: { sessionUpdate: 'agent_message_chunk' } },
    ];
    const p = a.command({ op: 'prompt', content: text('back') });
    const s2 = await h.fake.session();
    expect(await p).toBeUndefined();
    expect(h.fake.histories.at(-1)!.after).toBe('m-1');
    expect((await a.until((e) => e.t === 'user')).content).toEqual(text('in the terminal'));
    expect((await a.until((e) => e.t === 'update')).item).toBe('m-2');
    await s2.expect('prompt:back');
    expect(h.chat(c.id).r.chat.handedOff).toBeUndefined();
    a.close();
  });

  test('import: the earlier conversation first, the title the agent gave', async () => {
    const h = await host();
    h.fake.past = [
      { t: 'info', chat: { title: 'Earlier work' } as chat.Chat },
      { t: 'user', content: text('before') },
      { t: 'update', item: 'm-9', update: { sessionUpdate: 'agent_message_chunk' } },
    ];
    const res = await h.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h.cwd, resume: 'sess-1', import: true });
    const s = await h.fake.session();
    expect(s.p.resume).toBe('sess-1');
    const a = await h.attach(res.chat!.id);
    expect((await a.until((e) => e.t === 'user')).content).toEqual(text('before'));
    await eventually('titled', () => h.chat(res.chat!.id).r.chat.title === 'Earlier work');
    expect(h.chat(res.chat!.id).snapshot().status).toBe('idle');
    // A session a chat has is taken once.
    expect((await h.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h.cwd, resume: 'sess-1' })).error?.code).toBe('bad_request');
    // One a terminal runs is not taken.
    h.fake.running.add('sess-2');
    expect((await h.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h.cwd, resume: 'sess-2' })).error?.code).toBe('in_terminal');
    a.close();
  });

  test("sessions: the adapter's, with the chat that has each", async () => {
    const h = await host();
    const { chat: c } = await h.newChat({ resume: 'abc' });
    h.fake.list = [
      { sessionId: 'abc', cwd: h.cwd, title: 'one' },
      { sessionId: 'def', cwd: h.cwd },
    ];
    const res = await h.request({ op: chat.Op.Sessions, kind: FAKE_KIND, cwd: h.cwd });
    expect(res.sessions).toEqual([
      { sessionId: 'abc', cwd: h.cwd, title: 'one', chat: c.id },
      { sessionId: 'def', cwd: h.cwd },
    ]);
    expect(res.nextCursor).toBe('next-page');
    expect((await h.request({ op: chat.Op.Sessions, kind: 'nochat', cwd: h.cwd })).error?.code).toBe('unsupported');
  });

  test('set_config: a value of the option, kept for the next start', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await eventually('configured', () => (h.chat(c.id).r.chat.config ?? []).length === 1);
    expect(await a.command({ op: 'set_config', config: 'model', value: 'huge' })).toMatchObject({ code: 'bad_request' });
    expect(await a.command({ op: 'set_config', config: 'model', value: 'large' })).toBeUndefined();
    await s.expect('set_config:model=large');
    expect(h.chat(c.id).r.options.model).toBe('large');
    expect(h.chat(c.id).r.chat.config![0]!.currentValue).toBe('large');
    a.close();
  });

  test('bounds: connections, listings and commands waiting for the agent', async () => {
    const h = await host();
    // 256 connections, none past its hello, are served; the next is refused.
    // Dialed one after another: the listen backlog is smaller.
    const held: Client[] = [];
    for (let i = 0; i < 256; i++) held.push(await Client.dial(h.sock));
    const over = await Client.dial(h.sock);
    expect((await over.next()).error).toMatchObject({ code: 'too_many' });
    expect(await over.closed()).toBe(true);
    for (const c of held) c.close();
    await eventually('the connections to go', async () => (await h.request({ op: chat.Op.Chats })).ok === true);

    // Four listings at a time.
    let open!: () => void;
    h.fake.sessionsGate = new Promise((r) => (open = r));
    const listings = Array.from({ length: 4 }, () => h.request({ op: chat.Op.Sessions, kind: FAKE_KIND, cwd: h.cwd }));
    await eventually('four listings to run', () => h.fake.sessionsP.length === 4);
    expect((await h.request({ op: chat.Op.Sessions, kind: FAKE_KIND, cwd: h.cwd })).error?.code).toBe('busy');
    open();
    for (const l of await Promise.all(listings)) expect(l.nextCursor).toBe('next-page');

    // Eight commands of a connection wait for the agent; the ninth is refused.
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    let done!: () => void;
    h.fake.compactGate = new Promise((r) => (done = r));
    const waiting = await Promise.all(Array.from({ length: 8 }, () => a.send({ op: 'compact' })));
    for (let i = 0; i < 8; i++) await s.expect('compact');
    expect(await a.command({ op: 'compact' })).toMatchObject({ code: 'busy' });
    done();
    for (const id of waiting) expect((await a.ack(id)).error).toBeUndefined();
    a.close();
  });

  test('a connection that sends no request in time is closed', async () => {
    const h = await host((t) => (t.o.timing = { ...t.o.timing!, requestTimeout: 200 }));
    const c = await Client.dial(h.sock);
    expect(await c.closed(5000)).toBe(true);
  });

  test('commands that need an agent, without one', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await h.request({ op: chat.Op.Close, chat: c.id });
    await s.expect('close');
    const a = await h.attach(c.id);
    expect(await a.command({ op: 'cancel' })).toMatchObject({ code: 'sleeping' });
    expect(await a.command({ op: 'compact' })).toMatchObject({ code: 'sleeping' });
    expect(await a.command({ op: 'nope' })).toMatchObject({ code: 'bad_request' });
    expect(await a.command({ op: 'rename', title: '  ' })).toMatchObject({ code: 'bad_request' });
    expect(await a.command({ op: 'rename', title: 'Mine' })).toBeUndefined();
    expect(h.chat(c.id).r.renamed).toBe(true);
    a.close();
  });

  test('an attach replays the log after from, then follows; first is the lowest kept', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    for (let i = 1; i <= 5; i++) s.say(`m${i}`, `text ${i}`);
    await eventually('stored', () => h.chat(c.id).r.chat.seq === h.chat(c.id).madeSeq());
    const a = await h.attach(c.id, 0);
    expect(a.head.first).toBe(1);
    const seqs: number[] = [];
    const last = h.chat(c.id).r.chat.seq;
    for (let i = 0; i < last; i++) seqs.push((await a.event()).seq!);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    s.say('m6', 'six');
    expect(await a.event()).toMatchObject({ item: 'm6', seq: seqs.length + 1 });
    const b = await h.attach(c.id, seqs.length + 1);
    s.say('m7', 'seven');
    expect(await b.event()).toMatchObject({ item: 'm7' });
    a.close();
    b.close();
  });

  test('a connection that falls too far behind is closed', async () => {
    const h = await host((t) => (t.o.subscriberLimits = { events: 4, bytes: 1 << 20, batch: 64, writeMs: 30_000 }));
    const { chat: c, s } = await h.newChat();
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    const a = await h.attach(c.id, h.chat(c.id).r.chat.seq);
    a.c.sock.pause();
    // A big burst it does not read.
    for (let i = 0; i < 400; i++) s.stream('m1', 'x'.repeat(4096));
    await eventually('dropped', () => h.chat(c.id).subs.size === 0);
    expect(h.log.some((l) => l.includes('fell behind'))).toBe(true);
  });

  test('a chat over its bytes loses its oldest events', async () => {
    const h = await host((t) => (t.o.settings = { ...chat.defaultHostSettings(), maxChatBytes: 8 << 20 }));
    const { chat: c, s } = await h.newChat();
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    for (let i = 0; i < 12; i++) s.say(`m${i}`, 'y'.repeat(900 << 10));
    await eventually('trimmed', () => h.chat(c.id).first > 1 && h.chat(c.id).r.bytes <= 8 << 20);
    const a = await h.attach(c.id, 0);
    expect(a.head.first).toBe(h.chat(c.id).first);
    a.close();
  });

  test('bounds: closed chats past their retention go, archived first past maxChats', async () => {
    const h = await host((t) => (t.o.timing = { ...t.o.timing, day: 1 }));
    const { chat: c, s } = await h.newChat();
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await h.request({ op: chat.Op.Close, chat: c.id });
    await s.expect('close');
    await Bun.sleep(50);
    h.host.enforceSoon();
    await eventually('removed', () => !h.host.chats.has(c.id));
  });

  test('an event too large: a tool call cut, anything else a notice', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    const huge = 'a'.repeat(3 * chat.TOOL_OUTPUT_END) + 'é'.repeat(chat.MAX_EVENT / 2) + 'z'.repeat(3 * chat.TOOL_OUTPUT_END);
    s.sink.event({
      t: 'update',
      item: 't1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        content: [{ type: 'content', content: { type: 'text', text: huge } }],
      },
    });
    const e = await a.until((x) => x.t === 'update' && x.item === 't1');
    const cut = (e.update as { content: Array<{ content: { text: string } }> }).content[0]!.content.text;
    expect(cut.startsWith('a'.repeat(chat.TOOL_OUTPUT_END))).toBe(true);
    expect(cut.endsWith('z'.repeat(chat.TOOL_OUTPUT_END))).toBe(true);
    s.say('m9', 'b'.repeat(chat.MAX_EVENT));
    const n = await a.until((x) => x.t === 'notice');
    expect(n).toMatchObject({ item: 'm9', method: noticeMethod(Notice.Skipped), params: { t: 'update' } });
    a.close();
  });

  test('trust: what may not be trusted is refused; the list; untrust', async () => {
    const h = await host();
    const safe = join(h.home, 'proj');
    mkdirSync(safe, { mode: 0o700 });
    expect((await h.request({ op: chat.Op.Trust, cwd: '/' })).error?.code).toBe('unsafe_folder');
    expect((await h.request({ op: chat.Op.Trust, cwd: h.home })).error?.code).toBe('unsafe_folder');
    const open = join(h.home, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    expect((await h.request({ op: chat.Op.Trust, cwd: open })).error?.code).toBe('unsafe_folder');
    expect((await h.request({ op: chat.Op.Trust, cwd: safe })).ok).toBe(true);
    expect((await h.request({ op: chat.Op.Trusted })).trusted?.map((t) => t.cwd)).toEqual([safe]);
    expect(await h.host.trusted(join(safe, 'sub'))).toBe(true);
    expect((await h.request({ op: chat.Op.Untrust, cwd: join(safe, 'sub') })).ok).toBe(true);
    expect((await h.request({ op: chat.Op.Trusted })).trusted).toEqual([]);
  });

  test('full access: off until configured; an agent that takes it is set back', async () => {
    const h = await host((t) => {
      t.o.settings = undefined;
      t.fake.config = [
        {
          id: 'mode',
          name: 'Mode',
          category: chat.Category.Mode,
          type: chat.CONFIG_SELECT,
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Ask' },
            { value: 'yolo', name: 'Yolo', full: true },
          ],
        },
      ];
    });
    expect(h.host.settings().allowFull).toBeUndefined();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    expect(await a.command({ op: 'set_config', config: 'mode', value: 'yolo' })).toMatchObject({ code: 'not_allowed' });
    // The agent switches itself.
    s.sink.update((x) => (x.config = [{ ...x.config![0]!, currentValue: 'yolo' }]));
    await s.expect('set_config:mode=default');
    await a.until((e) => e.t === 'notice' && e.method === noticeMethod(Notice.FullAccessOff));
    expect((await h.request({ op: chat.Op.Configure, settings: { allowFull: true } })).ok).toBe(true);
    expect(await a.command({ op: 'set_config', config: 'mode', value: 'yolo' })).toBeUndefined();
    await s.expect('set_config:mode=yolo');
    // Turned off: the agent starts again in the default mode.
    expect((await h.request({ op: chat.Op.Configure, settings: {} })).ok).toBe(true);
    await s.expect('close');
    await h.fake.session();
    expect(h.fake.starts.at(-1)!.options.mode).toBe('default');
    a.close();
  });

  // The worker is held as long as a statement of 30 million rows takes.
  extended("a journal that waits holds the chats' stored events, not the host", async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await eventually('stored', () => h.chat(c.id).r.chat.seq === h.chat(c.id).madeSeq());
    let held = true;
    const holding = h.host.journal.holdForTests(30_000_000).then(() => (held = false));
    s.say('m1', 'one');
    let told = false;
    const m1 = a
      .until((e) => e.item === 'm1')
      .then((e) => {
        told = true;
        return e;
      });
    // The host answers meanwhile, from what it has.
    expect((await h.request({ op: chat.Op.Chats })).chats).toHaveLength(1);
    expect((await h.request({ op: chat.Op.HostStatus })).hostStatus?.liveAgents).toBe(1);
    expect(held).toBe(true);
    expect(told).toBe(false);
    await holding;
    expect((await m1).seq).toBe(h.chat(c.id).r.chat.seq);
    a.close();
  });

  test('host_status', async () => {
    const h = await host();
    const { chat: c } = await h.newChat();
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    const st = (await h.request({ op: chat.Op.HostStatus })).hostStatus!;
    expect(st).toMatchObject({ proto: chat.PROTO, version: VERSION, pid: process.pid, liveAgents: 1, totalChats: 1 });
    expect(st.sessions![0]).toMatchObject({ chat: c.id, kind: FAKE_KIND, state: 'idle' });
  });

  test('an event the journal refuses: nothing after it reaches a client, the chat fails, its log has no hole', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await eventually('stored', () => h.chat(c.id).r.chat.seq === h.chat(c.id).madeSeq());
    const before = h.chat(c.id).r.chat.seq;
    h.host.journal.failAppends = 1;
    // The first is refused; the ones made before the host knew are not
    // stored either (they would follow a hole), nor told.
    s.say('m1', 'one');
    s.stream('m2', 'live');
    s.say('m2', 'two');
    s.say('m3', 'three');
    const failed = await a.until((e) => e.t === 'state' && e.state === 'failed');
    expect(failed.seq).toBe(before + 1);
    expect(failed.error).toMatchObject({ code: 'failed' });
    expect(failed.error!.message).toContain("the chat's log could not be written");
    await s.expect('close');
    expect(h.log.some((l) => l.includes(`store event ${before + 1}`))).toBe(true);
    // Read again from the start: every number once, in order.
    const b = await h.attach(c.id, 0);
    const seqs: number[] = [];
    for (let i = 0; i < before + 1; i++) {
      const ev = await b.event();
      expect(ev.item === 'm1' || ev.item === 'm2' || ev.item === 'm3').toBe(false);
      seqs.push(ev.seq!);
    }
    expect(seqs).toEqual(Array.from({ length: before + 1 }, (_, i) => i + 1));
    a.close();
    b.close();
  });

  test('the host ends after its idle time with no agent and no connection', async () => {
    const h = await host((t) => (t.o.timing = { ...t.o.timing, idleExit: 200 }));
    expect(await h.finished).toBeUndefined();
    expect(existsSync(h.sock)).toBe(false);
  });

  test('untrusted: the notice is told once until a start in a trusted folder', async () => {
    const h = await host((t) => (t.fake.untrusted = true));
    const { chat: c, s } = await h.newChat();
    const a = await h.attach(c.id);
    await a.until((e) => e.t === 'notice' && e.method === noticeMethod(Notice.UntrustedFolder));
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    expect(h.chat(c.id).r.untrustedTold).toBe(true);
    void s;
    a.close();
  });

  test('new chat env: validated, forwarded to adapter in memory only, never persisted to sqlite or logs', async () => {
    const h = await host();
    // Invalid env entries are rejected before starting any agent.
    expect((await h.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h.cwd, env: { 'BAD-NAME': 'x' } })).error?.code).toBe('bad_request');
    expect((await h.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h.cwd, env: { OK_KEY: 'has\0nul' } })).error?.code).toBe(
      'bad_request',
    );
    expect(h.fake.starts).toHaveLength(0);

    const secret = 'vault-chat-env-s3cr3t-value';
    const res = await h.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h.cwd, env: { API_TOKEN: secret } });
    expect(res.ok).toBe(true);
    await h.fake.session();
    expect(h.fake.starts.at(-1)!.env).toMatchObject({ API_TOKEN: secret });
    expect(h.log.join('\n')).not.toContain(secret);
    // Secret value must never be written into SQLite database files.
    const { readFileSync } = await import('node:fs');
    for (const f of readdirSync(h.base)) {
      if (f.endsWith('.db') || f.endsWith('.db-wal')) {
        expect(readFileSync(join(h.base, f)).includes(Buffer.from(secret))).toBe(false);
      }
    }
  });
});

void writeFileSync;
void mkdtempSync;
void tmpdir;
