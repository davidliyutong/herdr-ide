// The System Monitor's routes: their guards and audit records, what
// reaches a machine (a fake of the Go agent's plugin op) and passes back
// to the page; and its settings.
import { afterEach, expect, test } from 'bun:test';
import { Op, readBody, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { defineFeature } from '#kernel/feature.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { agentDialer, checkGuarded, running, sshSpec, testHub, testMachines, waitFor } from '#kernel/testing.ts';
import { MONITOR_CACHE_TTL_MS, monitorFeature } from './hub.ts';
import { settings } from './settings.ts';

const ON = { 'plugins.monitor.enabled': true };
const offlineHub = (readOnly = false) =>
  testHub({ features: [monitorFeature()], machines: testMachines([sshSpec('x', 'x', 'x', false)]), readOnly, settings: { ...ON } });

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

test('routes', async () => {
  const { problems, checked } = await checkGuarded(offlineHub(), offlineHub(true), { machine: 'x' });
  expect([problems, checked]).toEqual([[], ['POST /api/m/:id/p/monitor/signal']]);
  const gets = offlineHub().hub.http.app.routes.filter((r) => r.method === 'GET' && r.path.includes('/p/monitor/'));
  expect([...new Set(gets.map((r) => r.path))].sort()).toEqual(['/api/m/:id/p/monitor/metrics', '/api/m/:id/p/monitor/processes']);
});

// A signal names a process above 1 (invalid_pid before the machine is
// asked), TERM when it names no signal; its record holds both.
test('signal params', async () => {
  const tc = offlineHub();
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
  const tc = testHub({ features: [monitorFeature()], machines, settings: { ...ON } });
  stops.push(running(tc.hub));
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

test('caches and coalesces metrics/processes, invalidates processes on signal, and aborts on machine forget', async () => {
  let now = 10_000;
  let metricsCalls = 0;
  let procCalls = 0;
  let holdMetrics = false;
  let releaseMetrics!: () => void;
  let metricsStreamClosed = false;

  const makeMetrics = (n: number) => ({
    hostname: 'box',
    os: 'linux',
    arch: 'amd64',
    uptimeSec: n,
    timestampMs: now,
    cpu: { usagePct: n, cores: 2, load1: 0, load5: 0, load15: 0 },
    memory: { totalBytes: 1, usedBytes: 1, availableBytes: 0, usedPct: 100, swapTotalBytes: 0, swapUsedBytes: 0 },
    gpus: null,
    network: { rxBytesPerSec: 0, txBytesPerSec: 0, rxBytes: 0, txBytes: 0 },
    diskIO: { readBytesPerSec: 0, writeBytesPerSec: 0, readBytes: 0, writeBytes: 0 },
    disks: [],
    sensors: { temps: [] },
  });
  const makeProcs = (n: number) => ({ processes: [], total: n, cores: 2, memTotalBytes: 1, timestampMs: now });

  const serve = async (h: Header, conn: AgentStream) => {
    try {
      if (h.op !== Op.Plugin || h.plugin !== 'monitor') return void (await writeLine(conn.stream, { ok: false, error: 'unsupported' }));
      const params = (h.params_length ? await readBody(conn.reader, h.params_length) : (h.params ?? {})) as Record<string, unknown>;
      if (h.action === 'metrics') {
        const n = ++metricsCalls;
        if (holdMetrics) {
          conn.stream.on('error', () => {});
          conn.stream.resume();
          await new Promise<void>((r) => {
            releaseMetrics = r;
            conn.stream.once('close', () => {
              metricsStreamClosed = true;
              r();
            });
          });
          return;
        }
        await writeLine(conn.stream, { ok: true, plugin: makeMetrics(n) } satisfies Reply);
      } else if (h.action === 'processes') {
        const n = ++procCalls;
        await Bun.sleep(10);
        await writeLine(conn.stream, { ok: true, plugin: makeProcs(n) } satisfies Reply);
      } else if (h.action === 'signal') {
        await writeLine(conn.stream, {
          ok: true,
          plugin: { ok: true, pid: params.pid as number, signal: params.signal as string },
        } satisfies Reply);
      }
    } catch {
      // stream closed by abort
    } finally {
      conn.reader.release();
      closeStream(conn.stream);
    }
  };

  let forgetMachine!: (id: string) => void;
  const forgetProbe = defineFeature({
    id: 'forget-probe',
    toggle: false,
    setup(ctx) {
      forgetMachine = ctx.forget;
    },
  });
  const machines = testMachines([sshSpec('x')], { dial: agentDialer({ serve }) });
  const tc = testHub({ features: [monitorFeature({ now: () => now }), forgetProbe], machines, settings: { ...ON } });
  stops.push(running(tc.hub));
  await waitFor('x ready', () => machines.get('x')!.ready);

  // Concurrent /processes calls coalesce into a single machine request, then serve cached within TTL.
  const [p1, p2] = await Promise.all([
    tc.request('GET', '/api/m/x/p/monitor/processes'),
    tc.request('GET', '/api/m/x/p/monitor/processes'),
  ]);
  expect([(await p1.json()) as { total: number }, (await p2.json()) as { total: number }]).toEqual([
    expect.objectContaining({ total: 1 }),
    expect.objectContaining({ total: 1 }),
  ]);
  expect(procCalls).toBe(1);

  const m1 = await tc.request('GET', '/api/m/x/p/monitor/metrics');
  const m2 = await tc.request('GET', '/api/m/x/p/monitor/metrics');
  expect([((await m1.json()) as { uptimeSec: number }).uptimeSec, ((await m2.json()) as { uptimeSec: number }).uptimeSec]).toEqual([1, 1]);
  expect(metricsCalls).toBe(1);

  // POST /signal invalidates the processes cache immediately while keeping metrics cached.
  const sig = await tc.request('POST', '/api/m/x/p/monitor/signal', { body: '{"pid":4242,"signal":"TERM"}' });
  expect(sig.status).toBe(200);
  const p3 = await tc.request('GET', '/api/m/x/p/monitor/processes');
  expect(((await p3.json()) as { total: number }).total).toBe(2);
  expect(procCalls).toBe(2);
  const m3 = await tc.request('GET', '/api/m/x/p/monitor/metrics');
  expect(((await m3.json()) as { uptimeSec: number }).uptimeSec).toBe(1);
  expect(metricsCalls).toBe(1);

  // Advancing past MONITOR_CACHE_TTL_MS expires the cache; onForget aborts an in-flight call and clears cached entries.
  now += MONITOR_CACHE_TTL_MS;
  holdMetrics = true;
  const inflight = tc.request('GET', '/api/m/x/p/monitor/metrics');
  await waitFor('metrics call in flight', () => metricsCalls === 2);
  forgetMachine('x');
  const aborted = await inflight;
  expect(aborted.status).toBeGreaterThanOrEqual(400);
  await waitFor('in-flight stream aborted on forget', () => metricsStreamClosed);
  releaseMetrics();

  // Cached processes entry for x was also cleared by onForget.
  holdMetrics = false;
  const p4 = await tc.request('GET', '/api/m/x/p/monitor/processes');
  expect(((await p4.json()) as { total: number }).total).toBe(3);
  expect(procCalls).toBe(3);
});
