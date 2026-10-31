import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { APP_SLUG } from '../../web/src/brand';
import { CoreProcess, coreArgs, coreEnv, corePort, DesktopError } from './core';

function fakeCore(source: string) {
  return ['-e', source];
}
const ready = `process.stdout.write(JSON.stringify({event:'ready',url:'http://127.0.0.1:7781'})+'\\n');`;

test('development is isolated; packaged mode has its own instance', () => {
  const args = coreArgs(true, 7791);
  assert.ok(args.includes('--local-only'));
  for (const flag of ['--local-session', '--remote-session']) assert.equal(args[args.indexOf(flag) + 1], `${APP_SLUG}-dev`);
  assert.equal(args[args.indexOf('--instance') + 1], 'dev');
  const release = coreArgs(false, 7781);
  assert.equal(release[release.indexOf('--instance') + 1], 'desktop');
  assert.ok(!release.includes('--local-session'));
  for (const port of ['-1', '65536', 'abc', '80;open', '0.0.0.0:7781'])
    assert.throws(
      () => corePort(port),
      (e: unknown) => e instanceof DesktopError && e.key === 'desktop.badPort',
    );
  assert.ok(coreArgs(true, corePort('0')).includes('127.0.0.1:0'));
  assert.ok(coreArgs(true, corePort('007791')).includes('127.0.0.1:7791'));
  assert.ok(coreEnv({ PATH: '/custom/bin' }, '/Users/test').PATH?.includes('/Users/test/.local/bin'));
  assert.ok(coreEnv({}, '/Users/test').PATH?.includes('/opt/homebrew/bin'));
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
