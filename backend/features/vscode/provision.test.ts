// Preparing code-server on a machine through its agent: the install modes,
// uploads, extensions installed once, readiness per agent session, and a
// forgotten machine.
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_EXT, SLUG } from '#shared/lib/brand.ts';
import { discard } from '#shared/lib/log.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { agentDialer, localSpec, running, testMachines, waitFor } from '#kernel/testing.ts';
import { Artifacts, tarballFile } from './artifacts.ts';
import { CodeServers, Phase } from './provision.ts';
import { INSTALL, Install, PATH, settings } from './settings.ts';
import { agentState, codeServerAgent, type AgentState } from './testdata/core.ts';
import { DEFAULT_TIMING } from './timing.ts';
import { vsixContentHash } from './vsix.ts';

const dirs: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (b: string) => createHash('sha256').update(b).digest('hex');

/** A connected machine whose agent serves code-server's actions, and
 * CodeServers over a seed directory holding the release. */
async function setup(o: { install?: { mode: Install; bin: string }; bridge?: Uint8Array; extensions?: boolean; offline?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vsc-prov-'));
  dirs.push(dir);
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  const file = tarballFile('9.9.9', 'linux-amd64');
  writeFileSync(join(seed, file), 'release');
  writeFileSync(join(seed, `${file}.sha256`), `${sha('release')}  ${file}\n`);
  writeFileSync(join(seed, 'pub.ext-1.0.0.vsix'), 'vsix');
  const agent: AgentState = agentState();
  const dial = agentDialer({ serve: codeServerAgent(agent) });
  const machines = testMachines([localSpec()], { dial });
  stops.push(running(machines));
  const m = machines.get('local')!;
  await waitFor('ready', () => m.ready);
  const logs: string[] = [];
  const artifacts = new Artifacts({
    logger: discard,
    version: '9.9.9',
    seedDirs: [seed],
    cacheDir: join(dir, 'cache'),
    offline: o.offline ?? true,
    extensions: o.extensions ? [{ id: 'pub.ext', version: '1.0.0' }] : [],
  });
  const cs = new CodeServers({
    artifacts,
    logger: (l) => void logs.push(l),
    timing: DEFAULT_TIMING,
    install: () => o.install ?? { mode: Install.Push, bin: '' },
    bridgeVSIX: o.bridge ? async () => o.bridge! : undefined,
  });
  return { m, machines, agent, cs, logs, artifacts, dial };
}

const actions = (a: AgentState) => a.headers.map((h) => (h.bin ? `${h.action}:${h.bin}` : h.action));

test('push: the core uploads the release, the bridge and the extensions once', async () => {
  const bridge = new Uint8Array(Buffer.from('bridge vsix'));
  const { m, agent, cs } = await setup({ bridge, extensions: true });
  expect(cs.status(m)).toEqual({ phase: Phase.Idle, ready: false });
  await cs.ensure(m, AbortSignal.timeout(5000));
  expect(cs.status(m)).toEqual({ phase: Phase.Ready, ready: true });
  expect(cs.ready(m)).toBe(true);
  expect(cs.running()).toEqual(['local']);
  expect(agent.uploads.get('install')?.toString()).toBe('release');
  expect(agent.uploads.get(`${BRIDGE_EXT}.vsix`)?.toString()).toBe('bridge vsix');
  expect(agent.uploads.get('pub.ext-1.0.0.vsix')?.toString()).toBe('vsix');
  expect([...agent.markers].sort()).toEqual([`.${BRIDGE_EXT}-${vsixContentHash(bridge)}`, `.${SLUG}-ext-pub.ext-1.0.0`].sort());
  expect(actions(agent)).toEqual(['status', 'install', 'marker', 'install-ext', 'marker', 'marker', 'install-ext', 'marker', 'start']);
  expect(agent.headers.every((h) => h.version === '9.9.9')).toBe(true);
  // Ready: nothing more.
  await cs.ensure(m, AbortSignal.timeout(5000));
  expect(agent.headers.length).toBe(9);
  // Prepared again (invalidated): installed, the markers hold.
  cs.invalidate(m.id);
  expect(cs.ready(m)).toBe(false);
  agent.headers.length = 0;
  await cs.ensure(m, AbortSignal.timeout(5000));
  expect(actions(agent)).toEqual(['status', 'marker', 'marker', 'start']);
});

test('callers share a preparation', async () => {
  const { m, agent, cs } = await setup();
  await Promise.all([
    cs.ensure(m, AbortSignal.timeout(5000)),
    cs.ensure(m, AbortSignal.timeout(5000)),
    cs.ensure(m, AbortSignal.timeout(5000)),
  ]);
  expect(actions(agent).filter((a) => a === 'start')).toEqual(['start']);
});

test('existing: the machine own code-server, else a release', async () => {
  const own = await setup({ install: { mode: Install.Existing, bin: '/opt/cs/bin/code-server' } });
  own.agent.existing = true;
  await own.cs.ensure(own.m, AbortSignal.timeout(5000));
  expect(actions(own.agent)).toEqual(['status:/opt/cs/bin/code-server', 'start:/opt/cs/bin/code-server']);

  const none = await setup({ install: { mode: Install.Existing, bin: 'auto' } });
  await none.cs.ensure(none.m, AbortSignal.timeout(5000));
  expect(actions(none.agent)).toEqual(['status:auto', 'status', 'install', 'start']);
  expect(none.logs.some((l) => l.includes('installing a release instead'))).toBe(true);
});

test('download: the machine fetches it, verified; the core uploads when it cannot', async () => {
  const { m, agent, cs } = await setup({ install: { mode: Install.Download, bin: '' }, offline: false });
  await cs.ensure(m, AbortSignal.timeout(5000));
  const dl = agent.headers.find((h) => h.action === 'download')!;
  expect(dl.url).toBe('https://github.com/coder/code-server/releases/download/v9.9.9/code-server-9.9.9-linux-amd64.tar.gz');
  expect(dl.digest).toBe(sha('release'));
  expect(agent.uploads.has('install')).toBe(false);

  // A digest the core does not know is recorded on first use.
  const other = await setup({ install: { mode: Install.Download, bin: '' }, offline: false });
  rmSync(join(other.artifacts.seedDirs[0], `${tarballFile('9.9.9', 'linux-amd64')}.sha256`));
  other.agent.downloadDigest = 'd'.repeat(64);
  await other.cs.ensure(other.m, AbortSignal.timeout(5000));
  expect(other.agent.headers.find((h) => h.action === 'download')!.digest).toBe('');
  expect(await other.artifacts.knownDigest(tarballFile('9.9.9', 'linux-amd64'))).toBe('d'.repeat(64));

  const failing = await setup({ install: { mode: Install.Download, bin: '' }, offline: false });
  failing.agent.downloadFails = true;
  await failing.cs.ensure(failing.m, AbortSignal.timeout(5000));
  expect(actions(failing.agent)).toEqual(['status', 'download', 'install', 'start']);
});

test('a failure is the status error', async () => {
  // Offline and not seeded.
  const empty = await setup();
  rmSync(empty.artifacts.seedDirs[0], { recursive: true });
  await expect(empty.cs.ensure(empty.m, AbortSignal.timeout(5000))).rejects.toThrow('artifact not available offline');
  const st = empty.cs.status(empty.m);
  expect([st.phase, st.ready, st.error?.startsWith('code-server linux-amd64: artifact not available offline: put')]).toEqual([
    Phase.Error,
    false,
    true,
  ]);
});

// Ready on the agent session it was prepared on only: after a reconnect,
// code-server is checked again.
test('readiness follows the agent session', async () => {
  const { m, cs, dial } = await setup();
  await cs.ensure(m, AbortSignal.timeout(5000));
  expect(cs.ready(m)).toBe(true);
  dial.agents[0].kill();
  await waitFor('reconnected', () => dial.agents.length === 2 && m.ready);
  expect(cs.ready(m)).toBe(false);
  expect(cs.status(m).ready).toBe(false);
});

test('stop and release', async () => {
  const { m, agent, cs } = await setup();
  await cs.ensure(m, AbortSignal.timeout(5000));
  await cs.stop(m, AbortSignal.timeout(5000));
  expect(cs.status(m)).toEqual({ phase: Phase.Idle, ready: false });
  await cs.ensure(m, AbortSignal.timeout(5000));
  await cs.release(m, AbortSignal.timeout(5000));
  expect(actions(agent).slice(-1)).toEqual(['release']);
  expect(cs.running()).toEqual([]);
});

// A removed machine's state is dropped, and a preparation still running for
// it changes nothing.
test('forget', async () => {
  const { m, cs } = await setup();
  const ensuring = cs.ensure(m, AbortSignal.timeout(5000));
  cs.forget(m.id);
  await ensuring;
  expect(cs.running()).toEqual([]);
});

// The feature's settings: how machines get code-server (push by default)
// and an existing one's path, also per machine.
test('settings as registered', () => {
  const s = new Settings('', { modules: [settings] });
  expect([s.string(INSTALL), s.string(PATH)]).toEqual(['push', '']);
  s.set(PATH, '', '~/bin/code-server');
  s.set(PATH, 'm1', '/opt/cs/bin/code-server');
  expect([s.string(PATH, 'm1'), s.string(PATH, 'm2')]).toEqual(['/opt/cs/bin/code-server', '~/bin/code-server']);
  expect(() => s.set(PATH, '', 'bin/code-server')).toThrow();
  expect(() => s.set(INSTALL, '', 'other')).toThrow();
});
