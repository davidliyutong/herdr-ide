// The Agent SDK's way to a machine, the core and the machine side through
// the wire (the kernel's own call and open), with tarballs made by the test
// and a registry on loopback (never the real SDK, never the network): the
// machine's own download, else the core's upload from an operator's
// directory, its cache or its own download; every copy checked against the
// pinned integrity; sdk_unavailable saying what each source said; a machine
// build without the action (the Go build's) left alone.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineProtocol } from '#shared/proto/protocol.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { defineMachine } from '#machine/feature.ts';
import { machineOf, rig, type Rig } from '#machine/testing.ts';
import type { Session } from '#kernel/machines/transport/session.ts';
import { sdkDir, type NpmTarball } from './claudesdk.ts';
import { chatMachine } from './machine.ts';
import { tempDir } from './machine/claude/testing.ts';
import { fakeSdk, fakeRegistry, type FakeSdk } from './machine/sdktesting.ts';
import { SDK_AUDIT_EVENT, SDK_FAILURE_MS, SDK_RECHECK_MS, SdkProvision, readRegular } from './sdkprovision.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sig = () => AbortSignal.timeout(30_000);

/** A machine of the TypeScript build serving the chat feature, pinned to f. */
async function tsMachine(pin: NpmTarball): Promise<{ r: Rig; m: Machine; base: string }> {
  const r = await rig({ features: [chatMachine({ sdkPin: pin })] });
  cleanups.push(() => r.close());
  return { r, m: machine(r.session, 'ts'), base: r.dirs.base };
}

/** The kernel's machine of session s, as SdkProvision sees one. */
const machine = (s: Session, id: string): Machine =>
  Object.assign(machineOf(s), { id, label: `machine ${id}`, connected: true, live: () => s }) as unknown as Machine;

/** A core pinned to a tarball made here, a registry that serves it (or
 * nothing, or other bytes under its name), an operator's directory with
 * seed in it. */
async function setup(
  o: {
    refuse?: (ua: string) => boolean;
    hang?: (ua: string) => boolean;
    offline?: boolean;
    seed?: Buffer;
    serve?: 'pinned' | 'nothing' | Buffer;
    now?: () => number;
    loadMs?: number;
  } = {},
) {
  const dir = tempDir('sdkp-');
  const f = await fakeSdk(dir);
  const served = o.serve === 'nothing' ? null : o.serve === undefined || o.serve === 'pinned' ? f.bytes : o.serve;
  const files = new Map(served ? [[f.pin.file, served]] : []);
  const reg = fakeRegistry({ files, refuse: o.refuse, hang: o.hang });
  cleanups.push(reg.stop);
  const seedDir = join(dir, 'seed');
  mkdirSync(seedDir);
  if (o.seed) writeFileSync(join(seedDir, f.pin.file), o.seed);
  const logs: string[] = [];
  const p = new SdkProvision({
    pin: f.pin,
    registry: reg.url,
    seedDirs: [seedDir],
    cacheDir: join(dir, 'cache'),
    offline: o.offline ?? false,
    logger: (l) => logs.push(l),
    now: o.now,
    loadMs: o.loadMs,
  });
  // The audit records the asks write.
  const audits: Array<Record<string, unknown>> = [];
  const audit = (event: string, fields: Record<string, unknown>) => void audits.push({ event, ...fields });
  return { dir, f, reg, files, p, logs, seedDir, audits, audit };
}

const isCurl = (ua: string) => /^(curl|wget)\//i.test(ua);

const installed = (base: string, f: FakeSdk) => existsSync(join(sdkDir(base, f.pin), 'sdk.mjs'));

const failure = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await p;
  } catch (e) {
    return { code: (e as { code?: string }).code ?? '', message: (e as Error).message };
  }
  return { code: 'no error', message: '' };
};

describe('the Agent SDK on a machine', () => {
  test('the machine downloads it itself; the core fetches nothing, and asks no more on that session for an hour', async () => {
    let now = Date.now();
    const { f, reg, p, audits, audit } = await setup({ now: () => now });
    const { m, base } = await tsMachine(f.pin);
    await p.ensure(m, sig(), { audit });
    expect(installed(base, f)).toBe(true);
    expect(reg.hits.length).toBe(1);
    expect(isCurl(reg.hits[0]!)).toBe(true);
    expect(audits).toEqual([{ event: SDK_AUDIT_EVENT, plugin: 'chat', machine: 'ts', source: 'machine', ok: true }]);
    rmSync(sdkDir(base, f.pin), { recursive: true });
    await p.ensure(m, sig(), { audit });
    expect(reg.hits.length).toBe(1);
    // An hour later the machine is asked again, and installs what went.
    now += SDK_RECHECK_MS;
    await p.ensure(m, sig(), { audit });
    expect(installed(base, f)).toBe(true);
    expect(reg.hits.length).toBe(2);
    // A machine that has it already installs nothing: no record.
    now += SDK_RECHECK_MS;
    await p.ensure(m, sig(), { audit });
    expect(reg.hits.length).toBe(2);
    expect(audits.map((a) => `${a.source} ${a.ok}`)).toEqual(['machine true', 'machine true']);
  });

  test('a machine that cannot download it gets it from the core, which downloads it once and keeps it', async () => {
    const { f, reg, p, dir, audits, audit } = await setup({ refuse: isCurl });
    const one = await tsMachine(f.pin);
    await p.ensure(one.m, sig(), { audit });
    expect(installed(one.base, f)).toBe(true);
    expect(reg.hits.filter((ua) => !isCurl(ua))).toHaveLength(1);
    expect(existsSync(join(dir, 'cache', f.pin.file))).toBe(true);
    // Another machine: from the core's cache.
    const two = await tsMachine(f.pin);
    await p.ensure(two.m, sig(), { audit });
    expect(installed(two.base, f)).toBe(true);
    expect(reg.hits.filter((ua) => !isCurl(ua))).toHaveLength(1);
    expect(audits.map((a) => `${a.source} ${a.ok}`)).toEqual(['download true', 'download true']);
    // A core started again: from its cache.
    const again = new SdkProvision({ pin: f.pin, registry: reg.url, cacheDir: join(dir, 'cache'), logger: () => {} });
    const three = await tsMachine(f.pin);
    await again.ensure(three.m, sig(), { audit });
    expect(installed(three.base, f)).toBe(true);
    expect(audits.at(-1)).toMatchObject({ source: 'cache', ok: true });
  });

  test("offline, the machines are not asked to download it: the core uploads an operator's directory's copy", async () => {
    const dir0 = tempDir('sdkp-');
    const seed = (await fakeSdk(dir0)).bytes;
    const { f, reg, p, audits, audit } = await setup({ offline: true, seed, serve: 'nothing' });
    const { m, base } = await tsMachine(f.pin);
    await p.ensure(m, sig(), { audit });
    expect(installed(base, f)).toBe(true);
    expect(reg.hits).toEqual([]);
    expect(audits).toEqual([{ event: SDK_AUDIT_EVENT, plugin: 'chat', machine: 'ts', source: 'seed', ok: true }]);
  });

  test('a copy that is not the pinned one is refused wherever it comes from: sdk_unavailable, saying what each source said', async () => {
    const other = await fakeSdk(tempDir('sdkp-'), { entry: 'export const query = 2;\n' });
    const { f, p, logs, audits, audit } = await setup({ seed: other.bytes, serve: 'nothing' });
    const { m, base } = await tsMachine(f.pin);
    const e = await failure(p.ensure(m, sig(), { audit }));
    expect(e.code).toBe('sdk_unavailable');
    expect(audits).toEqual([
      expect.objectContaining({
        event: SDK_AUDIT_EVENT,
        machine: 'ts',
        source: 'download',
        ok: false,
        error: expect.stringContaining('could not be installed'),
      }),
    ]);
    expect(e.message).toContain('the machine could not download it');
    expect(e.message).toContain(`the seed directory's ${f.pin.file} was refused`);
    expect(e.message).toContain('the core could not download');
    expect(e.message).toContain(`put ${f.pin.file} into a --seed-dir`);
    expect(installed(base, f)).toBe(false);
    expect(logs.join('\n')).toContain('could not be installed on machine ts');
  });

  test('other bytes under the pinned name in the registry are refused by the machine and by the core, and not cached', async () => {
    const other = await fakeSdk(tempDir('sdkp-'), { entry: 'export const query = 3;\n' });
    const { f, p, dir } = await setup({ serve: other.bytes });
    const { m, base } = await tsMachine(f.pin);
    const e = await failure(p.ensure(m, sig()));
    expect(e.code).toBe('sdk_unavailable');
    expect(e.message).toContain('is not the pinned');
    expect(installed(base, f)).toBe(false);
    expect(existsSync(join(dir, 'cache', f.pin.file))).toBe(false);
  });

  test("a machine build without the action (the Go build's chat host needs none) is left alone", async () => {
    const { reg, p } = await setup();
    const goProtocol = defineProtocol('chat', { open: { params: z.object({}), result: z.unknown(), stream: true } });
    const r = await rig({ features: [defineMachine(goProtocol, () => ({ actions: { open: async () => {} } }))] });
    cleanups.push(() => r.close());
    await p.ensure(machine(r.session, 'go'), sig());
    expect(reg.hits).toEqual([]);
    expect(existsSync(join(r.dirs.base, 'claude-agent-sdk'))).toBe(false);
  });

  test('a registry with credentials is refused: the machines would get them on their command lines', () => {
    for (const registry of ['https://u:p@mirror.example/npm', 'https://mirror.example/npm?token=x', 'https://mirror.example/npm#y'])
      expect(() => new SdkProvision({ registry, cacheDir: '/nonexistent', logger: () => {} })).toThrow(/user information|query|fragment/);
  });

  // A FIFO (or another file that is not a regular one) under the pinned
  // name in an operator's directory is refused at once, never waited on:
  // the next source is used.
  test.skipIf(process.platform === 'win32')("a FIFO in an operator's directory is refused at once; the next source is used", async () => {
    const { f, reg, p, seedDir, logs, audits, audit } = await setup({ refuse: isCurl });
    const fifo = join(seedDir, f.pin.file);
    expect(spawnSync('/usr/bin/mkfifo', [fifo]).status).toBe(0);
    const started = Date.now();
    expect(await failure(readRegular(fifo, 1 << 20))).toEqual({ code: '', message: 'not a regular file' });
    const { m, base } = await tsMachine(f.pin);
    await p.ensure(m, AbortSignal.timeout(10_000), { audit });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(installed(base, f)).toBe(true);
    expect(reg.hits.filter((ua) => !isCurl(ua))).toHaveLength(1);
    expect(logs.join('\n')).toContain('not a regular file');
    expect(audits.at(-1)).toMatchObject({ source: 'download', ok: true });
    // A directory under the name is no copy either.
    rmSync(fifo);
    mkdirSync(fifo);
    expect(await failure(readRegular(fifo, 1 << 20))).toEqual({ code: '', message: 'not a regular file' });
    expect(await readRegular(join(seedDir, 'absent.tgz'), 1 << 20)).toBeNull();
  });

  // The core's load of its tarball, which every machine that needs it
  // shares, is bounded: one that does not settle (a download that hangs)
  // is dropped, and the next ask loads it anew.
  test("the core's load that does not settle is dropped; the next ask loads it anew", async () => {
    let hang = true;
    const { f, reg, p } = await setup({ refuse: isCurl, hang: () => hang, loadMs: 500 });
    const { m, base } = await tsMachine(f.pin);
    const e = await failure(p.ensure(m, sig()));
    expect(e.code).toBe('sdk_unavailable');
    expect(e.message).toContain("the core's own copy was not ready within");
    expect(installed(base, f)).toBe(false);
    hang = false;
    await p.ensure(m, sig(), { retry: true });
    expect(installed(base, f)).toBe(true);
    expect(reg.hits.filter((ua) => !isCurl(ua)).length).toBe(2);
  });

  // A file in the core's cache that is not the pinned one is refused and
  // removed: online the core downloads it again, offline the machine gets
  // none.
  test("a tampered copy in the core's cache is refused and removed; the next source is used", async () => {
    const other = await fakeSdk(tempDir('sdkp-'), { entry: 'export const query = 4;\n' });
    const { f, reg, p, dir, logs, audits, audit } = await setup({ refuse: isCurl });
    const cached = join(dir, 'cache', f.pin.file);
    mkdirSync(join(dir, 'cache'));
    writeFileSync(cached, other.bytes);
    const { m, base } = await tsMachine(f.pin);
    await p.ensure(m, sig(), { audit });
    expect(installed(base, f)).toBe(true);
    expect(logs.join('\n')).toContain(`${cached} refused`);
    expect(reg.hits.filter((ua) => !isCurl(ua))).toHaveLength(1);
    expect(readFileSync(cached).equals(f.bytes)).toBe(true);
    expect(audits.at(-1)).toMatchObject({ source: 'download', ok: true });

    const off = new SdkProvision({ pin: f.pin, registry: reg.url, cacheDir: join(dir, 'cache'), offline: true, logger: () => {} });
    writeFileSync(cached, other.bytes);
    const two = await tsMachine(f.pin);
    const e = await failure(off.ensure(two.m, sig(), { audit }));
    expect(e.code).toBe('sdk_unavailable');
    expect(existsSync(cached)).toBe(false);
    expect(installed(two.base, f)).toBe(false);
    expect(audits.at(-1)).toMatchObject({ source: 'cache', ok: false });
  });

  // A failure holds on the agent session for SDK_FAILURE_MS for the asks
  // without retry (a page's subscription): they fail without asking the
  // machine or any source; one with retry (a new chat) asks; past the window
  // every one does. A caller that left is no failure.
  test('a failure holds for a while on the same agent session, but for a retry', async () => {
    let now = Date.now();
    const { f, reg, p } = await setup({ serve: 'nothing', now: () => now });
    const { m } = await tsMachine(f.pin);
    // The caller leaving: nothing is remembered.
    const ac = new AbortController();
    ac.abort();
    await failure(p.ensure(m, ac.signal));
    const hits = reg.hits.length;
    // The machine's download and the core's: both refused.
    expect((await failure(p.ensure(m, sig()))).code).toBe('sdk_unavailable');
    expect(reg.hits.length).toBe(hits + 2);
    const again = await failure(p.ensure(m, sig()));
    expect(again.code).toBe('sdk_unavailable');
    expect(reg.hits.length).toBe(hits + 2);
    expect((await failure(p.ensure(m, sig(), { retry: true }))).code).toBe('sdk_unavailable');
    expect(reg.hits.length).toBe(hits + 4);
    now += SDK_FAILURE_MS;
    expect((await failure(p.ensure(m, sig()))).code).toBe('sdk_unavailable');
    expect(reg.hits.length).toBe(hits + 6);
  });
});
