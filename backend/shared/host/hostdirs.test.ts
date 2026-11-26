import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as brand from '#shared/lib/brand.ts';
import { HOSTS_DIR, UNIX_PATH_BYTES, dirsFor, dirsOf, makeDirs, makeRun, runDir, setUserRuntimeRoot } from './hostdirs.ts';
import * as hostid from './hostid.ts';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'hostdirs-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let restore: string | undefined;
function withRuntimeRoot(root: string) {
  const was = setUserRuntimeRoot(root);
  restore ??= was;
}
afterEach(() => {
  if (restore !== undefined) setUserRuntimeRoot(restore);
  restore = undefined;
});

describe.skipIf(process.platform === 'win32')('unix', () => {
  // The runtime directory is in /run/user/<uid> when that is the user's and
  // private, named after the data directory and a hash of its path, so two
  // homes (tests) never share one; else in the data directory, named after
  // the host's id.
  test('TestRunDir', () => {
    const root = temp();
    withRuntimeRoot(root);
    const base = join(temp(), '.app-dev');
    expect(runDir(base)).toBe(join(base, 'run-' + hostid.id()));
    const user = join(root, String(process.getuid!()));
    mkdirSync(user, { mode: 0o755 });
    chmodSync(user, 0o755);
    expect(runDir(base).startsWith(base)).toBe(true); // others can read it: not taken
    chmodSync(user, 0o700);
    const a = runDir(base);
    expect(dirname(a)).toBe(user);
    expect(basename(a).startsWith('app-dev-')).toBe(true);
    expect(basename(a)).toHaveLength('app-dev-'.length + 8);
    expect(runDir(join(temp(), '.app-dev'))).not.toBe(a); // two homes never share one
    expect(runDir(base)).toBe(a); // stable
    // A link to the home gives the same directory.
    const link = join(temp(), 'home');
    symlinkSync(dirname(base), link);
    expect(runDir(join(link, '.app-dev'))).toBe(a);
  });

  // makeDirs creates the directories private, fixes looser modes and
  // refuses a link in the runtime directory's place.
  test('TestMake', () => {
    withRuntimeRoot(join(temp(), 'none'));
    const d = dirsOf(join(temp(), '.app'));
    mkdirSync(d.run, { recursive: true, mode: 0o755 });
    chmodSync(d.run, 0o755);
    makeDirs(d);
    for (const p of [d.base, d.host, d.run]) expect([p, statSync(p).mode & 0o777]).toEqual([p, 0o700]);
    expect(dirname(d.host)).toBe(join(d.base, HOSTS_DIR));
    expect(basename(d.host)).toBe(hostid.key());
    const target = temp();
    const run = join(temp(), 'run');
    symlinkSync(target, run);
    expect(() => makeRun(run)).toThrow();
  });

  test('long or multibyte socket paths use a private short directory', () => {
    withRuntimeRoot(join(temp(), 'none'));
    const home = temp();
    const name = `.app-${'é'.repeat(60)}`;
    const dir = runDir(join(home, name));
    expect(dirname(dir)).toBe('/tmp');
    expect(Buffer.byteLength(join(dir, 'bridge.sock'))).toBeLessThanOrEqual(UNIX_PATH_BYTES);
    expect(runDir(join(home, name + 'x'))).not.toBe(dir);
    const link = join(temp(), 'home');
    symlinkSync(home, link);
    expect(runDir(join(link, name))).toBe(dir);
    makeRun(dir);
    dirs.push(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

// The directories of an instance are in the home of $HOME.
test('dirsFor', () => {
  const home = temp();
  const was = process.env.HOME;
  const wasProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const d = dirsFor('dev');
    expect(d.home).toBe(home);
    expect(d.base).toBe(join(home, brand.dataDir('dev')));
    expect(() => dirsFor('Not/Valid')).toThrow('invalid instance name');
  } finally {
    setEnv('HOME', was);
    setEnv('USERPROFILE', wasProfile);
  }
});

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
