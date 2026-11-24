// The migrate plugin's core routes (internal/plugins/migrate), all of a
// machine: the namespace a previous product name left there, its layout
// and live terminals, and what moving tabs from it, stopping its terminal
// core and removing its files ask of the machine.
import { answer, failureOf, jsonInit, makeErrorText, PluginError } from '../../lib/pluginApi';
import type { OldTerminal } from './plan';

/** A failure with the core's or the machine's code (offline, none,
 * not_running, conflict, running, node, in_use, stop_failed, failed,
 * network). */
export class MigrateError extends PluginError {}

/** agentproto.MigrateStatus. */
export interface MigrateStatus {
  slug?: string;
  dir?: string;
  running?: boolean;
  version?: string;
  node?: boolean;
  terminals: number;
}

/** agentproto.MigrateScan. */
export interface MigrateScan extends MigrateStatus {
  layout: unknown;
  layout_version: number;
  terminal_list?: OldTerminal[];
}

const base = (m: string) => `/api/m/${encodeURIComponent(m)}/p/migrate`;
const fail = failureOf((code, message) => new MigrateError(code, message));

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, { cache: 'no-store', ...init });
  } catch (e) {
    throw new MigrateError('network', e instanceof Error ? e.message : String(e));
  }
  return answer<T>(r, fail);
}

export const migrateStatus = (m: string) => send<MigrateStatus>(`${base(m)}/status`);
export const migrateScan = (m: string) => send<MigrateScan>(`${base(m)}/scan`);

/** Writes the previous layout without what moved (at the version it was
 * read: conflict when it changed) and ends the moved terminals. */
export const migrateRelease = (m: string, layout: unknown, version: number, terminals: string[]) =>
  send<unknown>(`${base(m)}/release`, jsonInit('POST', { layout, version, terminals }));

export const migrateStop = (m: string) => send<unknown>(`${base(m)}/stop`, jsonInit('POST'));
export const migrateRemove = (m: string) => send<unknown>(`${base(m)}/remove`, jsonInit('POST'));

/** A failure as the user reads it. */
export const migrateErrorText = makeErrorText(MigrateError, 'migrate.error');
