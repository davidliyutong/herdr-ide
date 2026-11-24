import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelPair, CloseCode, type ChannelOpen, type Message } from '#kernel/channel.ts';
import { defineFeature } from '#kernel/feature.ts';
import { Registry } from '#kernel/machines/registry.ts';
import { loadSpecs, LOCAL_ID, type State } from '#kernel/machines/spec.ts';
import { authCommand } from '#kernel/machines/transport/ssh.ts';
import type { Pty, SpawnPty } from '#kernel/pty.ts';
import {
  agentDialer,
  checkGuarded,
  localSpec,
  running,
  sleep,
  sshSpec,
  testCore,
  testMachines,
  waitFor,
  type TestCore,
} from '#kernel/testing.ts';
import { machinesFeature, targetHost, type MachinesFeatureOptions } from './core.ts';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

/** A core with the local machine, a stored SSH machine (gpu) and an --ssh
 * machine (extra), over a machines file in a temporary directory. The
 * machines do not connect. */
function fixture(o: Partial<MachinesFeatureOptions> = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'machines-')), 'machines.json');
  const reg = Registry.open(path);
  reg.put(sshSpec('gpu', 'u@gpu'));
  const machines = testMachines([localSpec(), sshSpec('gpu', 'u@gpu'), sshSpec('extra')], { registry: reg });
  const forgotten: string[] = [];
  const forgetter = defineFeature({ id: 'forget', toggle: false, setup: (ctx) => ctx.onForget((id) => void forgotten.push(id)) });
  const opts: MachinesFeatureOptions = { home: () => '', controlDir: '', ...o };
  const core = (readOnly = false) => testCore({ features: [machinesFeature(opts), forgetter], machines, readOnly });
  const rw = core();
  return {
    path,
    machines,
    rw,
    ro: () => core(true),
    forgotten,
    stored: () => Registry.open(path).specs(),
    audited: () => rw.audit.text(),
  };
}

type Case = [readOnly: boolean, method: string, path: string, body: string | undefined, status: number, want: string];

async function run(f: ReturnType<typeof fixture>, cases: Case[]) {
  const ro = f.ro();
  for (const [readOnly, method, path, body, status, want] of cases) {
    const res = await (readOnly ? ro : f.rw).request(method, path, { body });
    const text = await res.text();
    expect([method, path, body, readOnly, res.status, text.includes(want) ? want : text]).toEqual([
      method,
      path,
      body,
      readOnly,
      status,
      want,
    ]);
  }
}

const READ_ONLY = '"error":"read_only"';

describe('machines API', () => {
  // Adding stores an SSH machine and adds it to the running core; targets
  // that would read as options, odd labels, a target the core has and
  // read-only browsers are refused.
  test('add', async () => {
    const f = fixture();
    await run(f, [
      [false, 'POST', '/api/machines', '{"target":"-oProxyCommand=x"}', 400, '"error":"invalid_target"'],
      [false, 'POST', '/api/machines', '{"target":"a b"}', 400, '"error":"invalid_target"'],
      [false, 'POST', '/api/machines', '{"target":""}', 400, '"error":"invalid_target"'],
      [false, 'POST', '/api/machines', '{}', 400, '"error":"invalid_target"'],
      [false, 'POST', '/api/machines', '{"target":"h!x"}', 400, '"error":"invalid_target"'],
      [false, 'POST', '/api/machines', '{"target":"box;id"}', 400, '"error":"invalid_target"'],
      [false, 'POST', '/api/machines', '{"target":"$(id)"}', 400, '"error":"invalid_target"'],
      [false, 'POST', '/api/machines', '{"target":"box\\u000aid"}', 400, '"error":"invalid_target"'],
      [false, 'POST', '/api/machines', '{"target":"box","label":"a\\nb"}', 400, '"error":"invalid"'],
      [false, 'POST', '/api/machines', `{"target":"box","label":"${'x'.repeat(65)}"}`, 400, '"error":"invalid"'],
      [false, 'POST', '/api/machines', '{', 400, '"error":"invalid"'],
      [false, 'POST', '/api/machines', '{"target":1}', 400, '"error":"invalid"'],
      [false, 'POST', '/api/machines', '{"target":"u@gpu"}', 409, 'machine_exists'],
      [false, 'POST', '/api/machines', '{"target":"extra"}', 409, 'machine_exists'],
      [true, 'POST', '/api/machines', '{"target":"box"}', 403, READ_ONLY],
      [false, 'GET', '/api/machines/add?target=box', undefined, 404, 'not_found'],
      [false, 'POST', '/api/machines/refresh', '', 404, 'not_found'],
    ]);
    expect(f.machines.states().length).toBe(3);

    let res = await f.rw.request('POST', '/api/machines', { body: '{"target":" u@new-host ","label":" New host "}' });
    const st = (await res.json()) as State;
    expect([res.status, st.label, st.target, st.kind, st.enabled, st.id.length]).toEqual([201, 'New host', 'u@new-host', 'ssh', true, 16]);
    expect(f.machines.get(st.id)).toBeDefined();
    expect(f.machines.states().length).toBe(4);
    const got = f.stored();
    expect(got).toEqual([sshSpec('gpu', 'u@gpu'), { id: st.id, label: 'New host', kind: 'ssh', target: 'u@new-host', enabled: true }]);
    // Without a label, the target names it.
    res = await f.rw.request('POST', '/api/machines', { body: '{"target":"plain"}' });
    expect([res.status, ((await res.json()) as State).label]).toEqual([201, 'plain']);
    // User names and aliases OpenSSH takes.
    for (const target of ['user+tag@host', 'me@[fe80::1%en0]:2222', 'ssh://u@h:22', 'ユーザー@ホスト']) {
      res = await f.rw.request('POST', '/api/machines', { body: JSON.stringify({ target }) });
      expect([target, res.status]).toEqual([target, 201]);
    }
    const text = f.audited();
    for (const want of [
      '"event":"machine.add"',
      '"target":"u@new-host"',
      '"error":"machine_exists"',
      '"error":"invalid_target"',
      `"machine":"${st.id}"`,
    ])
      expect(text).toContain(want);
    // Read-only refusals and requests that never reached the route are not
    // audited as its event.
    expect(f.rw.audit.records().filter((r) => r.event === 'machine.add').length).toBe(14 + 6);
  });

  // Renaming changes the label at once; it is stored for stored machines
  // and kept for this run for --ssh ones. Empty, odd or taken labels and
  // read-only browsers are refused.
  test('rename', async () => {
    const f = fixture();
    await run(f, [
      [false, 'PUT', '/api/m/gpu/label', '{"label":"  "}', 400, 'invalid'],
      [false, 'PUT', '/api/m/gpu/label', '{"label":"a\\u0007b"}', 400, 'invalid'],
      [false, 'PUT', '/api/m/gpu/label', `{"label":"${'x'.repeat(65)}"}`, 400, 'invalid'],
      [false, 'PUT', '/api/m/gpu/label', '{}', 400, 'invalid'],
      [false, 'PUT', '/api/m/gpu/label', '{"label":"extra"}', 409, 'label_taken'],
      [false, 'PUT', '/api/m/nope/label', '{"label":"x"}', 404, '"error":"unknown"'],
      [true, 'PUT', '/api/m/gpu/label', '{"label":"x"}', 403, READ_ONLY],
    ]);
    const res = await f.rw.request('PUT', '/api/m/gpu/label', { body: '{"label":" -GPU box "}' });
    expect([res.status, ((await res.json()) as State).label, f.machines.get('gpu')!.label]).toEqual([200, '-GPU box', '-GPU box']);
    expect(f.stored()[0].label).toBe('-GPU box');
    expect((await f.rw.request('PUT', '/api/m/extra/label', { body: '{"label":"Extra"}' })).status).toBe(200);
    expect([f.machines.get('extra')!.label, f.stored().length]).toEqual(['Extra', 1]);
    expect((await f.rw.request('PUT', '/api/m/local/label', { body: '{"label":"Workstation"}' })).status).toBe(200);
    expect(f.machines.get('local')!.label).toBe('Workstation');
    for (const want of ['"event":"machine.rename"', '"from":"gpu"', '"label":"-GPU box"']) expect(f.audited()).toContain(want);
  });

  // Ordering names every machine once; the order is stored, and a core
  // that starts over the machines file lists them in it.
  test('order', async () => {
    const f = fixture();
    await run(f, [
      [false, 'PUT', '/api/machines/order', '{}', 400, 'invalid'],
      [false, 'PUT', '/api/machines/order', '{"order":["gpu","local"]}', 400, 'invalid'],
      [false, 'PUT', '/api/machines/order', '{"order":["gpu","gpu","local"]}', 400, 'invalid'],
      [false, 'PUT', '/api/machines/order', '{"order":["gpu","nope","local"]}', 400, 'invalid'],
      [true, 'PUT', '/api/machines/order', '{"order":["gpu","extra","local"]}', 403, READ_ONLY],
    ]);
    const res = await f.rw.request('PUT', '/api/machines/order', { body: '{"order":["gpu","extra","local"]}' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as State[]).map((s) => s.id)).toEqual(['gpu', 'extra', 'local']);
    expect(f.machines.states().map((s) => s.id)).toEqual(['gpu', 'extra', 'local']);
    const again = testMachines([localSpec(), sshSpec('new'), sshSpec('gpu', 'u@gpu')], { registry: Registry.open(f.path) });
    expect(again.states().map((s) => s.id)).toEqual(['gpu', 'local', 'new']);
    expect(f.audited()).toContain('"event":"machine.order"');
  });

  // Removing drops the machine and its record and tells every feature;
  // the local machine stays.
  test('remove', async () => {
    const f = fixture();
    await run(f, [
      [false, 'DELETE', '/api/m/local', undefined, 400, '"error":"local"'],
      [false, 'DELETE', '/api/m/nope', undefined, 404, '"error":"unknown"'],
      [true, 'DELETE', '/api/m/gpu', undefined, 403, READ_ONLY],
    ]);
    let res = await f.rw.request('DELETE', '/api/m/gpu');
    expect([res.status, await res.json(), f.machines.get('gpu'), f.stored().length]).toEqual([200, { removed: 'gpu' }, undefined, 0]);
    expect(f.forgotten).toEqual(['gpu']);
    res = await f.rw.request('DELETE', '/api/m/extra');
    expect([res.status, f.machines.get('extra')]).toEqual([200, undefined]);
    for (const want of ['"event":"machine.remove"', '"target":"u@gpu"']) expect(f.audited()).toContain(want);
  });

  // Enabling and disabling is a mutation: refused in read-only mode,
  // checked, audited and stored.
  test('enabled', async () => {
    const f = fixture();
    await run(f, [
      [true, 'PUT', '/api/m/gpu/enabled', '{"enabled":false}', 403, READ_ONLY],
      [false, 'PUT', '/api/m/nope/enabled', '{"enabled":false}', 404, '"error":"unknown"'],
      [false, 'PUT', '/api/m/gpu/enabled', '{}', 400, 'invalid'],
      [false, 'PUT', '/api/m/gpu/enabled', '{"enabled":"no"}', 400, 'invalid'],
    ]);
    expect(f.machines.get('gpu')!.state().enabled).toBe(true);
    let res = await f.rw.request('PUT', '/api/m/gpu/enabled', { body: '{"enabled":false}' });
    expect([res.status, f.machines.get('gpu')!.state().status]).toEqual([200, 'disabled']);
    expect(f.stored()[0].enabled).toBe(false);
    res = await f.rw.request('PUT', '/api/m/local/enabled', { body: '{"enabled":false}' });
    expect([res.status, f.stored().length]).toEqual([200, 2]);
    res = await f.rw.request('PUT', '/api/m/gpu/enabled', { body: '{"enabled":true}' });
    expect([res.status, f.machines.get('gpu')!.state().status]).toEqual([200, 'connecting']);
    for (const want of ['"event":"machine.disable"', '"machine":"gpu"', '"event":"machine.enable"']) expect(f.audited()).toContain(want);
  });

  // A stored machine whose target validTarget refuses is listed in error
  // with its code, can be renamed and removed, and never reaches ssh, not
  // even through the authentication terminal.
  test('a machine with an invalid target', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'machines-')), 'machines.json');
    writeFileSync(
      path,
      '{"version":1,"machines":[{"id":"bad","label":"bad","kind":"ssh","target":"-oProxyCommand=touch /tmp/x","enabled":true,"future":1}]}',
    );
    const reg = Registry.open(path);
    let dials = 0;
    const machines = testMachines(loadSpecs(reg.specs(), [], 'box'), {
      registry: reg,
      dial: async () => {
        dials++;
        throw new Error('dialed');
      },
    });
    const spawned: string[][] = [];
    const t = testCore({ features: [machinesFeature({ home: () => '', controlDir: '/tmp/ctl', pty: fakePty(spawned).spawn })], machines });
    const list = (await (await t.request('GET', '/api/machines')).json()) as State[];
    const { updated_at, ...bad } = list.find((s) => s.id === 'bad')!;
    expect(typeof updated_at).toBe('number');
    expect(bad).toEqual({
      id: 'bad',
      label: 'bad',
      kind: 'ssh',
      target: '-oProxyCommand=touch /tmp/x',
      enabled: true,
      status: 'error',
      code: 'invalid_target',
    });
    let res = await t.request('GET', '/api/m/bad/auth', { upgrade: () => new Response(null) });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, 'invalid_target']);
    res = await t.request('PUT', '/api/m/bad/label', { body: '{"label":"Old box"}' });
    expect([res.status, Registry.open(path).specs()[0].label]).toEqual([200, 'Old box']);
    const file = readFileSync(path, 'utf8');
    expect(file).toContain('"future": 1');
    expect(file).toContain('ProxyCommand');
    res = await t.request('DELETE', '/api/m/bad');
    expect([res.status, Registry.open(path).specs().length]).toEqual([200, 0]);
    expect([dials, spawned]).toEqual([0, []]);
  });

  // A file that cannot be written fails the change with save, and the
  // machines stay as they were.
  test.skipIf(process.platform === 'win32')('a failed save', async () => {
    const f = fixture();
    // A directory where the file goes: every write of it fails.
    const { rmSync } = await import('node:fs');
    rmSync(f.path);
    mkdirSync(join(f.path, 'x'), { recursive: true });
    for (const [method, path, body] of [
      ['POST', '/api/machines', '{"target":"new"}'],
      ['PUT', '/api/m/gpu/label', '{"label":"G"}'],
      ['PUT', '/api/m/gpu/enabled', '{"enabled":false}'],
      ['PUT', '/api/machines/order', '{"order":["gpu","extra","local"]}'],
      ['DELETE', '/api/m/gpu', undefined],
    ] as const) {
      const res = await f.rw.request(method, path, { body });
      expect([method, path, res.status, ((await res.json()) as { error: string }).error]).toEqual([method, path, 500, 'save']);
    }
    expect(f.machines.states().map((s) => [s.id, s.label, s.enabled])).toEqual([
      [LOCAL_ID, 'local', true],
      ['gpu', 'gpu', true],
      ['extra', 'extra', true],
    ]);
  });

  test('list and perf', async () => {
    const f = fixture();
    const ro = f.ro();
    const list = (await (await ro.request('GET', '/api/machines')).json()) as State[];
    expect(list.map((s) => [s.id, s.kind, s.status])).toEqual([
      [LOCAL_ID, 'local', 'connecting'],
      ['gpu', 'ssh', 'connecting'],
      ['extra', 'ssh', 'connecting'],
    ]);
    // The core process's use of the system, also for read-only clients.
    const res = await ro.request('GET', '/api/perf', { host: 'localhost:7780' });
    const u = (await res.json()) as Record<string, number>;
    expect(res.status).toBe(200);
    expect(Object.keys(u).sort()).toEqual(['cpu_ms', 'cpus', 'goroutines', 'memory', 'uptime_ms']);
    expect(u.cpu_ms).toBeGreaterThanOrEqual(0);
    expect(u.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(u.memory).toBeGreaterThan(0);
    expect(u.cpus).toBeGreaterThanOrEqual(1);
    // Bun reports no active resources (Go's goroutines were at least 1).
    expect(u.goroutines).toBeGreaterThanOrEqual(0);
  });
});

// Every route that changes something, taken from the core's own route
// table: a request from another site is refused, and so is the request in
// read-only mode. A route added without mutating or writable fails here.
test('mutating routes are guarded', async () => {
  const machines = testMachines([localSpec(), sshSpec('x')]);
  const make = (readOnly: boolean): TestCore =>
    testCore({
      features: [machinesFeature({ home: () => '', controlDir: '/tmp/ctl' })],
      machines,
      readOnly,
      guard: { allowedOrigins: ['https://ide.example.com'] },
    });
  const writableGET = [
    'GET /api/m/:id/auth', // starts an interactive ssh login
    // Changes nothing, but only adding a machine needs the core host's ssh
    // aliases: guarded as the changes are.
    'GET /api/ssh/hosts',
  ];
  const { problems, checked } = await checkGuarded(make(false), make(true), { machine: 'x', writableGET });
  expect(problems).toEqual([]);
  expect(checked.sort()).toEqual([
    'DELETE /api/m/:id',
    'GET /api/m/:id/auth',
    'GET /api/ssh/hosts',
    'POST /api/machines',
    'PUT /api/m/:id/enabled',
    'PUT /api/m/:id/label',
    'PUT /api/machines/order',
  ]);
});

// The Add Machine dialog's list of the core host's ssh aliases: aliases
// that are no machine's target yet, with their HostName and User only;
// none from another site or in read-only mode, and an empty list without a
// configuration or a home.
test('ssh hosts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  mkdirSync(join(home, '.ssh'), { mode: 0o700 });
  writeFileSync(
    join(home, '.ssh', 'config'),
    `Host gpu extra lab bad|alias *.corp
  HostName 10.0.0.5
  User yutong
  IdentityFile ~/.ssh/id_secret
Host EXTRA2 other
`,
  );
  let current = mkdtempSync(join(tmpdir(), 'home-'));
  const f = fixture({ home: () => current });
  const get = (t: TestCore, origin?: string) => t.request('GET', '/api/ssh/hosts', { origin });
  let res = await get(f.rw);
  expect([res.status, await res.text()]).toEqual([200, '[]']);
  current = home;
  res = await get(f.rw, 'http://127.0.0.1:7780');
  const body = await res.text();
  // gpu is u@gpu's host and extra a target: both are machines already.
  expect([res.status, JSON.parse(body)]).toEqual([
    200,
    [{ alias: 'lab', hostname: '10.0.0.5', user: 'yutong' }, { alias: 'EXTRA2' }, { alias: 'other' }],
  ]);
  expect(body).not.toContain('id_secret');
  expect((await get(f.rw, 'https://evil.example')).status).toBe(403);
  res = await get(f.ro());
  const text = await res.text();
  expect([res.status, text.includes('lab')]).toEqual([403, false]);
  current = '';
  res = await get(f.rw);
  expect([res.status, await res.text()]).toEqual([200, '[]']);
});

test('targetHost', () => {
  for (const [i, want] of Object.entries({
    gpu: 'gpu',
    'me@gpu': 'gpu',
    'ssh://me@gpu:2222': 'gpu',
    'gpu:22': 'gpu',
    'me@[fe80::1%en0]:22': 'fe80::1%en0',
    'fe80::1': 'fe80::1',
    'u%40x@h': 'h',
  }))
    expect([i, targetHost(i)]).toEqual([i, want]);
});

/** A SpawnPty whose program echoes the first line it reads ("got:<line>")
 * and exits. */
function fakePty(spawned: string[][] = [], sizes: Array<{ cols: number; rows: number }> = []) {
  let kills = 0;
  const spawn: SpawnPty = (argv, size) => {
    spawned.push([...argv]);
    sizes.push(size);
    const listeners: Array<(d: Uint8Array) => void> = [];
    let exit!: (code: number) => void;
    let input = '';
    const pty: Pty = {
      write(d) {
        input += typeof d === 'string' ? d : Buffer.from(d).toString();
        const i = input.indexOf('\r');
        if (i < 0) return;
        const out = Buffer.from(`${input.slice(0, i)}\r\ngot:${input.slice(0, i)}\r\n`);
        setTimeout(() => {
          for (const l of listeners) l(out);
          exit(0);
        }, 5);
      },
      resize() {},
      kill: () => void kills++,
      onData: (fn) => void listeners.push(fn),
      exited: new Promise((r) => (exit = r)),
    };
    return pty;
  };
  return { spawn, kills: () => kills };
}

describe('ssh login', () => {
  // Without a control directory (Windows: ssh shares no connections) or a
  // terminal on the core's host the endpoint refuses a login.
  test('needs a control directory', async () => {
    const machines = testMachines([sshSpec('gpu')]);
    const upgrade = () => new Response(null);
    for (const [o, status, code] of [
      [{ controlDir: '' }, 501, 'ssh_login_unsupported'],
      [{ controlDir: '/tmp/ctl' }, 501, 'ssh_login_unsupported'],
      [{ controlDir: '', pty: fakePty().spawn }, 501, 'ssh_login_unsupported'],
    ] as const) {
      const t = testCore({ features: [machinesFeature({ home: () => '', ...o })], machines });
      const res = await t.request('GET', '/api/m/gpu/auth', { upgrade });
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([status, code]);
    }
    const t = testCore({
      features: [machinesFeature({ home: () => '', controlDir: '/tmp/ctl', pty: fakePty().spawn })],
      machines: testMachines([localSpec(), sshSpec('gpu')]),
    });
    let res = await t.request('GET', '/api/m/gpu/auth');
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([426, 'upgrade_required']);
    res = await t.request('GET', '/api/m/local/auth', { upgrade });
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, 'not_ssh']);
  });

  // The login runs ssh in a terminal of the core's host, bridged to a
  // channel: what the page types reaches it, its output reaches the page,
  // and the channel closes with "done" once ssh exited; a closed channel
  // ends the program.
  test('bridges a terminal', async () => {
    const spawned: string[][] = [];
    const sizes: Array<{ cols: number; rows: number }> = [];
    const pty = fakePty(spawned, sizes);
    const machines = testMachines([sshSpec('gpu', 'u@gpu')]);
    const t = testCore({
      features: [machinesFeature({ home: () => '', controlDir: '/tmp/ctl', pty: pty.spawn, ptyDrainMs: 300 })],
      machines,
    });
    const { a, b } = channelPair();
    const out: Message[] = [];
    let closed: [number, string] | undefined;
    b.adopt(() => ({ message: (m) => void out.push(m), close: (code, reason) => void (closed = [code, reason]) }));
    let woken = false;
    const m = machines.get('gpu')!;
    const wake = m.wake.bind(m);
    m.wake = () => {
      woken = true;
      wake();
    };
    const res = await t.request('GET', '/api/m/gpu/auth?cols=80&rows=24', {
      upgrade: (open: ChannelOpen) => {
        a.adopt(open);
        return new Response(null);
      },
    });
    expect(res.status).toBe(200);
    expect(spawned).toEqual([authCommand('/tmp/ctl', 'u@gpu')]);
    expect(sizes).toEqual([{ cols: 80, rows: 24 }]);
    b.send('hi\r');
    await waitFor('the channel to close', () => closed !== undefined, 3000);
    expect(Buffer.concat(out.map((d) => Buffer.from(d))).toString()).toContain('got:hi');
    expect(closed).toEqual([CloseCode.Normal, 'done']);
    expect(woken).toBe(true);
    const rec = t.audit.records().find((r) => r.event === 'ssh.auth');
    expect(rec).toMatchObject({ machine: 'gpu', target: 'u@gpu' });

    // A size out of bounds is the default one; the page leaving ends ssh.
    const p2 = channelPair();
    p2.b.adopt(() => ({ message: () => {} }));
    await t.request('GET', '/api/m/gpu/auth?cols=0&rows=99999', {
      upgrade: (open: ChannelOpen) => {
        p2.a.adopt(open);
        return new Response(null);
      },
    });
    expect(sizes[1]).toEqual({ cols: 100, rows: 24 });
    const kills = pty.kills();
    p2.b.close();
    await sleep(10);
    expect(pty.kills()).toBe(kills + 1);
  });
});

describe('pages', () => {
  // A page starts from the list of machines and follows their states and
  // agents' events; the event that sounds goes to the page used last.
  test('machine messages', async () => {
    const machines = testMachines([localSpec(), sshSpec('gpu')]);
    const t = testCore({ features: [machinesFeature({ home: () => '', controlDir: '' })], machines });
    const connect = () => {
      const { a, b } = channelPair();
      const got: Array<Record<string, unknown>> = [];
      a.adopt((ch) => t.core.pages.connect(ch, { client: 'browser', readOnly: false, who: {} }));
      b.adopt(() => ({ message: (m) => void got.push(JSON.parse(m as string)) }));
      return { got, send: (m: object) => b.send(JSON.stringify(m)), close: () => b.close() };
    };
    const p1 = connect();
    const p2 = connect();
    await sleep(10);
    expect(p1.got[0]).toMatchObject({ t: 'machines', list: [{ id: LOCAL_ID }, { id: 'gpu' }] });
    p2.send({ t: 'active', idle: 0 });
    p1.send({ t: 'active', idle: 10_000 });
    await sleep(10);
    machines.publishAgent({ m: 'gpu', data: { state: 'done' } });
    machines.get('gpu')!.setLabel('GPU');
    await sleep(10);
    expect(p1.got.slice(1)).toEqual([
      { t: 'agent', m: 'gpu', data: { state: 'done' }, sound: false },
      { t: 'machine', state: expect.objectContaining({ id: 'gpu', label: 'GPU' }) },
    ]);
    expect(p2.got[1]).toEqual({ t: 'agent', m: 'gpu', data: { state: 'done' }, sound: true });
    // A page that left follows nothing.
    p2.close();
    await sleep(10);
    const n = p2.got.length;
    machines.publishAgent({ m: 'gpu', data: 2 });
    await sleep(10);
    expect(p2.got.length).toBe(n);
    // Adding broadcasts the list.
    const res = await t.request('POST', '/api/machines', { body: '{"target":"new"}' });
    expect(res.status).toBe(201);
    await sleep(10);
    expect(p1.got.at(-1)).toMatchObject({ t: 'machines', list: [{ id: LOCAL_ID }, { id: 'gpu' }, { target: 'new' }] });
  });

  // A read-only page cannot make a machine reconnect: its retry is refused
  // and audited, and the machine keeps its session. A page that may wakes
  // a machine's wait.
  test('retry', async () => {
    const dial = agentDialer();
    const machines = testMachines([sshSpec('x')], { dial });
    const t = testCore({ features: [machinesFeature({ home: () => '', controlDir: '' })], machines });
    stops.push(running(machines));
    const m = machines.get('x')!;
    await waitFor('ready', () => m.ready);
    const first = m.live();
    let wakes = 0;
    const wake = m.wake.bind(m);
    m.wake = () => {
      wakes++;
      wake();
    };
    const page = (readOnly: boolean) => {
      const { a, b } = channelPair();
      a.adopt((ch) => t.core.pages.connect(ch, { client: 'browser', readOnly, who: { remote: '10.0.0.1' } }));
      b.adopt(() => ({ message: () => {} }));
      return (msg: object) => b.send(JSON.stringify(msg));
    };
    page(true)({ t: 'retry', m: 'x' });
    await sleep(100);
    expect([first.closed, m.live() === first, wakes]).toEqual([false, true, 0]);
    expect(t.audit.records().find((r) => r.event === 'denied.retry')).toMatchObject({ machine: 'x', remote: '10.0.0.1' });
    const send = page(false);
    send({ t: 'retry', m: 'nope' });
    send({ t: 'retry' });
    send({ t: 'retry', m: 'x' });
    await sleep(20);
    expect([wakes, m.live() === first]).toEqual([1, true]);
  });
});
