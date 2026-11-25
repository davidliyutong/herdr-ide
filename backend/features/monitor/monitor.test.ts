// The System Monitor's routes: their guards and audit records, what
// reaches a machine (a fake of the Go agent's plugin op) and passes back
// to the page; and its settings.
import { afterEach, expect, test } from 'bun:test';
import { Op, readBody, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { agentDialer, checkGuarded, running, sshSpec, testCore, testMachines, waitFor } from '#kernel/testing.ts';
import { monitorFeature } from './core.ts';
import { settings } from './settings.ts';

const ON = { 'plugins.monitor.enabled': true };
const offlineCore = (readOnly = false) =>
  testCore({ features: [monitorFeature()], machines: testMachines([sshSpec('x', 'x', 'x', false)]), readOnly, settings: { ...ON } });

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

test('routes', async () => {
  const { problems, checked } = await checkGuarded(offlineCore(), offlineCore(true), { machine: 'x' });
  expect([problems, checked]).toEqual([[], ['POST /api/m/:id/p/monitor/signal']]);
  const gets = offlineCore().core.http.app.routes.filter((r) => r.method === 'GET' && r.path.includes('/p/monitor/'));
  expect([...new Set(gets.map((r) => r.path))].sort()).toEqual(['/api/m/:id/p/monitor/metrics', '/api/m/:id/p/monitor/processes']);
});

// A signal names a process above 1 (invalid_pid before the machine is
// asked), TERM when it names no signal; its record holds both.
test('signal params', async () => {
  const tc = offlineCore();
  const res = await tc.request('POST', '/api/m/x/p/monitor/signal', { body: '{"pid":1,"signal":"term"}' });
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, 'invalid_pid']);
  expect(tc.audit.records().at(-1)).toMatchObject({
    event: 'monitor.signal',
    plugin: 'monitor',
    machine: 'x',
    pid: 1,
    signal: 'TERM',
    status: 400,
  });
  await tc.request('POST', '/api/m/x/p/monitor/signal', { body: '{"pid":0}' });
  expect(tc.audit.records().at(-1)).toMatchObject({ pid: 0, signal: 'TERM', error: 'invalid_pid' });
  // Beyond pid_t (the Go machine build's kill would take 2^32-1 as -1,
  // every process of the user, and 2^32+pid as pid).
  for (const pid of [2 ** 32 - 1, 2 ** 32 + process.pid, 2 ** 31]) {
    const r = await tc.request('POST', '/api/m/x/p/monitor/signal', { body: JSON.stringify({ pid, signal: 'CONT' }) });
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([400, 'invalid_pid']);
  }
  for (const body of ['', 'nope', '{"pid":"7"}', '{"pid":1.5}', JSON.stringify({ pid: 7, signal: 'x'.repeat(5000) })]) {
    const r = await tc.request('POST', '/api/m/x/p/monitor/signal', { body });
    expect([body.slice(0, 12), r.status, ((await r.json()) as { error: string }).error]).toEqual([body.slice(0, 12), 400, 'bad_request']);
  }
  // Past the checks: the machine is not connected.
  const off = await tc.request('POST', '/api/m/x/p/monitor/signal', { body: '{"pid":4242,"signal":" kill "}' });
  expect(off.status).toBe(409);
  expect(tc.audit.records().at(-1)).toMatchObject({ pid: 4242, signal: 'KILL', error: 'offline' });
});

test('through the machine', async () => {
  const calls: Array<[string, unknown]> = [];
  const metrics = {
    hostname: 'box',
    os: 'linux',
    arch: 'amd64',
    uptimeSec: 5,
    timestampMs: 1,
    cpu: { usagePct: 1, cores: 2, load1: 0, load5: 0, load15: 0 },
    memory: { totalBytes: 1, usedBytes: 1, availableBytes: 0, usedPct: 100, swapTotalBytes: 0, swapUsedBytes: 0 },
    gpus: null,
    network: { rxBytesPerSec: 0, txBytesPerSec: 0, rxBytes: 0, txBytes: 0 },
    diskIO: { readBytesPerSec: 0, writeBytesPerSec: 0, readBytes: 0, writeBytes: 0 },
    disks: [{ mount: '/', device: 'sda', totalBytes: 1, usedBytes: 1, availBytes: 0, usedPct: 100, later: 'kept' }],
    sensors: { temps: [{ chip: 'k', label: 'cpu', tempC: 40 }] },
  };
  const processes = { processes: [], total: 0, cores: 2, memTotalBytes: 1, timestampMs: 1 };
  const reply = (action: string, params: Record<string, unknown>): Reply => {
    if (action === 'metrics') return { ok: true, plugin: metrics };
    if (action === 'processes') return { ok: true, plugin: processes };
    if (params.pid === 99) return { ok: false, code: 'denied', error: 'operation not permitted' };
    return { ok: true, plugin: { ok: true, pid: params.pid as number, signal: params.signal as string } };
  };
  const serve = async (h: Header, conn: AgentStream) => {
    try {
      if (h.op !== Op.Plugin || h.plugin !== 'monitor') return void (await writeLine(conn.stream, { ok: false, error: 'unsupported' }));
      const params = (h.params_length ? await readBody(conn.reader, h.params_length) : (h.params ?? {})) as Record<string, unknown>;
      calls.push([h.action ?? '', params]);
      await writeLine(conn.stream, reply(h.action ?? '', params));
    } finally {
      conn.reader.release();
      closeStream(conn.stream);
    }
  };
  const machines = testMachines([sshSpec('x')], { dial: agentDialer({ serve }) });
  const tc = testCore({ features: [monitorFeature()], machines, settings: { ...ON } });
  stops.push(running(tc.core));
  await waitFor('x ready', () => machines.get('x')!.ready);

  let res = await tc.request('GET', '/api/m/x/p/monitor/metrics');
  expect([res.status, res.headers.get('Cache-Control'), await res.json()]).toEqual([200, 'no-store', metrics]);
  res = await tc.request('GET', '/api/m/x/p/monitor/processes');
  expect(await res.json()).toEqual(processes);
  res = await tc.request('POST', '/api/m/x/p/monitor/signal', { body: '{"pid":4242,"signal":"hup","other":1}' });
  expect([res.status, await res.json()]).toEqual([200, { ok: true, pid: 4242, signal: 'HUP' }]);
  res = await tc.request('POST', '/api/m/x/p/monitor/signal', { body: '{"pid":99}' });
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, 'denied']);
  expect(calls).toEqual([
    ['metrics', {}],
    ['processes', {}],
    ['signal', { pid: 4242, signal: 'HUP' }],
    ['signal', { pid: 99, signal: 'TERM' }],
  ]);
  expect(tc.audit.records().map((r) => [r.event, r.pid, r.signal, r.status])).toEqual([
    ['monitor.signal', 4242, 'HUP', 200],
    ['monitor.signal', 99, 'TERM', 400],
  ]);
});

test('settings', () => {
  const st = new Settings('', { modules: [settings] });
  expect([st.get('monitor.refreshSeconds'), st.get('monitor.statusBar'), st.get('monitor.confirmKill')]).toEqual([2, true, true]);
  expect(() => st.set('monitor.refreshSeconds', '', 31)).toThrow();
});
