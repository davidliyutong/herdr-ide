// A chat host for the open action's tests (machine.test.ts), run as the
// terminal core would run one: `hostmain.ts chat-host --base DIR --run DIR`,
// with the fake adapter, its build's version from TEST_HOST_VERSION. With
// TEST_HOST_PROTO it is no host but a server that says hello in that
// version of the protocol and answers every request with an error; with
// TEST_HOST_SILENT it serves nothing at all (a stuck host).
import { posix } from 'node:path';
import { setVersion } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { listenUnix } from '#machine/sockets.ts';
import { serveHost } from '../machine/host/host.ts';
import { FakeAdapter, fakeSpecs } from '../machine/host/testing.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args[args.indexOf(name) + 1] ?? '';
const base = flag('--base');
const run = flag('--run');
setVersion(process.env.TEST_HOST_VERSION ?? 'dev');

if (process.env.TEST_HOST_SILENT) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (process.env.TEST_HOST_PROTO) {
  const proto = Number(process.env.TEST_HOST_PROTO);
  await listenUnix(posix.join(run, chat.SOCKET_NAME), (c) => {
    c.on('error', () => {});
    c.write(chat.line({ host: { proto, version: process.env.TEST_HOST_VERSION ?? 'dev', pid: process.pid } }));
    c.on('data', () => c.end(chat.line({ error: { code: 'bad_request', message: 'another protocol' } })));
    c.resume();
  });
} else {
  const fake = new FakeAdapter();
  // TEST_HOST_PROCS: each session runs a program in a group of its own
  // (sh reading its input; with TEST_HOST_STUBBORN one that ignores
  // SIGTERM, its input's end and a program it left in its group), which
  // only the host's signals end.
  if (process.env.TEST_HOST_PROCS) {
    fake.proc = true;
    fake.pid = true;
    fake.closeWait = 3600_000;
    if (process.env.TEST_HOST_STUBBORN) fake.procScript = "trap '' TERM HUP INT; (trap '' TERM; sleep 60) & while :; do sleep 1; done";
  }
  await serveHost({
    base,
    run,
    logger: (l) => process.stderr.write(`host ${process.pid}: ${l}\n`),
    adapters: { fake },
    spec: fakeSpecs,
    client: { name: 'test', version: 'test' },
    hostEnv: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/', SHELL: '/bin/sh' },
    environ: async () => ({ PATH: '/usr/bin:/bin' }),
    timing: { closeGrace: 1000, stopDeadline: 3000 },
    signals: (on) => {
      const sigs = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const;
      const hs = sigs.map((s) => [s, () => on(s)] as const);
      for (const [s, h] of hs) process.on(s, h);
      return () => {
        for (const [s, h] of hs) process.off(s, h);
      };
    },
    exit: (c) => process.exit(c),
  });
  process.exit(0);
}
