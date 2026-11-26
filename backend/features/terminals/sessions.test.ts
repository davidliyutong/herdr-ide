import { afterEach, expect, test } from 'bun:test';
import { SessionFrom, type DetectEvent } from '#shared/proto/agentproto/index.ts';
import { waitFor } from '#kernel/testing.ts';
import { checkSession } from './agents.ts';
import { rig, type Rig, type TestClient } from './testing.ts';

const S1 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const S2 = '22222222-2222-4222-8222-222222222222';

const rigs: Rig[] = [];
const start = async (o: Parameters<typeof rig>[0] = {}) => {
  const r = await rig(o);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.stop();
});

/** Terminal t1's record as a new subscriber gets it. */
async function record(r: Rig): Promise<Record<string, unknown>> {
  const c = await r.client();
  c.send({ t: 'sub', m: 'x' });
  const list = (await c.until('snapshot')).terminals as Record<string, unknown>[];
  c.close();
  return list.find((t) => t.address === 't1')!;
}

/** A record's session: its members are there when it is known and absent
 * when it is not. */
function wantSession(m: Record<string, unknown>, session: string, source: string) {
  expect([m.agent_session, m.agent_session_source, 'agent_session' in m, 'agent_session_source' in m]).toEqual([
    session || undefined,
    source || undefined,
    session !== '',
    source !== '',
  ]);
}

/** An agent event's session: its members are always there, null when it
 * is not known. */
function wantEventSession(d: Record<string, unknown>, session: string, source: string) {
  expect('agent_session' in d && 'agent_session_source' in d).toBe(true);
  expect([d.agent_session, d.agent_session_source]).toEqual([session || null, source || null]);
}

const ev = (agent: string, status: string, session = '', source = ''): DetectEvent => ({
  terminal: 't1',
  agent,
  status,
  ...(session ? { session } : {}),
  ...(source ? { session_source: source } : {}),
});

// A terminal's session reaches its record and the terminal protocol's
// agent events; a change of the session alone is no news: no /ws message,
// and the status stays the core's. Sessions that are not session ids with
// a known source are dropped.
test('agent sessions', async () => {
  const r = await start();
  const c = await r.client();
  await c.ready();
  const b = r.backend();
  b.agents.apply(ev('claude', 'working'));
  wantEventSession(await c.agentData(), '', '');
  b.agents.apply(ev('claude', 'working', S1, SessionFrom.PID));
  let d = await c.agentData();
  expect([d.agent, d.agent_status]).toEqual(['claude', 'working']);
  wantEventSession(d, S1, SessionFrom.PID);
  wantSession(await record(r), S1, SessionFrom.PID);
  expect(r.ws.length).toBe(1);

  // A status change carries the session and is news as before.
  b.agents.apply(ev('claude', 'done', S1, SessionFrom.PID));
  d = await c.agentData();
  expect(d.agent_status).toBe('done');
  wantEventSession(d, S1, SessionFrom.PID);
  expect(r.ws.length).toBe(2);
  expect(r.ws[1]).toMatchObject({ agent_status: 'done' });
  expect(JSON.stringify(r.ws[1])).not.toContain('session');
  c.send({ t: 'attach', rid: 1, m: 'x', terminal: 't1', cols: 80, rows: 24 });
  const sid = (await c.until('attached')).s;
  c.send({ t: 'focus', s: sid, focused: true });
  expect((await c.agentData()).agent_status).toBe('idle');
  c.send({ t: 'focus', s: sid, focused: false });
  c.send({ t: 'ping', rid: 2 });
  await c.until('pong');

  // The machine still says done when the session changes (/clear): the
  // turn stays seen.
  b.agents.apply(ev('claude', 'done', S2, SessionFrom.PID));
  d = await c.agentData();
  expect(d.agent_status).toBe('idle');
  wantEventSession(d, S2, SessionFrom.PID);
  expect(r.ws.length).toBe(3);

  // A record the core replaces gets the session again right behind.
  r.sim.core!.event('labels', 't1', {
    labels: { a: 'b' },
    record: { address: 't1', state: 'live', cols: 80, rows: 24, labels: { a: 'b' } },
  });
  wantEventSession(await c.agentData(), S2, SessionFrom.PID);
  wantSession(await record(r), S2, SessionFrom.PID);

  // What is not a session id with a known source is dropped.
  for (const [session, source] of [
    ['../../etc/passwd', SessionFrom.PID],
    [S1.toUpperCase(), SessionFrom.PID],
    [S1, 'bogus'],
    [S1, ''],
  ]) {
    b.agents.apply(ev('claude', 'done', session, source));
    wantEventSession(await c.agentData(), '', '');
    wantSession(await record(r), '', '');
    b.agents.apply(ev('claude', 'done', S2, SessionFrom.PID));
    wantEventSession(await c.agentData(), S2, SessionFrom.PID);
  }
  expect(r.ws.length).toBe(3);

  // The agent leaves: no session either.
  b.agents.apply(ev('claude', 'idle', S1, SessionFrom.Argv));
  await c.agentData();
  b.agents.apply(ev('', ''));
  d = await c.agentData();
  expect([d.agent, d.agent_status]).toEqual([null, null]);
  wantEventSession(d, '', '');
  const rec = await record(r);
  expect('agent' in rec).toBe(false);
  wantSession(rec, '', '');
});

test('checkSession', () => {
  const cases: Array<[DetectEvent, boolean]> = [
    [{ terminal: '', agent: 'claude', status: '', session: S1, session_source: SessionFrom.Argv }, true],
    [{ terminal: '', agent: 'codex', status: '', session: S1, session_source: SessionFrom.Start }, true],
    [{ terminal: '', agent: 'codex', status: '', session: S1, session_source: SessionFrom.FD }, true],
    [{ terminal: '', agent: 'claude', status: '', session: S1, session_source: SessionFrom.Hook }, true],
    [{ terminal: '', agent: 'claude', status: '', session: S1, session_source: SessionFrom.Guess }, true],
    [{ terminal: '', agent: '', status: '', session: S1, session_source: SessionFrom.PID }, false],
    [{ terminal: '', agent: 'claude', status: '', session: S1 + '\n', session_source: SessionFrom.PID }, false],
    [{ terminal: '', agent: 'claude', status: '', session: '', session_source: SessionFrom.PID }, false],
    [{ terminal: '', agent: 'claude', status: '', session: S1, session_source: 'PID' }, false],
  ];
  for (const [input, keep] of cases) {
    const out = checkSession(input);
    expect([input, out.session ?? '', out.session_source ?? '']).toEqual([
      input,
      keep ? input.session! : '',
      keep ? input.session_source! : '',
    ]);
  }
});

// A session that ends leaves the agent events and the record: when another
// agent takes the place of the one that had it, when that one leaves and
// another starts, and when the machine reports the agent without it.
test('a session ends', async () => {
  const r = await start();
  const c = await r.client();
  await c.ready();
  const b = r.backend();
  const known = async () => {
    b.agents.apply(ev('claude', 'idle', S1, SessionFrom.Argv));
    wantEventSession(await c.agentData(), S1, SessionFrom.Argv);
    wantSession(await record(r), S1, SessionFrom.Argv);
  };
  await known();
  b.agents.apply(ev('codex', 'idle'));
  let d = await c.agentData();
  expect(d.agent).toBe('codex');
  wantEventSession(d, '', '');
  wantSession(await record(r), '', '');

  await known();
  b.agents.apply(ev('', ''));
  wantEventSession(await c.agentData(), '', '');
  wantSession(await record(r), '', '');
  b.agents.apply(ev('codex', 'working'));
  wantEventSession(await c.agentData(), '', '');
  wantSession(await record(r), '', '');

  await known();
  b.agents.apply(ev('claude', 'idle'));
  d = await c.agentData();
  expect([d.agent, d.agent_status]).toEqual(['claude', 'idle']);
  wantEventSession(d, '', '');
  wantSession(await record(r), '', '');
});

// The first event of each terminal after sessions were switched, against
// what the clients were told before: a block or a turn's end they were
// told of reaches the record and the terminal protocol but not /ws again,
// a done they saw stays idle; a turn that ended meanwhile, another agent,
// and the terminal's later events are news as before.
test('detected again after a switch', async () => {
  const r = await start();
  const c = await r.client();
  await c.ready();
  const b = r.backend();
  const statuses = (from: number) => r.ws.slice(from).map((x) => (x as { agent_status: unknown }).agent_status);
  const switched = async (before: DetectEvent, after: DetectEvent, status: string, ...news: string[]) => {
    if (b.agents.get('t1')) {
      b.agents.apply(ev('', ''));
      await c.agentData();
    }
    b.agents.apply(before);
    await c.agentData();
    const n = r.ws.length;
    const told = b.agents.entries();
    b.agents.apply(ev('', ''));
    expect((await c.agentData()).agent).toBeNull();
    b.agents.applyDetected(after, told);
    const d = await c.agentData();
    expect([before, after, d.agent, d.agent_status]).toEqual([before, after, after.agent, status]);
    expect((await record(r)).agent_status).toBe(status);
    expect([before, after, statuses(n)]).toEqual([before, after, [null, ...news]]);
    expect(told.size).toBe(0);
  };
  await switched(ev('claude', 'done'), ev('claude', 'done'), 'done');
  await switched(ev('claude', 'blocked'), ev('claude', 'blocked'), 'blocked');
  await switched(ev('claude', 'working'), ev('claude', 'done'), 'done', 'done');
  await switched(ev('claude', 'done'), ev('codex', 'done'), 'done', 'done');
  await switched(ev('claude', 'working'), ev('claude', 'working'), 'working', 'working');

  // A done the clients saw stays seen.
  b.agents.apply(ev('claude', 'done'));
  await c.agentData();
  b.seen('t1');
  expect((await c.agentData()).agent_status).toBe('idle');
  const n = r.ws.length;
  const told = new Map([['t1', ev('claude', 'idle')]]);
  b.agents.apply(ev('', ''));
  await c.agentData();
  b.agents.applyDetected(ev('claude', 'done'), told);
  expect((await c.agentData()).agent_status).toBe('idle');
  expect(statuses(n)).toEqual([null, 'idle']);
  // Taken by the first event: what follows is news.
  b.agents.applyDetected(ev('claude', 'working'), told);
  await c.agentData();
  b.agents.applyDetected(ev('claude', 'done'), told);
  expect((await c.agentData()).agent_status).toBe('done');
  expect(statuses(0).at(-1)).toBe('done');
});

/** Waits for the agent event after the detect stream was opened again. */
async function redetected(c: TestClient): Promise<Record<string, unknown>> {
  for (let d = await c.agentData(); ; d = await c.agentData()) if (d.agent === null) return c.agentData();
}

// Through the machine's agent: the detect stream asks for sessions while
// the agents feature is on; its events reach the record, a session without
// a /ws message; switching sessions off opens the stream again without
// them, and the record loses it.
test('sessions from the machine', async () => {
  const r = await start({
    sim: (s) =>
      (s.onDetect = (h) => (h.sessions ? [ev('claude', 'idle'), ev('claude', 'idle', S1, SessionFrom.PID)] : [ev('claude', 'idle')])),
  });
  const c = await r.client();
  await c.ready();
  let d = await c.agentData();
  expect([d.agent, d.agent_status]).toEqual(['claude', 'idle']);
  wantEventSession(d, '', '');
  d = await c.agentData();
  wantEventSession(d, S1, SessionFrom.PID);
  expect(d.agent_status).toBe('idle');
  wantSession(await record(r), S1, SessionFrom.PID);
  expect(r.ws.length).toBe(1);
  expect(r.sim.detects.map((x) => x.sessions)).toEqual([true]);

  r.tc.setSetting('plugins.agents.enabled', false);
  d = await redetected(c);
  expect(d.agent).toBe('claude');
  wantEventSession(d, '', '');
  wantSession(await record(r), '', '');
  await waitFor('the first stream closed', () => r.sim.detects[0].closed);
  expect(r.sim.openDetects().map((x) => x.sessions)).toEqual([false]);
});

// Switching sessions off and on again makes the machine detect the agent
// again, whose turn's end the clients were told of once only.
test('a switch notifies once', async () => {
  const r = await start({ sim: (s) => (s.onDetect = () => [ev('claude', 'done')]) });
  const c = await r.client();
  await c.ready();
  expect(await c.agentData()).toMatchObject({ agent: 'claude', agent_status: 'done' });
  for (const [i, on] of [false, true].entries()) {
    r.tc.setSetting('plugins.agents.enabled', on);
    expect(await redetected(c)).toMatchObject({ agent: 'claude', agent_status: 'done' });
    expect((await record(r)).agent_status).toBe('done');
    await Bun.sleep(100);
    const done = r.ws.filter((x) => (x as { agent_status: unknown }).agent_status === 'done').length;
    expect([i, done, r.ws.length]).toEqual([i, 1, 2 + i]);
  }
});

test('changing the plugin interrupts a detect retry delay', async () => {
  const r = await start({
    options: { timing: { detectRetryMs: 60_000 } },
    sim: (s) => (s.onDetect = () => [ev('claude', 'idle')]),
  });
  const c = await r.client();
  await c.ready();
  expect(await c.agentData()).toMatchObject({ agent: 'claude' });
  r.sim.detects[0].send({ terminal: 123 });
  expect(await c.agentData()).toMatchObject({ agent: null });
  expect(r.sim.detects).toHaveLength(1);
  r.tc.setSetting('plugins.agents.enabled', false);
  expect(await c.agentData()).toMatchObject({ agent: 'claude' });
  expect(r.sim.detects.map((x) => x.sessions)).toEqual([true, false]);
});

// A lost connection clears the agents it detected, telling the clients.
test('agents end with the connection', async () => {
  const r = await start({ sim: (s) => (s.onDetect = () => [ev('codex', 'working')]) });
  const c = await r.client();
  await c.ready();
  expect((await c.agentData()).agent).toBe('codex');
  r.sim.core!.drop();
  expect((await c.agentData()).agent).toBeNull();
  expect(r.ws.at(-1)).toMatchObject({ terminal: 't1', agent: null });
});
