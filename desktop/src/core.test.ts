import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { APP_SLUG } from '../../web/src/brand';
import {
  CoreProcess,
  coreArgs,
  coreEnv,
  coreHello,
  coreInstance,
  corePort,
  DESKTOP_COOKIE,
  desktopCookie,
  DesktopError,
  desktopToken,
  verifyKey,
} from './core';

function fakeCore(source: string) {
  return ['-e', source];
}
const ready = `process.stdout.write(JSON.stringify({event:'ready',url:'http://127.0.0.1:7781'})+'\\n');`;

test('development is isolated; packaged mode has its own instance', () => {
  assert.equal(coreInstance(false, 'e3'), 'desktop');
  assert.equal(coreInstance(true, undefined), 'dev');
  assert.equal(coreInstance(true, '1'), 'dev');
  assert.equal(coreInstance(true, 'e3'), 'e3');
  for (const bad of ['E3', '-x', 'a b', '../x', 'x'.repeat(33), 'desktop'])
    assert.throws(
      () => coreInstance(true, bad),
      (e: unknown) => e instanceof DesktopError && e.key === 'desktop.badInstance',
    );
  const args = coreArgs('dev', 7791);
  assert.ok(args.includes('--local-only'));
  assert.equal(args[args.indexOf('--instance') + 1], 'dev');
  assert.ok(coreArgs('e3', 7791).includes('--local-only'));
  const release = coreArgs('desktop', 7781);
  assert.equal(release[release.indexOf('--instance') + 1], 'desktop');
  assert.ok(!release.includes('--local-only'));
  // The app's machines are the default instance's, shared with a server's
  // cores; a development instance keeps its own.
  assert.ok(release.includes('--node-instance='));
  assert.ok(args.includes('--node-instance=dev'));
  for (const port of ['-1', '65536', 'abc', '80;open', '0.0.0.0:7781'])
    assert.throws(
      () => corePort(port),
      (e: unknown) => e instanceof DesktopError && e.key === 'desktop.badPort',
    );
  assert.ok(coreArgs('dev', corePort('0')).includes('127.0.0.1:0'));
  assert.ok(coreArgs('dev', corePort('007791')).includes('127.0.0.1:7791'));
});

test('PATH gains the usual installations on macOS and Linux; Windows keeps its own', () => {
  for (const p of ['darwin', 'linux'] as const) {
    assert.ok(coreEnv({ PATH: '/custom/bin' }, '/home/test', p).PATH?.startsWith('/custom/bin'));
    assert.ok(coreEnv({ PATH: '/custom/bin' }, '/home/test', p).PATH?.includes('/home/test/.local/bin'));
    assert.ok(coreEnv({}, '/Users/test', p).PATH?.includes('/opt/homebrew/bin'));
  }
  const env = { Path: 'C:\\Windows\\System32' };
  assert.equal(coreEnv(env, 'C:\\Users\\test', 'win32'), env);
});

// Windows has no signal a program can clean up after: closing stdin is what
// stops the core everywhere, and a core that does not end is killed.
test('stopping closes stdin and sends no signal; a core that stays is killed after the deadline', async () => {
  const graceful = new CoreProcess();
  await graceful.start(process.execPath, fakeCore(ready + 'process.stdin.resume();'), 7781, process.env, tmpdir(), () => {});
  const child = (graceful as unknown as { child: import('node:child_process').ChildProcess }).child;
  await graceful.stop(10_000);
  assert.deepEqual([child.exitCode, child.signalCode], [0, null]);

  const stuck = new CoreProcess();
  await stuck.start(
    process.execPath,
    fakeCore(ready + 'process.stdin.resume(); process.stdin.on("end", () => setInterval(() => {}, 1000));'),
    7781,
    process.env,
    tmpdir(),
    () => {},
  );
  const stuckChild = (stuck as unknown as { child: import('node:child_process').ChildProcess }).child;
  await stuck.stop(200);
  assert.equal(stuckChild.signalCode, 'SIGKILL');
});

test('waits for an owned child ready message and stops it idempotently', async () => {
  const core = new CoreProcess();
  let unexpected = false;
  try {
    const url = await core.start(process.execPath, fakeCore(ready + 'process.stdin.resume();'), 7781, process.env, tmpdir(), () => {
      unexpected = true;
    });
    assert.equal(url, 'http://127.0.0.1:7781');
  } finally {
    await Promise.all([core.stop(), core.stop()]);
  }
  assert.equal(unexpected, false);
});

test('rejects invalid readiness, wrong origins and wrong ports', async () => {
  for (const message of [
    'not json',
    JSON.stringify({ event: 'ready', url: 'https://example.com' }),
    JSON.stringify({ event: 'ready', url: 'http://127.0.0.1:7780' }),
    JSON.stringify({ event: 'ready', url: 'http://127.0.0.1:7781/other' }),
  ]) {
    const core = new CoreProcess();
    try {
      await assert.rejects(
        core.start(
          process.execPath,
          fakeCore(`console.log(${JSON.stringify(message)}); process.stdin.resume();`),
          7781,
          process.env,
          tmpdir(),
          () => {},
        ),
      );
    } finally {
      await core.stop();
    }
  }
});

test('spawn errors and early exits fail instead of attaching to an existing service', async () => {
  const missing = new CoreProcess();
  await assert.rejects(missing.start('/nonexistent/desktop-core', [], 7781, process.env, tmpdir(), () => {}));
  await missing.stop();
  const early = new CoreProcess();
  await assert.rejects(
    early.start(process.execPath, fakeCore('process.exit(2)'), 7781, process.env, tmpdir(), () => {}),
    (e: unknown) => e instanceof DesktopError && e.key === 'desktop.coreExited' && e.detail === '2',
  );
  await early.stop();
});

test('an exit after readiness is surfaced to the launcher', async () => {
  const core = new CoreProcess();
  let notify!: () => void;
  const exited = new Promise<void>((resolve) => {
    notify = resolve;
  });
  await core.start(process.execPath, fakeCore(ready), 7781, process.env, tmpdir(), notify);
  await exited;
  await core.stop();
});

test('port 0 accepts the port the core chose', async () => {
  const core = new CoreProcess();
  try {
    const chosen = `process.stdout.write(JSON.stringify({event:'ready',url:'http://127.0.0.1:54321'})+'\\n'); process.stdin.resume();`;
    assert.equal(await core.start(process.execPath, fakeCore(chosen), 0, process.env, tmpdir(), () => {}), 'http://127.0.0.1:54321');
  } finally {
    await core.stop();
  }
});

test('an error after startup does not escape as an uncaught exception', async () => {
  const core = new CoreProcess();
  try {
    await core.start(process.execPath, fakeCore(ready + 'process.stdin.resume();'), 7781, process.env, tmpdir(), () => {});
    const child = (core as unknown as { child: import('node:child_process').ChildProcess }).child;
    const logged = console.error;
    console.error = () => {};
    try {
      child.emit('error', new Error('kill failed'));
      child.emit('error', new Error('kill failed again'));
    } finally {
      console.error = logged;
    }
  } finally {
    await core.stop();
  }
});

// The desktop app tells its windows from browsers with a token of its
// launch: new each time, sent to the core on stdin (its hello), never in
// the core's environment, and set for the core's origin only.
test('the token of a launch goes to the core on stdin and into a cookie of its origin only', async () => {
  const token = desktopToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.notEqual(desktopToken(), token);
  assert.equal(
    desktopToken((n) => Buffer.alloc(n, 1)),
    '01'.repeat(32),
  );
  assert.equal(coreHello(token), `{"desktop_token":"${token}"}\n`);
  assert.equal(coreHello(''), '{}\n');
  assert.equal(coreHello(token, 'ab'), `{"desktop_token":"${token}","verify_key":"ab"}\n`);
  assert.equal(coreHello('', 'ab'), '{"verify_key":"ab"}\n');

  // A core that answers only when its first line on stdin is the hello
  // with this token, and whose environment holds no token.
  const core = new CoreProcess();
  try {
    const check = `
      let input = '';
      process.stdin.on('data', (d) => {
        input += d;
        const nl = input.indexOf('\\n');
        if (nl < 0) return;
        const hello = JSON.parse(input.slice(0, nl));
        if (hello.desktop_token !== ${JSON.stringify(token)}) process.exit(5);
        if (Object.values(process.env).includes(${JSON.stringify(token)})) process.exit(6);
        ${ready}
      });`;
    const env = coreEnv(process.env, '/home/test', 'linux');
    assert.equal(await core.start(process.execPath, fakeCore(check), 7781, env, tmpdir(), () => {}, token), 'http://127.0.0.1:7781');
  } finally {
    await core.stop();
  }

  const cookie = desktopCookie('http://127.0.0.1:7781', token);
  assert.deepEqual(cookie, {
    url: 'http://127.0.0.1:7781/',
    name: DESKTOP_COOKIE,
    value: token,
    path: '/',
    secure: false,
    httpOnly: true,
    sameSite: 'strict',
  });
  // Host-only and kept for this launch: no domain, no expiry.
  assert.ok(!('domain' in cookie) && !('expirationDate' in cookie));
  assert.equal(DESKTOP_COOKIE, `${APP_SLUG}-desktop`);
  for (const origin of ['https://127.0.0.1:7781', 'http://localhost:7781', 'http://127.0.0.1:7781/x', 'http://example.com'])
    assert.throws(() => desktopCookie(origin, token));
});

test('the key of the system prompts is another random value than the token, sent only in the hello', () => {
  const key = verifyKey();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, desktopToken());
  assert.notEqual(verifyKey(), key);
  assert.equal(
    verifyKey((n) => Buffer.alloc(n, 2)),
    '02'.repeat(32),
  );
  const token = desktopToken();
  const hello = JSON.parse(coreHello(token, key));
  assert.equal(hello.desktop_token, token);
  assert.equal(hello.verify_key, key);
  assert.notEqual(hello.verify_key, hello.desktop_token);
  // The cookie carries the token only.
  assert.ok(!JSON.stringify(desktopCookie('http://127.0.0.1:7781', token)).includes(key));
});
