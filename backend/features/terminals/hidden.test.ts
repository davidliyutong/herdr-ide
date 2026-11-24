import { afterEach, expect, test } from 'bun:test';
import { CHAT_HOST_NAME, HIDDEN_CHAT_HOST, HIDDEN_LABEL } from '#shared/proto/agentproto/index.ts';
import { waitFor } from '#kernel/testing.ts';
import { errKind, rig, type FakeHC, type Msg, type Rig, type TestClient } from './testing.ts';

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.stop();
});

const host = CHAT_HOST_NAME;

/** A terminal's record: live, of name ("" for none), with labels. */
const rec = (addr: string, name: string, labels: Record<string, string>) => ({
  address: addr,
  ...(name ? { name } : {}),
  state: 'live',
  pid: 42,
  cols: 80,
  rows: 24,
  argv: [],
  cwd: '/',
  created_ms: 1,
  labels,
  screen: 'exact',
});
const plainRec = (addr: string) => rec(addr, '', { name: 'mine' });
/** The record of a chat host: its name and the hidden label. */
const hiddenRec = (addr: string) => rec(addr, host, { [HIDDEN_LABEL]: HIDDEN_CHAT_HOST });

/** A core with machine x whose terminal core calls itself c0ffee or box,
 * has the terminals snap, answers terminal.list with list and
 * terminal.get with recs (by address or name; not_found for others). */
async function hiddenRig(snap: object[], list: object, recs: Record<string, object>, readOnly = false) {
  const r = await rig({
    readOnly,
    sim: (s) => {
      const core = s.core!;
      core.snap = snap;
      core.list = list;
      core.anyTerminal = false;
      for (const [k, v] of Object.entries(recs)) core.recs.set(k, v);
    },
  });
  rigs.push(r);
  const c = await r.client();
  await c.ready();
  return { r, c, core: r.sim.core!, b: r.backend() };
}

const addresses = (list: unknown) => (list as { address: string }[]).map((t) => t.address).sort();

/** The next event, which must be typ of terminal: one that was not to
 * reach the client would come before. */
async function nextEvent(c: TestClient, type: string, terminal: string): Promise<Msg> {
  const ev = await c.until('event');
  expect([ev.type, ev.terminal]).toEqual([type, terminal]);
  return ev;
}

const setRec = (core: FakeHC, r: object, ...keys: string[]) => {
  for (const k of keys) core.recs.set(k, r);
};

// The chat host's terminal is none of the clients': it is in no snapshot,
// event, agent state, list or shell that is typed into, and a call or an
// attach that names it, by its address or its name, is answered as for a
// terminal that does not exist, without reaching the terminal core. A
// client can neither set the hidden label nor take the chat host's name.
// A terminal that carries the label without the name, or the name without
// the label, is the clients' as any other; one that gets the label while
// it has the name leaves them, with the streams they had of it.
test('hidden terminals', async () => {
  const labeled = rec('t6', 'helper', { [HIDDEN_LABEL]: HIDDEN_CHAT_HOST });
  const { r, c, core, b } = await hiddenRig(
    [plainRec('t1'), hiddenRec('t5'), labeled],
    { terminals: [plainRec('t1'), hiddenRec('t5'), labeled], hidden_finished: 2 },
    { t1: plainRec('t1'), t5: hiddenRec('t5'), [host]: hiddenRec('t5'), t6: labeled, helper: labeled },
  );
  expect(addresses((await c.until('snapshot')).terminals)).toEqual(['t1', 't6']);

  // Events: what happens to the hidden terminal is not passed on; a
  // terminal that gets the label without the name stays the clients'.
  core.event('title', 't5', { title: 'the chat host' });
  core.event('created', 't2', plainRec('t2'));
  await nextEvent(c, 'created', 't2');
  core.event('labels', 't2', { labels: { name: 'mine', [HIDDEN_LABEL]: HIDDEN_CHAT_HOST } });
  await nextEvent(c, 'labels', 't2');
  core.event('finished', 't5', { reason: 'exited', exit_code: 0, signal: null, finished_ms: 1 });
  core.event('removed', 't5', {});
  core.event('title', 't1', { title: 'shown' });
  await nextEvent(c, 'title', 't1');

  // A terminal that takes the name, without the label, is the clients':
  // one attaches to it by its address after the core's name. When it gets
  // the label it leaves them, and the stream ends.
  core.event('created', 't7', rec('t7', host, {}));
  await nextEvent(c, 'created', 't7');
  setRec(core, rec('t7', host, {}), 't7');
  c.send({ t: 'attach', rid: 1, m: 'x', terminal: 'box/t7', cols: 80, rows: 24 });
  const sid = (await c.until('attached')).s;
  // Another client watches it and stops following the machine: its stream
  // stays, until the terminal is hidden too.
  const u = await r.client();
  u.send({ t: 'sub', m: 'x' });
  await u.until('snapshot');
  u.send({ t: 'attach', rid: 1, m: 'x', terminal: 't7', cols: 80, rows: 24, observe: true });
  const usid = (await u.until('attached')).s;
  u.send({ t: 'unsub', m: 'x' });
  expect(errKind(await u.call(2, 'terminal.get', { terminal: 't1' }))).toBe('unavailable');
  core.event('labels', 't7', { labels: { [HIDDEN_LABEL]: HIDDEN_CHAT_HOST }, record: hiddenRec('t7') });
  await nextEvent(c, 'removed', 't7');
  expect((await c.until('closed')).s).toBe(sid);
  expect((await u.until('closed')).s).toBe(usid);
  await waitFor('2 streams closed', () => core.closes === 2);
  setRec(core, hiddenRec('t7'), 't7', host);
  core.event('labels', 't7', { labels: {} }); // hidden until removed
  core.event('title', 't7', { title: 'still hidden' });
  core.event('title', 't1', { title: 'again' });
  await nextEvent(c, 'title', 't1');
  const hiddenSince = core.calls.length;

  // An agent in the hidden terminal is no news, for /api/v1/term or /ws.
  b.agents.apply({ terminal: 't7', agent: 'claude', status: 'working' });
  b.agents.apply({ terminal: 't1', agent: 'codex', status: 'working' });
  await nextEvent(c, 'agent', 't1');
  expect(r.ws.map((x) => (x as { terminal: string }).terminal)).toEqual(['t1']);

  // A later client's snapshot, the list and the shells have only the
  // clients' terminals.
  const c2 = await r.client();
  c2.send({ t: 'sub', m: 'x' });
  expect(addresses((await c2.until('snapshot')).terminals)).toEqual(['t1', 't2', 't6']);
  const res = (await c.call(2, 'terminal.list', { all: true })).result as Record<string, unknown>;
  expect([addresses(res.terminals), res.hidden_finished]).toEqual([['t1', 't6'], 2]);
  const sh = r.feature.shells('x')!;
  await expect(sh.all()).toEqual(['t1', 't2', 't6']);
  for (const target of ['t7', host, 'box/t7']) {
    await expect(sh.shell(target)).rejects.toThrow('not_found');
    await expect(sh.send(target, 'exit\r')).rejects.toThrow();
  }

  // A call that names it, by address or by name, with or without the
  // terminal core's own id or name before it, as its terminal, its caller
  // or a new terminal's parent.
  let rid = 10;
  const refused = async (method: string, params: object, message: string) => {
    const m = await c.call(++rid, method, params);
    expect([method, m.error]).toEqual([method, { kind: 'not_found', message }]);
  };
  await refused('terminal.read', { terminal: 't7' }, 'no terminal "t7"');
  await refused('terminal.get', { terminal: host }, `no terminal "${host}"`);
  await refused('terminal.kill', { terminal: 'box/t7' }, 'no terminal "t7"');
  await refused('terminal.rm', { terminal: 'c0ffee/' + host }, `no terminal "${host}"`);
  await refused('terminal.keep', { terminal: 'box/' + host, keep: true }, `no terminal "${host}"`);
  await refused('terminal.interrupt', { terminal: 't7' }, 'no terminal "t7"');
  await refused('terminal.label', { terminal: 't7', labels: { x: 'y' } }, 'no terminal "t7"');
  await refused('terminal.run', { argv: ['sh'], parent: 't7' }, 'no terminal "t7"');
  await refused('terminal.run', { argv: ['sh'], caller: host }, `no terminal "${host}"`);
  // Attaching is refused alike, also to observe.
  for (const terminal of ['t7', host, 'box/t7', 'c0ffee/' + host]) {
    c.send({ t: 'attach', rid: ++rid, m: 'x', terminal, cols: 80, rows: 24, observe: true });
    expect(await c.until('res')).toMatchObject({ rid, error: { kind: 'not_found' } });
  }

  // A client neither sets the hidden label nor takes the chat host's name,
  // also through an escape in its JSON.
  for (const [method, params] of [
    ['terminal.run', { argv: ['sh'], labels: { [HIDDEN_LABEL]: 'mine' } }],
    ['terminal.run', { argv: ['sh'], name: host }],
    ['terminal.label', { terminal: 't1', labels: { name: 'x', [HIDDEN_LABEL]: '' } }],
  ] as const)
    expect(errKind(await c.call(++rid, method, params))).toBe('refused');
  c.sendRaw(
    `{"t":"call","rid":${++rid},"m":"x","method":"terminal.run","params":{"argv":["sh"],"labels":{"${HIDDEN_LABEL.replace('.', '\\u002e')}":"x"}}}`,
  );
  expect(errKind(await c.until('res'))).toBe('refused');

  // None of it reached the terminal core.
  for (const word of ['t5', 't7', host, 'terminal.attach', 'terminal.run', 'terminal.label', 'terminal.get', 'terminal.read'])
    expect([word, core.gotSince(hiddenSince, word)]).toEqual([word, false]);
  const audit = r.tc.audit.records().filter((x) => x.event === 'denied.term');
  for (const want of [
    { method: 'terminal.read', param: 'terminal', reason: 'hidden' },
    { terminal: 'box/t7' },
    { method: 'terminal.run', param: 'parent' },
    { method: 'terminal.run', param: 'caller' },
    { method: 'terminal.attach', param: 'terminal' },
    { method: 'terminal.run', param: 'labels' },
    { method: 'terminal.run', param: 'name' },
    { method: 'terminal.label', param: 'labels' },
  ])
    expect(audit).toContainEqual(expect.objectContaining(want));

  // Other terminals are the clients' as before: by address, with labels
  // and names of their own, the one labeled as a helper's included.
  const passes = async (method: string, params: object) =>
    expect([method, (await c.call(++rid, method, params)).error]).toEqual([method, undefined]);
  await passes('terminal.read', { terminal: 't1' });
  await passes('terminal.read', { terminal: 't6' });
  await passes('terminal.get', { terminal: 'box/t1' });
  await passes('terminal.label', { terminal: 't1', labels: { name: 'x', hidden: 'no' } });
  await passes('terminal.run', { argv: ['sh'], name: HIDDEN_CHAT_HOST, labels: { name: 'y' }, parent: 't1' });
  c.send({ t: 'attach', rid: ++rid, m: 'x', terminal: 't6', cols: 80, rows: 24 });
  expect((await c.until('attached')).rid).toBe(rid);
  // A terminal that was removed is hidden no more: its address is any
  // address the terminal core does not know. The chat host's name stays
  // kept for it while none runs.
  core.event('removed', 't7', {});
  core.event('title', 't1', { title: 'after' });
  await nextEvent(c, 'title', 't1');
  setRec(core, plainRec('t7'), 't7');
  await passes('terminal.read', { terminal: 't7' });
  expect(core.seen('terminal.read {"terminal":"t7"}')).toBe(true);
  await refused('terminal.kill', { terminal: host }, `no terminal "${host}"`);
  expect(core.calls.some((x) => x.method === 'terminal.kill')).toBe(false);
});

// A terminal the backend does not know yet, or that a client names by a
// name, is looked up before the call: a hidden one is refused, its record
// read but nothing else asked of it, and any other is called by its
// address. An attach whose reply shows a hidden terminal ends the stream
// unread and is answered as for no terminal; the shells keep away alike.
test('the creation window', async () => {
  const { r, c, core } = await hiddenRig(
    [plainRec('t1'), plainRec('t2')],
    { terminals: [] },
    {
      t1: plainRec('t1'),
      t2: plainRec('t2'),
      t9: hiddenRec('t9'),
      t4: rec('t4', 'work', {}),
      work: rec('t4', 'work', {}),
      t3: plainRec('t3'),
    },
  );
  await c.until('snapshot');
  // The chat host just started as t9: its event is on its way.
  for (const [i, target] of ['t9', 'box/t9', 'c0ffee/t9'].entries()) {
    expect(errKind(await c.call(i + 1, 'terminal.read', { terminal: target }))).toBe('not_found');
    c.send({ t: 'attach', rid: 10 + i, m: 'x', terminal: target, cols: 80, rows: 24 });
    expect(await c.until('res')).toMatchObject({ rid: 10 + i, error: { kind: 'not_found' } });
  }
  expect(core.seen('terminal.get {"terminal":"t9"}')).toBe(true);
  expect(core.calls.some((x) => x.method === 'terminal.read' || x.method === 'terminal.attach')).toBe(false);
  const sh = r.feature.shells('x')!;
  await expect(sh.shell('t9')).rejects.toThrow('not_found');
  // A terminal the backend has as the clients' whose record says it is the
  // chat host by now.
  setRec(core, hiddenRec('t2'), 't2');
  await expect(sh.shell('t2')).rejects.toThrow('not_found');
  await expect(sh.send('t2', 'exit\r')).rejects.toThrow();
  await Bun.sleep(20);
  expect(core.calls.some((x) => x.method === 'terminal.attach')).toBe(false);

  // A name is looked up, and the call names the terminal by its address.
  expect((await c.call(20, 'terminal.read', { terminal: 'work', caller: 'box/t1' })).error).toBeUndefined();
  expect(core.seen('terminal.get {"terminal":"work"}')).toBe(true);
  expect(core.calls.find((x) => x.method === 'terminal.read')!.params).toEqual({ terminal: 't4', caller: 't1' });
  c.send({ t: 'attach', rid: 21, m: 'x', terminal: 'work', cols: 80, rows: 24 });
  const at = await c.until('attached');
  expect(at).toMatchObject({ rid: 21, terminal: 'work' });
  expect(core.seen('terminal.attach {"terminal":"t4"')).toBe(true);
  // A terminal that is hidden by the time it is attached to.
  core.attachedRecs.set('t3', hiddenRec('t3'));
  c.send({ t: 'attach', rid: 22, m: 'x', terminal: 't3', cols: 80, rows: 24 });
  expect(await c.until('res')).toMatchObject({ rid: 22, error: { kind: 'not_found' } });
  await waitFor('1 stream closed', () => core.closes === 1);
  // Nothing of it reached the client: until the reply to the next call, it
  // gets the output of the stream of work only.
  c.send({ t: 'call', rid: 23, m: 'x', method: 'terminal.get', params: { terminal: 't1' } });
  for (;;) {
    const m = await c.next();
    if ((m.bin !== undefined && m.bin !== at.s) || m.t === 'attached' || m.t === 'closed') throw new Error(`got ${JSON.stringify(m)}`);
    if (m.t === 'res') {
      expect(m).toMatchObject({ rid: 23 });
      expect(m.error).toBeUndefined();
      break;
    }
  }
  expect(r.tc.audit.records().filter((x) => x.reason === 'hidden').length).toBeGreaterThanOrEqual(7);
});

// A snapshot after missed events is the whole state: its hidden terminals
// are kept from the clients and from their calls, the agents detected in
// them are forgotten, the clients' streams of them end, and a terminal it
// no longer has as hidden is the clients' again.
test('hidden after missed events', async () => {
  const finished = { ...hiddenRec('t5'), state: 'finished' };
  const { c, core, b } = await hiddenRig(
    [plainRec('t1'), finished, rec('t7', host, {})],
    { terminals: [] },
    {
      t1: plainRec('t1'),
      t5: plainRec('t5'),
      t7: rec('t7', host, {}),
    },
  );
  expect(addresses((await c.until('snapshot')).terminals)).toEqual(['t1', 't7']);
  c.send({ t: 'attach', rid: 1, m: 'x', terminal: 't7', cols: 80, rows: 24 });
  const sid = (await c.until('attached')).s;
  b.agents.apply({ terminal: 't7', agent: 'claude', status: 'working' });
  await nextEvent(c, 'agent', 't7');
  const hiddenSince = core.calls.length;
  core.notify(
    JSON.stringify({ jsonrpc: '2.0', method: 'missed', params: { seq: 20, terminals: [plainRec('t1'), plainRec('t5'), hiddenRec('t7')] } }),
  );
  const got = new Set<string>();
  while (!got.has('snapshot') || !got.has('closed')) {
    const m = await c.next();
    if (m.t === 'snapshot') expect(addresses(m.terminals)).toEqual(['t1', 't5']);
    if (m.t === 'closed') expect(m.s).toBe(sid);
    if (m.t === 'event') throw new Error(`event ${JSON.stringify(m)}`);
    got.add(String(m.t));
  }
  await waitFor('1 stream closed', () => core.closes === 1);
  expect(b.agents.get('t7')).toBeUndefined();
  for (const [i, target] of ['t7', host, 'box/t7'].entries())
    expect(errKind(await c.call(i + 2, 'terminal.read', { terminal: target }))).toBe('not_found');
  expect((await c.call(9, 'terminal.read', { terminal: 't5' })).error).toBeUndefined();
  expect(core.gotSince(hiddenSince, 't7') || core.gotSince(hiddenSince, host)).toBe(false);
});

// A read-only client is kept from hidden terminals as any other.
test('hidden from read-only clients', async () => {
  const { c, core } = await hiddenRig(
    [plainRec('t1'), hiddenRec('t5')],
    { terminals: [plainRec('t1'), hiddenRec('t5')] },
    { t1: plainRec('t1'), t5: hiddenRec('t5') },
    true,
  );
  expect(addresses((await c.until('snapshot')).terminals)).toEqual(['t1']);
  c.send({ t: 'attach', rid: 1, m: 'x', terminal: host, cols: 80, rows: 24 });
  expect(errKind(await c.until('res'))).toBe('not_found');
  expect(errKind(await c.call(2, 'terminal.read', { terminal: 't5' }))).toBe('not_found');
  expect(addresses(((await c.call(3, 'terminal.list')).result as Record<string, unknown>).terminals)).toEqual(['t1']);
  expect(core.seen('t5') || core.seen('terminal.attach')).toBe(false);
});

// The terminals of other machines the terminal core has are none of the
// clients': they are in no snapshot, event, list or agent state, the list
// names no machine, and a call or an attach that names one, or a terminal
// after any machine but the core's own id or name, is refused (audited)
// without reaching the terminal core.
test('other machines’ terminals', async () => {
  const far = { ...plainRec('far/t3'), machine: 'far' };
  const { r, c, core, b } = await hiddenRig(
    [plainRec('t1'), far],
    { terminals: [plainRec('t1'), far], hidden_finished: 0, machines: [{ name: 'far', target: 'me@far.example' }] },
    { t1: plainRec('t1'), 'far/t3': far, farname: far },
  );
  expect(addresses((await c.until('snapshot')).terminals)).toEqual(['t1']);
  core.event('title', 'far/t3', { title: 'far' });
  core.event('created', 'far/t4', plainRec('far/t4'));
  core.notify('{"jsonrpc":"2.0","method":"event","params":{"seq":10,"type":"doc","machine":"far","data":{"name":"d","version":2}}}');
  b.agents.apply({ terminal: 'far/t3', agent: 'claude', status: 'blocked' });
  core.event('title', 't1', { title: 'here' });
  await nextEvent(c, 'title', 't1');
  b.agents.apply({ terminal: 't1', agent: 'codex', status: 'working' });
  await nextEvent(c, 'agent', 't1');
  expect(JSON.stringify(r.ws)).not.toContain('far');
  const res = (await c.call(1, 'terminal.list', { all: true })).result as Record<string, unknown>;
  expect([addresses(res.terminals), res.machines]).toEqual([['t1'], []]);

  let rid = 1;
  for (const [method, params] of [
    ['terminal.read', { terminal: 'far/t3' }],
    ['terminal.get', { terminal: 'far/work' }],
    ['terminal.kill', { terminal: 'unknown/t1' }],
    ['terminal.read', { terminal: 'box/t1', caller: 'far/t1' }],
    ['terminal.run', { argv: ['sh'], parent: 'far/t1' }],
    ['terminal.read', { terminal: 'box/far/t3' }],
    ['terminal.read', { terminal: '/t1' }],
    // A name the core finds on another machine.
    ['terminal.read', { terminal: 'farname' }],
  ] as const)
    expect([method, params, errKind(await c.call(++rid, method, params))]).toEqual([method, params, 'not_found']);
  c.send({ t: 'attach', rid: ++rid, m: 'x', terminal: 'far/t3', cols: 80, rows: 24, observe: true });
  expect(errKind(await c.until('res'))).toBe('not_found');
  await expect(r.feature.shells('x')!.shell('far/t3')).rejects.toThrow('not_found');
  expect(core.seen('terminal.get {"terminal":"farname"}')).toBe(true);
  for (const word of ['far/', 'unknown', 'terminal.attach', 'terminal.kill', 'terminal.run', 'terminal.read', '"terminal":"t1"'])
    expect([word, core.seen(word)]).toEqual([word, false]);
  const audit = r.tc.audit.records();
  for (const want of [
    { method: 'terminal.read', param: 'terminal', reason: 'machine', terminal: 'far/t3' },
    { param: 'caller', reason: 'machine' },
    { method: 'terminal.attach', param: 'terminal', reason: 'machine' },
  ])
    expect(audit).toContainEqual(expect.objectContaining(want));
  // The core's own id and name name its own terminals.
  for (const [i, target] of ['box/t1', 'c0ffee/t1'].entries())
    expect((await c.call(20 + i, 'terminal.read', { terminal: target })).error).toBeUndefined();
  expect(core.seen('terminal.read {"terminal":"t1"}')).toBe(true);
});

// Labels that are not an object of strings are refused before they reach
// the terminal core.
test('labels must be an object of strings', async () => {
  const { c, core } = await hiddenRig([plainRec('t1')], { terminals: [] }, { t1: plainRec('t1') });
  await c.until('snapshot');
  let rid = 0;
  for (const labels of ['null', '[]', '"x"', '1', '{"a":1}', '{"a":null}', '{"a":{"b":"c"}}', '{"a":["b"]}'])
    for (const method of ['terminal.run', 'terminal.label', 'terminal.list']) {
      c.sendRaw(`{"t":"call","rid":${++rid},"m":"x","method":"${method}","params":{"argv":["sh"],"terminal":"t1","labels":${labels}}}`);
      expect([method, labels, await c.until('res')]).toEqual([
        method,
        labels,
        expect.objectContaining({ rid, error: expect.objectContaining({ kind: 'usage' }) }),
      ]);
    }
  expect(core.calls).toEqual([]);
  expect((await c.call(100, 'terminal.label', { terminal: 't1', labels: { a: 'b', c: '' } })).error).toBeUndefined();
  expect((await c.call(101, 'terminal.run', { argv: ['sh'], parent: null })).error).toBeUndefined();
  expect(core.calls.some((x) => x.method === 'terminal.get')).toBe(false);
});
