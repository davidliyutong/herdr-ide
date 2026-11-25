// Drives the TypeScript machine side on a machine of the matrix as a core
// does over ssh: `node dial` of the machine bundle (machine.js) with the
// Bun runtime running this driver, a yamux session over its standard input
// and output, the agent protocol on it. It checks that the node starts and
// answers, that the terminal core it installs and starts runs a terminal,
// that a file is written and read back, and that links are refused where
// they must be: by the system calls the machine side makes (openat2's
// RESOLVE_NO_SYMLINKS, falling back on old kernels; O_NOFOLLOW; renameat2
// without replacing) and by the files feature (a path through a link into
// the data directory refused, a link removed rather than followed).
// build.sh bundles it into driver.js; run.sh runs it with each runtime.
import { spawn } from 'node:child_process';
import { constants, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Reader } from '../../../../backend/shared/lib/streamio.ts';
import { ChunkWriter, Op, readLine, type Reply } from '../../../../backend/shared/proto/agentproto/index.ts';
import { Conn as HCConn } from '../../../../backend/shared/proto/hc/index.ts';
import { closeStream, pairDuplex } from '../../../../backend/shared/proto/yamux.ts';
import { Session } from '../../../../backend/kernel/machines/transport/session.ts';
import { call } from '../../../../backend/kernel/agent.ts';
import { filesProtocol } from '../../../../backend/features/files/protocol.ts';
import { machineOf } from '../../../../backend/machine/testing.ts';
import { linkGuard, openNoLinks, renameNoReplace } from '../../../../backend/machine/sys/fs.ts';
import { peerCred, socketFd } from '../../../../backend/machine/sys/proc.ts';
import { RUNTIME_FLAGS } from '../../../../backend/kernel/machines/transport/builds.ts';
import { dataDir } from '../../../../backend/shared/lib/brand.ts';

const dir = import.meta.dir;
const home = process.env.HOME!;
const instance = 'matrix';
let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const step = async (what: string, f: () => Promise<void> | void) => {
  try {
    await f();
  } catch (e) {
    check(false, `${what}: ${(e as Error).stack ?? e}`);
  }
};

const bundle = join(dir, 'machine.js');
// MACHINE_EXE runs another machine build instead (the Go program, to tell
// what the machine does from what the TypeScript side does).
const machine = (args: string[]) =>
  process.env.MACHINE_EXE ? [process.env.MACHINE_EXE, ...args] : [process.execPath, ...RUNTIME_FLAGS, bundle, ...args];

// The node, through node dial, as ssh runs it.
const [exe, ...args] = machine(['node', 'dial', '--instance', instance, '--client', 'matrix-driver']);
const dial = spawn(exe, args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HOME: home } });
const session = new Session(pairDuplex(dial.stdout!, dial.stdin!), () => dial.kill());
const m = machineOf(session);

await step('hello', async () => {
  const rep = await session.request({ op: Op.Hello }, { timeoutMs: 60_000 });
  check(rep.ok && rep.info?.home === home && rep.info?.os === 'linux', `node answers: ${JSON.stringify(rep.info)}`);
  console.log(`INFO the machine build: ${process.env.MACHINE_EXE ?? bundle}`);
});

await step('a terminal of its terminal core', async () => {
  const gz = readFileSync(join(dir, 'hc', 'herdr-core.gz'));
  const digest = readFileSync(join(dir, 'hc', 'herdr-core.sha256'), 'utf8').trim();
  const { conn } = await session.open({ op: Op.HC, action: 'install', digest });
  const cw = new ChunkWriter(conn.stream);
  await cw.write(gz);
  await cw.finish();
  const installed = await readLine<Reply>(new Reader(conn.reader.release()));
  closeStream(conn.stream);
  check(installed.ok && installed.hc?.digest === digest, `herdr-core installed, checked by its digest (${installed.error ?? 'ok'})`);
  const started = await session.request({ op: Op.HC, action: 'start', digest }, { timeoutMs: 60_000 });
  check(!!started.hc?.running, `the terminal core runs (version ${started.hc?.version})`);
  const api = await session.open({ op: Op.HCAPI });
  const { conn: hc } = await HCConn.dial(pairDuplex(api.conn.reader.release(), api.conn.stream));
  const t = await hc.call<{ address: string }>('terminal.run', {
    argv: ['/bin/sh', '-c', 'echo "matrix-$((6*7))"; sleep 30'],
    cwd: home,
    size: { cols: 80, rows: 24 },
  });
  let screen = '';
  for (let i = 0; i < 100 && !screen.includes('matrix-42'); i++) {
    // terminal.read without history lines: the screen as text.
    screen = (await hc.call<{ text?: string }>('terminal.read', { terminal: t.address })).text ?? '';
    if (!screen.includes('matrix-42')) await new Promise((r) => setTimeout(r, 100));
  }
  check(screen.includes('matrix-42'), `a terminal runs a command: ${JSON.stringify(screen.trim().slice(0, 40))}`);
  hc.close();
});

await step('a file written and read back', async () => {
  const body = Buffer.from('written on the machine\n'.repeat(1000));
  const { conn } = await session.open({ op: Op.FsWrite, path: '~/mx/a.txt', mkdirs: true });
  const cw = new ChunkWriter(conn.stream);
  await cw.write(body);
  await cw.finish();
  const rep = await readLine<Reply>(conn.reader);
  closeStream(conn.stream);
  check(rep.ok && rep.stat?.size === body.length, `fs.write (${rep.error ?? 'ok'})`);
  const read = await session.open({ op: Op.FsRead, path: '~/mx/a.txt' });
  const parts: Buffer[] = [];
  for (let b = await read.conn.reader.chunk(); b; b = await read.conn.reader.chunk()) parts.push(b);
  check(Buffer.concat(parts).equals(body), 'fs.read gives the bytes back');
  const st = await call(m, filesProtocol, 'stat', { paths: ['~/mx/a.txt', '~/mx/missing'] });
  check(st[0].exists && st[0].size === body.length && !st[1].exists, 'files.stat');
});

await step('links refused', async () => {
  const real = join(home, 'real');
  mkdirSync(real);
  writeFileSync(join(real, 'f'), 'target');
  symlinkSync(real, join(home, 'link'));
  symlinkSync(join(real, 'f'), join(home, 'flink'));
  // The system calls, on this kernel.
  let code = '';
  try {
    openNoLinks(join(home, 'link', 'f'), constants.O_RDONLY);
  } catch (e) {
    code = (e as NodeJS.ErrnoException).code ?? '';
  }
  if (linkGuard.refusedEverywhere) check(code === 'ELOOP', `openat2 RESOLVE_NO_SYMLINKS refuses a link on the path (${code || 'opened'})`);
  else
    console.log(
      `INFO openat2 is not there (kernel ${readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim()}): only the last name is refused`,
    );
  code = '';
  try {
    openNoLinks(join(home, 'flink'), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    code = (e as NodeJS.ErrnoException).code ?? '';
  }
  check(code === 'ELOOP', `a link as the last name is refused (${code || 'opened'})`);
  writeFileSync(join(home, 'x'), 'x');
  writeFileSync(join(home, 'y'), 'y');
  code = '';
  try {
    renameNoReplace(join(home, 'x'), join(home, 'y'));
  } catch (e) {
    code = (e as NodeJS.ErrnoException).code ?? '';
  }
  check(code === 'EEXIST' && readFileSync(join(home, 'y'), 'utf8') === 'y', `a rename does not replace (${code || 'replaced'})`);
  // The files feature: into the data directory through a link, refused;
  // a link removed, its target kept.
  symlinkSync(join(home, dataDir(instance)), join(home, 'dlink'));
  const refused = await call(m, filesProtocol, 'mkdir', { path: '~/dlink/planted' }).then(
    () => 'made',
    (e: { code?: string }) => e.code ?? 'failed',
  );
  check(refused === 'refused', `a path through a link into the data directory is refused (${refused})`);
  await call(m, filesProtocol, 'remove', { paths: ['~/link'] });
  check(!existsSync(join(home, 'link')) && readFileSync(join(real, 'f'), 'utf8') === 'target', 'a link is removed, not followed');
});

await step('peer credentials', async () => {
  const { createServer, connect } = await import('node:net');
  const p = join(home, 'p.sock');
  const got = await new Promise<{ pid: number; uid: number }>((res, rej) => {
    const srv = createServer((s) => {
      try {
        res(peerCred(socketFd(s)));
      } catch (e) {
        rej(e);
      }
      s.destroy();
      srv.close();
    });
    srv.listen(p, () => connect(p).on('error', () => {}));
  });
  check(got.uid === process.getuid!() && got.pid === process.pid, `SO_PEERCRED uid ${got.uid} pid ${got.pid}`);
});

// The node and its terminal core end through the instance's own command.
session.close();
const stop = Bun.spawnSync(machine(['node', 'stop', '--instance', instance, '--terminal-core']), { env: { ...process.env, HOME: home } });
check(stop.exitCode === 0, `node stop --terminal-core: ${stop.stdout.toString().trim().replaceAll('\n', '; ')}`);

console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
