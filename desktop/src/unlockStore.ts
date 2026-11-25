// What this install keeps for the variable vault's unlock keys, in a file of
// the app's user data (0600): its install id, which names its unlock entry
// in the hub, and the shellSecret, 32 random bytes that go into the entry's
// key-encryption key beside what the Secure Enclave or Windows Hello gives.
// The secret is encrypted with Electron's safeStorage (the macOS Keychain,
// Windows DPAPI): a program that has the Enclave key's blob or the Hello key
// still lacks it. Without safeStorage no unlock is offered. Both are made at
// the first enroll and read at each unlock. On macOS a step run once before
// the store's first use of safeStorage (keychain.ts) can give the keychain
// item a new build's access first.
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

/** What the step before the first use of safeStorage decided: use it, or
 * leave it alone for this launch, with this install's keys when that step
 * already read them. */
export type Prepared = { use: true } | { use: false; keys?: UnlockKeys };

export interface UnlockStore {
  /** Whether the store can keep a secret (safeStorage works). */
  available(): Promise<boolean>;
  /** This install's id and secret; null when there are none or they do not
   * decrypt. */
  load(): Promise<UnlockKeys | null>;
  /** The same, made when there are none; null without safeStorage or when
   * the file cannot be written. A file whose secret no longer decrypts
   * keeps its install id and gets a new secret. */
  loadOrCreate(): Promise<UnlockKeys | null>;
}

export interface StoreOptions {
  random?: (n: number) => Buffer;
  /** Run once, before the store's first use of safeStorage. */
  prepare?: () => Promise<Prepared>;
}

export const INSTALL = /^[A-Za-z0-9_-]{16,64}$/;
export const UNLOCK_FILE = 'vault-unlock.json';
const MAX_FILE = 4096;

/** The file's contents, read only as a regular file of at most MAX_FILE
 * bytes, never through a symbolic link; undefined when there is none. */
export async function readSmall(file: string): Promise<string | undefined> {
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

/** Writes body to file: beside it and renamed over it, so a failed write
 * leaves the old one; created 0600, never through an existing file or
 * link. */
export async function writeAtomic(file: string, body: string, random: (n: number) => Buffer = randomBytes): Promise<void> {
  const tmp = `${file}.${random(6).toString('hex')}.tmp`;
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(body);
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
}

/** A file's install id and, when it has one, its secret's ciphertext
 * (safeStorage's bytes), without decrypting it. */
export async function readUnlockFile(file: string): Promise<{ install?: string; sealed?: Buffer }> {
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
  if (typeof o.secret !== 'string' || o.secret.length === 0 || o.secret.length > MAX_FILE) return { install: o.install };
  return { install: o.install, sealed: Buffer.from(o.secret, 'base64') };
}

/** Writes a file of install and a secret's ciphertext. */
export function writeUnlockFile(file: string, install: string, sealed: Buffer, random?: (n: number) => Buffer): Promise<void> {
  return writeAtomic(file, JSON.stringify({ v: 1, install, secret: sealed.toString('base64') }) + '\n', random);
}

/** The secret a decrypted text holds: base64url of 32 bytes, else none. */
export function secretOf(text: string): Buffer | undefined {
  const secret = fromBase64url(text, 32);
  return secret?.length === 32 ? secret : undefined;
}

/** The store in dir (the app's user data). */
export function unlockStore(dir: string, safe: SafeStorage, options: StoreOptions = {}): UnlockStore {
  const file = join(dir, UNLOCK_FILE);
  const random = options.random ?? randomBytes;
  let prepared: Promise<Prepared> | undefined;
  /** The step before the first use of safeStorage, run once; one that fails
   * leaves safeStorage as it was. */
  const ready = () =>
    (prepared ??= options.prepare ? options.prepare().catch((): Prepared => ({ use: true })) : Promise.resolve({ use: true }));
  /** A copy of the keys the step read: callers wipe what they get. */
  const held = (p: Prepared): UnlockKeys | null =>
    !p.use && p.keys ? { install: p.keys.install, secret: Buffer.from(p.keys.secret) } : null;
  const safeAvailable = () => {
    try {
      return safe.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  /** The file's install id and, when it decrypts, the secret. */
  const read = async (): Promise<{ install?: string; secret?: Buffer }> => {
    const { install, sealed } = await readUnlockFile(file);
    if (!install || !sealed) return { install };
    try {
      const secret = secretOf(safe.decryptString(sealed));
      return secret ? { install, secret } : { install };
    } catch {
      return { install };
    }
  };
  return {
    async available() {
      const p = await ready();
      return p.use ? safeAvailable() : !!p.keys;
    },
    async load() {
      const p = await ready();
      if (!p.use) return held(p);
      if (!safeAvailable()) return null;
      const { install, secret } = await read();
      return install && secret ? { install, secret } : null;
    },
    async loadOrCreate() {
      const p = await ready();
      // safeStorage is left alone for this launch: nothing is written.
      if (!p.use) return held(p);
      if (!safeAvailable()) return null;
      try {
        const got = await read();
        if (got.install && got.secret) return { install: got.install, secret: got.secret };
        const keys = { install: got.install ?? random(16).toString('base64url'), secret: random(32) };
        await writeUnlockFile(file, keys.install, safe.encryptString(keys.secret.toString('base64url')), random);
        return keys;
      } catch {
        return null;
      }
    },
  };
}
