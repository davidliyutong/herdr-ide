// The Agent SDK on a machine, with tarballs made by the test and a registry
// on loopback (never the real SDK, never the network): a tarball is checked
// against the pinned integrity before anything is unpacked, only the files
// pinned are unpacked, a link leaving the directory refuses the archive,
// the entry's own digest is checked again before each load, the chat host
// loads it from there, and versions unused for 14 days go.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatProtoError, Code } from '#shared/proto/chatproto/index.ts';
import { SDK_DIR, sdkDir } from '../claudesdk.ts';
import { tempDir } from './claude/testing.ts';
import { installedSdk } from './claude/load.ts';
import { SDK_RETENTION_MS, SDK_STAGING_MS, SdkStore } from './sdkstore.ts';
import { FAKE_ENTRY, fakeRegistry, fakeSdk } from './sdktesting.ts';

const stops: Array<() => void> = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent' };
const sig = () => AbortSignal.timeout(20_000);
async function* chunks(b: Buffer, size = 4096): AsyncGenerator<Buffer> {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}
const failure = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'no error';
};

describe('the store', () => {
  test('an upload checked against the pinned integrity is installed: only the files pinned, the entry the pinned one', async () => {
    const dir = tempDir('sdk-');
    const f = await fakeSdk(dir);
    const store = new SdkStore({ base: join(dir, 'base'), logger: () => {}, pin: f.pin });
    expect(await store.installed()).toBe(false);
    await store.receive(chunks(f.bytes));
    expect(await store.installed()).toBe(true);
    expect(readdirSync(store.dir).sort()).toEqual(['LICENSE.md', 'README.md', 'package.json', 'sdk.mjs']);
    expect(store.dir).toBe(join(dir, 'base', SDK_DIR, '9.9.9'));
    // Nothing staged is left beside it.
    expect(readdirSync(join(dir, 'base', SDK_DIR))).toEqual(['9.9.9']);
  });

  test('a tarball that is not the pinned one is refused before anything is unpacked', async () => {
    const dir = tempDir('sdk-');
    const f = await fakeSdk(dir);
    const store = new SdkStore({ base: join(dir, 'base'), logger: () => {}, pin: f.pin });
    const tampered = Buffer.from(f.bytes);
    tampered[tampered.length - 20] ^= 0xff;
    expect(await failure(store.receive(chunks(tampered)))).toContain('is not the pinned');
    expect(existsSync(store.dir)).toBe(false);
    expect(readdirSync(join(dir, 'base', SDK_DIR))).toEqual([]);
    // The pinned integrity, another entry: refused once unpacked, nothing
    // put in place.
    const other = await fakeSdk(dir, { version: '9.9.8', entry: 'export const query = 1;\n' });
    const s2 = new SdkStore({ base: join(dir, 'base2'), logger: () => {}, pin: { ...other.pin, entrySha256: f.pin.entrySha256 } });
    expect(await failure(s2.receive(chunks(other.bytes)))).toContain('its sdk.mjs is not the pinned one');
    expect(existsSync(s2.dir)).toBe(false);
  });

  test('a link leaving the directory refuses the archive', async () => {
    const dir = tempDir('sdk-');
    const f = await fakeSdk(dir, { link: '../../../etc/passwd' });
    const store = new SdkStore({ base: join(dir, 'base'), logger: () => {}, pin: f.pin });
    expect(await failure(store.receive(chunks(f.bytes)))).toContain('a link leaving the release');
    expect(existsSync(store.dir)).toBe(false);
  });

  test("the machine's own download from a registry, bounded; a failed one installs nothing", async () => {
    const dir = tempDir('sdk-');
    const f = await fakeSdk(dir);
    const reg = fakeRegistry({ files: new Map([[f.pin.file, f.bytes]]) });
    stops.push(reg.stop);
    const store = new SdkStore({ base: join(dir, 'base'), logger: () => {}, pin: f.pin });
    expect(await failure(store.fetch(`${reg.url}/@fake/sdk/-/missing.tgz`, { env, signal: sig() }))).toContain('download');
    expect(existsSync(store.dir)).toBe(false);
    await store.fetch(`${reg.url}/@fake/sdk/-/${f.pin.file}`, { env, signal: sig() });
    expect(await store.installed()).toBe(true);
    // Installed: not fetched again.
    const n = reg.hits.length;
    await store.fetch(`${reg.url}/@fake/sdk/-/${f.pin.file}`, { env, signal: sig() });
    expect(reg.hits.length).toBe(n);
    expect(
      await failure(
        new SdkStore({ base: join(dir, 'b3'), logger: () => {}, pin: f.pin }).fetch('file:///etc/passwd', { env, signal: sig() }),
      ),
    ).toContain('bad download URL');
  });

  test('a version unused for 14 days goes, what an interrupted install left after a day; a use keeps it', async () => {
    const dir = tempDir('sdk-');
    const f = await fakeSdk(dir);
    const base = join(dir, 'base');
    const store = new SdkStore({ base, logger: () => {}, pin: f.pin });
    await store.receive(chunks(f.bytes));
    const root = join(base, SDK_DIR);
    mkdirSync(join(root, '0.0.1'));
    mkdirSync(join(root, '.install-1-abc'));
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);
    utimesSync(join(root, '0.0.1'), ago(SDK_RETENTION_MS + 1000), ago(SDK_RETENTION_MS + 1000));
    utimesSync(join(root, '.install-1-abc'), ago(SDK_STAGING_MS + 1000), ago(SDK_STAGING_MS + 1000));
    utimesSync(store.dir, ago(SDK_RETENTION_MS - 60_000), ago(SDK_RETENTION_MS - 60_000));
    await store.prune(new Date(now));
    expect(readdirSync(root)).toEqual(['9.9.9']);
    // Unused past the retention: it goes too.
    utimesSync(store.dir, ago(SDK_RETENTION_MS + 1000), ago(SDK_RETENTION_MS + 1000));
    await store.prune(new Date(now));
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('the load', () => {
  test('the chat host loads the installed version, its entry checked again; it counts as a use', async () => {
    const dir = tempDir('sdk-');
    const f = await fakeSdk(dir);
    const base = join(dir, 'base');
    const missing = await installedSdk(base, f.pin)
      .load()
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(ChatProtoError);
    expect((missing as ChatProtoError).code).toBe(Code.SdkUnavailable);
    expect((missing as ChatProtoError).message).toContain('@fake/sdk 9.9.9 is not on this machine');
    await new SdkStore({ base, logger: () => {}, pin: f.pin }).receive(chunks(f.bytes));
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(sdkDir(base, f.pin), old, old);
    const m = (await installedSdk(base, f.pin).load()) as unknown as { query: () => string; marker: string };
    expect(m.query()).toBe('the fake SDK');
    expect(m.marker).toBe('fake-sdk');
    // The load counts as a use: retention counts from it.
    expect(Date.now() - statSync(sdkDir(base, f.pin)).mtimeMs).toBeLessThan(60_000);
    // An entry changed on disk is not loaded.
    writeFileSync(join(sdkDir(base, f.pin), 'sdk.mjs'), FAKE_ENTRY + '// changed\n');
    const changed = await installedSdk(base, f.pin)
      .load()
      .catch((e: unknown) => e);
    expect((changed as ChatProtoError).code).toBe(Code.SdkUnavailable);
  });
});
