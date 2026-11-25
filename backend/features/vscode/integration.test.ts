// VS Code's machine side with a real code-server release (skipped without
// one, make it): E2E_CODE_SERVER_SEED names a directory with
// code-server-<version>-<os>-<arch>.tar.gz of this machine's platform, as
// the end-to-end tests take it. The release is uploaded through op
// code-server with the digest the hub knows, unpacked without holding the
// node's thread, started on its socket (0600) with nothing of its process
// group listening on TCP, serves VS Code's workbench, and ends with stop.
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { ChunkWriter, Op, readLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { pgidOf } from '#machine/sys/proc.ts';
import { rig, type Rig } from '#machine/testing.ts';
import { PINNED, platformAsset } from './artifacts.ts';
import { vscodeMachine } from './machine.ts';
import { layoutOf } from './machine/layout.ts';
import { alive } from './machine/process.ts';
import { probe } from './machine/server.ts';

setDefaultTimeout(300_000);

const SEED = process.env.E2E_CODE_SERVER_SEED ?? '';
const asset = platformAsset(process.platform, process.arch === 'x64' ? 'amd64' : process.arch);
const file =
  SEED && existsSync(SEED)
    ? readdirSync(SEED).find((n) => /^code-server-.+\.tar\.gz$/.test(n) && n.endsWith(`-${asset}.tar.gz`))
    : undefined;
const version = file?.slice('code-server-'.length, -`-${asset}.tar.gz`.length) ?? '';

let r: Rig | undefined;
afterAll(async () => {
  await r?.close();
});

test.skipIf(!file)('a real code-server release, uploaded, started on its socket only and stopped', async () => {
  const path = posix.join(SEED, file!);
  const hash = createHash('sha256');
  for await (const b of createReadStream(path)) hash.update(b as Buffer);
  const digest = hash.digest('hex');
  if (PINNED[file!]) expect(digest).toBe(PINNED[file!]);
  r = await rig({ features: [vscodeMachine()] });
  const l = layoutOf({ home: r.home, run: r.dirs.run, host: r.dirs.host });
  const h = { op: Op.CodeServer, version } as Header;

  // The upload, while the thread is watched.
  let gap = 0;
  let last = performance.now();
  const watch = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 5);
  const { conn } = await r.session.open({ ...h, action: 'install', digest }, { timeoutMs: 30_000 });
  const cw = new ChunkWriter(conn.stream);
  for await (const b of createReadStream(path, { highWaterMark: 256 << 10 })) await cw.write(b as Buffer);
  await cw.finish();
  const installed = await readLine<Reply>(conn.reader);
  conn.reader.release();
  closeStream(conn.stream);
  clearInterval(watch);
  expect(installed.error).toBeUndefined();
  expect(installed.cs?.installed).toBe(true);
  expect(gap).toBeLessThan(250);

  const started = await r.session.request({ ...h, action: 'start' }, { timeoutMs: 120_000 });
  expect(started.cs?.running).toBe(true);
  expect(statSync(l.socket).mode & 0o777).toBe(0o600);
  const status = await probe(l.socket, 30_000);
  expect(status).not.toBeNull();
  expect(status!).toBeLessThan(400);
  const pid = (JSON.parse(await Bun.file(l.pidFile).text()) as { pid: number }).pid;
  const pgid = pgidOf(pid)!;
  expect(pgid).toBe(pid);
  // Nothing of its process group listens on TCP (lsof exits 1 when it
  // finds nothing).
  const lsof = spawnSync('lsof', ['-nP', '-a', '-g', String(pgid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  if (!lsof.error) expect(lsof.stdout.trim()).toBe('');

  const stopped = await r.session.request({ ...h, action: 'stop' }, { timeoutMs: 30_000 });
  expect(stopped.cs?.running).toBe(false);
  expect(alive(pid)).toBe(false);
});
