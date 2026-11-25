// Extended tests: those that wait on real time for what runs in the
// background (a timer, programs a test starts, a worker, a compile), on
// programs of the machine, on Docker or on large inputs. They wait long
// enough for a machine that is not busy. `make test` skips them;
// `make test-extended` and CI run them (EXTENDED_TESTS=1).
import { describe, test } from 'bun:test';

const skip = !process.env.EXTENDED_TESTS;

/** An extended test, skipped unless EXTENDED_TESTS is set. */
export const extended = test.skipIf(skip);

/** A suite of extended tests, skipped unless EXTENDED_TESTS is set. */
export const extendedDescribe = describe.skipIf(skip);
