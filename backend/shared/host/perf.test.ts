import { expect, test } from 'bun:test';
import { sample } from './perf.ts';

test('TestSample', () => {
  const a = sample();
  expect(a.memory).toBeGreaterThan(0);
  expect(a.goroutines).toBeGreaterThanOrEqual(0); // no goroutines: what the process waits on
  expect(a.cpus).toBeGreaterThanOrEqual(1);
  expect(a.cpu_ms).toBeGreaterThanOrEqual(0);
  expect(a.uptime_ms).toBeGreaterThanOrEqual(0);
  for (const v of Object.values(a)) expect(Number.isInteger(v)).toBe(true);
  const b = sample();
  expect(b.cpu_ms).toBeGreaterThanOrEqual(a.cpu_ms);
  expect(b.uptime_ms).toBeGreaterThanOrEqual(a.uptime_ms);
  expect(Object.keys(b).sort()).toEqual(['cpu_ms', 'cpus', 'goroutines', 'memory', 'uptime_ms']);
});
