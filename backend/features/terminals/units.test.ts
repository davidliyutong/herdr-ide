import { afterEach, describe, expect, test } from 'bun:test';
import { addEnv, readScreenOnly } from './allowlist.ts';
import { detectEvent } from './agents.ts';
import { goQuote, parseInbound } from './messages.ts';
import { localName, visibleList } from './records.ts';
import { sshEnv } from './sshenv.ts';
import { rig, type Rig, type TestClient } from './testing.ts';

// Only addresses and ports become the ssh variables.
test('sshEnv', () => {
  for (const [conn, client] of [
    ['10.0.0.2 51000 10.0.0.9 22', '10.0.0.2 51000 22'],
    ['  fe80::1%en0 4022 fe80::2%en0 22', 'fe80::1%en0 4022 22'],
    ['::1 1 ::1 2', '::1 1 2'],
  ])
    expect(sshEnv(conn)).toEqual({ SSH_CLIENT: client, SSH_CONNECTION: conn.trim().split(/\s+/).join(' ') });
  for (const conn of [
    '',
    '10.0.0.2 51000 10.0.0.9',
    'host 1 host 2',
    '10.0.0.2 x 10.0.0.9 22',
    '10.0.0.2 70000 10.0.0.9 22',
    '10.0.0.2 1 10.0.0.9 22 extra',
    '10.0.0.2 1 10.0.0.9 22\nEVIL=1',
    '$(id) 1 10.0.0.9 22',
    'fe80::1%$(id) 1 fe80::2 22',
    'fe80::1%a\x1b[31m 1 fe80::2 22',
    'fe80::1%a;b 1 fe80::2 22',
    'fe80::1% 1 fe80::2 22',
    '1.2.3.4%en0 1 fe80::2 22',
    'fe80::1%' + 'a'.repeat(40) + ' 1 fe80::2 22',
    '10.0.0.2﻿ 1 10.0.0.9 22',
  ])
    expect([conn, sshEnv(conn)]).toEqual([conn, null]);
});

test('the local machine gets no ssh session', async () => {
  const { terminalsFeature } = await import('./hub.ts');
  const { testHub, testMachines, localSpec, agentDialer, running, waitFor } = await import('#kernel/testing.ts');
  const { AgentSim } = await import('./testing.ts');
  const sim = new AgentSim();
  const machines = testMachines([localSpec()], { dial: agentDialer({ ssh: '10.0.0.2 1 10.0.0.9 22', serve: (h, c) => sim.serve(h, c) }) });
  const tc = testHub({ features: [terminalsFeature()], machines, settings: { 'terminal.sshEnv': true } });
  const stop = running(tc.hub);
  try {
    await waitFor('ready', () => machines.get('local')!.ready);
    const { TestClient } = await import('./testing.ts');
    const c = await TestClient.open(tc);
    await c.ready('local');
    await c.call(1, 'terminal.run', { argv: ['sh'] }, 'local');
    expect(sim.core!.calls.find((x) => x.method === 'terminal.run')!.params).toEqual({ argv: ['sh'] });
    c.close();
  } finally {
    await stop();
  }
});

test('parseInbound reads members as the Go core did', () => {
  expect(
    parseInbound('{"t":"attach","rid":3,"m":"x","terminal":"t1","cols":80,"rows":24,"display":{"bg":"#000","cell":[],"x":1}}'),
  ).toEqual({
    t: 'attach',
    rid: 3,
    m: 'x',
    s: 0,
    method: '',
    params: undefined,
    terminal: 't1',
    cols: 80,
    rows: 24,
    history: 0,
    observe: false,
    display: { bg: '#000' },
    focused: false,
    n: 0,
  });
  expect(parseInbound('null')).toMatchObject({ t: '', rid: 0 });
  expect(parseInbound('{"t":"call","params":null}')!.params).toBeNull();
  for (const bad of [
    '[]',
    '1',
    '{"rid":"1"}',
    '{"s":-1}',
    '{"s":4294967296}',
    '{"cols":1.5}',
    '{"observe":"yes"}',
    '{"display":[]}',
    '{"display":{"bg":1}}',
    '{"display":{"cell":["a"]}}',
  ])
    expect([bad, parseInbound(bad)]).toEqual([bad, null]);
});

test('goQuote', () => {
  expect(goQuote('t7')).toBe('"t7"');
  expect(goQuote('a"b\\c\n\x1b é')).toBe('"a\\"b\\\\c\\n\\x1b\\u00a0é"');
});

test('detect lines', () => {
  expect(detectEvent({ terminal: 't1', agent: 'claude', status: 'done', future: 1 })).toEqual({
    terminal: 't1',
    agent: 'claude',
    status: 'done',
    session: '',
    session_source: '',
  });
  expect(detectEvent({ terminal: 5 })).toBeUndefined();
  expect(detectEvent([1])).toBeUndefined();
});

test('addresses', () => {
  const core = { id: 'c0ffee', name: 'box' };
  expect(['t7', 'box/t7', 'c0ffee/t7', 'far/t7', 'box/', '/t7', 'box/a/b', 'name'].map((t) => localName(t, core))).toEqual([
    't7',
    't7',
    't7',
    null,
    null,
    null,
    null,
    'name',
  ]);
});

test('visibleList', () => {
  const none = () => false;
  const r = { terminals: [{ address: 't1' }], hidden_finished: 0 };
  expect(visibleList(r, none)).toBe(r);
  expect(visibleList({ terminals: null }, none)).toEqual({ terminals: null });
  expect(visibleList({ terminals: [{ address: 't1' }, { address: 'far/t2' }] }, none)).toEqual({ terminals: [{ address: 't1' }] });
  expect(visibleList({ terminals: [], machines: [{ name: 'far' }] }, none)).toEqual({ terminals: [], machines: [] });
  expect(visibleList({ terminals: [], machines: null }, none)).toEqual({ terminals: [], machines: null });
  expect(visibleList({ terminals: [{ address: 't1' }] }, (a) => a === 't1')).toEqual({ terminals: [] });
  for (const bad of [null, [], {}, { terminals: {} }, { terminals: [1] }]) expect(visibleList(bad, none)).toBeUndefined();
});

test('addEnv and readScreenOnly', () => {
  const p: Record<string, unknown> = { env: { A: '1', B: '2' } };
  expect(addEnv(p, { B: 'x', C: '3' }, false)).toEqual(['C']);
  expect(p.env).toEqual({ A: '1', B: '2', C: '3' });
  expect(addEnv(p, { B: 'y' }, true)).toEqual(['B']);
  expect(addEnv({ env: 'A=1' }, { B: 'y' }, true)).toBeUndefined();
  expect(addEnv({ env: { A: 1 } }, { B: 'y' }, true)).toBeUndefined();
  const q: Record<string, unknown> = { env: null };
  expect(addEnv(q, { B: 'y' }, true)).toEqual(['B']);
  expect(q.env).toEqual({ B: 'y' });
  const r: Record<string, unknown> = { lines: 1, LINES: 2, Lines: 3, lineſ: 4, linesx: 5, terminal: 't1' };
  readScreenOnly(r);
  expect(r).toEqual({ linesx: 5, terminal: 't1' });
});

describe('terminal.read', () => {
  const rigs: Rig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) await r.stop();
  });
  const start = async (readOnly: boolean) => {
    const r = await rig({ readOnly });
    rigs.push(r);
    const c = await r.client();
    await c.ready();
    return { r, c };
  };
  const callRead = async (c: TestClient, rid: number, params: string) => {
    c.sendRaw(`{"t":"call","rid":${rid},"m":"x","method":"terminal.read","params":${params}}`);
    const m = await c.until('res');
    expect(m.rid).toBe(rid);
    return m;
  };

  // A read-only client's terminal.read reads the screen only: the history
  // lines it asks for, which would make the terminal core scroll a program
  // on the alternate screen, do not reach the core, whatever their type or
  // spelling. The rest of its params does.
  test('a read-only client reads the screen only', async () => {
    const { r, c } = await start(true);
    const core = r.sim.core!;
    const reads = () => core.calls.filter((x) => x.method === 'terminal.read');
    const cases = [
      '"lines":50',
      '"lines":"50"',
      '"lines":null',
      '"lines":-1',
      '"lines":1.5e3',
      '"lines":true',
      '"lines":[50]',
      '"lines":{"n":50}',
      '"Lines":50',
      '"LINES":50',
      '"lines":50',
      '"lines":50,"lines":60',
    ];
    for (const [i, lines] of cases.entries()) {
      const terminal = `r${i}`;
      expect((await callRead(c, i, `{"terminal":"${terminal}",${lines},"future":1}`)).result).toBeTruthy();
      expect([lines, reads().at(-1)!.params]).toEqual([lines, { terminal, future: 1 }]);
    }
    // Params that are not an object are refused; null is passed on.
    for (const [i, params] of ['[{"lines":50}]', '"lines"', '50'].entries())
      expect((await callRead(c, 100 + i, params)).error).toMatchObject({ kind: 'usage' });
    expect((await callRead(c, 200, 'null')).result).toBeTruthy();
    expect(reads().length).toBe(13);
    expect(reads().at(-1)!.raw).toContain('"params":null');
  });

  // A client that may write reads history as it asks.
  test('a client that may write reads history', async () => {
    const { r, c } = await start(false);
    for (const [i, lines] of ['50', '"50"', '{"n":50}'].entries()) {
      const terminal = `w${i}`;
      expect((await callRead(c, i, `{"terminal":"${terminal}","lines":${lines}}`)).result).toBeTruthy();
      expect(r.sim.core!.calls.filter((x) => x.method === 'terminal.read').at(-1)!.params).toEqual({ terminal, lines: JSON.parse(lines) });
    }
  });
});
