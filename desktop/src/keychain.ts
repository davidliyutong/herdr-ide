// macOS: Electron's safeStorage keeps its key in the login keychain item
// "<app name> Safe Storage" (account "<app name> Key"), which the build of
// the app that first used safeStorage made. The item's access list trusts
// that build alone: its designated requirement and, in the partition list,
// its Team ID, or for a build without one (signed ad hoc, or with a
// certificate of the user's own) its cdhash, which every build changes. A
// later build that read the key had macOS ask for the keychain's password:
// at every launch after Allow, and again with every build after Always
// Allow.
//
// Once per launch, before the vault's unlock store first uses safeStorage
// (unlockStore.ts), this step compares the running app's code identity with
// the one recorded for the item's maker. When they differ it moves the key
// to this build: it reads the old item's password once with
// /usr/bin/security (the one prompt, which names security), decrypts with it
// the secrets of every instance's vault-unlock.json, deletes the old item,
// lets safeStorage make a new one (this build's, with a new key), seals the
// secrets with it, writes the files and records the build. Two items of one
// name cannot exist together, so the old password stays in memory until
// this instance's file is written, and a failure puts the old item back with
// it. When no file holds a secret the old item is deleted unread, without a
// prompt.
import { spawn as spawnProcess } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { APP_SLUG } from '../../web/src/brand';
import {
  readSmall,
  readUnlockFile,
  secretOf,
  UNLOCK_FILE,
  writeAtomic,
  writeUnlockFile,
  type Prepared,
  type SafeStorage,
  type UnlockKeys,
} from './unlockStore';

export const SECURITY = '/usr/bin/security';
export const CODESIGN = '/usr/bin/codesign';
/** The record of the code identity of the build that made the item, in the
 * app data directory beside every instance's user data. */
export const KEYCHAIN_RECORD = `${APP_SLUG}-desktop-keychain.json`;
/** How long a read of the old item may wait for the user's answer. */
export const READ_TIMEOUT_MS = 2 * 60_000;
/** How long any other run of security or codesign may take. */
export const TOOL_TIMEOUT_MS = 15_000;
/** The most a run may write on stdout and stderr together. */
export const TOOL_MAX_OUTPUT = 64 * 1024;
/** A migration's lock older than this was left by a launch that ended. */
export const LOCK_STALE_MS = 10 * 60_000;
/** The most instances whose files a migration carries over. */
export const MAX_INSTANCES = 64;
/** security's exit status for errSecItemNotFound (-25300). */
const NOT_FOUND = 44;

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs file (an absolute path) with input on stdin; its exit status and
 * output. Rejects on a relative path, a timeout or more output than
 * TOOL_MAX_OUTPUT, and kills the process when it gives up on it. */
export type RunTool = (file: string, args: string[], input: string, timeoutMs: number) => Promise<ToolResult>;

export function runTool(file: string, args: string[], input: string, timeoutMs: number, spawn = spawnProcess): Promise<ToolResult> {
  if (!isAbsolute(file)) return Promise.reject(new Error('not an absolute path'));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error: Error | undefined, result?: ToolResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);
    const collect = (into: Buffer[]) => (data: Buffer) => {
      size += data.length;
      if (size > TOOL_MAX_OUTPUT) return finish(new Error('too much output'));
      into.push(data);
    };
    child.stdout!.on('data', collect(out));
    child.stderr!.on('data', collect(err));
    child.on('error', (error) => finish(error));
    child.on('close', (code) =>
      finish(undefined, { code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
    );
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
  });
}

/** A code identity as the keychain tells builds apart. */
const IDENTITY = /^(cdhash:[0-9a-f]{40}|teamid:[A-Z0-9]{10}:[A-Za-z0-9._-]{1,255})$/;

/** The identity in codesign's display of a signature: the Team ID and
 * identifier of a build that has a Team ID, else its cdhash; undefined
 * when it shows neither. */
export function identityOf(display: string): string | undefined {
  const field = (key: string) => display.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
  const team = field('TeamIdentifier');
  const identifier = field('Identifier');
  const cdhash = field('CDHash');
  const withTeam = `teamid:${team}:${identifier}`;
  if (team && team !== 'not set' && IDENTITY.test(withTeam)) return withTeam;
  const adhoc = `cdhash:${cdhash}`;
  return cdhash && IDENTITY.test(adhoc) ? adhoc : undefined;
}

/** The running process pid's identity, from codesign (the signature it runs
 * with, not the files on disk, which an update may have replaced). */
export async function codeIdentity(run: RunTool, pid: number): Promise<string | undefined> {
  try {
    const r = await run(CODESIGN, ['-d', '-vvv', `+${pid}`], '', TOOL_TIMEOUT_MS);
    return r.code === 0 ? identityOf(`${r.stderr}\n${r.stdout}`) : undefined;
  } catch {
    return undefined;
  }
}

export interface KeychainItem {
  service: string;
  account: string;
}

/** The item safeStorage keeps its key in on macOS, for the app's name. */
export const safeStorageItem = (name: string): KeychainItem => ({ service: `${name} Safe Storage`, account: `${name} Key` });

export interface Keychain {
  /** Whether the item exists; undefined when that cannot be told. Reads
   * its attributes only, which asks nothing. */
  exists(): Promise<boolean | undefined>;
  /** The item's password, after macOS asked the user; null on a refusal,
   * a timeout or anything else. */
  read(): Promise<string | null>;
  /** Deletes the item; whether it is gone. */
  remove(): Promise<boolean>;
  /** Adds the item with password, trusted by the app alone; whether it is
   * there afterwards. */
  restore(password: string): Promise<boolean>;
}

/** A safeStorage item's password: base64, as Chromium makes it. */
const PASSWORD = /^[A-Za-z0-9+/=]{1,256}$/;
/** Text that may stand between double quotes in security's interactive
 * mode. */
const QUOTABLE = /^[^"\\\p{Cc}]{1,1024}$/u;

/** The item through /usr/bin/security; app is the app's bundle, which a
 * restored item trusts. */
export function securityKeychain(item: KeychainItem, app: string, run: RunTool): Keychain {
  const match = ['-s', item.service, '-a', item.account];
  const exists = async () => {
    try {
      const r = await run(SECURITY, ['find-generic-password', ...match], '', TOOL_TIMEOUT_MS);
      return r.code === 0 ? true : r.code === NOT_FOUND ? false : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    exists,
    async read() {
      try {
        const r = await run(SECURITY, ['find-generic-password', ...match, '-w'], '', READ_TIMEOUT_MS);
        if (r.code !== 0) return null;
        const password = r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
        return PASSWORD.test(password) ? password : null;
      } catch {
        return null;
      }
    },
    async remove() {
      try {
        const r = await run(SECURITY, ['delete-generic-password', ...match], '', TOOL_TIMEOUT_MS);
        return r.code === 0 || r.code === NOT_FOUND;
      } catch {
        return false;
      }
    },
    async restore(password) {
      if (!PASSWORD.test(password) || ![item.service, item.account, app].every((s) => QUOTABLE.test(s))) return false;
      // The password goes on security's standard input, never in its
      // arguments, which other programs can list.
      const q = (s: string) => `"${s}"`;
      const line = ['add-generic-password', '-s', q(item.service), '-a', q(item.account), '-w', q(password), '-T', q(app)].join(' ');
      try {
        await run(SECURITY, ['-i'], `${line}\n`, TOOL_TIMEOUT_MS);
      } catch {
        // Whether it was added is told below.
      }
      return (await exists()) === true;
    },
  };
}

const V10 = Buffer.from('v10', 'latin1');

/** Whether bytes are safeStorage's macOS ciphertext (Chromium's OSCrypt,
 * version "v10"). */
export const isV10 = (sealed: Buffer) =>
  sealed.length > V10.length && sealed.subarray(0, V10.length).equals(V10) && (sealed.length - V10.length) % 16 === 0;

/** The key OSCrypt derives from the item's password: PBKDF2-HMAC-SHA1,
 * salt "saltysalt", 1003 iterations, 128 bits. */
export const oscryptKey = (password: string) => pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');

/** What safeStorage sealed on macOS, opened with the item's password:
 * AES-128-CBC with an IV of 16 spaces after the prefix "v10"; undefined
 * for anything that does not open. */
export function oscryptDecrypt(password: string, sealed: Buffer): string | undefined {
  if (!isV10(sealed)) return undefined;
  try {
    const decipher = createDecipheriv('aes-128-cbc', oscryptKey(password), Buffer.alloc(16, 0x20));
    return Buffer.concat([decipher.update(sealed.subarray(V10.length)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/** The vault-unlock.json of every instance's user data in appData
 * (`<slug>-desktop`, `<slug>-desktop-<instance>`): directories only, never
 * links, at most MAX_INSTANCES. */
export async function instanceFiles(appData: string, slug: string = APP_SLUG): Promise<string[]> {
  const name = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-desktop(-[a-z0-9][a-z0-9-]{0,31})?$`);
  const entries = await readdir(appData, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && name.test(e.name))
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_INSTANCES)
    .map((n) => join(appData, n, UNLOCK_FILE));
}

export interface MigrationOptions {
  safe: SafeStorage;
  keychain: Keychain;
  /** The running app's code identity (codeIdentity); undefined when it
   * cannot be told. */
  identity(): Promise<string | undefined>;
  /** This instance's vault-unlock.json. */
  own: string;
  /** The vault-unlock.json of every instance whose app shares the item. */
  files(): Promise<string[]>;
  /** The record of the item's maker (KEYCHAIN_RECORD); a migration's lock
   * is beside it. */
  record: string;
  /** false: only record the build when its first use makes the item, never
   * move it (development runs, whose executable is Electron's own). */
  move?: boolean;
  random?: (n: number) => Buffer;
  now?: () => number;
}

/** The step for the unlock store (StoreOptions.prepare). */
export function keychainMigration(o: MigrationOptions): () => Promise<Prepared> {
  const random = o.random ?? randomBytes;
  const now = o.now ?? Date.now;
  const lock = `${o.record}.lock`;
  const use: Prepared = { use: true };
  const safeAvailable = () => {
    try {
      return o.safe.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  const recorded = async (): Promise<string | undefined> => {
    try {
      const v = JSON.parse((await readSmall(o.record)) ?? 'null') as { v?: unknown; identity?: unknown } | null;
      return v?.v === 1 && typeof v.identity === 'string' && IDENTITY.test(v.identity) ? v.identity : undefined;
    } catch {
      return undefined;
    }
  };
  // A record that cannot be written moves the item again at the next
  // launch, which reads the files as this one left them.
  const record = (identity: string) => writeAtomic(o.record, JSON.stringify({ v: 1, identity }) + '\n', random).catch(() => {});
  /** The lock of one migration at a time across the app's instances. */
  const take = async (): Promise<boolean> => {
    for (let tries = 0; tries < 2; tries++) {
      try {
        const handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        await handle.writeFile(`${process.pid}\n`).finally(() => handle.close());
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      }
      try {
        if (now() - (await lstat(lock)).mtimeMs < LOCK_STALE_MS) return false;
        await rm(lock, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
    }
    return false;
  };
  /** The old item back with its password, after removing a new one if
   * safeStorage made it: the files' ciphertexts stay readable. */
  const rollback = async (password: string) => {
    await o.keychain.remove();
    await o.keychain.restore(password);
  };

  const migrate = async (identity: string): Promise<Prepared> => {
    const files = [...new Set([o.own, ...(await o.files().catch(() => []))])];
    const sealed: Array<{ file: string; install: string; sealed: Buffer }> = [];
    for (const file of files) {
      const f = await readUnlockFile(file);
      if (f.install && f.sealed) sealed.push({ file, install: f.install, sealed: f.sealed });
    }
    if (sealed.some((f) => !isV10(f.sealed))) {
      // A format this step does not read: the item stays as it is, and
      // the record keeps this build from being asked again for it.
      await record(identity);
      return use;
    }
    let password: string | undefined;
    const keys = new Map<string, UnlockKeys>();
    if (sealed.length > 0) {
      // The one prompt: macOS asks to let security read the old item.
      const read = await o.keychain.read();
      // Refused: no unlock in this launch, asked again at the next.
      if (read === null) return { use: false };
      password = read;
      for (const f of sealed) {
        const text = oscryptDecrypt(password, f.sealed);
        const secret = text === undefined ? undefined : secretOf(text);
        // A secret sealed under another key was lost before; it stays.
        if (secret) keys.set(f.file, { install: f.install, secret });
      }
    }
    const own = keys.get(o.own);
    const wipe = (but?: UnlockKeys) => keys.forEach((k) => k !== but && k.secret.fill(0));
    /** safeStorage left alone for this launch, with this install's keys. */
    const held = (): Prepared => {
      wipe(own);
      return own ? { use: false, keys: own } : { use: false };
    };
    // The old item goes; safeStorage's next use makes a new one, this
    // build's, with a new key.
    if (!(await o.keychain.remove())) return held();
    const resealed = new Map<string, Buffer>();
    let stale = false;
    try {
      if (!safeAvailable()) throw new Error('no new item');
      // safeStorage that read the old key before this step seals with it
      // for the rest of the launch: something else in the app uses it at
      // its start, so no launch of this build could move the item.
      stale = password !== undefined && oscryptDecrypt(password, o.safe.encryptString('probe')) === 'probe';
      if (stale) throw new Error('old key');
      for (const [file, k] of keys) {
        const text = k.secret.toString('base64url');
        const c = o.safe.encryptString(text);
        if (o.safe.decryptString(c) !== text) throw new Error('round trip');
        resealed.set(file, c);
      }
    } catch {
      if (password !== undefined) await rollback(password);
      // Recorded, this build is not asked again for a move it cannot make.
      if (stale) await record(identity);
      return held();
    }
    // This instance's file first: one that cannot be written puts the old
    // item back.
    const mine = resealed.get(o.own);
    if (own && mine) {
      try {
        await writeUnlockFile(o.own, own.install, mine, random);
      } catch {
        await rollback(password!);
        return held();
      }
    }
    // Another instance's file that cannot be written makes its secret
    // again at its next enrollment.
    for (const [file, c] of resealed) {
      if (file !== o.own) await writeUnlockFile(file, keys.get(file)!.install, c, random).catch(() => {});
    }
    await record(identity);
    wipe();
    return use;
  };

  return async () => {
    const identity = await o.identity();
    if (!identity) return use;
    const exists = await o.keychain.exists();
    if (exists === undefined) return use;
    if (!exists) {
      // safeStorage's first use makes the item: this build's.
      if (safeAvailable()) await record(identity);
      return use;
    }
    if (o.move === false) return use;
    const was = await recorded();
    if (was === identity) return use;
    // An item made before any build was recorded, when this build has a
    // Team ID: a Team ID stays from build to build, so the item trusts it.
    if (was === undefined && identity.startsWith('teamid:')) {
      await record(identity);
      return use;
    }
    // Another instance moves the item now: no unlock in this launch.
    if (!(await take())) return { use: false };
    try {
      if ((await recorded()) === identity) return use;
      return await migrate(identity);
    } finally {
      await rm(lock, { force: true }).catch(() => {});
    }
  };
}
