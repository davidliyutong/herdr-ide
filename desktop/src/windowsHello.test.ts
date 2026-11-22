import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHALLENGE_VAR,
  helloFor,
  helloKeysFor,
  KEY_NAME_VAR,
  keyResult,
  MESSAGE_VAR,
  POWERSHELL_ARGS,
  powershellPath,
  type RunPowerShell,
} from './windowsHello';

function hello(out: string | Error) {
  const calls: Array<{ script: string; env: Record<string, string> }> = [];
  const run: RunPowerShell = async (script, env) => {
    calls.push({ script, env });
    if (out instanceof Error) throw out;
    return out;
  };
  return { h: helloFor(run), calls };
}

test('PowerShell runs without profile or questions, reading the script from stdin', () => {
  assert.deepEqual(POWERSHELL_ARGS, ['-NoProfile', '-NonInteractive', '-Command', '-']);
});

test('PowerShell is run by its full path under the system directory', () => {
  const tail = 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.equal(powershellPath('D:\\WinNT'), `D:\\WinNT\\${tail}`);
  assert.equal(powershellPath('C:\\Windows\\'), `C:\\Windows\\${tail}`);
  assert.equal(powershellPath(undefined), `C:\\Windows\\${tail}`);
  assert.equal(powershellPath(''), `C:\\Windows\\${tail}`);
});

test('available only for the output Available', async () => {
  for (const [out, want] of [
    ['Available\r\n', true],
    ['Available', true],
    ['DeviceNotPresent\r\n', false],
    ['NotConfiguredForUser', false],
    ['DisabledByPolicy', false],
    ['', false],
    ['Available but not really', false],
    ['Verified', false],
  ] as const) {
    assert.equal(await hello(out).h.available(), want, out);
  }
});

test('request only for the output Verified', async () => {
  for (const [out, want] of [
    ['Verified\r\n', true],
    ['Canceled\r\n', false],
    ['DeviceBusy', false],
    ['RetriesExhausted', false],
    ['Available', false],
    ['', false],
  ] as const) {
    assert.equal(await hello(out).h.request('m'), want, out);
  }
});

test('a failing run (a non-zero exit, a timeout) is false', async () => {
  const { h } = hello(new Error('exit 1'));
  assert.equal(await h.available(), false);
  assert.equal(await h.request('m'), false);
});

test('the message goes in the environment, never into the script', async () => {
  const message = `Confirm "$(calc)" '; Remove-Item * #\n\`x`;
  const { h, calls } = hello('Verified');
  assert.equal(await h.request(message), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env[MESSAGE_VAR], message);
  assert.deepEqual(Object.keys(calls[0].env), [MESSAGE_VAR]);
  assert.ok(!calls[0].script.includes(message));
  assert.ok(!calls[0].script.includes('calc'));
  assert.ok(calls[0].script.includes(`$env:${MESSAGE_VAR}`));
  assert.ok(calls[0].script.includes('RequestVerificationAsync'));
  assert.ok(calls[0].script.includes('AsTask'));
  // The availability check carries no message.
  await h.available();
  assert.deepEqual(calls[1].env, {});
  assert.ok(calls[1].script.includes('CheckAvailabilityAsync'));
});

const pub = Buffer.alloc(294, 1);
const sig = Buffer.alloc(256, 2);

test('key results: "Success <base64>" with bytes, NotFound is a key that is gone, UserCanceled a cancel', () => {
  assert.deepEqual(keyResult(`Success ${pub.toString('base64')}\r\n`), { ok: true, value: pub });
  assert.deepEqual(keyResult('NotFound\r\n'), { ok: false, error: 'invalidated' });
  assert.deepEqual(keyResult('UserCanceled'), { ok: false, error: 'cancel' });
  for (const out of [
    'UnknownError',
    'UserPrefersPassword',
    'SecurityDeviceLocked',
    'CredentialAlreadyExists',
    '',
    'Success',
    'Success ',
    `Success ${pub.toString('base64url').replace(/^./, '-')}`,
    `Success ${pub.toString('base64')}x`,
    `Success ${Buffer.alloc(3000).toString('base64')}`,
    `success ${pub.toString('base64')}`,
    `Success ${pub.toString('base64')}\nSuccess ${pub.toString('base64')}`,
    'Verified',
  ]) {
    assert.deepEqual(keyResult(out), { ok: false, error: 'failed' }, out);
  }
});

function keys(out: string | Error) {
  const calls: Array<{ script: string; env: Record<string, string> }> = [];
  const run: RunPowerShell = async (script, env) => {
    calls.push({ script, env });
    if (out instanceof Error) throw out;
    return out;
  };
  return { k: helloKeysFor(run), calls };
}

test('Hello keys: supported only for True; the name and challenge in the environment, never in the script', async () => {
  for (const [out, want] of [
    ['True\r\n', true],
    ['False\r\n', false],
    ['', false],
    ['Available', false],
  ] as const) {
    assert.equal(await keys(out).k.supported(), want, out);
  }
  assert.equal(await keys(new Error('exit 1')).k.supported(), false);
  const name = 'app-vault-install-0123456789ab';
  const created = keys(`Success ${pub.toString('base64')}`);
  assert.deepEqual(await created.k.create(name), { ok: true, value: pub });
  assert.deepEqual(created.calls[0].env, { [KEY_NAME_VAR]: name });
  assert.ok(!created.calls[0].script.includes(name));
  assert.ok(created.calls[0].script.includes('RequestCreateAsync'));
  assert.ok(created.calls[0].script.includes('ReplaceExisting'));
  assert.ok(created.calls[0].script.includes('X509SubjectPublicKeyInfo'));
  const challenge = Buffer.alloc(32, 9);
  const signed = keys(`Success ${sig.toString('base64')}\r\n`);
  assert.deepEqual(await signed.k.sign(name, challenge), { ok: true, value: sig });
  assert.deepEqual(signed.calls[0].env, { [KEY_NAME_VAR]: name, [CHALLENGE_VAR]: challenge.toString('base64') });
  assert.ok(!signed.calls[0].script.includes(challenge.toString('base64')));
  for (const part of ['OpenAsync', 'RequestSignAsync', `$env:${KEY_NAME_VAR}`, `$env:${CHALLENGE_VAR}`, 'AsTask']) {
    assert.ok(signed.calls[0].script.includes(part), part);
  }
  assert.deepEqual(await keys('NotFound').k.sign(name, challenge), { ok: false, error: 'invalidated' });
  assert.deepEqual(await keys(new Error('timeout')).k.sign(name, challenge), { ok: false, error: 'failed' });
});

test('Hello keys refuse a name or a challenge of another form without running', async () => {
  const { k, calls } = keys(`Success ${sig.toString('base64')}`);
  for (const name of ['', 'a b', 'x"; Remove-Item *', 'n'.repeat(129), 'a\nb']) {
    assert.deepEqual(await k.create(name), { ok: false, error: 'failed' });
    assert.deepEqual(await k.sign(name, Buffer.alloc(32)), { ok: false, error: 'failed' });
  }
  assert.deepEqual(await k.sign('name', Buffer.alloc(0)), { ok: false, error: 'failed' });
  assert.deepEqual(await k.sign('name', Buffer.alloc(1025)), { ok: false, error: 'failed' });
  assert.deepEqual(calls, []);
});
