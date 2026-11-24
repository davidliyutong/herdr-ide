// The private directory of an instance's ssh control sockets.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SLUG } from '#shared/lib/brand.ts';

/** Keeps a control socket's path, <dir>/<%C: 40 hex> and the 17 characters
 * ssh adds while it binds, within macOS's 104 bytes. */
const MAX_CONTROL_NAME = 16;

/** s for the default instance, s-<instance> for another, h-<hash> for a
 * name longer than MAX_CONTROL_NAME (a prefix of its own, as the hash is
 * itself a valid short name), so instances never share a connection. */
export function controlName(instance: string): string {
  if (instance === '') return 's';
  if (instance.length <= MAX_CONTROL_NAME) return `s-${instance}`;
  return 'h-' + createHash('sha256').update(instance).digest('hex').slice(0, 12);
}

export function controlParent(): string {
  return join('/tmp', `${SLUG}-${process.getuid!()}`);
}

/** Refuses a directory that is no directory of ours or that others can reach. */
export function checkPrivateDir(d: string): void {
  const st = lstatSync(d);
  if (!st.isDirectory() || st.uid !== process.getuid!())
    throw new Error(`${d} is not a directory owned by uid ${process.getuid!()}; refusing to use it for ssh control sockets`);
  if ((st.mode & 0o077) !== 0)
    throw new Error(`${d} is accessible by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 700 ${d}`);
}

/** The directory of an instance's ssh control sockets; empty on Windows,
 * whose OpenSSH cannot share connections (ControlMaster), so each ssh
 * command connects and authenticates itself. It lives in /tmp because unix
 * socket paths are limited to ~104 bytes; as /tmp is shared, both levels
 * must be real directories owned by us and not accessible to anyone else,
 * otherwise another local user could plant control sockets and hijack
 * every ssh connection. */
export function controlDir(instance: string): string {
  if (process.platform === 'win32') return '';
  const parent = controlParent();
  const dir = join(parent, controlName(instance));
  for (const d of [parent, dir]) {
    try {
      mkdirSync(d, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    checkPrivateDir(d);
  }
  return dir;
}
