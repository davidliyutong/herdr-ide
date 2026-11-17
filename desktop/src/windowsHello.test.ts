import assert from 'node:assert/strict';
import test from 'node:test';
import { helloFor, MESSAGE_VAR, POWERSHELL_ARGS, powershellPath, type RunPowerShell } from './windowsHello';

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
