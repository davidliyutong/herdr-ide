// The local machine's node, the Go machine build, reached by the
// TypeScript core: the wire between them while both programs exist.
import { afterAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Op } from '#shared/proto/agentproto/index.ts';
import { CORE_BIN } from '#shared/lib/brand.ts';
import { discard } from '#shared/lib/log.ts';
import { LOCAL_SUPPORTED, dialNode } from './local.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';

const go = spawnSync('go', ['version']).status === 0;
const root = REPO_ROOT;
// A short home: the node's socket path stays within macOS's 104 bytes.
const home = realpathSync(mkdtempSync('/tmp/tsl-'));
const instance = 'ts-it';
let exe = '';

afterAll(() => {
  if (exe) spawnSync(exe, ['node', 'stop', '--instance', instance], { env: { ...process.env, HOME: home } });
  rmSync(home, { recursive: true, force: true });
});

test.skipIf(!go || !LOCAL_SUPPORTED)(
  'the core starts the local node of the machine build and talks to it',
  async () => {
    const build = join(home, 'build', CORE_BIN);
    const b = spawnSync('go', ['build', '-o', build, `./cmd/${CORE_BIN}`], { cwd: root, encoding: 'utf8' });
    if (b.status !== 0) throw new Error(b.stderr);
    const bin = readFileSync(build);
    const version = createHash('sha256').update(bin).digest('hex').slice(0, 16);
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const s = await dialNode({ instance, builds: async () => ({ kind: 'go' as const, bin, version }), logger: discard });
      exe = join(home, '.' + CORE_BIN, 'agent', version, CORE_BIN);
      const rep = await s.request({ op: Op.Hello });
      expect(rep.ok).toBe(true);
      expect(rep.info?.home).toBe(home);
      expect(rep.info?.os).toBe(process.platform);
      // A second session reaches the same node.
      const s2 = await dialNode({ instance, builds: async () => ({ kind: 'go' as const, bin, version }), logger: discard });
      expect((await s2.request({ op: Op.Hello })).info?.data_dir).toBe(rep.info?.data_dir);
      const stat = await s2.request({ op: Op.FsStat, path: home });
      expect(stat.stat?.is_dir).toBe(true);
      s.close();
      s2.close();
    } finally {
      process.env.HOME = oldHome;
    }
  },
  120_000,
);
