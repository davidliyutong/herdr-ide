// gpupick, installed and preloaded (Linux, with the library this
// repository carries for the architecture): a damaged copy is replaced,
// concurrent installs leave one usable library, and a program sees only the
// GPUs of its CUDA_VISIBLE_DEVICES: other device nodes do not open, indices
// count among the GPUs left, and programs it starts keep the set.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { slow } from '#shared/testdata/slow.ts';
import { Pick } from './pick.ts';

const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const LIB = join(REPO_ROOT, 'scripts', 'gpupick', 'bin', `gpupick-linux-${arch}.so`);
const supported = process.platform === 'linux' && existsSync(LIB);

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const TABLE = 'GPU-70987003-ef14=1,GPU-dd0ff3fe-3db4=0,GPU-46f915f8-3cfa=3,GPU-b1b5b6db-ca22=2';
// What a program sees: its CUDA_VISIBLE_DEVICES, the minors kept, the GLX
// vendor, and what opening /dev/nvidia0 says ("hidden" or else).
const SCRIPT = `r=$( (: < /dev/nvidia0) 2>&1 ); case "$r" in *"not permitted"*) r=hidden;; *) r=open;; esac
echo "$CUDA_VISIBLE_DEVICES|$GPUPICK_KEEP|$__GLX_VENDOR_LIBRARY_NAME|$r"`;

// It runs programs with the library preloaded.
(supported ? slow : test.skip)(
  'gpupick: installed, and a program sees the GPUs of its CUDA_VISIBLE_DEVICES',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'pick-'));
    dirs.push(home);
    const bytes = readFileSync(LIB);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const env = () => ({ PATH: process.env.PATH ?? '/usr/bin:/bin' });
    const fresh = () => new Pick(home, env, async () => ({ bytes, digest }));
    let p = fresh();
    expect(await p.path()).toBe('');
    await p.install();
    const lib = await p.path();
    expect(lib.startsWith(p.root())).toBe(true);
    expect(statSync(lib).mode & 0o777).toBe(0o600);
    // A damaged copy is not offered, and installing replaces it.
    writeFileSync(lib, 'damaged');
    p = fresh();
    expect(await p.path()).toBe('');
    await p.install();
    expect(await p.path()).toBe(lib);
    // Concurrent installs leave the library usable.
    rmSync(posix.dirname(lib), { recursive: true, force: true });
    const others = [fresh(), fresh(), fresh(), fresh()];
    await Promise.all(others.map((o) => o.install()));
    expect(await fresh().path()).toBe(lib);

    const sees = (vars: Record<string, string>, table = true) =>
      spawnSync('/bin/sh', ['-c', SCRIPT], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LD_PRELOAD: lib, ...(table ? { GPUPICK_TABLE: TABLE } : {}), ...vars },
        encoding: 'utf8',
      }).stdout.trim();
    const cases: Array<[Record<string, string>, string]> = [
      [{}, '|||open'],
      [{ CUDA_VISIBLE_DEVICES: '2' }, '0|3||hidden'],
      [{ CUDA_VISIBLE_DEVICES: '1' }, '0|0||open'],
      [{ CUDA_VISIBLE_DEVICES: '3,0' }, '1,0|2,1||hidden'],
      [{ CUDA_VISIBLE_DEVICES: ' 2 , 1' }, '1,0|3,0||open'],
      [{ CUDA_VISIBLE_DEVICES: 'GPU-46f915f8' }, 'GPU-46f915f8|3||hidden'],
      [{ CUDA_VISIBLE_DEVICES: 'GPU-46f915f8,0' }, 'GPU-46f915f8,0|3,1||hidden'],
      // The display's GPU out of sight: OpenGL through Mesa, unless said.
      [{ CUDA_VISIBLE_DEVICES: '0', GPUPICK_DISPLAY: '0' }, '0|1|mesa|hidden'],
      [{ CUDA_VISIBLE_DEVICES: '0', GPUPICK_DISPLAY: '0', __GLX_VENDOR_LIBRARY_NAME: 'nvidia' }, '0|1|nvidia|hidden'],
      [{ CUDA_VISIBLE_DEVICES: '1', GPUPICK_DISPLAY: '0' }, '0|0||open'],
      // Nothing changes for a value that names no GPU, one twice, all of
      // them, none, or a UUID two GPUs could have.
      [{ CUDA_VISIBLE_DEVICES: '7' }, '7|||open'],
      [{ CUDA_VISIBLE_DEVICES: '1,1' }, '1,1|||open'],
      [{ CUDA_VISIBLE_DEVICES: '0,1,2,3' }, '0,1,2,3|||open'],
      [{ CUDA_VISIBLE_DEVICES: '' }, '|||open'],
      [{ CUDA_VISIBLE_DEVICES: '-1' }, '-1|||open'],
      [{ CUDA_VISIBLE_DEVICES: 'GPU-' }, 'GPU-|||open'],
      [{ CUDA_VISIBLE_DEVICES: 'MIG-46f915f8' }, 'MIG-46f915f8|||open'],
      // GPUs of several models: indices only in bus order.
      [{ CUDA_VISIBLE_DEVICES: '2', GPUPICK_MIXED: '1' }, '2|||open'],
      [{ CUDA_VISIBLE_DEVICES: '2', GPUPICK_MIXED: '1', CUDA_DEVICE_ORDER: 'PCI_BUS_ID' }, '0|3||hidden'],
      [{ CUDA_VISIBLE_DEVICES: 'GPU-46f915f8', GPUPICK_MIXED: '1' }, 'GPU-46f915f8|3||hidden'],
      // A set inherited is kept whatever CUDA_VISIBLE_DEVICES says then.
      [{ CUDA_VISIBLE_DEVICES: '1', GPUPICK_KEEP: '3,2' }, '1|3,2||hidden'],
    ];
    for (const [vars, want] of cases) expect([vars, sees(vars)]).toEqual([vars, want]);
    // Without the table (a machine with one GPU) nothing happens.
    expect(sees({ CUDA_VISIBLE_DEVICES: '2' }, false)).toBe('2|||open');
    // Files other than GPUs open, are created with their mode, and are found
    // relative to a directory.
    const dir = mkdtempSync(join(tmpdir(), 'pick-files-'));
    dirs.push(dir);
    const r = spawnSync('/bin/sh', ['-c', 'umask 022; cd "$1" && echo x > new && cat new && ls -l new | cut -c1-10', 'sh', dir], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LD_PRELOAD: lib, GPUPICK_TABLE: TABLE, CUDA_VISIBLE_DEVICES: '2' },
      encoding: 'utf8',
    });
    expect(r.stdout).toBe('x\n-rw-r--r--\n');
  },
  60_000,
);
