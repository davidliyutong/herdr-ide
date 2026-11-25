import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { checkGuarded, testCore, testMachines, sshSpec, waitFor, sleep } from '#kernel/testing.ts';
import { terminalsFeature } from './hub.ts';
import { FrameKind } from './messages.ts';
import { shells } from './shells.ts';
import { errKind, rig, type Rig } from './testing.ts';

const rigs: Rig[] = [];
const start = async (o: Parameters<typeof rig>[0] = {}) => {
  const r = await rig(o);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.stop();
});

const kind = (m: Record<string, unknown>) => errKind(m);

describe('protocol', () => {
  test('subscribe, calls, streams, credit, a lost core', async () => {
    const r = await start();
    const core = r.sim.core!;
    const c = await r.client();
    c.send({ t: 'sub', m: 'nope' }); // unknown machines are ignored
    c.send({ t: 'sub', m: 'x' });
    expect(await c.until('backend')).toMatchObject({ m: 'x', state: 'starting' });
    expect(await c.until('backend')).toMatchObject({ state: 'ready', version: '9.9.9' });
    const snap = await c.until('snapshot');
    expect(snap.terminals).toEqual([{ address: 't1', state: 'live', cols: 80, rows: 24, future_field: 7 }]);
    expect(await c.until('event')).toMatchObject({ type: 'status', terminal: 't1' });

    // Calls: allowed ones pass with their errors, the rest is refused.
    expect((await c.call(1, 'terminal.list')).result).toBeTruthy();
    expect(kind(await c.call(2, 'terminal.kill', { terminal: 't9' }))).toBe('not_found');
    const refused = [
      ['machine.exec', { argv: ['id'] }],
      ['file.read', { path: '/etc/passwd' }],
      ['server.stop', undefined],
      ['terminal.attach', undefined],
      ['terminal.read', { terminal: 't1', on: 'other' }],
    ] as const;
    for (const [i, [method, params]] of refused.entries())
      expect([method, kind(await c.call(10 + i, method, params))]).toEqual([method, 'refused']);
    expect(kind(await c.call(20, 'terminal.list', undefined, 'y'))).toBe('unavailable');
    const audit = r.tc.audit.text();
    expect(audit).toContain('"denied.term"');
    expect(audit).toContain('"machine.exec"');
    expect(audit).toContain('"event":"terminal.kill"');
    expect(r.tc.audit.records()).toContainEqual(expect.objectContaining({ event: 'denied.term', method: 'terminal.read', param: 'on' }));
    // Interrupting and keeping terminals are audited like killing them.
    for (const [i, method] of ['terminal.interrupt', 'terminal.keep'].entries()) {
      expect((await c.call(30 + i, method, { terminal: 't1' })).result).toBeTruthy();
      expect(r.tc.audit.records()).toContainEqual(expect.objectContaining({ event: method, terminal: 't1', machine: 'x' }));
    }

    // A stream: the reply, then output; input, credit and size reach the core.
    c.send({ t: 'attach', rid: 3, m: 'x', terminal: 't1', cols: 90, rows: 20 });
    const at = await c.until('attached');
    expect(at).toMatchObject({ rid: 3, observe: false, automatic: true, cols: 100, terminal: 't1' });
    const sid = at.s as number;
    expect(await c.next()).toEqual({ bin: sid, kind: FrameKind.Data, data: 'paint' });
    c.bin(sid, FrameKind.Data, 'ls\r');
    expect((await c.until('bin')).data).toBe('echo:ls\r');
    c.bin(sid, FrameKind.Automatic, '\x1b[?1;2c');
    await core.waitFor('6:\x1b[?1;2c');
    c.send({ t: 'ack', s: sid, n: 5 });
    await core.waitFor('1:\x05\x00\x00\x00');
    // Credit is returned for output the client was sent, no more: of 13
    // bytes ("paint", "echo:ls\r") 8 are left, and then none.
    c.send({ t: 'ack', s: sid, n: 1000 });
    await core.waitFor('1:\x08\x00\x00\x00');
    c.send({ t: 'ack', s: sid, n: 50 });
    c.send({ t: 'resize', s: sid, cols: 120, rows: 40 });
    await core.waitFor('3:\x78\x00\x28\x00');
    expect(core.seen('1:\xe8\x03') || core.seen('1:2\x00')).toBe(false);
    c.send({ t: 'focus', s: sid, focused: true });
    await core.waitFor('4:\x01');
    c.send({ t: 'facts', s: sid, display: { bg: '#101010', extra: 1 } });
    await core.waitFor('5:{"bg":"#101010"}');
    // The terminal's last viewer detaches: the program is told its focus is
    // gone, and the stream stays at the core, so that the terminal keeps
    // its size while no page shows it.
    c.send({ t: 'detach', s: sid });
    await core.waitFor('4:\x00');

    c.send({ t: 'attach', rid: 4, m: 'x', terminal: 't404', cols: 80, rows: 24 });
    expect(await c.until('res')).toMatchObject({ rid: 4, error: { kind: 'not_found' } });
    expect(core.seen('2:')).toBe(false);
    // A program that ends closes its stream with how. The terminal's new
    // viewer attached, the kept stream ends.
    c.send({ t: 'attach', rid: 5, m: 'x', terminal: 't1', cols: 80, rows: 24, history: 1 });
    await core.waitFor('2:');
    expect(await c.until('closed')).toMatchObject({ reason: 'exited', exit_code: 0, signal: null });

    // A later client gets the terminals with the events applied.
    const c2 = await r.client();
    c2.send({ t: 'sub', m: 'x' });
    const t1 = ((await c2.until('snapshot')).terminals as Record<string, unknown>[])[0];
    expect(t1).toMatchObject({ status: { state: 'working' }, reported: true, future_field: 7 });

    // The core goes away: open streams end, the backend reports it and
    // comes back when the core answers again.
    c.send({ t: 'attach', rid: 6, m: 'x', terminal: 't1', cols: 80, rows: 24 });
    await c.until('attached');
    core.drop();
    let sawClosed = false;
    let sawError = false;
    while (!sawClosed || !sawError) {
      const m = await c.next();
      if (m.t === 'closed') sawClosed = m.reason === 'disconnected';
      if (m.t === 'backend') sawError ||= m.state === 'error' && m.code === 'disconnected';
    }
    r.feature.existing('x')!.wakeUp();
    while ((await c.until('backend')).state !== 'ready');
    await c.until('snapshot');
    expect(r.machines.get('x')!.state().hc).toEqual({ state: 'ready', version: '9.9.9' });
  });

  test('messages of the wrong types are ignored', async () => {
    const r = await start();
    const c = await r.client();
    await c.ready();
    for (const bad of [
      '{"t":"ping","rid":"1"}',
      '{"t":"ping","rid":1.5}',
      '[1]',
      'nope',
      '{"t":"call","rid":1,"m":"x","method":"terminal.list","observe":1}',
    ])
      c.sendRaw(bad);
    c.sendRaw('{"t":"ping","rid":7,"future":{}}');
    expect(await c.until('pong')).toEqual({ t: 'pong', rid: 7 });
    expect(await c.until('res', 300).catch(() => null)).toBeNull();
  });

  test('read-only clients observe', async () => {
    const r = await start({ readOnly: true });
    const core = r.sim.core!;
    const c = await r.client();
    await c.ready();
    expect(kind(await c.call(1, 'terminal.run', { argv: ['sh'] }))).toBe('read_only');
    expect((await c.call(2, 'terminal.read', { terminal: 't1' })).result).toBeTruthy();
    // A watcher's attach observes, without display facts: the terminal's
    // size comes in the stream, and nothing it sends reaches the program.
    const b = r.backend();
    b.agents.apply({ terminal: 't1', agent: 'claude', status: 'done' });
    c.send({ t: 'attach', rid: 3, m: 'x', terminal: 't1', cols: 80, rows: 24, display: { bg: '#101010' } });
    const at = await c.until('attached');
    expect(at.observe).toBe(true);
    await core.waitFor('"observe":true');
    expect(core.calls.find((x) => x.method === 'terminal.attach')!.raw).not.toContain('"display"');
    expect(await c.next()).toMatchObject({ kind: FrameKind.Resize, data: '\x64\x00\x1e\x00' });
    expect((await c.next()).data).toBe('paint');
    const sid = at.s as number;
    c.bin(sid, FrameKind.Data, 'rm -rf\r');
    c.send({ t: 'resize', s: sid, cols: 10, rows: 10 });
    c.send({ t: 'focus', s: sid, focused: true });
    c.send({ t: 'facts', s: sid, display: { bg: '#202020' } });
    // Credit only for the 5 bytes of output sent.
    c.send({ t: 'ack', s: sid, n: 500 });
    await core.waitFor('1:\x05\x00\x00\x00');
    for (const w of ['rm -rf', '3:', '4:', '5:', '1:\xf4\x01']) expect([w, core.seen(w)]).toEqual([w, false]);
    // A watcher looking at a finished turn does not mark it seen.
    expect(b.agents.get('t1')?.status).toBe('done');
  });

  test('without a terminal core', async () => {
    // None on the machine and none in this build.
    const r = await start({ sim: (s) => ((s.digest = ''), (s.running = false)) });
    const c = await r.client();
    c.send({ t: 'sub', m: 'x' });
    let m;
    while ((m = await c.until('backend')).state !== 'error');
    expect(m.code).toBe('not_bundled');
    expect(kind(await c.call(1, 'terminal.list'))).toBe('unavailable');

    // A read-only core starts nothing, also with an executable to offer.
    const gz = gzipSync(Buffer.from('x'));
    const ro = await start({
      readOnly: true,
      sim: (s) => ((s.digest = ''), (s.running = false)),
      options: { hc: async () => ({ gz, digest: 'a'.repeat(64) }) },
    });
    const c2 = await ro.client();
    c2.send({ t: 'sub', m: 'x' });
    while ((m = await c2.until('backend')).state !== 'error');
    expect(m.code).toBe('not_bundled');
    expect(ro.tc.audit.text()).not.toContain('term.install');
    expect(ro.sim.actions).not.toContain('install');
  });

  test('installs and starts the build’s terminal core', async () => {
    const exe = Buffer.from('#!/bin/sh\n');
    const digest = createHash('sha256').update(exe).digest('hex');
    const r = await start({
      sim: (s) => ((s.digest = 'old'), (s.running = true)),
      options: { hc: async () => ({ gz: gzipSync(exe), digest }) },
    });
    const c = await r.client();
    await c.ready();
    expect(r.sim.digest).toBe(digest);
    expect(r.sim.actions).toEqual(['status', 'install', 'restart']);
    expect(r.tc.audit.records().map((x) => x.event)).toEqual(expect.arrayContaining(['term.install', 'term.restart']));
  });
});

// A machine build that carries its herdr-core (the TypeScript machine
// executable) installs that one, from its own copy: the core uploads
// nothing, also when it carries one for the platform.
test('a machine build that carries herdr-core installs and runs its own', async () => {
  const exe = Buffer.from('#!/bin/sh\n');
  const digest = createHash('sha256').update(exe).digest('hex');
  const r = await start({
    sim: (s) => ((s.digest = 'old'), (s.embedded = 'e'.repeat(64)), (s.running = true)),
    options: { hc: async () => ({ gz: gzipSync(exe), digest }) },
  });
  const c = await r.client();
  await c.ready();
  expect(r.sim.digest).toBe('e'.repeat(64));
  expect(r.sim.actions).toEqual(['status', 'install-embedded', 'restart']);
});

// The core's release recorded which herdr-core each platform's build
// carries: a machine build that carries another is not run.
test('a machine build whose herdr-core the release did not record is refused', async () => {
  const r = await start({
    sim: (s) => ((s.digest = ''), (s.embedded = 'e'.repeat(64)), (s.running = false)),
    options: { embeddedHC: async () => 'f'.repeat(64) },
  });
  const c = await r.client();
  c.send({ t: 'sub', m: 'x' });
  let m;
  while ((m = await c.until('backend')).state !== 'error');
  expect(m.code).toBe('install_failed');
  expect(r.sim.actions).not.toContain('install-embedded');
  // The recorded one runs.
  const ok = await start({
    sim: (s) => ((s.digest = ''), (s.embedded = 'e'.repeat(64)), (s.running = false)),
    options: { embeddedHC: async () => 'e'.repeat(64) },
  });
  await (await ok.client()).ready();
  expect(ok.sim.actions).toContain('install-embedded');
});

// The terminal core is stopped, started and restarted from the UI. A
// stopped core stays stopped while a client is subscribed (code stopped)
// until it is started again; the machine's state shows the backend's, and
// every action is audited.
test('the terminal core’s lifecycle from the UI', async () => {
  const r = await start();
  const c = await r.client();
  await c.ready();
  const mc = r.machines.get('x')!;
  await waitFor('the machine state', () => mc.state().hc?.state === 'ready' && mc.state().hc?.version === '9.9.9');
  const json = async (res: Response) => [res.status, await res.json()] as const;
  expect(await json(await r.tc.request('GET', '/api/m/x/hc'))).toEqual([
    200,
    expect.objectContaining({ running: true, version: '9.9.9', digest: 'd1' }),
  ]);
  expect(await json(await r.tc.request('GET', '/api/m/x/privacy'))).toEqual([200, r.sim.privacy]);
  expect((await r.tc.request('GET', '/api/m/nope/hc')).status).toBe(404);

  // Stop: the core goes away and the backend does not start another.
  expect(await json(await r.tc.request('POST', '/api/m/x/hc/stop'))).toEqual([200, expect.objectContaining({ running: false })]);
  while ((await c.until('backend')).code !== 'stopped');
  await waitFor('stopped in the machine state', () => mc.state().hc?.code === 'stopped');

  // Start: the backend connects again.
  expect(await json(await r.tc.request('POST', '/api/m/x/hc/start'))).toEqual([200, expect.objectContaining({ running: true })]);
  while ((await c.until('backend')).state !== 'ready');
  expect(await json(await r.tc.request('POST', '/api/m/x/hc/restart'))).toEqual([200, expect.objectContaining({ running: true })]);
  expect((await r.tc.request('POST', '/api/m/x/hc/explode')).status).toBe(404);
  const events = r.tc.audit.records().map((x) => x.event);
  for (const e of ['hc.stop', 'hc.start', 'hc.restart', 'term.restart']) expect([e, events.includes(e)]).toEqual([e, true]);

  // An agent that fails: the code, audited.
  r.sim.digest = '';
  r.sim.running = false;
  expect(await json(await r.tc.request('POST', '/api/m/x/hc/start'))).toEqual([502, expect.objectContaining({ error: 'not_bundled' })]);
  expect(r.tc.audit.records().at(-1)).toMatchObject({ event: 'hc.start', machine: 'x', error: 'not_bundled' });
});

test('routes that change state are guarded', async () => {
  const machines = () => testMachines([sshSpec('x')]);
  const rw = testCore({ features: [terminalsFeature()], machines: machines() });
  const ro = testCore({ features: [terminalsFeature()], machines: machines(), readOnly: true });
  const { problems, checked } = await checkGuarded(rw, ro, { machine: 'x' });
  expect(problems).toEqual([]);
  expect(checked).toEqual(['POST /api/m/:id/hc/:action']);
  // An offline machine.
  expect(await (await rw.request('GET', '/api/m/x/hc')).json()).toMatchObject({ error: 'machine_offline' });
  expect((await rw.request('GET', '/api/m/x/privacy')).status).toBe(409);
  // Not a WebSocket.
  expect((await rw.request('GET', '/api/v1/term')).status).toBe(426);
});

// New terminals get the machine's virtual display: its variables replace
// the client's, the rest of the client's environment stays, and the audit
// log names them. Malformed environments are refused.
test('terminal.run gets the display', async () => {
  let display: Record<string, string> | undefined = { DISPLAY: ':20', XAUTHORITY: '/home/u/.veldr/run/xauth' };
  const r = await start({ options: { paneEnv: () => display } });
  const core = r.sim.core!;
  const c = await r.client();
  await c.ready();
  const run = await c.call(1, 'terminal.run', { argv: ['sh'], cwd: '/srv/api', env: { DISPLAY: ':0', TOKEN: 's3cret' } });
  expect(run.error).toBeUndefined();
  const last = () => core.calls.filter((x) => x.method === 'terminal.run').at(-1)!.params as Record<string, unknown>;
  expect(last().env).toEqual({ DISPLAY: ':20', TOKEN: 's3cret', XAUTHORITY: '/home/u/.veldr/run/xauth' });
  // The audit entry names the variables added and those the client gave,
  // with its working directory, but no values.
  expect(r.tc.audit.records()).toContainEqual(
    expect.objectContaining({
      event: 'terminal.run',
      env: ['DISPLAY', 'XAUTHORITY'],
      client_env: ['DISPLAY', 'TOKEN'],
      cwd: '/srv/api',
      argv: ['sh'],
    }),
  );
  expect(r.tc.audit.text()).not.toContain('s3cret');
  expect(kind(await c.call(2, 'terminal.run', { env: 'DISPLAY=:0' }))).toBe('usage');
  // Without a display nothing is added.
  display = undefined;
  await c.call(3, 'terminal.run', { argv: ['sh'] });
  expect('env' in last()).toBe(false);
});

// New terminals of an ssh machine get the variables of its agent's ssh
// session: what the client gave stays, the audit log names the ones added,
// the setting turns them off, and clients do not see the session in the
// machine's state.
test('terminal.run gets the ssh session', async () => {
  const settings = { 'terminal.sshEnv': true };
  let display: Record<string, string> | undefined;
  const r = await start({ ssh: '10.0.0.2 51000 10.0.0.9 22', settings, options: { paneEnv: () => display } });
  const core = r.sim.core!;
  const c = await r.client();
  await c.ready();
  const last = () => core.calls.filter((x) => x.method === 'terminal.run').at(-1)!.params as Record<string, unknown>;
  expect((await c.call(1, 'terminal.run', { argv: ['sh'] })).error).toBeUndefined();
  expect(last().env).toEqual({ SSH_CONNECTION: '10.0.0.2 51000 10.0.0.9 22', SSH_CLIENT: '10.0.0.2 51000 22' });
  expect(r.tc.audit.records().at(-1)).toMatchObject({ env: ['SSH_CLIENT', 'SSH_CONNECTION'] });
  expect(r.tc.audit.text()).not.toContain('51000');
  // The client's own value stays, and the display's variables come too.
  display = { DISPLAY: ':20' };
  await c.call(2, 'terminal.run', { argv: ['sh'], env: { SSH_CONNECTION: 'mine' } });
  expect(last().env).toEqual({ SSH_CONNECTION: 'mine', SSH_CLIENT: '10.0.0.2 51000 22', DISPLAY: ':20' });
  expect(r.tc.audit.records().at(-1)).toMatchObject({ env: ['DISPLAY', 'SSH_CLIENT'] });
  display = undefined;
  // Clients see the machine, not its ssh session.
  expect(JSON.stringify(r.machines.get('x')!.state())).not.toContain('51000');
  // Off for this machine: nothing is added.
  r.tc.settings['terminal.sshEnv'] = false;
  await c.call(3, 'terminal.run', { argv: ['sh'] });
  expect('env' in last()).toBe(false);
});

// Program windows read each terminal's record now and type as a viewer of
// the terminal's own size.
test('shells', async () => {
  const r = await start();
  const core = r.sim.core!;
  expect(r.feature.shells('x')).toBeUndefined();
  const c = await r.client();
  await c.ready();
  const sh = r.feature.shells('x')!;
  expect(sh.all()).toEqual(['t1']);
  expect(await sh.shell('t1')).toEqual({ pid: 42, idle: true });
  await sh.send('t1', 'echo typed\r');
  await core.waitFor('0:echo typed\r');
  await core.waitFor('"resumed":true');
  await core.waitFor('"cols":80,"rows":24');
  expect(shells(r.backend()).all()).toEqual(['t1']);
});

describe('agents', () => {
  // Detected agents reach the terminal records, the subscribers (an
  // "agent" event) and /ws (agent messages, with the terminal's address).
  // A turn that ended is seen, and reported idle, when a client has the
  // terminal focused, then or later.
  test('records, events and /ws', async () => {
    const r = await start();
    const c = await r.client();
    await c.ready();
    const b = r.backend();
    b.agents.apply({ terminal: 't1', agent: 'claude', status: 'working' });
    expect(await c.agentData()).toMatchObject({ agent_status: 'working' });
    // A later subscriber finds it in the record.
    const c2 = await r.client();
    c2.send({ t: 'sub', m: 'x' });
    expect(((await c2.until('snapshot')).terminals as object[])[0]).toMatchObject({ agent: 'claude', agent_status: 'working' });
    b.agents.apply({ terminal: 't1', agent: 'claude', status: 'done' });
    expect((await c.agentData()).agent_status).toBe('done');
    // Focusing the terminal sees it.
    c.send({ t: 'attach', rid: 1, m: 'x', terminal: 't1', cols: 80, rows: 24 });
    const sid = (await c.until('attached')).s;
    c.send({ t: 'focus', s: sid, focused: true });
    expect((await c.agentData()).agent_status).toBe('idle');
    // While it has the focus, a turn that ends is seen at once.
    b.agents.apply({ terminal: 't1', agent: 'claude', status: 'working' });
    await c.agentData();
    b.agents.apply({ terminal: 't1', agent: 'claude', status: 'done' });
    expect((await c.agentData()).agent_status).toBe('idle');
    b.agents.apply({ terminal: 't1', agent: '', status: '' });
    expect((await c.agentData()).agent).toBeNull();
    b.agents.apply({ terminal: 't1', agent: '', status: '' }); // nothing to clear: no event
    expect(r.ws.length).toBe(6);
    expect(r.ws[0]).toEqual({ agent: 'claude', agent_status: 'working', display_agent: 'claude', terminal: 't1', title: '' });
    expect(r.ws[1]).toMatchObject({ agent_status: 'done' });
  });

  // A done the program reports itself (OSC 7501) outlives the core: a
  // client that sees it labels the terminal with its turn, and a core that
  // starts again reads that turn's done as seen; a later turn's done is
  // news.
  test('a seen turn outlives the core', async () => {
    const rec = (turn: number, labels: object) => [
      { address: 't1', state: 'live', cols: 80, rows: 24, labels, reported: true, status: { state: 'done' }, turn },
    ];
    const begin = async (snap: object[]) => {
      const r = await start({ sim: (s) => (s.core!.snap = snap) });
      const c = await r.client();
      await c.ready();
      return { r, c, b: r.backend() };
    };
    let { r, c, b } = await begin(rec(3, { seen: '3', closing: '' }));
    b.agents.apply({ terminal: 't1', agent: 'codex', status: 'done' });
    expect((await c.agentData()).agent_status).toBe('idle');
    ({ r, c, b } = await begin(rec(4, { seen: '3' })));
    b.agents.apply({ terminal: 't1', agent: 'codex', status: 'done' });
    expect((await c.agentData()).agent_status).toBe('done');
    const labels = () => r.sim.core!.calls.filter((x) => x.method === 'terminal.label').map((x) => x.params);
    expect(labels()).toEqual([]);
    c.send({ t: 'attach', rid: 1, m: 'x', terminal: 't1', cols: 80, rows: 24 });
    const sid = (await c.until('attached')).s;
    c.send({ t: 'focus', s: sid, focused: true });
    expect((await c.agentData()).agent_status).toBe('idle');
    await waitFor('the seen label', () => JSON.stringify(labels()) === '[{"labels":{"seen":"4"},"terminal":"t1"}]');
    // A done the program does not report itself is never taken for seen.
    ({ c, b } = await begin([{ address: 't1', state: 'live', cols: 80, rows: 24, labels: { seen: '0' } }]));
    b.agents.apply({ terminal: 't1', agent: 'claude', status: 'done' });
    expect((await c.agentData()).agent_status).toBe('done');
  });
});

describe('the last viewer', () => {
  // A terminal's size is its last active viewer's: the stream of the last
  // viewer that sets the size stays attached until another has attached or
  // the terminal ends. Any other viewer's stream is closed when it leaves,
  // and an observer's always.
  test('is kept', async () => {
    const r = await start();
    const core = r.sim.core!;
    const closes = (n: number) => waitFor(`${n} streams closed`, () => core.closes === n);
    const attach = async (c: Awaited<ReturnType<Rig['client']>>, rid: number, observe: boolean) => {
      c.send({ t: 'attach', rid, m: 'x', terminal: 't1', cols: 80, rows: 24, observe });
      return (await c.until('attached')).s;
    };
    const a = await r.client();
    const b = await r.client();
    for (const c of [a, b]) {
      c.send({ t: 'sub', m: 'x' });
      await c.until('snapshot');
    }
    const sa = await attach(a, 1, false);
    const sb = await attach(b, 1, false);
    let so = await attach(a, 2, true);
    // One of two viewers leaves, and an observer: both streams are closed.
    a.send({ t: 'detach', s: sa });
    await closes(1);
    a.send({ t: 'detach', s: so });
    await closes(2);
    // The last one leaves: its stream stays.
    b.send({ t: 'detach', s: sb });
    a.send({ t: 'attach', rid: 3, m: 'x', terminal: 't404', cols: 80, rows: 24 });
    await a.until('res');
    expect(core.closes).toBe(2);
    // An observer does not take its place; the next viewer does.
    so = await attach(a, 4, true);
    a.send({ t: 'detach', s: so });
    await closes(3);
    await attach(a, 5, false);
    await closes(4);
    // A client that leaves with the terminal's last viewer: the stream
    // stays as after a detach, until the next client's viewer has attached.
    a.close();
    b.send({ t: 'attach', rid: 6, m: 'x', terminal: 't404', cols: 80, rows: 24 });
    await b.until('res');
    await sleep(50);
    expect(core.closes).toBe(4);
    await attach(b, 7, false);
    await closes(5);
  });

  // The stream kept for a terminal's size is handed back by a client that
  // stopped following the machine, and ends with its terminal also when
  // the events saying so were missed.
  test('ends with its terminal', async () => {
    const r = await start();
    const core = r.sim.core!;
    const a = await r.client();
    const sub = async () => {
      a.send({ t: 'sub', m: 'x' });
      await a.until('snapshot');
    };
    const attach = async (rid: number) => {
      a.send({ t: 'attach', rid, m: 'x', terminal: 't1', cols: 80, rows: 24 });
      return (await a.until('attached')).s;
    };
    const barrier = async (rid: number) => {
      a.send({ t: 'attach', rid, m: 'x', terminal: 't404', cols: 80, rows: 24 });
      await a.until('res');
    };
    await sub();
    let sa = await attach(1);
    a.send({ t: 'unsub', m: 'x' });
    a.send({ t: 'detach', s: sa });
    a.send({ t: 'sub', m: 'x' });
    await a.until('snapshot');
    await barrier(2);
    expect(core.closes).toBe(0);
    // The next viewer takes its place and is the last one in turn.
    sa = await attach(3);
    await waitFor('1 stream closed', () => core.closes === 1);
    a.send({ t: 'detach', s: sa });
    await barrier(4);
    expect(core.closes).toBe(1);
    // t1 ended while the events were missed.
    core.notify('{"jsonrpc":"2.0","method":"missed","params":{"seq":9,"terminals":[]}}');
    await waitFor('2 streams closed', () => core.closes === 2);
    void sub;
  });
});

test('a removed machine’s backend goes', async () => {
  const r = await start();
  const c = await r.client();
  await c.ready();
  const b = r.backend();
  r.tc.core.forget('x');
  expect(r.feature.existing('x')).toBeUndefined();
  // The client no longer follows it: a call is unavailable, a sub starts a
  // new backend.
  expect(kind(await c.call(1, 'terminal.list'))).toBe('unavailable');
  c.send({ t: 'sub', m: 'x' });
  while ((await c.until('backend')).state !== 'ready');
  expect(r.feature.existing('x')).not.toBe(b);
  expect(b.connection()).toBeNull();
});

test('an idle backend closes its connection', async () => {
  const r = await start({ options: { timing: { idleMs: 50 } } });
  const c = await r.client();
  await c.ready();
  const b = r.backend();
  c.send({ t: 'unsub', m: 'x' });
  await waitFor('the connection closes', () => b.connection() === null);
  await waitFor('the machine shows no terminal core', () => r.machines.get('x')!.state().hc === undefined);
  c.send({ t: 'sub', m: 'x' });
  while ((await c.until('backend')).state !== 'ready');
});
