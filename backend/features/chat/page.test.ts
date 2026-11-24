import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import * as chat from '#shared/proto/chatproto/index.ts';
import { waitFor } from '#kernel/testing.ts';
import { MAX_AUDIT } from './audit.ts';
import { Sub } from './page.ts';
import { errCode, rig, testChat, type Msg, type Rig, type RigOptions } from './testing.ts';
import { MAX_PAGE_ID, MAX_SUBS, MAX_SUBS_PER_MACHINE } from './wire.ts';

const rigs: Rig[] = [];
const start = async (o: RigOptions = {}) => {
  const r = await rig(o);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.stop();
});

/** Makes a chat of the fake host. */
const newChat = (r: Rig, state: string = chat.State.Idle) => {
  const id = chat.newChatID();
  r.host.chats.set(id, testChat({ id, state }));
  return id;
};
const attachedN = (r: Rig, n: number) => waitFor(`${n} attached`, () => r.host.attached.size === n);
/** The audit records of the chats' commands. */
const chatAudits = (r: Rig) => r.audit.records().filter((a) => String(a.event).startsWith('chat.'));
const ev = (m: Msg) => m.ev as Record<string, unknown>;

describe('page', () => {
  // A page attaches to a chat and gets its events as the host sends them;
  // its commands reach the host under the core's ids, and each host's
  // answer reaches the page under the page's; those that decide what an
  // agent may do are audited, without what was answered.
  test('relay', async () => {
    const r = await start();
    const id = newChat(r);
    const pg = await r.page();
    pg.send({ op: 'attach', sub: 's1', m: 'gpu', chat: id, from: 3 });
    expect(await pg.expect('attached')).toMatchObject({ sub: 's1', first: 1, chat: { id } });
    await attachedN(r, 1);
    expect(r.host.requests.at(-1)).toEqual({ op: 'attach', chat: id, from: 3 });
    await r.host.emit(id, { seq: 4, t: 'user', clientId: 'u1', content: [{ type: 'text', text: '<b>hi</b>' }] });
    await r.host.emit(id, { t: 'update', live: true, item: 'm1', update: { sessionUpdate: 'agent_message_chunk' } });
    let m = await pg.expect('event');
    expect(m.sub).toBe('s1');
    expect(ev(m)).toEqual({ seq: 4, t: 'user', clientId: 'u1', content: [{ type: 'text', text: '<b>hi</b>' }] });
    expect(ev(await pg.expect('event')).live).toBe(true);

    pg.send({
      op: 'command',
      id: 'p1',
      m: 'gpu',
      chat: id,
      cmd: { op: 'prompt', id: 'x', clientId: 'u2', content: [{ type: 'text', text: 'secret prompt' }] },
    });
    expect(await pg.expect('ack')).toEqual({ t: 'ack', id: 'p1' });
    pg.send({ op: 'command', id: 'p2', m: 'gpu', chat: id, cmd: { op: 'permission', request: 'r1', option: 'allow_once' } });
    await pg.expect('ack');
    pg.send({ op: 'command', id: 'p3', m: 'gpu', chat: id, cmd: { op: 'answer', request: 'q1', answers: { a: ['hunter2'] } } });
    await pg.expect('ack');
    r.host.ackErr.set('set_config', { code: chat.Code.NotAllowed, message: 'full access is off' });
    pg.send({ op: 'command', id: 'p4', m: 'gpu', chat: id, cmd: { op: 'set_config', config: 'mode', value: 'full' } });
    m = await pg.expect('ack');
    expect([m.id, errCode(m)]).toEqual(['p4', 'not_allowed']);
    expect(r.host.commands.map((c) => `${c.op}:${c.id}`)).toEqual(['prompt:k1', 'permission:k2', 'answer:k3', 'set_config:k4']);
    expect(r.host.commands[0]).toEqual({ op: 'prompt', id: 'k1', content: [{ type: 'text', text: 'secret prompt' }], clientId: 'u2' });
    const audits = chatAudits(r);
    expect(JSON.stringify(audits)).not.toMatch(/hunter2|secret prompt/);
    const base = { plugin: 'chat', machine: 'gpu', chat: id, remote: '127.0.0.1' };
    expect(audits).toEqual([
      expect.objectContaining({ ...base, event: 'chat.permission', request: 'r1', option: 'allow_once', status: 200 }),
      expect.objectContaining({ ...base, event: 'chat.answer', request: 'q1', questions: 1, status: 200 }),
      expect.objectContaining({ ...base, event: 'chat.set_config', config: 'mode', value: 'full', error: 'not_allowed', status: 403 }),
    ]);
    expect(audits[0]).not.toHaveProperty('error');
  });

  // A read-only core takes attaches and refuses every command, audited; it
  // leaves out the agents' standard error and starts nothing.
  test('read-only', async () => {
    const id = chat.newChatID();
    const failed = (stderr: string) =>
      testChat({ id, kind: 'claude', state: chat.State.Failed, error: { code: chat.Code.StartFailed, message: 'm', stderr } });
    const r = await start({ readOnly: true, host: (h) => h.chats.set(id, failed('TOKEN=1')) });
    const pg = await r.page();
    pg.send({ op: 'attach', sub: 's1', m: 'gpu', chat: id });
    let m = await pg.expect('attached');
    expect(JSON.stringify(m)).not.toContain('TOKEN');
    expect(JSON.stringify(m)).toContain('start_failed');
    await attachedN(r, 1);
    // Its attach starts nothing on the machine (no catch-up).
    expect(r.host.requests.at(-1)).toEqual({ op: 'attach', chat: id, noCatchUp: true });
    await r.host.emit(id, { seq: 2, t: 'state', state: 'failed', error: { code: 'failed', message: 'm', stderr: 'TOKEN=2' } });
    m = await pg.expect('event');
    expect(JSON.stringify(m)).not.toContain('TOKEN');
    expect(ev(m).seq).toBe(2);
    await r.host.emit(id, { t: 'info', live: true, chat: failed('TOKEN=3') });
    m = await pg.expect('event');
    expect(JSON.stringify(m)).not.toContain('TOKEN');
    expect(JSON.stringify(m)).toContain('start_failed');
    pg.send({ op: 'command', id: 'p1', m: 'gpu', chat: id, cmd: { op: 'prompt' } });
    m = await pg.expect('ack');
    expect([m.id, errCode(m)]).toEqual(['p1', 'read_only']);
    await Bun.sleep(20);
    expect(r.host.commands).toEqual([]);
    expect(chatAudits(r)).toEqual([expect.objectContaining({ event: 'chat.prompt', error: 'read_only', status: 403, chat: id })]);
    // It starts no host.
    r.host.end(false);
    await pg.expect('detached');
    pg.send({ op: 'attach', sub: 's2', m: 'gpu', chat: id });
    m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['s2', 'not_running']);
    expect(r.host.opens.at(-1)).toBe(false);
  });

  // A page has at most MAX_SUBS_PER_MACHINE subscriptions of a machine and
  // MAX_SUBS in all; an attach under an id it has replaces that one.
  test('limits', async () => {
    const r = await start();
    await r.setEnabled('box', true);
    const pg = await r.page();
    for (let i = 0; i < MAX_SUBS; i++) {
      pg.send({ op: 'attach', sub: `s${i}`, m: i < MAX_SUBS_PER_MACHINE ? 'gpu' : 'box', chat: newChat(r) });
      await pg.expect('attached');
    }
    pg.send({ op: 'attach', sub: 'more', m: 'other', chat: newChat(r) });
    let m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['more', 'too_many']);
    pg.send({ op: 'detach', sub: 's0' });
    pg.send({ op: 'attach', sub: 'more', m: 'box', chat: newChat(r) });
    m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['more', 'too_many']);
    const id = newChat(r);
    pg.send({ op: 'attach', sub: 's1', m: 'gpu', chat: id });
    m = await pg.expect('attached');
    expect((m.chat as chat.Chat).id).toBe(id);
    await attachedN(r, MAX_SUBS - 1);
    for (const bad of [
      { op: 'attach', sub: 'bad', m: 'gpu', chat: 'c1' },
      { op: 'attach', sub: 'bad', chat: id },
      { op: 'attach', sub: 'bad', m: 'x'.repeat(MAX_PAGE_ID + 1), chat: id },
    ]) {
      pg.send(bad);
      m = await pg.expect('detached');
      expect([m.sub, errCode(m)]).toEqual(['bad', 'bad_request']);
    }
    // Messages that are not of the protocol, and subscriptions without an
    // id, are passed over.
    pg.sendRaw('{');
    pg.send({ op: 'attach', sub: 7, m: 'gpu', chat: id });
    pg.send({ op: 'attach', m: 'gpu', chat: id });
    pg.send({ op: 'attach', sub: 'x', m: 'gpu', chat: id, from: -1 });
    pg.send({ op: 'detach', sub: 'none' });
    m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['none', 'unknown_sub']);
  });

  // A subscription ends when the page detaches it, when the chat host's
  // connection ends (lost, or offline with the machine) and when the host
  // refuses it; each command that waits gets its answer then.
  test('ends', async () => {
    const r = await start();
    const f = r.host;
    const id = newChat(r, chat.State.Working);
    const pg = await r.page();

    pg.send({ op: 'detach', sub: 'none' });
    let m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['none', 'unknown_sub']);
    pg.send({ op: 'command', id: 'p0', m: 'gpu', chat: id, cmd: { op: 'cancel' } });
    m = await pg.expect('ack');
    expect([m.id, errCode(m)]).toEqual(['p0', 'not_attached']);
    pg.send({ op: 'command', id: 'p0', m: 'gpu', chat: id, cmd: { op: 'rm' } });
    expect(errCode(await pg.expect('ack'))).toBe('bad_request');
    pg.send({ op: 'attach', sub: 'u', m: 'gpu', chat: chat.newChatID() });
    m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['u', 'unknown_chat']);

    f.holdAcks = true;
    pg.send({ op: 'attach', sub: 's1', m: 'gpu', chat: id });
    await pg.expect('attached');
    pg.send({ op: 'command', id: 'p1', m: 'gpu', chat: id, cmd: { op: 'handoff' } });
    await waitFor('the command', () => f.commands.length === 1);
    pg.send({ op: 'detach', sub: 's1' });
    m = await pg.expect('ack');
    expect([m.id, errCode(m)]).toEqual(['p1', 'not_attached']);
    await attachedN(r, 0);

    pg.send({ op: 'attach', sub: 's2', m: 'gpu', chat: id });
    await pg.expect('attached');
    pg.send({ op: 'command', id: 'p2', m: 'gpu', chat: id, cmd: { op: 'cancel' } });
    await waitFor('the command', () => f.commands.length === 2);
    f.end(true);
    m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['s2', 'lost']);
    m = await pg.expect('ack');
    expect([m.id, errCode(m)]).toEqual(['p2', 'lost']);

    pg.send({ op: 'attach', sub: 's3', m: 'gpu', chat: id });
    await pg.expect('attached');
    await r.setEnabled('gpu', false);
    m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['s3', 'offline']);
    pg.send({ op: 'attach', sub: 's4', m: 'gpu', chat: id });
    m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['s4', 'offline']);
  });

  // Turning the feature off ends every subscription and the page's
  // WebSocket.
  test('the feature turned off', async () => {
    const r = await start();
    r.start();
    const id = newChat(r);
    const pg = await r.page();
    pg.send({ op: 'attach', sub: 's1', m: 'gpu', chat: id });
    await pg.expect('attached');
    r.settings.set('plugins.chat.enabled', '', false);
    const m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['s1', 'plugin_disabled']);
    expect(await pg.closed()).toBe(1001);
    await attachedN(r, 0);
  });

  // A large replay to a page that does not take it as fast as it comes
  // fills only that subscription's share of the page's backlog: the core
  // stops reading it from the host, which drops that connection; the page
  // hears lost once it took what was sent and attaches again from its last
  // sequence number, while its other chats go on and its WebSocket stays.
  test('flow control', async () => {
    const r = await start({
      limits: { backlogMessages: 64, backlogBytes: 256 << 10, pageBuffered: 1 },
      host: (h) => (h.dropAfterMs = 100),
    });
    const big = newChat(r, chat.State.Working);
    const small = newChat(r);
    const pg = await r.page();
    pg.send({ op: 'attach', sub: 's1', m: 'gpu', chat: big });
    await pg.expect('attached');
    pg.send({ op: 'attach', sub: 's2', m: 'gpu', chat: small });
    await pg.expect('attached');
    await attachedN(r, 2);
    pg.pause(true);
    const text = randomBytes(32 << 10).toString('hex');
    for (let i = 1; i <= 4096 && r.host.attachedTo(big) > 0; i++)
      await r.host.emit(big, { seq: i, t: 'update', item: 'm', update: { text } });
    await waitFor('the host to drop the slow connection', () => r.host.attachedTo(big) === 0);
    expect(r.hub.pages.size).toBe(1);
    pg.pause(false);
    let last = 0;
    for (;;) {
      const m = await pg.next();
      if (m.t === 'event' && m.sub === 's1') {
        expect(ev(m).seq).toBe(last + 1);
        last = ev(m).seq as number;
        continue;
      }
      expect([m.t, m.sub, errCode(m)]).toEqual(['detached', 's1', 'lost']);
      break;
    }
    expect(last).toBeGreaterThan(0);
    // The page's other chat goes on.
    await r.host.emit(small, { seq: 1, t: 'turn', state: 'start' });
    expect((await pg.expect('event')).sub).toBe('s2');
    pg.send({ op: 'command', id: 'p1', m: 'gpu', chat: small, cmd: { op: 'cancel' } });
    expect(await pg.expect('ack')).toEqual({ t: 'ack', id: 'p1' });
    // It attaches again after what it has.
    pg.send({ op: 'attach', sub: 's3', m: 'gpu', chat: big, from: last });
    await pg.expect('attached');
    expect(r.host.requests.at(-1)).toEqual({ op: 'attach', chat: big, from: last });
  });

  // What only the core sends (answers, ends of subscriptions) is bounded by
  // the page's backlog, the events of its subscriptions by their shares: a
  // page that falls behind on the former is disconnected (try again later).
  test("the core's own messages overflow", async () => {
    const r = await start({ limits: { backlogMessages: 16, backlogBytes: 256 << 10, pageBuffered: 1 } });
    const pg = await r.page();
    await waitFor('the page', () => r.hub.pages.size === 1);
    const page = [...r.hub.pages][0];
    pg.pause(true);
    const data = new Sub(page, 'x', 'gpu', chat.newChatID(), 0);
    for (let i = 0; i < 4 * 16; i++) page.enqueue('{"t":"event","sub":"x","ev":{"t":"update"}}', data);
    const afterData = page.closed;
    for (let i = 0; i < 16 / 2 + 1; i++) page.enqueue('{"t":"ack","id":"k"}');
    expect([afterData, page.closed]).toEqual([false, true]);
    expect(await pg.closed()).toBe(1013);
  });

  // A page that takes nothing for pageWriteMs is disconnected.
  test('a page that takes nothing', async () => {
    const r = await start({ limits: { pageBuffered: 1 }, timing: { pageWriteMs: 50 } });
    const id = newChat(r);
    const pg = await r.page();
    pg.send({ op: 'attach', sub: 's1', m: 'gpu', chat: id });
    await pg.expect('attached');
    pg.pause(true);
    await r.host.emit(id, { seq: 1, t: 'turn', state: 'start' });
    await r.host.emit(id, { seq: 2, t: 'turn', state: 'end' });
    expect(await pg.closed()).toBe(1013);
    await attachedN(r, 0);
  });

  // Before an attach, on which a prompt may start the chat's agent, the
  // host process the core reaches takes the machine's settings unless it
  // took them as they are: a host started again (another pid) takes them
  // anew, and so after the settings changed.
  test('configures', async () => {
    const r = await start();
    r.settings.onChange((ch) => r.hub.settingsChanged(ch, AbortSignal.timeout(5000)));
    const id = newChat(r, chat.State.Sleeping);
    const pg = await r.page();
    const attach = async (sub: string) => {
      const n = r.host.requests.length;
      pg.send({ op: 'attach', sub, m: 'gpu', chat: id });
      await pg.expect('attached');
      return r.host.ops(n);
    };
    expect(await attach('s1')).toEqual(['configure', 'attach']);
    expect(await attach('s2')).toEqual(['attach']);
    r.host.pid = 7;
    r.host.end(true);
    await pg.expect('detached');
    await pg.expect('detached');
    expect(await attach('s3')).toEqual(['configure', 'attach']);
    r.settings.set('chat.allowFullAccess', 'gpu', true);
    expect(await attach('s4')).toEqual(['configure', 'attach']);
    expect(r.host.requests.filter((q) => q.op === 'configure' && !q.settings)).toEqual([]);
    expect(r.host.requests.at(-2)?.settings?.allowFull).toBe(true);
  });

  // The core keeps at most maxHostConns connections to a machine's chat
  // host, the last reservedConns for the watch and the configures: beyond,
  // a subscription or a request is refused (too_many).
  test('connections to a host', async () => {
    const r = await start({ limits: { maxHostConns: 5, reservedConns: 2 } });
    const pg = await r.page();
    for (let i = 0; i < 3; i++) {
      pg.send({ op: 'attach', sub: `s${i}`, m: 'gpu', chat: newChat(r) });
      await pg.expect('attached');
    }
    pg.send({ op: 'attach', sub: 'more', m: 'gpu', chat: newChat(r) });
    const m = await pg.expect('detached');
    expect([m.sub, errCode(m)]).toEqual(['more', 'too_many']);
    expect(await r.call('GET', '/api/m/gpu/p/chat/chats')).toMatchObject([409, { error: 'too_many' }]);
    // The watch and its configure have their own.
    r.start();
    await waitFor('the watch', () => r.host.watchers.size === 1);
    await waitFor('its configure', () => r.host.count('configure') >= 2);
    // A subscription that ends gives its connection back.
    pg.send({ op: 'detach', sub: 's0' });
    await attachedN(r, 2);
    await waitFor('the connection back', () => r.hub.link.count('gpu').open === 2);
    pg.send({ op: 'attach', sub: 'again', m: 'gpu', chat: newChat(r) });
    expect((await pg.expect('attached')).sub).toBe('again');
  });

  // A command that names no machine or chat is refused without a record;
  // what a page gives is clipped in the records, and of its refusals of one
  // operation, one is written per refusalGapMs, the next one counting those
  // in between.
  test('audit bounds', async () => {
    const r = await start({ readOnly: true });
    const id = newChat(r);
    const pg = await r.page();
    for (const bad of [
      { op: 'command', id: 'b1', m: 'm'.repeat(MAX_PAGE_ID + 1), chat: id, cmd: { op: 'prompt' } },
      { op: 'command', id: 'b2', m: 'gpu', chat: '../x', cmd: { op: 'prompt' } },
      { op: 'command', id: 'b3', chat: id, cmd: { op: 'prompt' } },
    ]) {
      pg.send(bad);
      const m = await pg.expect('ack');
      expect([m.id, errCode(m)]).toEqual([bad.id, 'bad_request']);
    }
    const long = 'é'.repeat(400);
    for (let i = 0; i < 5; i++) {
      pg.send({ op: 'command', id: `c${i}`, m: 'gpu', chat: id, cmd: { op: 'set_config', config: 'mode', value: long } });
      expect(errCode(await pg.expect('ack'))).toBe('read_only');
    }
    pg.send({ op: 'command', id: 'p0', m: 'gpu', chat: id, cmd: { op: 'prompt' } });
    await pg.expect('ack');
    r.advance(10_000);
    pg.send({ op: 'command', id: 'c5', m: 'gpu', chat: id, cmd: { op: 'set_config', config: 'mode', value: 'x' } });
    await pg.expect('ack');
    const audits = chatAudits(r);
    expect(audits.map((a) => `${a.event} repeated=${a.repeated}`)).toEqual([
      'chat.set_config repeated=undefined',
      'chat.prompt repeated=undefined',
      'chat.set_config repeated=4',
    ]);
    for (const a of audits) expect([a.machine, a.chat]).toEqual(['gpu', id]);
    const v = audits[0].value as string;
    expect(Buffer.byteLength(v)).toBeLessThanOrEqual(MAX_AUDIT + Buffer.byteLength('…'));
    expect(long.startsWith(v.slice(0, -1))).toBe(true);
    expect(v.endsWith('…')).toBe(true);
  });

  // One WebSocket carries the subscriptions of several chats of several
  // machines, each with its own connection to the host: the events of a
  // chat reach each of its subscriptions, under its id; a command is sent
  // on one of them and answered once.
  test('multiplexes', async () => {
    const r = await start();
    await r.setEnabled('box', true);
    const one = newChat(r);
    const two = newChat(r);
    const pg = await r.page();
    for (const [sub, m, id] of [
      ['a', 'gpu', one],
      ['b', 'box', two],
      ['c', 'gpu', one],
    ]) {
      pg.send({ op: 'attach', sub, m, chat: id });
      await pg.expect('attached');
    }
    await attachedN(r, 3);
    await r.host.emit(two, { seq: 1, t: 'turn', state: 'start' });
    expect((await pg.expect('event')).sub).toBe('b');
    await r.host.emit(one, { seq: 5, t: 'turn', state: 'end' });
    const got = new Set<unknown>();
    for (let i = 0; i < 2; i++) {
      const m = await pg.expect('event');
      expect(ev(m).seq).toBe(5);
      got.add(m.sub);
    }
    expect([...got].sort()).toEqual(['a', 'c']);
    pg.send({ op: 'command', id: 'p1', m: 'gpu', chat: one, cmd: { op: 'compact' } });
    expect((await pg.expect('ack')).id).toBe('p1');
    pg.send({ op: 'command', id: 'p2', m: 'box', chat: one, cmd: { op: 'compact' } });
    const m = await pg.expect('ack');
    expect([m.id, errCode(m)]).toEqual(['p2', 'not_attached']);
    expect(r.host.commands.length).toBe(1);
  });
});
