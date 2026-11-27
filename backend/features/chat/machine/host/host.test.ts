import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Adapter as AdapterKind } from '#shared/agents/kinds.ts';
import { Notice, noticeMethod, VERSION } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { hostFile, open } from '#shared/store/index.ts';
import { acpAdapter } from '../acp/adapter.ts';
import { OPTION_ALLOW_ONCE, type Adapter } from '../adapter.ts';
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

  test('set_config wakes a sleeping chat (including before the first turn) and respects closed/allowFull', async () => {
    const h = await host();
    expect((await h.request({ op: chat.Op.Configure, settings: { maxLive: 1, allowFull: false } })).ok).toBe(true);
    const { chat: c, s: s1 } = await h.newChat();
    const a = await h.attach(c.id);
    await eventually('idle', () => h.chat(c.id).r.chat.state === 'idle');
    await eventually('configured', () => (h.chat(c.id).r.chat.config ?? []).length === 1);
    // Starting a second chat evicts the untouched first chat (fresh = true) to sleeping.
    const { chat: c2 } = await h.newChat();
    await eventually('second idle', () => h.chat(c2.id).r.chat.state === 'idle');
    await eventually('sleeping', () => h.chat(c.id).r.chat.state === 'sleeping');
    expect(h.chat(c.id).r.fresh).toBe(true);
    await s1.expect('close');
    // Switching config while sleeping wakes a fresh session instead of failing with sleeping.
    const set = a.command({ op: 'set_config', config: 'model', value: 'large' });
    const s2 = await h.fake.session();
    expect(await set).toBeUndefined();
    expect(s2).not.toBe(s1);
    expect(h.fake.starts.at(-1)!.resume).toBe('');
    await s2.expect('set_config:model=large');
    expect(h.chat(c.id).r.chat.state).toBe('idle');
    expect(h.chat(c.id).r.options.model).toBe('large');
    expect(h.chat(c.id).r.chat.config![0]!.currentValue).toBe('large');
    // A closed chat is not woken by set_config.
    const startsBeforeClose = h.fake.starts.length;
    await h.request({ op: chat.Op.Close, chat: c.id });
    await s2.expect('close');
    expect(await a.command({ op: 'set_config', config: 'model', value: 'small' })).toMatchObject({ code: 'sleeping' });
    expect(h.fake.starts.length).toBe(startsBeforeClose);
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

    // Four listings run concurrently, up to 16 more queue FIFO, and overflow refuses with probe_busy.
    let open!: () => void;
    h.fake.sessionsGate = new Promise((r) => (open = r));
    const running = Array.from({ length: 4 }, () => h.request({ op: chat.Op.Sessions, kind: FAKE_KIND, cwd: h.cwd }));
    await eventually('four listings to run', () => h.fake.sessionsP.length === 4);
    const queued = Array.from({ length: 16 }, () => h.request({ op: chat.Op.Sessions, kind: FAKE_KIND, cwd: h.cwd }));
    // Give the 16 queued requests a moment to enter the host's probeQueue.
    await eventually('probe queue filled', async () => {
      const r = await h.request({ op: chat.Op.Sessions, kind: FAKE_KIND, cwd: h.cwd });
      return r.error?.code === chat.Code.ProbeBusy;
    });
    expect(h.fake.sessionsP.length).toBe(4);
    open();
    for (const l of await Promise.all([...running, ...queued])) expect(l.nextCursor).toBe('next-page');

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

  // #2: Non-blocking async questions do not block the chat in State.Waiting,
  // survive Turn.End, and can be answered after the turn finishes.
  test('async questions survive turn end without entering State.Waiting', async () => {
    const h = await host();
    const { chat: c, s } = await h.newChat();
    const id = c.id;
    const a = await h.attach(id, 0);
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    await a.command({ op: chat.CommandOp.Prompt, content: text('plan please') });
    await s.expect('prompt:plan please');
    await a.until((e) => e.t === chat.EventType.Turn && e.state === chat.TurnState.Start);

    // Ask an async question mid-turn with optional=true.
    const ansP = s.asyncQuestion({ item: 'msg-async-1', autoResolutionMs: 30_000, optional: true });
    const qev = await a.until((e) => e.t === chat.EventType.Question);
    expect(qev.async).toBe(true);
    expect(qev.autoResolutionMs).toBe(30_000);
    expect(qev.item).toBe('msg-async-1');

    // Chat remains working (not waiting), and ending the turn keeps the question open!
    expect(h.host.chats.get(id)!.r.chat.state).toBe(chat.State.Working);
    s.endTurn('end_turn');
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // Answer the async question AFTER the turn completed.
    expect(await a.command({ op: chat.CommandOp.Answer, request: qev.id, answers: { follow: ['Ship'] } })).toBeUndefined();
    expect(await ansP).toEqual({ answers: { follow: ['Ship'] } });
    const done = await a.until((e) => e.t === chat.EventType.QuestionDone && e.id === qev.id);
    expect(done.by).toBe(chat.By.User);
    expect(done.answers).toEqual({ follow: ['Ship'] });
    a.close();
  });

  // #3: Op.Models caches per kind in SQLite, probes on refresh, and updates live sessions.
  test('models refresh probes adapter, caches in journal, and updates live chats', async () => {
    const h = await host();
    // Unfetched cache returns empty without probing.
    let res = await h.request({ op: chat.Op.Models, kind: FAKE_KIND, refresh: false });
    expect(res).toEqual({ ok: true, models: [] });
    expect(h.fake.modelsCalls).toHaveLength(0);

    // Start a live chat, then refresh models.
    const { chat: c } = await h.newChat();
    const id = c.id;
    const a = await h.attach(id, 0);
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    h.fake.modelsList = [
      { value: 'model-v2', name: 'Model v2', efforts: ['low', 'high'], defaultEffort: 'high', images: true },
      { value: 'model-v3', name: 'Model v3' },
    ];
    res = await h.request({ op: chat.Op.Models, kind: FAKE_KIND, cwd: h.cwd, refresh: true });
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(h.fake.modelsList);
    expect(res.fetchedAt).toBeTruthy();
    expect(h.fake.modelsCalls).toHaveLength(1);

    // Live chat received updated Model ConfigOption (keeping currentValue 'small').
    const info = await a.until(
      (e) => e.t === chat.EventType.Info && !!e.chat?.config?.some((o) => o.options?.some((v) => v.value === 'model-v2')),
    );
    const modelOpt = info.chat!.config!.find((o) => o.category === chat.Category.Model)!;
    expect(modelOpt.options!.map((o) => o.value)).toEqual(['small', 'model-v2', 'model-v3']);

    // Subsequent non-refresh request hits cache without re-probing.
    res = await h.request({ op: chat.Op.Models, kind: FAKE_KIND, refresh: false });
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(h.fake.modelsList);
    expect(h.fake.modelsCalls).toHaveLength(1);
    a.close();
  });

  // #4 & #9 & #10: delivery modes, steer_queued, compact wake-up + instructions,
  // and background tasks + stop_task.
  test('delivery modes, steer_queued, compact wake-up, and background tasks stop_task', async () => {
    const h = await host((t) => {
      t.fake.caps.steer = true;
      t.fake.caps.cancelQueued = true;
      t.fake.caps.stopTask = true;
    });
    const { chat: c, s } = await h.newChat();
    const id = c.id;
    const a = await h.attach(id, 0);
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // Publish live background tasks via sink.update and stop one via CommandOp.StopTask.
    const tasks: chat.BackgroundTask[] = [
      {
        id: 'bg-1',
        kind: chat.TaskKind.Shell,
        status: chat.TaskStatus.Running,
        description: 'npm test',
        stoppable: true,
        backgrounded: true,
      },
    ];
    s.sink.update((c) => {
      c.tasks = tasks;
    });
    const info = await a.until((e) => e.t === chat.EventType.Info && e.chat?.tasks?.length === 1);
    expect(info.chat!.tasks).toEqual(tasks);
    expect(await a.command({ op: chat.CommandOp.StopTask, task: 'bg-1' })).toBeUndefined();
    await s.expect('stop_task:bg-1');

    // Start a turn, send a queued prompt with delivery: 'steer', and promote via steer_queued.
    await a.command({ op: chat.CommandOp.Prompt, content: text('first') });
    await s.expect('prompt:first');
    expect(s.prompts[0]!.uuid).toBeTruthy();
    await a.until((e) => e.t === chat.EventType.Turn && e.state === chat.TurnState.Start);

    await a.command({ op: chat.CommandOp.Prompt, content: text('nudge'), delivery: chat.Delivery.Steer });
    await s.expect('prompt:nudge');
    expect(s.prompts[1]!.delivery).toBe(chat.Delivery.Steer);
    // Simulate adapter taking the steered message into the running turn.
    s.sink.event({ t: chat.EventType.Queued, message: s.prompts[1]!.message, state: chat.QueuedState.Taken });

    expect(await a.command({ op: chat.CommandOp.SteerQueued, message: 'm123', delivery: chat.Delivery.Interrupt })).toBeUndefined();
    await s.expect('steer_queued:m123:interrupt');
    s.endTurn('end_turn');
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // Close the chat so it sleeps, then send compact with instructions: host wakes it and compacts.
    await h.request({ op: chat.Op.Close, chat: id });
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Closed);
    // Tasks cleared when agent stopped.
    expect(h.host.chats.get(id)!.r.chat.tasks).toBeUndefined();

    const compactP = a.command({ op: chat.CommandOp.Compact, instructions: 'keep decisions' });
    const s2 = await h.fake.session();
    expect(await compactP).toBeUndefined();
    await s2.expect('compact:keep decisions');
    a.close();
  });

  // #6: Fork (native + fallback), Switch, Export, and Rewind (native + Reset + re-send).
  test('fork, switch, export, and rewind', async () => {
    const h = await host((t) => {
      t.fake.caps.fork = true;
      t.fake.caps.rewind = true;
      t.fake.caps.rewindFiles = true;
    });
    const { chat: c, s } = await h.newChat();
    const id = c.id;
    const a = await h.attach(id, 0);
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // Run two turns so we can fork, switch, export, and rewind.
    await a.command({ op: chat.CommandOp.Prompt, content: text('turn one') });
    await s.expect('prompt:turn one');
    const u1 = await a.until((e) => e.t === chat.EventType.User);
    s.say('a1', 'reply one');
    s.endTurn('end_turn');
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    await a.command({ op: chat.CommandOp.Prompt, content: text('turn two') });
    await s.expect('prompt:turn two');
    const u2 = await a.until((e) => e.t === chat.EventType.User);
    s.say('a2', 'reply two');
    s.endTurn('end_turn');
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // Export Markdown digest.
    const exp = await h.request({ op: chat.Op.Export, chat: id });
    expect(exp.ok).toBe(true);
    expect(exp.markdown).toContain('turn one');
    expect(exp.markdown).toContain('reply two');
    expect(u1.item).toBeTruthy();

    // Native fork up to end of turn 1.
    const forkRes = await h.request({ op: chat.Op.Fork, chat: id, upToSeq: u2.seq! - 1, title: 'Fork 1' });
    expect(forkRes.ok).toBe(true);
    expect(forkRes.chat!.title).toBe('Fork 1');
    expect(forkRes.chat!.sessionId).toBe('forked-sess-1');
    expect(h.fake.forkCalls).toHaveLength(1);
    await h.fake.session();

    // Fallback fork when adapter throws Code.Unsupported seeds context on first prompt.
    h.fake.forkErr = { code: chat.Code.Unsupported, message: 'no native fork' };
    const fbFork = await h.request({ op: chat.Op.Fork, chat: id, title: 'Fallback Fork' });
    expect(fbFork.ok).toBe(true);
    expect(fbFork.chat!.sessionId).toBe('');
    const fbSess = await h.fake.session();
    const fbAtt = await h.attach(fbFork.chat!.id, 0);
    await fbAtt.until((e) => e.t === chat.EventType.Notice && e.method === noticeMethod(Notice.Forked));
    await fbAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    await fbAtt.command({ op: chat.CommandOp.Prompt, content: text('after fallback fork') });
    const fbPrompt = await fbSess.calls.next('fallback fork prompt');
    expect(fbPrompt).toContain('<handoff_context>');
    expect(fbPrompt).toContain('turn one');
    fbSess.endTurn('end_turn');
    fbAtt.close();
    h.fake.forkErr = null;

    // Switch agent: creates a new chat with Notice.Switched and prepends handoff context on first prompt.
    const swRes = await h.request({ op: chat.Op.Switch, chat: id, targetKind: FAKE_KIND });
    expect(swRes.ok).toBe(true);
    const swId = swRes.chat!.id;
    const swSess = await h.fake.session();
    const swAtt = await h.attach(swId, 0);
    await swAtt.until((e) => e.t === chat.EventType.Notice && e.method === noticeMethod(Notice.Switched));
    await swAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    await swAtt.command({ op: chat.CommandOp.Prompt, content: text('continue here') });
    const swFirst = await swSess.calls.next('switched first prompt');
    expect(swFirst).toContain('<handoff_context>');
    expect(swFirst).toContain('reply two');
    // Second prompt does NOT re-prepend the handoff context.
    swSess.endTurn('end_turn');
    await swAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    await swAtt.command({ op: chat.CommandOp.Prompt, content: text('second msg') });
    await swSess.expect('prompt:second msg');
    swSess.endTurn('end_turn');
    swAtt.close();

    // Rewind original chat to turn 2, restoring files and re-sending edited text.
    const rwErr = await a.command({
      op: chat.CommandOp.Rewind,
      seq: u2.seq,
      content: text('turn two edited'),
      restoreFiles: true,
    });
    expect(rwErr).toBeUndefined();
    expect(h.fake.rewinds).toHaveLength(1);
    expect(h.fake.rewinds[0]).toMatchObject({ userMessageId: u2.item, restoreFiles: true });
    const resetEv = await a.until((e) => e.t === chat.EventType.Reset);
    expect(resetEv.seq).toBe(u2.seq! - 1);
    await s.expect(`rewind:${u2.item}:files`);
    await s.expect('prompt:turn two edited');
    s.endTurn('end_turn');
    a.close();
  });

  // Review fixes (#34/#35): entryUuid resolution, Queued(taken) rewind,
  // ack-before-reset ordering, partial fork turn normalization, async question
  // cancellation on rewind, By.Superseded, seed restore after Turn.Error, and
  // vault extraEnv inheritance on fork/switch.
  test('rewind/fork review invariants: entryUuid, queued-taken, ack-before-reset, partial fork, superseded, seed restore, env carry', async () => {
    const h = await host((t) => {
      t.fake.caps.fork = true;
      t.fake.caps.rewind = true;
      t.fake.caps.rewindFiles = true;
    });
    const secret = 'vault-carry-s3cr3t';
    const created = await h.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h.cwd, env: { CARRY_SECRET: secret } });
    expect(created.ok).toBe(true);
    const id = created.chat!.id;
    const s = await h.fake.session();
    const a = await h.attach(id, 0);
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // Turn 1: assistant emits API msg_01... item WITH a real transcript entryUuid.
    const assistantUuid1 = '11111111-1111-4111-8111-111111111111';
    const queuedUserUuid = '22222222-2222-4222-8222-222222222222';
    const assistantUuid2 = '33333333-3333-4333-8333-333333333333';

    await a.command({ op: chat.CommandOp.Prompt, content: text('first turn') });
    await s.expect('prompt:first turn');
    const u1 = await a.until((e) => e.t === chat.EventType.User);
    // Emit a Turn(start) with Codex-like turn id and assistant Update with msg_01 item + entryUuid.
    s.sink.event({
      t: chat.EventType.Update,
      item: 'msg_01ABCDEF/0',
      entryUuid: assistantUuid1,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ans 1' } },
    });
    s.sink.event({
      t: chat.EventType.Update,
      item: 'toolu_01XYZ',
      update: { sessionUpdate: 'tool_call', toolCallId: 'toolu_01XYZ', title: 'Read', kind: 'read', status: 'completed' },
    });
    s.sink.event({ t: chat.EventType.Turn, item: 'turn-1', state: chat.TurnState.End, stopReason: 'end_turn' });
    s.turn = false;
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // Turn 2: simulate a queued-then-taken user turn (Turn(start) followed by Queued(taken) with entryUuid).
    s.sink.event({ t: chat.EventType.Turn, item: 'turn-2', state: chat.TurnState.Start });
    s.sink.event({
      t: chat.EventType.Queued,
      message: 'q2',
      item: queuedUserUuid,
      entryUuid: queuedUserUuid,
      content: text('queued turn two'),
      state: chat.QueuedState.Taken,
    });
    const q2Taken = await a.until((e) => e.t === chat.EventType.Queued && e.state === chat.QueuedState.Taken);
    s.sink.event({
      t: chat.EventType.Update,
      item: 'msg_02HIJK/0',
      entryUuid: assistantUuid2,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ans 2' } },
    });
    s.sink.event({ t: chat.EventType.Turn, item: 'turn-2', state: chat.TurnState.End, stopReason: 'end_turn' });
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // Partial fork pointing at Turn 1's User seq extends to end of Turn 1 (before Turn 2),
    // sets partial: true, resolves upToMessageId to assistantUuid1 (NOT toolu_01XYZ or msg_01ABCDEF),
    // sets beforeTurnId = 'turn-2', and NEVER inherits src's vault extraEnv when req.env is absent!
    const pFork = await h.request({ op: chat.Op.Fork, chat: id, upToSeq: u1.seq, title: 'After T1' });
    expect(pFork.ok).toBe(true);
    expect(h.fake.forkCalls.at(-1)).toMatchObject({
      partial: true,
      upToMessageId: assistantUuid1,
      lastTurnId: 'turn-1',
      beforeTurnId: 'turn-2',
    });
    await h.fake.session();
    expect(h.fake.starts.at(-1)!.env.CARRY_SECRET).toBeUndefined();

    // Fork pointing at the LAST turn (q2Taken.seq) normalizes to a full fork (partial absent)
    // and forwards freshly supplied req.env (resolved from an unlocked vault) when provided.
    h.fake.forkSessionId = 'forked-full-2';
    const freshForkSecret = 'vault-fresh-fork-s3cr3t';
    const fullFork = await h.request({
      op: chat.Op.Fork,
      chat: id,
      upToSeq: q2Taken.seq,
      title: 'Full',
      env: { FRESH_SECRET: freshForkSecret },
    });
    expect(fullFork.ok).toBe(true);
    expect(h.fake.forkCalls.at(-1)!.partial).toBeUndefined();
    expect(h.fake.forkCalls.at(-1)!.upToMessageId).toBeUndefined();
    await h.fake.session();
    expect(h.fake.starts.at(-1)!.env.CARRY_SECRET).toBeUndefined();
    expect(h.fake.starts.at(-1)!.env.FRESH_SECRET).toBe(freshForkSecret);

    // Switch NEVER inherits src's vault extraEnv, forwards fresh req.env when supplied,
    // and restores seed if Turn.Error fires before rejecting prompt.
    const freshSwitchSecret = 'vault-fresh-switch-s3cr3t';
    const sw = await h.request({
      op: chat.Op.Switch,
      chat: id,
      targetKind: FAKE_KIND,
      env: { SWITCH_SECRET: freshSwitchSecret },
    });
    expect(sw.ok).toBe(true);
    const swSess = await h.fake.session();
    expect(h.fake.starts.at(-1)!.env.CARRY_SECRET).toBeUndefined();
    expect(h.fake.starts.at(-1)!.env.SWITCH_SECRET).toBe(freshSwitchSecret);
    const swAtt = await h.attach(sw.chat!.id, 0);
    await swAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    // Force Turn.Error inside prompt before rejection (clearing this.turn early): seed must still restore!
    const origPrompt = swSess.prompt.bind(swSess);
    let failOnce = true;
    swSess.prompt = async (p) => {
      if (failOnce) {
        failOnce = false;
        swSess.sink.event({ t: chat.EventType.Turn, state: chat.TurnState.Error, error: { code: chat.Code.Failed, message: 'boom' } });
        throw new chat.ChatProtoError({ code: chat.Code.Failed, message: 'boom' });
      }
      return origPrompt(p);
    };
    const firstErr = await swAtt.command({ op: chat.CommandOp.Prompt, content: text('retry me') });
    expect(firstErr?.code).toBe(chat.Code.Failed);
    // Second attempt MUST still receive the restored <handoff_context> seed!
    await swAtt.command({ op: chat.CommandOp.Prompt, content: text('second try') });
    const retried = await swSess.calls.next('retried prompt');
    expect(retried).toContain('<handoff_context>');
    swSess.endTurn('end_turn');
    swAtt.close();

    // Test By.Superseded when async question aborts with By.Superseded.
    const supAc = new AbortController();
    const supP = s.asyncQuestion({}, supAc.signal);
    const supEv = await a.until((e) => e.t === chat.EventType.Question);
    supAc.abort(chat.By.Superseded);
    expect(await supP).toEqual({ cancelled: true });
    const supDone = await a.until((e) => e.t === chat.EventType.QuestionDone && e.id === supEv.id);
    expect(supDone.by).toBe(chat.By.Superseded);

    // Open another async question BEFORE rewinding: rewind must cancel it before truncating!
    const openAsyncP = s.asyncQuestion({});
    await a.until((e) => e.t === chat.EventType.Question);

    // Send raw CommandOp.Rewind on Queued(taken) turn (q2Taken.seq) and verify:
    // 1. Ack arrives STRICTLY BEFORE EventType.Reset on the raw wire.
    // 2. rewind receives real UUIDs: userMessageId = queuedUserUuid, resumeBeforeId = assistantUuid1, beforeTurnId = 'turn-2'.
    // 3. Open async question was cancelled before truncation.
    const rawId = await a.send({
      op: chat.CommandOp.Rewind,
      seq: q2Taken.seq,
      content: text('queued turn edited'),
      restoreFiles: true,
    });
    const frames: Record<string, unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      const f = await a.c.next();
      frames.push(f);
      if (f.t === chat.EventType.Reset) break;
    }
    const ackIdx = frames.findIndex((f) => f.t === chat.EventType.Ack && f.id === rawId);
    const resetIdx = frames.findIndex((f) => f.t === chat.EventType.Reset);
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(ackIdx);
    expect(frames[ackIdx]!.error).toBeUndefined();
    expect(await openAsyncP).toEqual({ cancelled: true });
    expect(h.fake.rewinds.at(-1)).toEqual({
      userMessageId: queuedUserUuid,
      resumeBeforeId: assistantUuid1,
      beforeTurnId: 'turn-2',
      restoreFiles: true,
    });
    await s.expect(`rewind:turn-2:files`);
    await s.expect('prompt:queued turn edited');
    s.endTurn('end_turn');
    a.close();
  });

  test('rejects rewind when agent lacks native caps.rewind (preserving session/cache), supports truncate-only native rewind + usage invalidation, and per-kind defaultModes', async () => {
    // 1. Agent without native rewind capability (like ACP): refuses rewind with Code.Unsupported
    //    without stopping the live session or invalidating its context usage.
    const h = await host((t) => {
      t.fake.caps.rewind = false;
      t.fake.caps.rewindFiles = false;
    });
    await h.request({
      op: chat.Op.Configure,
      settings: { defaultMode: chat.Mode.Default, defaultModes: { [FAKE_KIND]: chat.Mode.Plan } },
    });

    const created = await h.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h.cwd });
    expect(created.ok).toBe(true);
    const id = created.chat!.id;
    const s1 = await h.fake.session();
    expect(h.fake.starts.at(-1)!.options?.mode).toBe(chat.Mode.Plan);
    const a = await h.attach(id, 0);
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    await a.command({ op: chat.CommandOp.Prompt, content: text('turn one') });
    await s1.expect('prompt:turn one');
    const u1 = await a.until((e) => e.t === chat.EventType.User);
    s1.sink.update((c) => {
      c.usage = { used: 8000, size: 100000, percentage: 8 };
    });
    s1.endTurn('end_turn');
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    const rwUnsupported = await a.command({ op: chat.CommandOp.Rewind, seq: u1.seq });
    expect(rwUnsupported?.code).toBe(chat.Code.Unsupported);
    // Session stays alive and usage stays intact (prompt cache preserved).
    const checkIntact = await h.attach(id, 0);
    expect(checkIntact.head.chat!.state).toBe(chat.State.Idle);
    expect(checkIntact.head.chat!.usage).toMatchObject({ used: 8000, size: 100000, percentage: 8 });
    checkIntact.close();
    a.close();

    // 2. Agent with native rewind: truncate-only rewind (no content) truncates log and invalidates usage.
    const h2 = await host((t) => {
      t.fake.caps.rewind = true;
      t.fake.caps.rewindFiles = false;
    });
    const created2 = await h2.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h2.cwd });
    const id2 = created2.chat!.id;
    const sn = await h2.fake.session();
    const an = await h2.attach(id2, 0);
    await an.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    await an.command({ op: chat.CommandOp.Prompt, content: text('native one') });
    await sn.expect('prompt:native one');
    sn.endTurn('end_turn');
    await an.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    await an.command({ op: chat.CommandOp.Prompt, content: text('native two') });
    await sn.expect('prompt:native two');
    const u2 = await an.until((e) => e.t === chat.EventType.User && JSON.stringify(e.content).includes('native two'));
    sn.sink.update((c) => {
      c.usage = { used: 24000, size: 100000, percentage: 24 };
    });
    sn.endTurn('end_turn');
    await an.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    expect(await an.command({ op: chat.CommandOp.Rewind, seq: u2.seq })).toBeUndefined();
    await an.until((e) => e.t === chat.EventType.Reset);
    expect(h2.fake.rewinds).toHaveLength(1);
    an.close();

    const an2 = await h2.attach(id2, 0);
    expect(an2.head.chat!.usage).toMatchObject({ used: 0, size: 100000, percentage: 0, stale: true });
    an2.close();

    // 3. Global defaultMode=full with allowFull passes Mode.Full when no per-kind override is set.
    await h2.request({ op: chat.Op.Configure, settings: { defaultMode: chat.Mode.Full, allowFull: true } });
    const created3 = await h2.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h2.cwd });
    expect(created3.ok).toBe(true);
    await h2.fake.session();
    expect(h2.fake.starts.at(-1)!.options?.mode).toBe(chat.Mode.Full);
  });

  test('backfills client mode config for Grok chats on new/reload and resolves matching pending permissions on mode switch', async () => {
    const h = await host((t) => {
      const origSpec = t.o.spec;
      t.o.spec = (kind) =>
        kind === 'grok' ? { adapter: AdapterKind.ACP, argv: ['/bin/sh', '--grok'], newSessionMeta: { yoloMode: false } } : origSpec(kind);
      (t.fake as Adapter).prepareConfig = acpAdapter().prepareConfig;
      t.o.adapters = { ...t.o.adapters, [AdapterKind.ACP]: t.fake };
      t.fake.config = [
        {
          id: 'model',
          name: 'Model',
          category: chat.Category.Model,
          type: chat.CONFIG_SELECT,
          currentValue: 'grok-4.7',
          options: [{ value: 'grok-4.7', name: 'Grok 4.7' }],
        },
        {
          id: 'mode',
          name: 'Mode',
          category: chat.Category.Mode,
          type: chat.CONFIG_SELECT,
          currentValue: chat.Mode.Default,
          options: [
            { value: chat.Mode.Default, name: 'Default' },
            { value: chat.Mode.AcceptEdits, name: 'Accept Edits' },
            { value: chat.Mode.Full, name: 'Full Access', full: true },
          ],
        },
      ];
    });
    await h.request({ op: chat.Op.Configure, settings: { allowFull: true } });

    // 1. A brand-new Grok chat immediately exposes the client mode selector before the agent starts.
    const created = await h.request({ op: chat.Op.New, kind: 'grok', cwd: h.cwd });
    expect(created.ok).toBe(true);
    const id = created.chat!.id;
    const initMode = created.chat!.config?.find((c) => c.category === chat.Category.Mode);
    expect(initMode?.currentValue).toBe(chat.Mode.Default);
    expect(initMode?.options?.map((o) => o.value)).toEqual([chat.Mode.Default, chat.Mode.AcceptEdits, chat.Mode.Full]);

    const s = await h.fake.session();
    const a = await h.attach(id, 0);
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // 2. While waiting on a command permission, switching mode to Full Access auto-approves via allow_once.
    await a.command({ op: chat.CommandOp.Prompt, content: text('run command') });
    await s.expect('prompt:run command');
    const permP = s.permission(chat.PermissionKind.Command);
    await a.until((e) => e.t === chat.EventType.Permission);
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Waiting);

    expect(await a.command({ op: chat.CommandOp.SetConfig, config: 'mode', value: chat.Mode.Full })).toBeUndefined();
    expect(await permP).toEqual({ option: OPTION_ALLOW_ONCE });
    const doneEv = await a.until((e) => e.t === chat.EventType.PermissionDone);
    expect(doneEv.outcome).toEqual({ outcome: chat.OutcomeKind.Selected, optionId: OPTION_ALLOW_ONCE });
    s.endTurn('end_turn');
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    a.close();

    // 3. A pre-upgrade sleeping Grok chat persisted in SQLite with only [model] (no mode option)
    //    gets its client mode option backfilled on host restart.
    await h.stop();
    const db = open(hostFile(h.base, DB_NAME), { migrations: MIGRATIONS });
    const modelOnly = JSON.stringify([
      {
        id: 'model',
        name: 'Model',
        category: chat.Category.Model,
        type: chat.CONFIG_SELECT,
        currentValue: 'grok-4.7',
        options: [{ value: 'grok-4.7', name: 'Grok 4.7' }],
      },
    ]);
    db.prepare('UPDATE chats SET config = ? WHERE id = ?').run(modelOnly, id);
    db.close();

    await h.serve();
    const listed = await h.request({ op: chat.Op.Chats });
    const reloaded = listed.chats!.find((c) => c.id === id)!;
    const reloadedMode = reloaded.config?.find((c) => c.category === chat.Category.Mode);
    expect(reloadedMode?.id).toBe('mode');
    expect(reloadedMode?.currentValue).toBe(chat.Mode.Full);
    expect(reloadedMode?.options?.map((o) => o.value)).toEqual([chat.Mode.Default, chat.Mode.AcceptEdits, chat.Mode.Full]);
  });

  test('cross-agent handoff: native history injection + persistence, unsupported fallback, clean queued events, busy refusal, bare /compact, and multi-hop lineage', async () => {
    const h = await host((t) => {
      t.fake.nativeHistory = true;
    });
    const { chat: chatA, s: sessA } = await h.newChat();
    const aAtt = await h.attach(chatA.id, 0);
    await aAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // Turn 1 in Chat A: run a prompt while refusing Op.Switch while busy!
    await aAtt.command({ op: chat.CommandOp.Prompt, content: text('Initial goal from chat A') });
    await sessA.expect('prompt:Initial goal from chat A');
    const busySwitch = await h.request({ op: chat.Op.Switch, chat: chatA.id, targetKind: FAKE_KIND });
    expect(busySwitch.error?.code).toBe(chat.Code.Busy);
    sessA.say('a1', 'Completed step 1 in chat A.');
    sessA.endTurn('end_turn');
    await aAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // 1. Switch A -> B with native history injection enabled: injects on launch(),
    //    marks chat B non-fresh (so sleep/resume preserves the thread), and keeps B's first prompt clean!
    const swB = await h.request({ op: chat.Op.Switch, chat: chatA.id, targetKind: FAKE_KIND });
    expect(swB.ok).toBe(true);
    const idB = swB.chat!.id;
    const sessB = await h.fake.session();
    const bAtt = await h.attach(idB, 0);
    const bNotice = await bAtt.until((e) => e.t === chat.EventType.Notice && e.method === noticeMethod(Notice.Switched));
    expect(bNotice.params).toMatchObject({
      fromChat: chatA.id,
      fromKind: FAKE_KIND,
      totalTurns: 1,
      keptTurns: 1,
      omittedTurns: 0,
    });
    await bAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    await sessB.expect('inject_history:2');
    expect(h.fake.injectedHistories).toHaveLength(1);
    expect(h.fake.injectedHistories[0]!.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h.fake.injectedHistories[0]![0]!.text).toContain('Initial goal from chat A');
    expect(h.fake.injectedHistories[0]![1]!.text).toContain('Completed step 1 in chat A.');
    // Chat B must be marked non-fresh after native injection so sleep/resume loads this session!
    expect(h.chat(idB).r.fresh).toBe(false);

    // First user prompt on B goes completely clean (no <handoff_context> wrapper).
    await bAtt.command({ op: chat.CommandOp.Prompt, content: text('Step 2 in chat B') });
    await sessB.expect('prompt:Step 2 in chat B');
    sessB.say('b1', 'Completed step 2 in chat B.');
    sessB.endTurn('end_turn');
    await bAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // Diverge Chat A AFTER A -> B switch: later turns in A must NOT leak into B -> C!
    await aAtt.command({ op: chat.CommandOp.Prompt, content: text('DIVERGENT_LATER_TURN_IN_A') });
    await sessA.expect('prompt:DIVERGENT_LATER_TURN_IN_A');
    sessA.say('a2', 'Divergent reply in A.');
    sessA.endTurn('end_turn');
    await aAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // 2. Chained switch B -> C when native injection rejects with Code.Unsupported:
    //    falls back transparently to attributed prompt context, carries BOTH A (up to fromSeq) and B,
    //    excludes A's divergent turn, does NOT burn seed on bare `/compact`, and NEVER leaks
    //    <handoff_context> into stored User events!
    h.fake.injectHistoryErr = { code: chat.Code.Unsupported, message: 'older codex' };
    const swC = await h.request({ op: chat.Op.Switch, chat: idB, targetKind: FAKE_KIND });
    expect(swC.ok).toBe(true);
    const idC = swC.chat!.id;
    const sessC = await h.fake.session();
    const cAtt = await h.attach(idC, 0);
    await cAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    await sessC.expect('inject_history:4');
    // Failed native inject leaves chat C fresh and seed preserved.
    expect(h.chat(idC).r.fresh).toBe(true);

    // Bare /compact must NOT consume the pending handoff seed.
    await cAtt.command({ op: chat.CommandOp.Prompt, content: text('/compact') });
    await sessC.expect('prompt:/compact');
    sessC.endTurn('end_turn');
    await cAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // First real prompt receives attributed handoff containing BOTH chat A & chat B, without A's divergent turn!
    await cAtt.command({ op: chat.CommandOp.Prompt, content: text('Continue in chat C') });
    const cWire = await sessC.calls.next('C wire prompt');
    expect(cWire).toContain('<handoff_context>');
    expect(cWire).toContain('Initial goal from chat A');
    expect(cWire).toContain('Completed step 2 in chat B.');
    expect(cWire).not.toContain('DIVERGENT_LATER_TURN_IN_A');
    expect(cWire).toContain('Continue in chat C');
    // Stored User event on C must contain ONLY clean user content!
    const cUser = await cAtt.until((e) => e.t === chat.EventType.User && JSON.stringify(e.content).includes('Continue in chat C'));
    expect(cUser.content).toEqual(text('Continue in chat C'));
    sessC.endTurn('end_turn');
    await cAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // 3. Re-switching immediately before sending any prompt (B -> D -> E) preserves full lineage even with 0 turns in D!
    h.fake.nativeHistory = false;
    h.fake.injectHistoryErr = null;
    const swD = await h.request({ op: chat.Op.Switch, chat: idB, targetKind: FAKE_KIND });
    expect(swD.ok).toBe(true);
    const sessD = await h.fake.session();
    const dAtt = await h.attach(swD.chat!.id, 0);
    await dAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    // Delete chat B? Keep B so D->E walks D -> B -> A even with zero turns in D!
    const swE = await h.request({ op: chat.Op.Switch, chat: swD.chat!.id, targetKind: FAKE_KIND });
    expect(swE.ok).toBe(true);
    const sessE = await h.fake.session();
    const eAtt = await h.attach(swE.chat!.id, 0);
    await eAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    await eAtt.command({ op: chat.CommandOp.Prompt, content: text('First prompt on E') });
    const eWire = await sessE.calls.next('E wire prompt');
    expect(eWire).toContain('Initial goal from chat A');
    expect(eWire).toContain('Completed step 2 in chat B.');
    sessE.endTurn('end_turn');
    void sessD;
    aAtt.close();
    bAtt.close();
    cAtt.close();
    dAtt.close();
    eAtt.close();
  });

  test('security & concurrency invariants: stopAgent wipes extraEnv, Full mode skips Plan permissions, rewind/fork guards, and embedded runtime', async () => {
    // 1. stopAgent (via Op.Close) wipes extraEnv; resuming the chat does NOT pass stale vault secrets.
    const h = await host((t) => {
      t.fake.caps.rewind = true;
      t.fake.caps.rewindFiles = true;
      t.fake.caps.fork = true;
      t.fake.config = [
        {
          id: 'mode',
          name: 'Mode',
          category: chat.Category.Mode,
          type: chat.CONFIG_SELECT,
          currentValue: chat.Mode.Default,
          options: [
            { value: chat.Mode.Default, name: 'Default' },
            { value: chat.Mode.AcceptEdits, name: 'Accept Edits' },
            { value: chat.Mode.Full, name: 'Full Access', full: true },
          ],
        },
      ];
    });
    await h.request({ op: chat.Op.Configure, settings: { allowFull: true } });
    const created = await h.request({ op: chat.Op.New, kind: FAKE_KIND, cwd: h.cwd, env: { VAULT_KEY: 'ephemeral-s3cr3t' } });
    expect(created.ok).toBe(true);
    const id = created.chat!.id;
    const s1 = await h.fake.session();
    expect(h.fake.starts.at(-1)!.env.VAULT_KEY).toBe('ephemeral-s3cr3t');
    const a = await h.attach(id, 0);
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // 2. Switching to Full mode auto-approves Command permissions, NEVER Plan permissions!
    await a.command({ op: chat.CommandOp.Prompt, content: text('turn one') });
    await s1.expect('prompt:turn one');
    const u1 = await a.until((e) => e.t === chat.EventType.User);
    const planPerm = s1.permission(chat.PermissionKind.Plan);
    const permEv = await a.until((e) => e.t === chat.EventType.Permission && e.kind === chat.PermissionKind.Plan);
    expect(await a.command({ op: chat.CommandOp.SetConfig, config: 'mode', value: chat.Mode.Full })).toBeUndefined();
    // Plan permission MUST still be pending (not auto-approved by Full mode).
    let planSettled = false;
    void planPerm.then(() => {
      planSettled = true;
    });
    await Bun.sleep(20);
    expect(planSettled).toBe(false);
    // Cancel the plan permission and finish Turn 1, including a mid-turn steered Queued(Taken) event.
    await a.command({ op: chat.CommandOp.Permission, request: permEv.id!, cancelled: true });
    s1.sink.event({
      t: chat.EventType.Queued,
      message: 'steered-mid',
      content: text('mid turn steer'),
      state: chat.QueuedState.Taken,
    });
    const steeredEv = await a.until((e) => e.t === chat.EventType.Queued && e.state === chat.QueuedState.Taken);
    s1.endTurn('end_turn');
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);

    // 3. Rewind refuses a mid-turn steered Queued(Taken) target with BadRequest!
    const badRewind = await a.command({ op: chat.CommandOp.Rewind, seq: steeredEv.seq! });
    expect(badRewind?.code).toBe(chat.Code.BadRequest);

    // 4. Putting the chat to sleep (calls stopAgent) wipes extraEnv; rewinding wakes the sleeping
    //    chat before checking capabilities.rewind, passes NO VAULT_KEY, and marks r.fresh = true on
    //    Turn-1 rewind even when restoreFiles: true!
    const stopped = h.chat(id).stopAgent(chat.State.Sleeping);
    await h.host.endSession(stopped, false);
    await a.until((e) => e.t === chat.EventType.State && e.state === chat.State.Sleeping);
    // Configure fake adapter so Turn-1 rewind returns { sessionId: 'fresh-sid', fresh: true }.
    const origStart = h.fake.start.bind(h.fake);
    h.fake.start = async (p, sink, signal) => {
      const sess = await origStart(p, sink, signal);
      sess.rewind = async () => ({ sessionId: 'fresh-after-t1', fresh: true });
      return sess;
    };
    const rwPromise = a.command({ op: chat.CommandOp.Rewind, seq: u1.seq!, restoreFiles: true });
    await h.fake.session();
    expect(await rwPromise).toBeUndefined();
    expect(h.fake.starts.at(-1)!.env.VAULT_KEY).toBeUndefined();
    expect(h.chat(id).r.fresh).toBe(true);
    a.close();

    // 5. Embedded runtime adapter (meta.runtime = 'embedded', argv = [], pid = 0, available())
    //    works end-to-end in Host without any PATH lookup or signalGroup calls.
    let embeddedAvailable = false;
    const hEmb = await host((t) => {
      const origSpec = t.o.spec;
      t.o.spec = (kind) => (kind === 'pi' ? { adapter: AdapterKind.ACP, argv: [], runtime: 'embedded' } : origSpec(kind));
      const embAdapter: Adapter = {
        meta: { runtime: 'embedded', handoffInjection: 'attributed_context', partialForkBy: 'none' },
        available: async () => embeddedAvailable,
        start: async (p, sink, signal) => {
          const sess = await t.fake.start({ ...p, argv: ['/bin/sh'] }, sink, signal);
          Object.defineProperty(sess, 'pid', { value: 0 });
          return sess;
        },
        sessions: async () => ({ sessions: [], next: '' }),
        history: async () => {},
        models: async () => [{ value: 'pi-1', name: 'Pi 1' }],
      };
      t.o.adapters = { ...t.o.adapters, [AdapterKind.ACP]: embAdapter };
    });
    // When available() returns false, Op.Agents reports unavailable without PATH error.
    const a1 = await hEmb.request({ op: chat.Op.Agents, kinds: ['pi'] });
    expect(a1.agents).toEqual([{ kind: 'pi', available: false, reason: 'not_found' }]);
    // When available() returns true, Op.Agents reports available and Op.New starts cleanly with pid = 0.
    embeddedAvailable = true;
    const a2 = await hEmb.request({ op: chat.Op.Agents, kinds: ['pi'] });
    expect(a2.agents).toEqual([{ kind: 'pi', available: true }]);
    const piNew = await hEmb.request({ op: chat.Op.New, kind: 'pi', cwd: hEmb.cwd });
    expect(piNew.ok).toBe(true);
    const piSess = await hEmb.fake.session();
    expect(piSess.pid).toBe(0);
    const piAtt = await hEmb.attach(piNew.chat!.id, 0);
    await piAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    await piAtt.command({ op: chat.CommandOp.Prompt, content: text('hello embedded') });
    await piSess.expect('prompt:hello embedded');
    piSess.endTurn('end_turn');
    await piAtt.until((e) => e.t === chat.EventType.State && e.state === chat.State.Idle);
    piAtt.close();
  });
});

void writeFileSync;
void mkdtempSync;
void tmpdir;
