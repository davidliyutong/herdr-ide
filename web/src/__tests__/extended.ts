// The web suite's extended tests, the equivalent of the hub's
// backend/shared/testdata/extended.ts: skipped by `make test`, run by
// `make test-extended` and CI (EXTENDED_TESTS=1).
import { describe, test } from 'vitest';

declare const process: { env: Record<string, string | undefined> };
const skip = !process.env.EXTENDED_TESTS;

/** An extended test, skipped unless EXTENDED_TESTS is set. */
export const extended = test.skipIf(skip);

/** A suite of extended tests, skipped unless EXTENDED_TESTS is set. */
export const extendedDescribe = describe.skipIf(skip);
