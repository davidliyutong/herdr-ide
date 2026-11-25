// The Agent SDK as a machine gets it, not as the tests import it: a tarball
// of the development dependency's files (the registry's own tarball is not
// in the repository: it is Anthropic's), installed by the machine's store
// and loaded from the data directory, runs a recording; and a
// `bun build --compile` executable loads it the same way, resolving
// nothing but Node's own modules.
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { create } from 'tar';
import { CLAUDE_SDK, type NpmTarball } from '../../claudesdk.ts';
import { SdkStore } from '../sdkstore.ts';
import { installedSdk } from './load.ts';
import { golden, goldenOf, isolateHome, replay, tempDir } from './testing.ts';

isolateHome();

const PKG = join(import.meta.dir, '..', '..', '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The development dependency's files the product unpacks, as a tarball
 * (package/...) installed into a data directory; the pin that trusts it,
 * its entry the product's pinned one. */
async function installed(): Promise<{ base: string; pin: NpmTarball }> {
  const dir = tempDir('sdkr-');
  dirs.push(dir);
  mkdirSync(join(dir, 'src', 'package'), { recursive: true });
  for (const f of CLAUDE_SDK.files) cpSync(join(PKG, f), join(dir, 'src', 'package', f));
  const file = join(dir, CLAUDE_SDK.file);
  await create({ gzip: true, cwd: join(dir, 'src'), file, portable: true }, ['package']);
  const bytes = readFileSync(file);
  const pin: NpmTarball = { ...CLAUDE_SDK, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
  const base = join(dir, 'base');
  async function* one() {
    yield bytes;
  }
  await new SdkStore({ base, logger: () => {}, pin }).receive(one());
  return { base, pin };
}

test("the pin's entry is the development dependency's", () => {
  expect(
    createHash('sha256')
      .update(readFileSync(join(PKG, CLAUDE_SDK.entry)))
      .digest('hex'),
  ).toBe(CLAUDE_SDK.entrySha256);
  expect((JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { version: string }).version).toBe(CLAUDE_SDK.version);
});

test('the SDK installed in a data directory runs a recording as the development dependency does', async () => {
  const { base, pin } = await installed();
  const name = 'claude-03-permissions.jsonl';
  const { r } = await replay(name, undefined, { sdk: installedSdk(base, pin) });
  try {
    expect(r.mismatches()).toEqual([]);
    const got = goldenOf(r);
    const want = golden(name);
    expect(got.events).toEqual(want.events);
    expect(got.permissions).toEqual(want.permissions);
  } finally {
    r.close();
  }
}, 60_000);

test('a compiled executable loads it from the data directory', async () => {
  const { base, pin } = await installed();
  const out = join(tempDir('sdkc-'), 'compiled');
  dirs.push(join(out, '..'));
  const build = Bun.spawnSync(
    [process.execPath, 'build', '--compile', join(import.meta.dir, 'testdata', 'compiled.ts'), '--outfile', out],
    // In the temporary directory: Bun leaves a .<hash>.bun-build copy of
    // the executable in its working directory.
    { cwd: join(out, '..'), stdout: 'pipe', stderr: 'pipe' },
  );
  expect(build.exitCode).toBe(0);
  // The executable carries none of the SDK.
  expect(readFileSync(out).includes('CLAUDE_SDK_CAN_USE_TOOL' + '_SHADOWED')).toBe(false);
  const run = Bun.spawnSync([out, base, JSON.stringify(pin)], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  expect(run.stderr.toString()).toBe('');
  const line = JSON.parse(run.stdout.toString().trim()) as { type: string; request: { subtype: string } };
  expect(line.type).toBe('control_request');
  expect(line.request.subtype).toBe('initialize');
}, 60_000);
