import { expect, test } from 'bun:test';
import { formatDuration } from './gotime.ts';

test("durations are written as Go's time.Duration writes them", () => {
  const ms = 1e6;
  for (const [ns, want] of [
    [0, '0s'],
    [1, '1ns'],
    [1500, '1.5µs'],
    [200 * ms, '200ms'],
    [1.5 * ms, '1.5ms'],
    [1000 * ms, '1s'],
    [1500 * ms, '1.5s'],
    [120_000 * ms, '2m0s'],
    [600_000 * ms, '10m0s'],
    [3_600_000 * ms, '1h0m0s'],
    [3_661_000 * ms, '1h1m1s'],
    [-300 * ms, '-300ms'],
  ] as const)
    expect(formatDuration(ns)).toBe(want);
});
