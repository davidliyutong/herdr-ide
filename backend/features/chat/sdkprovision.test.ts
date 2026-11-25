// The Agent SDK's way to a machine, the core and the machine side through
// the wire (the kernel's own call and open), with tarballs made by the test
// and a registry on loopback (never the real SDK, never the network): the
// machine's own download, else the core's upload from an operator's
// directory, its cache or its own download; every copy checked against the
// pinned integrity; sdk_unavailable saying what each source said; a machine
// build without the action (the Go build's) left alone.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { SdkProvision } from './sdkprovision.ts';

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
  o: { refuse?: (ua: string) => boolean; offline?: boolean; seed?: Buffer; serve?: 'pinned' | 'nothing' | Buffer } = {},
) {
  const dir = tempDir('sdkp-');
  const f = await fakeSdk(dir);
  const served = o.serve === 'nothing' ? null : o.serve === undefined || o.serve === 'pinned' ? f.bytes : o.serve;
  const reg = fakeRegistry({ files: new Map(served ? [[f.pin.file, served]] : []), refuse: o.refuse });
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
  });
  return { dir, f, reg, p, logs, seedDir };
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
  test('the machine downloads it itself; the core fetches nothing, and asks no more on that session', async () => {
    const { f, reg, p } = await setup();
    const { m, base } = await tsMachine(f.pin);
    await p.ensure(m, sig());
    expect(installed(base, f)).toBe(true);
    expect(reg.hits.length).toBe(1);
    expect(isCurl(reg.hits[0]!)).toBe(true);
    await p.ensure(m, sig());
    expect(reg.hits.length).toBe(1);
  });

  test('a machine that cannot download it gets it from the core, which downloads it once and keeps it', async () => {
    const { f, reg, p, dir } = await setup({ refuse: isCurl });
    const one = await tsMachine(f.pin);
    await p.ensure(one.m, sig());
    expect(installed(one.base, f)).toBe(true);
    expect(reg.hits.filter((ua) => !isCurl(ua))).toHaveLength(1);
    expect(existsSync(join(dir, 'cache', f.pin.file))).toBe(true);
    // Another machine: from the core's cache.
    const two = await tsMachine(f.pin);
    await p.ensure(two.m, sig());
    expect(installed(two.base, f)).toBe(true);
    expect(reg.hits.filter((ua) => !isCurl(ua))).toHaveLength(1);
  });

  test("offline, the machines are not asked to download it: the core uploads an operator's directory's copy", async () => {
    const dir0 = tempDir('sdkp-');
    const seed = (await fakeSdk(dir0)).bytes;
    const { f, reg, p } = await setup({ offline: true, seed, serve: 'nothing' });
    const { m, base } = await tsMachine(f.pin);
    await p.ensure(m, sig());
    expect(installed(base, f)).toBe(true);
    expect(reg.hits).toEqual([]);
  });

  test('a copy that is not the pinned one is refused wherever it comes from: sdk_unavailable, saying what each source said', async () => {
    const other = await fakeSdk(tempDir('sdkp-'), { entry: 'export const query = 2;\n' });
    const { f, p, logs } = await setup({ seed: other.bytes, serve: 'nothing' });
    const { m, base } = await tsMachine(f.pin);
    const e = await failure(p.ensure(m, sig()));
    expect(e.code).toBe('sdk_unavailable');
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
});
