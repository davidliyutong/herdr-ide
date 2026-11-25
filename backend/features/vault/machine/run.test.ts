import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mask, maskOutput, runWithEnv, withCore } from './run.ts';
import { survivors } from './testdata/procs.ts';

describe('run_with_env', () => {
  // TestRunLimits
  test('output, timeouts, exit statuses and directories', async () => {
    const r = { maxOutput: 100 };
    let ran = await runWithEnv('yes abcdefghij | head -c 5000', {}, '', 0, { limits: r });
    expect(ran.failed).toBe(false);
    expect(ran.out).toContain('[output truncated: 100 of 5000 bytes]');
    // A value cut by the limit is still masked.
    ran = await runWithEnv(`printf '%080d' 0; printf %s "$V"`, { V: 's'.repeat(60) }, '', 0, { limits: r });
    expect(ran.out).not.toContain('ssssssssss');

    const start = Date.now();
    ran = await runWithEnv('sleep 30 & sleep 30', {}, '', 3_600_000, { limits: { maxTimeoutMs: 300 } });
    expect(ran.failed).toBe(true);
    expect(ran.out).toContain('timed out after 300ms');
    expect(Date.now() - start).toBeLessThan(10_000);
    ran = await runWithEnv('sleep 30', {}, '', 0, { limits: { defaultTimeoutMs: 200 } });
    expect(ran.failed).toBe(true);
    expect(ran.out).toContain('timed out after 200ms');

    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'run-')));
    try {
      ran = await runWithEnv('exit 3', {}, dir, 0, { limits: r });
      expect(ran.failed).toBe(true);
      expect(ran.out.startsWith('exit status: 3\n')).toBe(true);
      ran = await runWithEnv('pwd', {}, dir, 0);
      expect(ran.out).toBe(`exit status: 0\n${dir}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    ran = await runWithEnv('pwd', {}, '/nonexistent-dir', 0, { limits: r });
    expect(ran.failed).toBe(true);
    expect(ran.out).toContain('cannot start');
    // Standard error goes where the output goes, in order.
    ran = await runWithEnv('echo one; echo two >&2; echo three', {}, '', 0);
    expect(ran.out).toBe('exit status: 0\none\ntwo\nthree\n');
  });

  // TestRunLimitsFromTheCore (the runner's side): the core's timeouts, in
  // seconds, become the runner's; without them the runner's own hold.
  test("the core's limits replace the runner's", () => {
    expect(withCore({}, { timeout: 1, max_timeout: 2, max_output: 50 })).toEqual({
      maxOutput: 50,
      defaultTimeoutMs: 1000,
      maxTimeoutMs: 2000,
    });
    expect(withCore({ maxOutput: 7 }, undefined)).toEqual({ maxOutput: 7 });
    expect(withCore({ maxOutput: 7 }, { timeout: 0, max_timeout: 0, max_output: 0 })).toEqual({ maxOutput: 7 });
  });

  // TestMaskAtTheCut: masking shrinks the text, so the beginning of a
  // value at the cut, which no occurrence matches, would come within the
  // returned part; it is dropped, and an occurrence that began before it is
  // masked whole.
  test('a value at the cut of the capture is not shown', async () => {
    const v = { V: 'SECRET' };
    for (const [input, cut, want] of [
      ['a SECRET b SEC', true, 'a *** '],
      ['a SECRET b SEC', false, 'a *** b SEC'], // a part the command printed
      ['xxxxSECRET', true, 'xxxx***'],
      ['SECRETSECRETSECR', true, '******'],
      ['', true, ''],
    ] as const)
      expect(maskOutput(Buffer.from(input), v, cut).toString()).toBe(want);
    // A shorter value inside the cut beginning of a longer one leaves none
    // of the longer one's bytes.
    const two = { A: 'XAB', B: 'ABCDE' };
    expect(maskOutput(Buffer.from('..XABCD'), two, true).toString()).toBe('..***');
    expect(mask('x ABCDE XAB y', two)).toBe('x *** *** y');
    // Bytes, not characters: a value of several bytes per character.
    expect(mask('ü=ÜBER ÜBER', { V: 'ÜBER' })).toBe('ü=*** ***');

    // A 39-byte value printed 4000 times: the capture (64 KiB beyond the
    // limit) ends inside one, which is not shown.
    const secret = 'sk-live-0123456789abcdefghijklmnopqrstuv'.slice(0, 39);
    const ran = await runWithEnv('yes "$V" | head -n 4000', { V: secret }, '', 0);
    expect(ran.failed).toBe(false);
    expect(ran.out).toContain('[output truncated: 65536 of 160000 bytes]');
    expect(ran.out).not.toContain(secret.slice(0, 4));
  });

  // TestRunKillsBackgroundPrograms: programs a command leaves in the
  // background, with the values in their environment, do not outlive the
  // call: the process group is killed when the command returns, also while
  // they hold the output's pipe.
  test('programs left in the background are killed with the call', async () => {
    for (const command of ['sleep 30 >/dev/null 2>&1 & echo $!', 'sleep 30 & echo $!']) {
      const ran = await runWithEnv(command, { V: 'secret' }, '', 0, { waitDelayMs: 200 });
      expect(ran.failed).toBe(false);
      const lines = ran.out.trim().split('\n');
      const pid = Number(lines[lines.length - 1]);
      expect(Number.isInteger(pid)).toBe(true);
      expect(await survivors([pid])).toEqual([]);
      // The one that held the output is told.
      expect(ran.out.includes('[programs left in the background were killed]')).toBe(command === 'sleep 30 & echo $!');
    }
  });

  test('a cancelled command is killed', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const ran = await runWithEnv('sleep 30', {}, '', 0, { signal: ac.signal });
    expect(ran.failed).toBe(true);
    expect(ran.out).toBe('exit status: -1\n[cancelled; the command was killed]\n');
  });
});
