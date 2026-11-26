// The hub's database: hub[-<instance>]-<host>.db beside the instance's
// settings file, which the features that keep state there share (usage,
// the vault's access log), named for this host (hostFile). Releases before
// the rename of the core to the hub named it core[-<instance>]-<host>.db;
// its records are not carried over: when the hub starts it removes this
// host's old database of its instance, and the old databases other hosts
// of a shared home left go after the retention, as other hosts' hub
// databases do (pruneHostFiles).
import * as fs from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { hostFile, JOURNALS, pruneHostFiles, removeFiles, removeUnheld } from './host.ts';

/** The stem of the hub's database names. */
export const HUB_DB = 'hub';

/** The stem releases before the rename gave the hub's database. */
export const OLD_HUB_DB = 'core';

/** The name of the hub's database of the instance whose file of kind
 * (settings[-<instance>].json, vault[-<instance>].json) is file, before
 * hostFile: hub[-<instance>].db; stem gives another stem. */
export function hubDBName(file: string, kind: string, stem = HUB_DB): string {
  const name = basename(file).replace(kind, stem);
  return name.slice(0, name.length - extname(name).length) + '.db';
}

/** The hub's database of this host beside file of kind (hubDBName); ""
 * for "", a hub without such a file, which keeps no state. */
export function hubDBBeside(file: string, kind: string): string {
  if (!file) return '';
  return hostFile(dirname(file), hubDBName(file, kind));
}

/** What tidyHubDBs removed: this host's database of the old name, and
 * other hosts' databases (of either name) past the retention. */
export interface Tidied {
  old: string[];
  others: string[];
}

/** Removes, beside the instance's settings file, this host's database of
 * the old name (core[-<instance>]-<host>.db, with its journal files; one
 * a process still holds stays) and the databases of other hosts that
 * pruneHostFiles removes, of the new name and the old. Only this
 * instance's names are looked at: core.db of the default instance never
 * takes core-<instance>-<host>.db (pruneHostFiles' instancesBeside). */
export function tidyHubDBs(settingsFile: string, retention?: number, now?: Date): Tidied {
  const out: Tidied = { old: [], others: [] };
  if (!settingsFile) return out;
  const dir = dirname(settingsFile);
  const oldName = hubDBName(settingsFile, 'settings', OLD_HUB_DB);
  const mine = hostFile(dir, oldName);
  if (removeOld(mine)) out.old.push(basename(mine));
  for (const name of [hubDBName(settingsFile, 'settings'), oldName]) out.others.push(...pruneHostFiles(dir, name, retention, now));
  return out;
}

/** Removes the database at p and its journal files unless a process holds
 * it (removeUnheld; on Windows, where removeUnheld removes nothing, an
 * open file cannot be removed anyway). Journal files without their
 * database go too. Whether anything was removed. */
function removeOld(p: string): boolean {
  const there = (s: string) => {
    try {
      return fs.lstatSync(p + s).isFile();
    } catch {
      return false;
    }
  };
  if (!there('')) {
    const left = JOURNALS.filter(there);
    for (const s of left) fs.unlinkSync(p + s);
    return left.length > 0;
  }
  if (process.platform === 'win32') {
    removeFiles(p);
    return true;
  }
  return removeUnheld(p, () => true);
}
