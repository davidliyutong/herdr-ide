import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { Fail } from '../fail.ts';
import { agentDialer, localSpec, running, sleep, sshSpec, testMachines, waitFor, TEST_INFO } from '../testing.ts';
import { Op, readLine, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { Machine, type Dialer, type StreamHandler } from './machine.ts';
import { Registry } from './registry.ts';
import { LOCAL_ID, loadSpecs, sortByOrder, validTarget, type Spec, type State } from './spec.ts';

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'machines-')), 'machines.json');

const failCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof Fail ? e.code : `not a Fail: ${(e as Error).message}`;
  }
  return 'no error';
};

const asyncFailCode = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'no error',
    (e) => (e instanceof Fail ? e.code : `not a Fail: ${(e as Error).message}`),
  );

describe('registry', () => {
  // Records are written at once and read back; a broken file, or one of
  // another kind, is reported and left alone (the core then keeps its
  // machines in memory); without a file there are no machines and none is
  // written.
  test('round trip and errors', () => {
    const path = tempFile();
    let r = Registry.open(path);
    r.put(sshSpec('x1', 'u@box', 'box'));
    r.put({ id: 'y2', label: '', kind: 'ssh', target: 'y', enabled: false });
    r.put({ ...sshSpec('x1', 'u@box', 'box 2'), enabled: false });
    expect(() => r.put({ id: '', label: '', kind: 'ssh', target: 'z', enabled: false })).toThrow();
    r.delete('y2');
    r = Registry.open(path);
    expect(r.specs()).toEqual([{ id: 'x1', label: 'box 2', kind: 'ssh', target: 'u@box', enabled: false }]);

    writeFileSync(path, '{');
    expect(() => Registry.open(path)).toThrow();
    // What the core falls back to writes nothing.
    Registry.memory().put(sshSpec('z'));
    expect(readFileSync(path, 'utf8')).toBe('{');

    writeFileSync(path, '{"enabled":{"a1":false}}');
    expect(() => Registry.open(path)).toThrow('not a machines file');
    for (const bad of ['[]', '{"version":"1"}', '{"machines":{}}', '{"machines":[],"order":[1]}']) {
      writeFileSync(path, bad);
      expect(() => Registry.open(path)).toThrow();
    }

    const none = tempFile();
    expect(Registry.open(none).specs()).toEqual([]);
    expect(existsSync(none)).toBe(false);
  });

  // A stored record whose target is refused is kept: it is stored, written
  // back with the file's other entries and the fields this version does not
  // know, and listed; new records with such a target are refused.
  test('keeps invalid targets, unknown entries and fields', () => {
    const path = tempFile();
    writeFileSync(
      path,
      `{"version":1,"machines":[
        {"id":"a1","label":"gpu","kind":"ssh","target":"gpu-host","enabled":true},
        {"id":"p1","label":"proxy","kind":"ssh","target":"-oProxyCommand=touch /tmp/pwned","enabled":true},
        {"id":"s1","label":"","kind":"ssh","target":"host;id","enabled":true}]}`,
    );
    let r = Registry.open(path);
    const got = r.specs();
    expect(got.length).toBe(3);
    expect([got[1].id, got[1].target, got[2].label]).toEqual(['p1', '-oProxyCommand=touch /tmp/pwned', 's1']);
    r.put(got[0]);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('ProxyCommand');
    expect(written).toContain('host;id');
    // New records and changed targets must be valid; a stored record keeps
    // its own target through a rename.
    expect(failCode(() => r.put(sshSpec('p2', '-oProxyCommand=x')))).toBe('invalid_target');
    expect(failCode(() => r.put(sshSpec('a1', 'a;b', 'gpu')))).toBe('invalid_target');
    r.put({ id: 'p1', label: 'renamed', kind: 'ssh', target: '-oProxyCommand=touch /tmp/pwned', enabled: false });
    expect(r.get('p1')?.label).toBe('renamed');

    // The file's own entries: what this version cannot use is kept as
    // written, unknown fields too, across a read and a write.
    writeFileSync(
      path,
      `{"version":1,"note":{"by":"hand"},"machines":[
        {"id":"a1","kind":"ssh","target":"gpu-host","enabled":true,"jump":"bastion"},
        {"id":"p1","kind":"ssh","target":"-oProxyCommand=touch /tmp/pwned","enabled":true},
        {"id":"n1","label":"no target","kind":"ssh","enabled":true},
        {"label":"no id","target":"x"},
        {"id":"a1","target":"duplicate"},
        {"id":"d1","kind":"docker","target":"c1"},
        "not a record",
        {"id":"local","kind":"local","enabled":false,"pinned":true}]}`,
    );
    r = Registry.open(path);
    expect(r.specs().map((s) => `${s.id}:${s.label}`)).toEqual(['a1:gpu-host', 'p1:p1', 'n1:no target', 'local:']);
    expect(r.kept()).toBe(4);
    r.put({ id: 'a1', label: 'GPU', kind: 'ssh', target: 'gpu-host', enabled: false });
    r.delete('n1');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect([file.version, file.note, file.machines.length]).toEqual([1, { by: 'hand' }, 7]);
    const want = [
      `{"id":"a1","label":"GPU","kind":"ssh","target":"gpu-host","enabled":false,"jump":"bastion"}`,
      `{"id":"p1","label":"p1","kind":"ssh","target":"-oProxyCommand=touch /tmp/pwned","enabled":true}`,
      `{"label":"no id","target":"x"}`,
      `{"id":"a1","target":"duplicate"}`,
      `{"id":"d1","kind":"docker","target":"c1"}`,
      `"not a record"`,
      `{"id":"local","label":"","kind":"local","enabled":false,"pinned":true}`,
    ];
    expect(file.machines.map((m: unknown) => JSON.stringify(m))).toEqual(want);
    // Read again, the same.
    r = Registry.open(path);
    expect([r.specs().length, r.kept()]).toEqual([3, 4]);

    expect(failCode(() => testMachines([]).add({ id: 'p3', label: 'p3', target: '-oProxyCommand=x' }))).toBe('invalid_target');
  });

  // A newer file's version is kept; the order is written only when set.
  test('version and order', () => {
    const path = tempFile();
    writeFileSync(path, '{"version":3,"machines":[]}');
    const r = Registry.open(path);
    r.put(sshSpec('a'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 3, machines: [sshSpec('a')] });
    r.setOrder(['a', LOCAL_ID]);
    expect(Registry.open(path).getOrder()).toEqual(['a', LOCAL_ID]);
  });

  // A change whose write fails is undone.
  test.skipIf(process.platform === 'win32')('a failed write changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'machines-'));
    const blocked = Registry.open(join(dir, 'machines.json'));
    // A directory where the file should be: the rename fails.
    mkdirSync(join(dir, 'machines.json', 'x'), { recursive: true });
    expect(() => blocked.put(sshSpec('b'))).toThrow();
    expect(blocked.specs()).toEqual([]);
    expect(() => blocked.setOrder(['b'])).toThrow();
    expect(blocked.getOrder()).toEqual([]);
  });
});

describe('specs', () => {
  // The local machine comes first, then the stored SSH machines and the
  // --ssh targets, each once. A stored machine whose target is refused
  // stays (it shows an error); an --ssh one does not (the core refuses to
  // start with it).
  test('loadSpecs', () => {
    const stored: Spec[] = [
      sshSpec('a1', 'gpu-host', 'gpu'),
      { id: LOCAL_ID, label: '', kind: 'local', enabled: true },
      sshSpec('evil', '-oProxyCommand=touch /tmp/x'),
    ];
    const specs = loadSpecs(
      stored,
      [{ target: 'extra' }, { id: 'a1', target: 'dup' }, { target: '-oProxyCommand=sh' }, { target: 'host;id' }],
      'mac.local',
    );
    expect(specs.map((s) => s.id)).toEqual([LOCAL_ID, 'a1', 'evil', 'extra']);
    expect(specs[0]).toEqual({ id: LOCAL_ID, label: 'mac (local)', kind: 'local', enabled: true });
    expect(specs[3]).toEqual({ id: 'extra', label: 'extra', kind: 'ssh', target: 'extra', enabled: true });
    // The local machine's record: its flag, and its label once given.
    const local = loadSpecs([{ id: LOCAL_ID, label: 'Workstation', kind: 'local', enabled: false }], [], 'mac');
    expect(local).toEqual([{ id: LOCAL_ID, label: 'Workstation', kind: 'local', enabled: false }]);
  });

  test('sortByOrder', () => {
    expect(sortByOrder(['a', 'b', 'c', 'd'], ['c', 'x', 'a', 'c'])).toEqual(['c', 'a', 'b', 'd']);
    expect(sortByOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });

  // Targets are the destinations OpenSSH takes, never one that reads as an
  // option or holds whitespace, a control character or a shell
  // metacharacter: the vectors every client runs
  // (spec/vectors/machines/targets.json).
  test('validTarget', () => {
    const v = JSON.parse(readFileSync(join(REPO_ROOT, 'spec/vectors/machines/targets.json'), 'utf8')) as {
      accept: string[];
      reject: string[];
    };
    expect(v.accept.length).toBeGreaterThanOrEqual(20);
    expect(v.reject.length).toBeGreaterThanOrEqual(30);
    for (const ok of [...v.accept, 'user+tag@host', 'me@[fe80::1%en0]:2222', 'ssh://u@h:22', '~alias', '日本'])
      expect([ok, validTarget(ok)]).toEqual([ok, true]);
    // Go's invalid UTF-8 ("h\xff") has no JS string; lone surrogates are
    // what a JS string holds instead.
    for (const bad of [...v.reject, '-oProxyCommand=x', 'a b', 'h`id`', '$(x)', 'h\uD800', 'h\uDC00x', 'x'.repeat(256)])
      expect([bad, validTarget(bad)]).toEqual([bad, false]);
    expect(validTarget('é'.repeat(127))).toBe(true);
    expect(validTarget('é'.repeat(128))).toBe(false); // 256 bytes of UTF-8
  });
});

/** Records the dials of each machine; each fails. */
function failingDialer() {
  const dials = new Map<string, number>();
  const dial: Dialer = async (s) => {
    dials.set(s.id, (dials.get(s.id) ?? 0) + 1);
    throw new Error('no');
  };
  return { dial, dials };
}

describe('machines', () => {
  // A machine whose stored target is refused shows an error with its code
  // and is never dialed: not when the manager runs it, not when it is
  // enabled, retried or renamed. Removing it ends it.
  test('an invalid target is never dialed', async () => {
    const path = tempFile();
    writeFileSync(path, '{"version":1,"machines":[{"id":"bad","kind":"ssh","target":"h$(id)","enabled":false}]}');
    const reg = Registry.open(path);
    const { dial, dials } = failingDialer();
    const mg = testMachines(loadSpecs(reg.specs(), [], 'box'), { registry: reg, dial });
    const stop = running(mg);
    let st = mg.get('bad')!.state();
    expect([st.status, st.code, st.label]).toEqual(['error', 'invalid_target', 'bad']);
    mg.setEnabled('bad', true);
    mg.get('bad')!.wake();
    mg.setLabel('bad', 'old box');
    await sleep(50);
    st = mg.get('bad')!.state();
    expect([st.status, st.code, st.enabled, st.label]).toEqual(['error', 'invalid_target', true, 'old box']);
    expect(reg.get('bad')).toEqual({ id: 'bad', label: 'old box', kind: 'ssh', target: 'h$(id)', enabled: true });
    await mg.remove('bad');
    await stop();
    expect(dials.get('bad')).toBeUndefined();
  });

  // Where no agent runs (Windows) the local machine is listed in error with
  // its code and never dialed; SSH machines connect as anywhere else.
  test('the local machine without an agent', async () => {
    const { dial, dials } = failingDialer();
    const mg = testMachines([localSpec('box (local)'), sshSpec('gpu')], { dial, localSupported: false });
    const stop = running(mg);
    await waitFor('the SSH machine to be dialed', () => (dials.get('gpu') ?? 0) > 0);
    mg.get(LOCAL_ID)!.wake();
    await sleep(50);
    await stop();
    const st = mg.get(LOCAL_ID)!.state();
    expect([st.status, st.code]).toEqual(['error', 'local_unsupported']);
    expect(dials.get(LOCAL_ID)).toBeUndefined();
  });

  // A failed dial is shown with what failed and tried again after a wait
  // that grows; wake ends the wait.
  test('a failed dial is retried', async () => {
    const { dial, dials } = failingDialer();
    const states: State[] = [];
    const m = new Machine(sshSpec('x'), {
      dial,
      logger: () => {},
      publish: (st) => void states.push(st),
      streams: () => undefined,
      localSupported: true,
      timing: { backoffMinMs: 10_000 },
    });
    const ac = new AbortController();
    const done = m.run(ac.signal);
    await waitFor('the first dial', () => dials.get('x') === 1);
    await waitFor('the error', () => m.state().status === 'error');
    expect(m.state().error).toBe('no');
    m.wake();
    await waitFor('the second dial', () => dials.get('x') === 2);
    ac.abort();
    await done;
  });

  // A machine is ready once its agent answers, quietly.
  test('ready when the agent answers', async () => {
    const logs: string[] = [];
    const dial = agentDialer({ ssh: '10.0.0.1 5555 10.0.0.2 22' });
    const states: State[] = [];
    const m = new Machine(sshSpec('x'), {
      dial,
      logger: (l) => void logs.push(l),
      publish: (st) => void states.push(st),
      streams: () => undefined,
      localSupported: true,
    });
    expect(m.state().status).toBe('connecting');
    const ac = new AbortController();
    const done = m.run(ac.signal);
    await waitFor('ready', () => m.ready);
    await sleep(300);
    const st = m.state();
    expect([st.status, st.platform, st.info]).toEqual(['ready', 'test/test', TEST_INFO]);
    expect(m.live()).toBe(dial.agents[0].session);
    expect(m.sshConnection).toBe('10.0.0.1 5555 10.0.0.2 22');
    expect(states.at(-1)?.status).toBe('ready');
    expect(logs).toEqual([]);
    ac.abort();
    await done;
    expect(dial.agents[0].session.closed).toBe(true);
    // Without a session, calls fail offline.
    expect(failCode(() => m.live())).toBe('offline');
  });

  // A session that ends is shown as an error and dialed again.
  test('a lost session is dialed again', async () => {
    const dial = agentDialer();
    const m = new Machine(sshSpec('x'), {
      dial,
      logger: () => {},
      publish: () => {},
      streams: () => undefined,
      localSupported: true,
      timing: { sessionRetryMs: 10 },
    });
    const ac = new AbortController();
    const done = m.run(ac.signal);
    await waitFor('ready', () => m.ready);
    dial.agents[0].kill();
    await waitFor('a second session', () => dial.agents.length === 2 && m.ready);
    expect(m.live()).toBe(dial.agents[1].session);
    ac.abort();
    await done;
  });

  // A node that another took over announces its drain: the machine dials
  // again, moves to the new session and closes the old one after a grace
  // period; when dialing again fails it keeps the old one.
  test('drain moves to the node that took over', async () => {
    const dial = agentDialer();
    const logs: string[] = [];
    const m = new Machine(sshSpec('x'), {
      dial,
      logger: (l) => void logs.push(l),
      publish: () => {},
      streams: () => undefined,
      localSupported: true,
      timing: { drainGraceMs: 50 },
    });
    const ac = new AbortController();
    const done = m.run(ac.signal);
    await waitFor('ready', () => m.ready);
    const conn = await dial.agents[0].open({ op: Op.NodeDrain });
    expect(await readLine<Reply>(conn.reader)).toEqual({ ok: true });
    await waitFor('the new session', () => dial.agents.length === 2 && m.live() === dial.agents[1].session);
    expect(dial.agents[0].session.closed).toBe(false);
    await dial.agents[0].session.done();
    expect(m.ready).toBe(true);
    expect(logs).toEqual(['machine x: moved to the node that took over']);
    ac.abort();
    await done;
  });

  test('drain without a node to move to keeps the session', async () => {
    const dial = agentDialer();
    let fail = false;
    const m = new Machine(sshSpec('x'), {
      dial: async (s, signal) => {
        if (fail) throw new Error('refused');
        return dial(s, signal);
      },
      logger: () => {},
      publish: () => {},
      streams: () => undefined,
      localSupported: true,
    });
    const ac = new AbortController();
    const done = m.run(ac.signal);
    await waitFor('ready', () => m.ready);
    fail = true;
    const conn = await dial.agents[0].open({ op: Op.NodeDrain });
    expect(await readLine<Reply>(conn.reader)).toEqual({ ok: true });
    await sleep(50);
    expect([m.ready, m.live() === dial.agents[0].session]).toEqual([true, true]);
    ac.abort();
    await done;
  });

  // The streams an agent opens go to the stream handler with their header;
  // without a handler they are refused, and a stream without a header in
  // time is dropped.
  test('streams the agent opens', async () => {
    const dial = agentDialer();
    let handler: StreamHandler | undefined;
    const m = new Machine(sshSpec('x'), {
      dial,
      logger: () => {},
      publish: () => {},
      streams: () => handler,
      localSupported: true,
      timing: { headerTimeoutMs: 50 },
    });
    const ac = new AbortController();
    const done = m.run(ac.signal);
    await waitFor('ready', () => m.ready);
    const agent = dial.agents[0];
    let conn = await agent.open({ op: Op.Plugin, plugin: 'p' });
    expect(await readLine<Reply>(conn.reader)).toEqual({ ok: false, error: 'unsupported' });

    const got: Array<[string, Header]> = [];
    handler = (mc, c, h) => {
      got.push([mc.id, h]);
      void writeLine(c.stream, { ok: true, plugin: 'served' } satisfies Reply);
    };
    conn = await agent.open({ op: Op.Plugin, plugin: 'p', action: 'a' });
    expect(await readLine<Reply>(conn.reader)).toEqual({ ok: true, plugin: 'served' });
    expect(got).toEqual([['x', { op: Op.Plugin, plugin: 'p', action: 'a' }]]);

    const silent = await agent.open();
    silent.stream.on('error', () => {});
    silent.stream.resume();
    await new Promise((r) => silent.stream.once('close', r));
    expect(got.length).toBe(1);
    ac.abort();
    await done;
  });

  // Disabling a connected machine ends its session at once; enabling it
  // connects again.
  test('disable and enable at runtime', async () => {
    const dial = agentDialer();
    const path = tempFile();
    const reg = Registry.open(path);
    reg.put(sshSpec('x'));
    const mg = testMachines([sshSpec('x')], { registry: reg, dial });
    const stop = running(mg);
    const m = mg.get('x')!;
    await waitFor('a session', () => m.ready);
    const first = m.live();

    mg.setEnabled('x', false);
    await first.done();
    expect(failCode(() => m.live())).toBe('offline');
    await sleep(100);
    let st = m.state();
    expect([st.status, st.enabled, dial.agents.length]).toEqual(['disabled', false, 1]);
    expect(Registry.open(path).specs()[0].enabled).toBe(false);

    mg.setEnabled('x', true);
    await waitFor('a new session', () => m.ready && m.live() !== first);
    st = m.state();
    expect([st.enabled, dial.agents.length]).toEqual([true, 2]);
    expect(failCode(() => mg.setEnabled('nope', true))).toBe('unknown');
    await stop();
  });

  // Machines added at runtime are stored, join a running manager and
  // connect; removing one ends its session, deletes its record and
  // publishes nothing more for it. A target or id the core has is refused,
  // and the local machine cannot be removed.
  test('add and remove at runtime', async () => {
    const dial = agentDialer();
    const path = tempFile();
    const reg = Registry.open(path);
    // Stored, but left out of this run (--local-only).
    reg.put(sshSpec('off', 'u@elsewhere', 'elsewhere'));
    const mg = testMachines([localSpec()], { registry: reg, dial });
    let removed = false;
    let afterRemove = 0;
    mg.subscribe({ state: (st) => void (st.id === 'x' && removed && afterRemove++) });
    const stop = running(mg);

    const spec = { id: 'x', label: 'x', target: 'u@x' };
    mg.add(spec);
    for (const dup of [
      spec,
      { id: 'y', label: 'y', target: 'u@x' },
      { id: 'z', label: 'z', target: 'u@elsewhere' },
      { id: 'off', label: 'o', target: 'new' },
    ])
      expect(failCode(() => mg.add(dup))).toBe('machine_exists');
    expect(failCode(() => mg.add({ id: '', label: '', target: 'fresh' }))).toBe('machine_exists');
    const m = mg.get('x')!;
    await waitFor("the added machine's session", () => m.ready);
    const states = mg.states();
    expect(states.map((s) => [s.id, s.kind])).toEqual([
      [LOCAL_ID, 'local'],
      ['x', 'ssh'],
    ]);
    expect(
      Registry.open(path)
        .specs()
        .map((s) => s.target),
    ).toEqual(['u@elsewhere', 'u@x']);
    const sess = m.live();

    removed = true;
    await mg.remove('x');
    await sess.done();
    expect(mg.get('x')).toBeUndefined();
    expect(mg.states().length).toBe(1);
    await sleep(50);
    expect(afterRemove).toBe(0);
    expect(readFileSync(path, 'utf8')).not.toContain('"x"');
    expect(await asyncFailCode(mg.remove('x'))).toBe('unknown');
    expect(await asyncFailCode(mg.remove(LOCAL_ID))).toBe('local');
    await stop();
  });

  // Renaming is stored for stored machines and kept in memory for --ssh
  // ones; a label another machine has (also one stored but not running) is
  // refused, and the local machine's name is stored once given. Enabling
  // or disabling the local machine stores a record of it, without its
  // host's name.
  test('labels and the local record', () => {
    const path = tempFile();
    const reg = Registry.open(path);
    reg.put(sshSpec('a'));
    reg.put(sshSpec('off', 'e', 'elsewhere'));
    const mg = testMachines([localSpec('mac (local)'), sshSpec('a'), sshSpec('extra')], { registry: reg });
    const labels: string[] = [];
    mg.subscribe({ state: (st) => void labels.push(st.label) });

    mg.setLabel('a', 'GPU');
    expect([mg.get('a')!.label, labels[0]]).toEqual(['GPU', 'GPU']);
    for (const [id, label, want] of [
      ['extra', 'GPU', 'label_taken'],
      ['extra', 'elsewhere', 'label_taken'],
      [LOCAL_ID, 'GPU', 'label_taken'],
      ['nope', 'x', 'unknown'],
    ])
      expect([id, label, failCode(() => mg.setLabel(id, label))]).toEqual([id, label, want]);
    mg.setLabel('extra', 'Extra');
    expect(mg.get('extra')!.label).toBe('Extra');
    mg.setEnabled(LOCAL_ID, false);
    let got = Registry.open(path).specs();
    expect(got.length).toBe(3);
    expect(got[0].label).toBe('GPU');
    expect(got[2]).toEqual({ id: LOCAL_ID, label: '', kind: 'local', enabled: false });
    expect(mg.get(LOCAL_ID)!.state().status).toBe('disabled');
    // Renamed, the local machine keeps its name in its record, which the
    // next start uses instead of the host's.
    mg.setLabel(LOCAL_ID, 'Workstation');
    expect(mg.get(LOCAL_ID)!.label).toBe('Workstation');
    const r = Registry.open(path);
    expect(r.get(LOCAL_ID)).toEqual({ id: LOCAL_ID, label: 'Workstation', kind: 'local', enabled: false });
    const local = loadSpecs(r.specs(), [], 'mac')[0];
    expect([local.label, local.enabled]).toEqual(['Workstation', false]);
    got = r.specs();
    expect(got.length).toBe(3);
  });

  // The order names each machine once; it is stored, and machines made
  // over the same file list themselves in it.
  test('order', () => {
    const path = tempFile();
    const reg = Registry.open(path);
    const mg = testMachines([localSpec(), sshSpec('a'), sshSpec('b')], { registry: reg });
    for (const bad of [
      ['a', 'b'],
      ['a', 'a', 'b'],
      ['a', 'b', 'nope'],
      ['a', 'b', LOCAL_ID, 'a'],
    ])
      expect(failCode(() => mg.setOrder(bad))).toBe('invalid');
    mg.setOrder(['b', LOCAL_ID, 'a']);
    expect(mg.list().map((m) => m.id)).toEqual(['b', LOCAL_ID, 'a']);
    const again = testMachines([localSpec(), sshSpec('c'), sshSpec('a')], { registry: Registry.open(path) });
    expect(again.list().map((m) => m.id)).toEqual([LOCAL_ID, 'a', 'c']);
  });

  // Agent events reach the listeners for machines the core has.
  test('agent events', () => {
    const mg = testMachines([localSpec()]);
    const got: unknown[] = [];
    const unsubscribe = mg.subscribe({ agent: (ev) => void got.push(ev) });
    mg.publishAgent({ m: LOCAL_ID, data: 1 });
    mg.publishAgent({ m: 'nope', data: 2 });
    unsubscribe();
    mg.publishAgent({ m: LOCAL_ID, data: 3 });
    expect(got).toEqual([{ m: LOCAL_ID, data: 1 }]);
  });
});
