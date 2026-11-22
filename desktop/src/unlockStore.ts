// What this install keeps for the variable vault's unlock keys, in a file of
// the app's user data (0600): its install id, which names its unlock entry
// in the core, and the shellSecret, 32 random bytes that go into the entry's
// key-encryption key beside what the Secure Enclave or Windows Hello gives.
// The secret is encrypted with Electron's safeStorage (the macOS Keychain,
// Windows DPAPI): a program that has the Enclave key's blob or the Hello key
// still lacks it. Without safeStorage no unlock is offered. Both are made at
// the first enroll and read at each unlock.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fromBase64url } from './relay';

/** The parts of Electron's safeStorage the store uses. */
export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface UnlockKeys {
  install: string;
  secret: Buffer;
}

export interface UnlockStore {
  /** Whether the store can keep a secret (safeStorage works). */
  available(): boolean;
  /** This install's id and secret; null when there are none or they do not
   * decrypt. */
  load(): Promise<UnlockKeys | null>;
  /** The same, made when there are none; null without safeStorage or when
   * the file cannot be written. A file whose secret no longer decrypts
   * keeps its install id and gets a new secret. */
  loadOrCreate(): Promise<UnlockKeys | null>;
}

export const INSTALL = /^[A-Za-z0-9_-]{16,64}$/;
export const UNLOCK_FILE = 'vault-unlock.json';
const MAX_FILE = 4096;

/** The file's contents, read only as a regular file of at most MAX_FILE
 * bytes, never through a symbolic link; undefined when there is none. */
async function readSmall(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_FILE) return undefined;
    const buf = Buffer.alloc(MAX_FILE + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return bytesRead > MAX_FILE ? undefined : buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** The store in dir (the app's user data). */
export function unlockStore(dir: string, safe: SafeStorage, random: (n: number) => Buffer = randomBytes): UnlockStore {
  const file = join(dir, UNLOCK_FILE);
  const available = () => {
    try {
      return safe.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  /** The file's install id and, when it decrypts, the secret. */
  const read = async (): Promise<{ install?: string; secret?: Buffer }> => {
    const text = await readSmall(file);
    if (text === undefined) return {};
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return {};
    }
    const o = v as { v?: unknown; install?: unknown; secret?: unknown } | null;
    if (typeof o !== 'object' || o === null || o.v !== 1 || typeof o.install !== 'string' || !INSTALL.test(o.install)) return {};
    if (typeof o.secret !== 'string' || o.secret.length > MAX_FILE) return { install: o.install };
    try {
      const secret = fromBase64url(safe.decryptString(Buffer.from(o.secret, 'base64')), 32);
      return secret?.length === 32 ? { install: o.install, secret } : { install: o.install };
    } catch {
      return { install: o.install };
    }
  };
  const write = async (keys: UnlockKeys) => {
    const body = JSON.stringify({
      v: 1,
      install: keys.install,
      secret: safe.encryptString(keys.secret.toString('base64url')).toString('base64'),
    });
    // Written beside the file and renamed over it, so a failed write leaves
    // the old one; created 0600, never through an existing file or link.
    const tmp = `${file}.${random(6).toString('hex')}.tmp`;
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(body + '\n');
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  };
  return {
    available,
    async load() {
      if (!available()) return null;
      const { install, secret } = await read();
      return install && secret ? { install, secret } : null;
    },
    async loadOrCreate() {
      if (!available()) return null;
      try {
        const got = await read();
        if (got.install && got.secret) return { install: got.install, secret: got.secret };
        const keys = { install: got.install ?? random(16).toString('base64url'), secret: random(32) };
        await write(keys);
        return keys;
      } catch {
        return null;
      }
    },
  };
}
