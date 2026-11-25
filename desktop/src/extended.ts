// The shell's extended tests, the equivalent of the hub's
// backend/shared/testdata/extended.ts: skipped by `make test`, run by
// `make test-extended` and CI (EXTENDED_TESTS=1).
import test from 'node:test';

const skip = !process.env.EXTENDED_TESTS;

/** An extended test, skipped unless EXTENDED_TESTS is set. */
export const extended = (name: string, fn: () => unknown) => test(name, { skip }, fn);
