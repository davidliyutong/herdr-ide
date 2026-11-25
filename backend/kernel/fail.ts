// The hub's failures (#shared/lib/fail.ts: Fail, which the machine side
// throws too) and the ones the kernel answers with.
import { Fail } from '#shared/lib/fail.ts';

export { Fail, failOf } from '#shared/lib/fail.ts';

/** The machine has no agent session. */
export const offline = () => new Fail('offline', 409, 'machine not connected');

/** Refused in read-only mode. */
export const readOnly = () => new Fail('read_only', 403, 'read-only mode');

/** A feature that is off for the requesting client. */
export const featureOff = () => new Fail('plugin_disabled', 404);

/** An unknown machine in the path. */
export const unknownMachine = () => new Fail('unknown', 404, 'unknown machine');
