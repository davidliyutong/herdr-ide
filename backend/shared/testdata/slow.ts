// Tests that wait on real time for what runs in the background (a timer,
// programs a test starts, a worker, a compile): they wait long enough for
// a machine that is not busy. `make test` skips them; `make test-slow`
// and CI run them (SLOW_TESTS=1).
import { describe, test } from 'bun:test';

const skip = !process.env.SLOW_TESTS;

/** A slow test, skipped unless SLOW_TESTS is set. */
export const slow = test.skipIf(skip);

/** A suite of slow tests, skipped unless SLOW_TESTS is set. */
export const slowDescribe = describe.skipIf(skip);
