import { afterEach, describe, expect, test } from 'bun:test';
import * as chat from '#shared/proto/chatproto/index.ts';
import { sleep, waitFor } from '#kernel/testing.ts';
import { backoff, MAX_FAILURES } from './watch.ts';
import { chatState, rig, type Rig, type RigOptions } from './testing.ts';
import type { StatesData } from './wire.ts';

const rigs: Rig[] = [];
const start = async (o: RigOptions = {}) => {
  const r = await rig(o);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.stop();
});

const last = (r: Rig) => r.broadcasts.at(-1)!.data as unknown as StatesData;
const states = (r: Rig) => r.broadcasts.length;

describe('watch', () => {
  // The core reads every chat's state when it watches a host, sends them to
  // the pages in full and then each change, numbered; it notifies of chats
  // that became blocked or done, once each, and of the first states it
  // reads only of the blocked ones.
  test('states and notifications', async () => {
    const a = chatState(chat.Status.Blocked, chat.State.Waiting, 5);
    const b = chatState(chat.Status.Done, chat.State.Idle, 7);
    const c = chatState(chat.Status.Working, chat.State.Working, 3);
    const r = await start({ host: (h) => (h.states = [a, b, c]) });
    r.start();
    await waitFor('the full states', () => states(r) === 1);
    expect(r.broadcasts[0].m).toBe('gpu');
    expect(last(r)).toMatchObject({ t: 'states', full: true, rev: 1, hostVersion: 'test' });
    expect(last(r).states.length).toBe(3);
    await waitFor("the blocked chat's notification", () => r.notes.length === 1);
    await waitFor('a configure', () => r.host.count('configure') === 1);
    expect(r.host.opens[0]).toBe(false);
    expect(r.host.requests[0].op).toBe('watch');
    for (const q of r.host.requests) if (q.op === 'configure') expect(q.settings).toEqual(chat.defaultHostSettings());
    expect(r.notes[0]).toEqual({
      agent: 'claude',
      agent_status: 'blocked',
      chat: a.id,
      display_agent: 'Claude Code',
      terminal: '',
      title: 't',
      m: 'gpu',
    });

    // A notification follows its change's states; one too many shows by
    // the next change.
    let had = 1;
    const step = async (st: chat.ChatState, notes: number) => {
      expect(r.notes.length).toBe(had);
      const n = states(r);
      r.host.change({ ...st });
      await waitFor('the change', () => states(r) === n + 1 && r.notes.length >= notes);
      expect(last(r)).toEqual({ t: 'states', states: [st], full: false, rev: n + 1, hostVersion: 'test' });
      had = notes;
    };
    Object.assign(c, { state: chat.State.Idle, status: chat.Status.Done, seq: 9 });
    await step(c, 2);
    c.title = 'renamed';
    await step(c, 2);
    Object.assign(a, { state: chat.State.Working, status: chat.Status.Working, seq: 6 });
    await step(a, 2);
    Object.assign(a, { state: chat.State.Waiting, status: chat.Status.Blocked, seq: 8 });
    await step(a, 3);
    c.status = chat.Status.Idle;
    await step(c, 3);
    b.state = chat.State.Deleted;
    await step(b, 3);

    const [code, out] = await r.call('GET', '/api/p/chat/states');
    const gpu = (out.machines as Record<string, StatesData>).gpu;
    expect([code, gpu.rev, gpu.full, gpu.states.length]).toEqual([200, 7, true, 2]);
    expect(out.machines).not.toHaveProperty('box');
  });

  // A chat done again after a gap in the watch (a turn ran and ended while
  // the core did not watch) is told again; one whose state is as it was is
  // not, nor one that only changed its title while done.
  test('done across a gap', async () => {
    const c = chatState(chat.Status.Working, chat.State.Working, 3);
    const r = await start({ host: (h) => (h.states = [c]) });
    r.start();
    await waitFor('the states', () => states(r) === 1);
    Object.assign(c, { state: chat.State.Idle, status: chat.Status.Done, seq: 5 });
    r.host.change({ ...c });
    await waitFor('done', () => r.notes.length === 1);
    // Another turn runs and ends while the watch is down.
    c.seq = 9;
    r.host.states[0] = { ...c };
    r.host.end(true);
    await waitFor('done again', () => r.notes.length === 2);
    expect(r.notes[1]).toMatchObject({ chat: c.id, agent_status: 'done' });
    // A gap after which it is as it was tells nothing; a live change of
    // its title neither.
    const n = states(r);
    r.host.end(true);
    await waitFor('the states again', () => states(r) === n + 1);
    r.host.change({ ...c, title: 'renamed' });
    await waitFor('the change', () => states(r) === n + 2);
    await sleep(30);
    expect(r.notes.length).toBe(2);
  });

  // After its host ended the core watches again, and notifies of what
  // became blocked or done meanwhile, not of what it told before.
  test('again', async () => {
    const a = chatState(chat.Status.Blocked, chat.State.Waiting, 5);
    const c = chatState(chat.Status.Working, chat.State.Working, 3);
    const r = await start({ host: (h) => (h.states = [a, c]) });
    r.start();
    await waitFor('the states', () => states(r) === 1 && r.notes.length === 1);
    r.host.states[1] = { ...c, state: chat.State.Idle, status: chat.Status.Done, seq: 10 };
    r.host.end(true);
    await waitFor('the states again', () => states(r) === 2);
    expect(last(r)).toMatchObject({ full: true, rev: 2 });
    await waitFor("the done chat's notification", () => r.notes.length === 2);
    expect(r.notes[1]).toMatchObject({ chat: c.id, agent_status: 'done' });
    await sleep(50);
    expect(r.notes.length).toBe(2);
  });

  // A watch starts no host: with none serving, the core waits for a change
  // or a page to use the machine's. A host the core knew of agents in that
  // is gone left them sleeping.
  test('starts no host', async () => {
    const r = await start({ host: (h) => (h.running = false) });
    r.start();
    await waitFor("the watch's try", () => r.host.opens.length === 1);
    await sleep(50);
    expect(r.host.opens).toEqual([false]);
    expect(r.host.running).toBe(false);
    expect(states(r)).toBe(0);

    const c = chatState(chat.Status.Working, chat.State.Working, 3);
    r.host.states = [c];
    expect((await r.call('GET', '/api/m/gpu/p/chat/chats'))[0]).toBe(409);
    expect((await r.call('POST', '/api/m/gpu/p/chat/agents'))[0]).toBe(200);
    await waitFor('the states', () => states(r) === 1);

    r.host.end(false);
    await waitFor('the stale states', () => states(r) === 2);
    expect(last(r)).toEqual({ t: 'states', states: [{ ...c, state: 'sleeping', status: 'idle' }], full: false, rev: 2 });
    expect(r.host.running).toBe(false);
    expect(r.host.opens.at(-1)).toBe(false);
  });

  // The core stops watching a host when none of its chats runs an agent, no
  // page is attached and nothing used it for a while: the host can end.
  test('lets a quiet host go', async () => {
    const working = chatState(chat.Status.Working, chat.State.Working, 2);
    const r = await start({ host: (h) => (h.states = [chatState(chat.Status.Idle, chat.State.Sleeping, 3)]) });
    r.start();
    await waitFor('the watch', () => r.host.watchers.size === 1);
    r.host.change({ ...working });
    await waitFor('the change', () => states(r) === 2);
    r.advance(120_000);
    await sleep(30);
    expect(r.host.watchers.size).toBe(1);
    r.host.change({ ...working, state: chat.State.Sleeping, status: chat.Status.Idle });
    await waitFor('the watch to end', () => r.host.watchers.size === 0);
    const n = r.host.opens.length;
    await sleep(30);
    expect(r.host.opens.length).toBe(n);
    // A use of the host makes the core watch it again.
    expect((await r.call('GET', '/api/m/gpu/p/chat/chats'))[0]).toBe(200);
    await waitFor('the watch again', () => r.host.watchers.size === 1);
  });

  // The host gets the machine's settings when they change, the machine's
  // own or everyone's; a read-only core configures nothing.
  test('configures', async () => {
    const r = await start();
    r.start();
    await waitFor('a configure', () => r.host.count('configure') === 1);
    r.settings.set('chat.maxLive', 'gpu', 3);
    await waitFor('a configure', () => r.host.count('configure') === 2);
    r.settings.set('chat.permissionMode', '', chat.Mode.Plan);
    await waitFor('a configure', () => r.host.count('configure') === 3);
    expect(r.host.requests.at(-1)?.settings).toMatchObject({ maxLive: 3, defaultMode: 'plan' });
    r.settings.set('chat.maxLive', 'box', 4);
    await sleep(30);
    expect(r.host.count('configure')).toBe(3);

    const ro = await start({ readOnly: true });
    ro.start();
    await waitFor('the watch', () => ro.host.watchers.size === 1);
    await sleep(30);
    expect(ro.host.count('configure')).toBe(0);
  });

  // The watch ends with the machine's connection and with the feature; a
  // machine without a chat host is not asked again until it connects
  // again.
  test('follows the machine and the feature', async () => {
    const r = await start();
    r.start();
    await waitFor('the watch', () => r.host.watchers.size === 1);
    await r.setEnabled('gpu', false);
    await waitFor('the watch to end', () => r.host.watchers.size === 0);
    await r.setEnabled('gpu', true);
    await waitFor('the watch again', () => r.host.watchers.size === 1);
    r.settings.set('plugins.chat.enabled', '', false);
    await waitFor('the watch to end', () => r.host.watchers.size === 0);
    r.settings.set('plugins.chat.enabled', '', true);
    await waitFor('the watch again', () => r.host.watchers.size === 1);

    const o = await start({ host: (h) => (h.openErr = 'unknown_plugin') });
    o.start();
    await waitFor('a try', () => o.host.opens.length === 1);
    await sleep(50);
    expect(o.host.opens.length).toBe(1);
    await o.setEnabled('gpu', false);
    await o.setEnabled('gpu', true);
    await waitFor('a try after the machine connected again', () => o.host.opens.length === 2);
  });

  // A failing watch is tried again, waiting longer each time, and given up
  // after MAX_FAILURES until the host is used.
  test('retries', async () => {
    expect([backoff(1000, 1), backoff(1000, 3), backoff(1000, 20)]).toEqual([1000, 4000, 300_000]);
    const r = await start({ host: (h) => (h.openErr = 'transport') });
    r.start();
    await waitFor('the tries', () => r.host.opens.length === MAX_FAILURES);
    await sleep(50);
    expect(r.host.opens.length).toBe(MAX_FAILURES);
    r.host.openErr = '';
    await r.call('GET', '/api/m/gpu/p/chat/chats');
    await waitFor('the watch', () => r.host.watchers.size === 1);
  });

  // When a machine goes offline, live and blocked chats in the core's cache
  // are marked stale and sleeping so they do not appear working or blocked
  // while it is away, and fresh states clear the stale flag on reconnect.
  test('an offline machine marks its states stale', async () => {
    const working = chatState(chat.Status.Working, chat.State.Working, 2);
    const blocked = chatState(chat.Status.Blocked, chat.State.Waiting, 4);
    const done = { ...chatState(chat.Status.Done, chat.State.Idle, 6), unread: true };
    const r = await start({ host: (h) => (h.states = [working, blocked, done]) });
    r.start();
    await waitFor('initial states', () => states(r) === 1);

    await r.setEnabled('gpu', false);
    await waitFor('the stale states', () => states(r) === 2);
    expect(last(r)).toMatchObject({ full: true, stale: true });
    const byID = new Map(last(r).states.map((s) => [s.id, s]));
    expect(byID.get(working.id)).toMatchObject({ stale: true, state: 'sleeping', status: 'idle' });
    expect(byID.get(blocked.id)).toMatchObject({ stale: true, state: 'sleeping', status: 'idle' });
    expect(byID.get(done.id)).toMatchObject({ stale: true, state: 'sleeping', status: 'done', unread: true });
    const snap = r.board.watch.snapshot().machines.gpu;
    expect([snap.stale, snap.states.length]).toEqual([true, 3]);

    await r.setEnabled('gpu', true);
    await waitFor('the states again', () => states(r) === 3);
    expect(last(r).full).toBe(true);
    expect(last(r)).not.toHaveProperty('stale');
    for (const s of last(r).states) expect(s).not.toHaveProperty('stale');
  });

  // A state the watch read before the machine left, taken after the step
  // ended the watch and marked the machine's chats stale, is dropped: the
  // offline chat stays sleeping and stale, and the pages hear nothing of
  // it. The states a watch read first are dropped the same way.
  test('a change after the machine left is dropped', async () => {
    const r = await start();
    const working = chatState(chat.Status.Working, chat.State.Working, 2);
    const w = r.board.watch.record('gpu');
    const ac = new AbortController();
    expect(r.board.watch.up(ac.signal, w, { proto: chat.PROTO, version: '', pid: 0 }, [working])).toBe(true);
    // The step: the machine left.
    ac.abort();
    expect(r.board.watch.markStale(w)).toBeDefined();
    const n = states(r);
    // The watch takes the line it had read.
    expect(r.board.watch.change(ac.signal, w, { ...working, seq: 3 })).toBe(false);
    let snap = r.board.watch.snapshot().machines.gpu;
    expect(snap.stale).toBe(true);
    expect(snap.states).toEqual([{ ...working, state: 'sleeping', status: 'idle', stale: true }]);
    expect(states(r)).toBe(n);
    // A watch ended before it took its first states takes none.
    expect(r.board.watch.up(ac.signal, w, { proto: chat.PROTO, version: '', pid: 0 }, [working])).toBe(false);
    snap = r.board.watch.snapshot().machines.gpu;
    expect([snap.stale, snap.states[0].state]).toEqual([true, 'sleeping']);
  });

  // The states say which build the machine's chat host is and whether it
  // is another than the core's, until no host serves.
  for (const build of ['test', 'v0.5.0-3-gabc-dirty.1700000002'])
    test(`a host of build ${build}`, async () => {
      const r = await start({ version: build, host: (h) => (h.states = [chatState(chat.Status.Working, chat.State.Working, 3)]) });
      r.start();
      await waitFor('the states', () => states(r) === 1);
      const outdated = build !== 'test';
      expect([last(r).hostVersion, last(r).outdated ?? false]).toEqual(['test', outdated]);
      const snap = r.board.watch.snapshot().machines.gpu;
      expect([snap.hostVersion, snap.outdated ?? false]).toEqual(['test', outdated]);
      r.host.end(false);
      await waitFor('the host gone', () => states(r) === 2);
      expect(last(r)).not.toHaveProperty('hostVersion');
      expect(last(r)).not.toHaveProperty('outdated');
      expect(last(r).states).toBeArray();
    });
});
