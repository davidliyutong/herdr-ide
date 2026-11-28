// The variable vault's store on the hub host: named values encrypted one
// by one with AES-256-GCM in vault.json beside the settings file, which
// every hub of the namespace shares (each operation takes the file as it
// is then, and one written meanwhile is not written over), under a master
// key derived from the user's passphrase with
// Argon2id and kept, while the vault is unlocked, as a CryptoKey that
// cannot be exported (crypto.ts); a lock forgets it. Names, descriptions
// and the machines allowed to read a variable are in the clear; each
// value's encryption covers its name, its machines and its inject-only
// flag (adOf), so a file edited to let a machine read a variable no longer
// opens it. The file is the Go hub's, which this hub replaced: it opens
// the files that one wrote (docs/features/30-variable-vault.md).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import * as userfile from '#shared/host/userfile.ts';
import { formatRFC3339, parseRFC3339 } from '#shared/lib/gotime.ts';
import {
  b64,
  derive,
  ecdhEphemeral,
  goJSON,
  goSort,
  isCode,
  kekKey,
  Mutex,
  open,
  seal,
  unb64,
  unwrap,
  validPoint,
  VaultError,
  wrap,
  type KDF,
  type Key,
  type Sealed,
} from './crypto.ts';
import {
  checkHash,
  clash,
  enclaveKEK,
  entryAD,
  helloKEK,
  helloKeyName,
  isDesktop,
  keptEntries,
  MAX_AUTH_ID,
  MAX_DESKTOP_UNLOCKS,
  MAX_SIGNATURE,
  prfKEK,
  UNLOCK_ENCLAVE,
  UNLOCK_HELLO,
  UNLOCK_PRF,
  VALID_UNLOCK_ID,
  validInstall,
  validPRF,
  validText,
  type UnlockEntry,
} from './unlock.ts';

export const FILE_VERSION = 3;
export const MAX_NAME = 128;
export const MAX_VALUE = 64 << 10;
export const MAX_DESCRIPTION = 1 << 10;
export const MAX_MACHINES = 256;
export const MAX_MACHINE_ID = 256;
export const MAX_ENTRIES = 1000;
export const MAX_GROUPS = 128;
export const MAX_PRESETS = 128;
export const MAX_WORKSPACE_LINKS = 256;
export const MAX_PRESETS_PER_WORKSPACE = 32;
export const MAX_LABEL = 128;
export const MAX_WORKSPACE_ID = 128;
export const MAX_EXEMPTIONS = 64;
/** Process names as the kernels keep them (15 bytes on Linux). */
export const MAX_APP = 15;
const MAX_APP_FIELD = 64;
export const MAX_AUTHENTICATORS = 16;
/** In a variable's machines: every machine may read it. */
export const ALL_MACHINES = '*';
export const KIND_WEBAUTHN = 'webauthn';
export const KIND_DESKTOP = 'desktop';
export const MODE_PASSPHRASE = 'passphrase';

/** New passphrases' Argon2id (RFC 9106's second option). */
export const DEFAULT_KDF = { time: 3, memory: 64 << 10, threads: 4 };
/** A file's derivation within these bounds only, so an edited file can
 * neither weaken it nor exhaust memory. */
const KDF_BOUNDS = { salt: 16, maxTime: 10, minMemory: 8 << 10, maxMemory: 1 << 20, maxThreads: 16 };

export const MIN_PASSPHRASE_DAYS = 1;
export const MAX_PASSPHRASE_DAYS = 90;

const GUARD_AD = '#guard';
const CHECK_AD = '#check';
const CHECK_TEXT = 'vault-check';
const PASSPHRASE_AT_AD = '#passphraseAt';
const POLICY_AD = '#policy';
const ZERO_TIME = '0001-01-01T00:00:00Z';

const err = {
  locked: () => new VaultError('vault_locked', 'the vault is locked'),
  notFound: (variable = '') => new VaultError('not_found', 'no such variable', { variable }),
  groupNotFound: () => new VaultError('not_found', 'no such group'),
  presetNotFound: () => new VaultError('not_found', 'no such preset'),
  invalidName: (variable = '') =>
    new VaultError('invalid_name', 'a name is a letter or _ followed by letters, digits and _, at most 128', { variable }),
  invalid: (why: string, variable = '') => new VaultError('invalid', `invalid variable: ${why}`, { variable }),
  passphrase: () => new VaultError('wrong_passphrase', 'wrong passphrase'),
  weak: () => new VaultError('weak_passphrase', 'the passphrase must have at least 8 characters'),
  full: () => new VaultError('full', 'too many variables'),
  tooManyGroups: () => new VaultError('full', 'too many groups'),
  tooManyPresets: () => new VaultError('full', 'too many presets'),
  tooManyLinks: () => new VaultError('full', 'too many workspace links'),
  exists: (variable = '') => new VaultError('exists', 'a variable of that name exists', { variable }),
  groupExists: () => new VaultError('exists', 'a group of that name exists'),
  presetExists: () => new VaultError('exists', 'a preset of that name exists'),
  noPassphrase: () => new VaultError('no_passphrase', 'the vault has no passphrase yet'),
  proof: (why = '') => new VaultError('vault_proof', "the authenticator's unlock did not open or verify", { why }),
  stale: (why = '') => new VaultError('unlock_stale', 'the unlock entry or its authenticator is gone', { why }),
  due: () => new VaultError('passphrase_due', 'the passphrase is due: unlock with it'),
  changed: () => new VaultError('vault_changed', 'the vault was changed elsewhere meanwhile: try again'),
};

export const validName = (n: unknown): n is string => typeof n === 'string' && n.length <= MAX_NAME && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n);
export const validMachineID = (m: unknown): m is string => validText(m, MAX_MACHINE_ID);
export const validLabel = (s: unknown): s is string => validText(s, MAX_LABEL) && s.trim().length > 0 && s.trim() === s;
export const validEntityId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
export const validWorkspaceId = (s: unknown): s is string => validText(s, MAX_WORKSPACE_ID);
const validMachines = (ms: readonly unknown[]) => ms.length <= MAX_MACHINES && ms.every(validMachineID);
const dedupe = (ms: readonly string[]) => [...new Set(ms)];
const runes = (s: string) => [...s].length;

export interface Entry {
  name: string;
  description?: string;
  group?: string;
  machines: string[];
  injectOnly?: boolean;
  value: Sealed | null;
  created: string;
  updated: string;
}

/** A user-defined group for organizing variables in the vault. */
export interface Group {
  id: string;
  name: string;
  description?: string;
  created: string;
  updated: string;
}

/** A named collection of variables and/or groups that can be linked to workspaces. */
export interface Preset {
  id: string;
  name: string;
  description?: string;
  variables: string[];
  groups: string[];
  created: string;
  updated: string;
}

/** Presets linked to a workspace on a machine, injected into new panels. */
export interface WorkspaceLink {
  machine: string;
  workspace: string;
  presets: string[];
  updated: string;
}

/** Result of resolving a workspace's linked presets for panel env injection. */
export interface ResolvedWorkspaceEnv {
  presets: string[];
  env: Record<string, string>;
  names: string[];
  missing: string[];
  locked: boolean;
}

/** Authoritative preset membership and workspace links sealed under the
 * master key (POLICY_AD) so an offline edit to vault.json cannot inject
 * variables by altering groups, presets or links. */
interface Policy {
  entryGroups: Record<string, string>;
  presets: Array<{ id: string; variables: string[]; groups: string[] }>;
  workspaceLinks: Array<{ machine: string; workspace: string; presets: string[] }>;
}

export interface Authenticator {
  id: string;
  kind: string;
  label: string;
  /** A WebAuthn credential's: the page it was added from and proves for,
   * its host name, id, COSE algorithm and SubjectPublicKeyInfo (base64),
   * and the last counter it signed. */
  origin?: string;
  rpId?: string;
  credential?: string;
  alg?: number;
  publicKey?: string;
  signCount?: number;
  created: string;
  lastUsed?: string;
}

export interface Exemption {
  id: string;
  machine: string;
  app: string;
  created: string;
}

/** What guards the vault beside its passphrase, sealed with the key: a
 * file edited without it gains no authenticator or exemption. */
export interface Guard {
  authenticators?: Authenticator[];
  verifyEachAllow?: boolean;
  exempt?: Exemption[];
}

/** A variable as clients see it: everything but the value. */
export interface Info {
  name: string;
  description: string;
  group?: string;
  machines: string[];
  injectOnly: boolean;
  created: string;
  updated: string;
}

export const allows = (i: Info, m: string) => i.machines.includes(ALL_MACHINES) || i.machines.includes(m);

export interface Status {
  mode: string;
  locked: boolean;
  setup?: boolean;
  passphraseSet?: string;
}

/** A change of a variable; undefined members stay as they are. */
export interface Update {
  to?: string;
  description?: string;
  /** Group id; "" removes the variable from its group (ungrouped). */
  group?: string;
  machines?: string[];
  injectOnly?: boolean;
  value?: string;
}

export interface GroupUpdate {
  name?: string;
  description?: string;
}

export interface PresetUpdate {
  name?: string;
  description?: string;
  variables?: string[];
  groups?: string[];
}

/** How long after the passphrase an authenticator may unlock (days), and
 * the auto-lock then (ms; 0: never). */
export interface Window {
  days: number;
  autoLockMs: number;
}

export interface ExportVariable {
  name: string;
  value: string;
  description?: string;
  machines: string[];
  injectOnly?: boolean;
  created: string;
  updated: string;
}

export interface Import {
  name: string;
  value: string;
  description: string;
  machines: string[];
  injectOnly: boolean;
  /** Kept for a new variable unless it is in the future. */
  created: string;
  overwrite: boolean;
}

/** Why name cannot be exempted as an app; undefined when it can. */
export function checkApp(name: unknown): VaultError | undefined {
  if (!validApp(name)) return new VaultError('invalid', `invalid app ${JSON.stringify(name)}`);
  if (Buffer.byteLength(name) > MAX_APP)
    return new VaultError('app_too_long', "an app's name is at most 15 bytes, as the kernels keep a process's name");
  if (GENERIC_APPS.has(name.toLowerCase().replace(/[0-9.]+$/, '')))
    return new VaultError('app_generic', 'a shell or an interpreter runs any script, so it cannot be exempted');
  return undefined;
}
const validApp = (s: unknown): s is string => validText(s, MAX_APP_FIELD) && s.trim() === s;

/** Shells, interpreters and launchers: they run any script. */
const GENERIC_APPS = new Set(
  (
    'sh bash zsh fish dash ksh mksh csh tcsh busybox env sudo doas nohup xargs script login node nodejs deno bun python pypy ' +
    'ruby perl php lua luajit tclsh wish osascript pwsh powershell java uv npx npm pnpm yarn make'
  ).split(' '),
);

/** Why a value or a variable of an import cannot be stored; undefined when
 * it can. */
export function checkImport(im: Import): VaultError | undefined {
  if (!validName(im.name)) return err.invalidName(im.name);
  if (Buffer.byteLength(im.value) > MAX_VALUE) return err.invalid(`value longer than ${MAX_VALUE} bytes`, im.name);
  if (Buffer.byteLength(im.description) > MAX_DESCRIPTION) return err.invalid(`description longer than ${MAX_DESCRIPTION} bytes`, im.name);
  if (!validMachines(im.machines)) return err.invalid('machines', im.name);
  return undefined;
}

/** The additional data of a value: the file's version, the variable's
 * name, machines (sorted) and flag as JSON. */
const adOf = (e: Pick<Entry, 'name' | 'machines' | 'injectOnly'>) =>
  goJSON({ v: FILE_VERSION, name: e.name, machines: goSort(e.machines), injectOnly: !!e.injectOnly });

const info = (e: Entry, forgotten: readonly string[]): Info => ({
  name: e.name,
  description: e.description ?? '',
  ...(e.group ? { group: e.group } : {}),
  machines: e.machines.filter((m) => !forgotten.includes(m)),
  injectOnly: !!e.injectOnly,
  created: e.created,
  updated: e.updated,
});

const sealed = z.object({ nonce: z.string(), ciphertext: z.string() });
const time = z.string().nullish();
const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  created: time,
  updated: time,
});
const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  variables: z.array(z.string()).nullish(),
  groups: z.array(z.string()).nullish(),
  created: time,
  updated: time,
});
const workspaceLinkSchema = z.object({
  machine: z.string(),
  workspace: z.string(),
  presets: z.array(z.string()).nullish(),
  updated: time,
});
const fileSchema = z.object({
  version: z.number().nullish(),
  mode: z.string().nullish(),
  kdf: z.object({ salt: z.string().nullish(), time: z.number().int(), memory: z.number().int(), threads: z.number().int() }).nullish(),
  check: sealed.nullish(),
  passphraseSet: time,
  entries: z
    .array(
      z.object({
        name: z.string().nullish(),
        description: z.string().nullish(),
        group: z.string().nullish(),
        machines: z.array(z.string()).nullish(),
        injectOnly: z.boolean().nullish(),
        value: sealed.nullish(),
        created: time,
        updated: time,
      }),
    )
    .nullish(),
  groups: z.array(groupSchema).nullish(),
  presets: z.array(presetSchema).nullish(),
  workspaceLinks: z.array(workspaceLinkSchema).nullish(),
  policy: sealed.nullish(),
  forgotten: z.array(z.string()).nullish(),
  guard: sealed.nullish(),
  unlock: z.array(z.unknown()).nullish(),
  passphraseAt: sealed.nullish(),
  passphraseHint: z.string().nullish(),
});
const KNOWN = Object.keys(fileSchema.shape);

const policySchema = z.object({
  entryGroups: z.record(z.string(), z.string()).default({}),
  presets: z
    .array(
      z.object({
        id: z.string(),
        variables: z.array(z.string()).default([]),
        groups: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  workspaceLinks: z
    .array(
      z.object({
        machine: z.string(),
        workspace: z.string(),
        presets: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

const guardSchema = z.object({
  authenticators: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        label: z.string().default(''),
        origin: z.string().optional(),
        rpId: z.string().optional(),
        credential: z.string().optional(),
        alg: z.number().int().optional(),
        publicKey: z.string().optional(),
        signCount: z.number().int().optional(),
        created: z.string().default(ZERO_TIME),
        lastUsed: z.string().optional(),
      }),
    )
    .nullish(),
  verifyEachAllow: z.boolean().nullish(),
  exempt: z.array(z.object({ id: z.string(), machine: z.string(), app: z.string(), created: z.string().default(ZERO_TIME) })).nullish(),
});

interface FileState {
  version: number;
  mode: string;
  kdf?: KDF;
  check?: Sealed;
  passphraseSet?: string;
  entries: Entry[];
  groups: Group[];
  presets: Preset[];
  workspaceLinks: WorkspaceLink[];
  policy?: Sealed;
  forgotten: string[];
  guard?: Sealed;
  unlock: UnlockEntry[];
  passphraseAt?: Sealed;
  passphraseHint?: string;
  rest: Record<string, unknown>;
}

export interface StoreOptions {
  /** New passphrases' derivation (tests lower it). */
  kdf?: { time: number; memory: number; threads: number };
  now?: () => Date;
  /** Test hook run right before acquiring the store mutex for an operation. */
  beforeLock?: (op: string) => void | Promise<void>;
  /** Called, with the store's lock held, when the file someone else wrote
   * has another passphrase: the key went, the vault is locked here. */
  lockedElsewhere?: () => void;
}

/** Lock-held verification helpers exposed to authorize callbacks running
 * inside Store's write mutex so policy checks, fresh proof/passphrase
 * verification and commits happen atomically without re-entering #mu. */
export interface StoreVerifier {
  status(): Status;
  guard(): Promise<Guard>;
  strict(): Promise<boolean>;
  recordProof(id: string, at: Date, count?: number): Promise<void>;
  verifyPassphrase(passphrase: string, w?: Window): Promise<void>;
}

/** Why a file does not open: version (of another version), invalid
 * (damaged or edited) or failed (not readable). */
export class OpenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class Store {
  readonly path: string;
  kdf: { time: number; memory: number; threads: number };
  now: () => Date;
  #beforeLock?: (op: string) => void | Promise<void>;
  #lockedElsewhere?: () => void;
  #f: FileState;
  /** The version of the file #f was read from or written as. */
  #sig: userfile.Sig;
  #key: Key | null = null;
  readonly #mu = new Mutex();

  private constructor(path: string, f: FileState, sig: userfile.Sig, o: StoreOptions) {
    this.path = path;
    this.#f = f;
    this.#sig = sig;
    this.kdf = o.kdf ?? DEFAULT_KDF;
    this.now = o.now ?? (() => new Date());
    this.#beforeLock = o.beforeLock;
    this.#lockedElsewhere = o.lockedElsewhere;
  }

  /** Reads the vault at path (none yet: an empty vault without a
   * passphrase). It is locked until an unlock. */
  static open(path: string, o: StoreOptions = {}): Store {
    const { f, sig } = Store.#read(path);
    return new Store(path, f, sig, o);
  }

  /** The vault's file at path as it is now; OpenError when it does not
   * open. */
  static #read(path: string): { f: FileState; sig: userfile.Sig } {
    let data: Buffer | null;
    let sig: userfile.Sig;
    try {
      ({ data, sig } = userfile.read(path));
    } catch (e) {
      throw new OpenError('failed', `${path}: ${(e as Error).message}`);
    }
    const invalid = (why: string) => new OpenError('invalid', `${path}: invalid: ${why}`);
    if (!data)
      return {
        f: {
          version: FILE_VERSION,
          mode: '',
          entries: [],
          groups: [],
          presets: [],
          workspaceLinks: [],
          forgotten: [],
          unlock: [],
          rest: {},
        },
        sig,
      };
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString('utf8'));
    } catch (e) {
      throw invalid((e as Error).message);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('not an object');
    const r = fileSchema.safeParse(raw);
    if (!r.success) throw invalid(r.error.issues.map((i) => i.path.join('.')).join(', '));
    const p = r.data;
    const f: FileState = {
      version: p.version ?? 0,
      mode: p.mode ?? '',
      kdf: p.kdf ? { salt: p.kdf.salt ?? '', time: p.kdf.time, memory: p.kdf.memory, threads: p.kdf.threads } : undefined,
      check: p.check ?? undefined,
      passphraseSet: p.passphraseSet ?? undefined,
      entries: (p.entries ?? []).map((e) => ({
        name: e.name ?? '',
        ...(e.description ? { description: e.description } : {}),
        ...(e.group ? { group: e.group } : {}),
        machines: e.machines ?? [],
        ...(e.injectOnly ? { injectOnly: true } : {}),
        value: e.value ?? null,
        created: e.created ?? ZERO_TIME,
        updated: e.updated ?? ZERO_TIME,
      })),
      groups: (p.groups ?? []).map((g) => ({
        id: g.id,
        name: g.name,
        ...(g.description ? { description: g.description } : {}),
        created: g.created ?? ZERO_TIME,
        updated: g.updated ?? ZERO_TIME,
      })),
      presets: (p.presets ?? []).map((pr) => ({
        id: pr.id,
        name: pr.name,
        ...(pr.description ? { description: pr.description } : {}),
        variables: pr.variables ?? [],
        groups: pr.groups ?? [],
        created: pr.created ?? ZERO_TIME,
        updated: pr.updated ?? ZERO_TIME,
      })),
      workspaceLinks: (p.workspaceLinks ?? []).map((l) => ({
        machine: l.machine,
        workspace: l.workspace,
        presets: l.presets ?? [],
        updated: l.updated ?? ZERO_TIME,
      })),
      policy: p.policy ?? undefined,
      forgotten: p.forgotten ?? [],
      guard: p.guard ?? undefined,
      unlock: [],
      passphraseAt: p.passphraseAt ?? undefined,
      passphraseHint: p.passphraseHint ?? undefined,
      rest: Object.fromEntries(Object.entries(raw).filter(([k]) => !KNOWN.includes(k))),
    };
    if (f.mode === MODE_PASSPHRASE) {
      if (!f.kdf || !f.check) throw invalid("a passphrase vault without its key's parameters");
      const why = kdfProblem(f.kdf);
      if (why) throw invalid(why);
    } else if (f.mode === '') {
      if (f.entries.length || f.groups.length || f.presets.length || f.workspaceLinks.length)
        throw invalid('variables without a passphrase');
    } else throw new OpenError('version', `${path}: the vault's file is of another version: mode ${JSON.stringify(f.mode)}`);
    if (f.version !== FILE_VERSION) {
      if (f.mode !== '')
        throw new OpenError('version', `${path}: the vault's file is of another version ${f.version}, not ${FILE_VERSION}`);
      f.version = FILE_VERSION;
    }
    f.unlock = keptEntries(p.unlock, f.check, MAX_AUTHENTICATORS);
    return { f, sig };
  }

  /** Runs fn with the store's lock held, on the file as it is now
   * (#fresh). */
  #run<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.#mu.run(() => {
      this.#fresh();
      return fn();
    });
  }

  /** Takes the file as it is now when someone else wrote it since this
   * store last read or wrote it (another hub of the namespace shares it);
   * true when it did. The key stays only while the file's passphrase is
   * the one it came from (the same mode, derivation and check): a
   * passphrase changed elsewhere locks the vault here (lockedElsewhere).
   * A file that does
   * not open keeps the state read before, and #commit refuses to write
   * over it. */
  #fresh(): boolean {
    if (userfile.sameSig(userfile.stat(this.path), this.#sig)) return false;
    let next: { f: FileState; sig: userfile.Sig };
    try {
      next = Store.#read(this.path);
    } catch {
      return false;
    }
    const prev = this.#f;
    this.#f = next.f;
    this.#sig = next.sig;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (this.#key && (next.f.mode !== prev.mode || !same(next.f.kdf, prev.kdf) || !same(next.f.check, prev.check))) {
      this.#key = null;
      this.#lockedElsewhere?.();
    }
    return true;
  }

  /** Takes the file as someone else left it (#fresh), with the store's
   * lock held; true when it changed. */
  reload(): Promise<boolean> {
    return this.#mu.run(() => this.#fresh());
  }

  status(): Status {
    const f = this.#f;
    return {
      mode: f.mode,
      locked: f.mode !== '' && !this.#key,
      ...(f.mode === '' ? { setup: true } : {}),
      ...(f.passphraseSet ? { passphraseSet: f.passphraseSet } : {}),
    };
  }

  /** The variables by name, without their values. */
  list(): Info[] {
    return this.#f.entries.map((e) => info(e, this.#f.forgotten)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  get(name: string): Info | undefined {
    const e = this.#find(name);
    return e && info(e, this.#f.forgotten);
  }

  #find(name: string): Entry | undefined {
    return this.#f.entries.find((e) => e.name === name);
  }

  /** The key, or why there is none: a new vault needs its passphrase. */
  #need(): Key {
    if (this.#key) return this.#key;
    throw this.#f.mode === '' ? err.noPassphrase() : err.locked();
  }

  /** A variable's value; when authorize is supplied (page reveal), strict-mode
   * verification runs atomically inside #mu before decryption. */
  async value(name: string, authorize?: (v: StoreVerifier) => Promise<void>): Promise<string> {
    if (authorize) await this.#beforeLock?.('value');
    return this.#run(async () => {
      if (authorize && this.#key && (await this.#strictWith(this.#key))) {
        await authorize(this.#verifier(this.#key));
      }
      const e = this.#find(name);
      if (!e) throw err.notFound();
      if (!this.#key) throw err.locked();
      const b = await open(this.#key, e.value, adOf(e));
      const v = b.toString('utf8');
      b.fill(0);
      return v;
    });
  }

  /** Creates or changes a variable: a new one needs a value, and to
   * renames one (a taken name is refused), in one write. The value is
   * sealed again with the name, machines and flag, which needs the key.
   * When authorize is supplied, widening checks and verification execute
   * atomically inside #mu against the live policy and entry state. */
  async set(name: string, u: Update, authorize?: (v: StoreVerifier, existing: boolean) => Promise<void>): Promise<Info> {
    if (!validName(name)) throw err.invalidName();
    const to = u.to ?? name;
    if (!validName(to)) throw err.invalidName();
    if (u.description !== undefined && Buffer.byteLength(u.description) > MAX_DESCRIPTION)
      throw err.invalid(`description longer than ${MAX_DESCRIPTION} bytes`);
    if (u.value !== undefined && Buffer.byteLength(u.value) > MAX_VALUE) throw err.invalid(`value longer than ${MAX_VALUE} bytes`);
    if (u.machines && !validMachines(u.machines)) throw err.invalid('machines');
    if (u.group !== undefined && u.group !== '' && !validEntityId(u.group)) throw err.invalid('group');
    await this.#beforeLock?.('set');
    return this.#run(async () => {
      let e = this.#find(name);
      if (!e && to !== name) throw err.notFound();
      if (!e && u.value === undefined) throw new VaultError('value_required', 'a new variable needs a value');
      if (!e && this.#f.entries.length >= MAX_ENTRIES) throw err.full();
      if (to !== name && this.#find(to)) throw err.exists();
      if (u.group !== undefined && u.group !== '' && !this.#findGroup(u.group)) throw err.groupNotFound();
      const k = this.#need();
      await this.#verifyPolicy(k);
      if (authorize) {
        const cur = e && info(e, this.#f.forgotten);
        const widensAccess = !!cur && ((u.injectOnly === false && cur.injectOnly) || !!u.machines?.some((m) => !allows(cur, m)));
        const widensLinkedGroup = !!u.group && u.group !== cur?.group && this.groupInLinkedPreset(u.group);
        const widensLinkedVar = (!cur && this.variableInLinkedPreset(name)) || (to !== name && this.variableInLinkedPreset(to));
        if ((widensAccess || widensLinkedGroup || widensLinkedVar) && (await this.#strictWith(k))) {
          await authorize(this.#verifier(k), !!cur);
        }
      }
      await this.#applyForgotten(k);
      e = this.#find(name);
      const plain = u.value !== undefined ? Buffer.from(u.value, 'utf8') : await open(k, e!.value, adOf(e!));
      try {
        const now = formatRFC3339(this.now());
        const n: Entry = e ? structuredClone(e) : { name, machines: [], value: null, created: now, updated: now };
        if (u.description !== undefined) n.description = u.description || undefined;
        if (u.group !== undefined) n.group = u.group || undefined;
        if (u.machines) n.machines = dedupe(u.machines);
        if (u.injectOnly !== undefined) n.injectOnly = u.injectOnly || undefined;
        n.name = to;
        n.updated = now;
        n.value = await seal(k, plain, adOf(n));
        const entries = e ? this.#f.entries.map((x) => (x === e ? n : x)) : [...this.#f.entries, n];
        const presets =
          to !== name && this.#f.presets.some((p) => p.variables.includes(name))
            ? this.#f.presets.map((p) =>
                p.variables.includes(name) ? { ...p, variables: dedupe(p.variables.map((v) => (v === name ? to : v))), updated: now } : p,
              )
            : this.#f.presets;
        const policy = await sealPolicy(k, entries, presets, this.#f.workspaceLinks);
        this.#commit({ entries, presets, policy });
        return info(n, this.#f.forgotten);
      } finally {
        plain.fill(0);
      }
    });
  }

  /** Lets machine m read name without asking. */
  async allow(name: string, m: string): Promise<void> {
    if (!validMachineID(m)) throw err.invalid('machine');
    return this.#run(async () => {
      let e = this.#find(name);
      if (!e) throw err.notFound();
      if (allows(info(e, this.#f.forgotten), m)) return;
      if (!this.#key) throw err.locked();
      const k = this.#key;
      await this.#applyForgotten(k);
      e = this.#find(name)!;
      if (e.machines.length >= MAX_MACHINES) throw err.invalid('machines');
      const plain = await open(k, e.value, adOf(e));
      try {
        const n = { ...e, machines: [...e.machines, m] };
        n.value = await seal(k, plain, adOf(n));
        this.#commit({ entries: this.#f.entries.map((x) => (x === e ? n : x)) });
      } finally {
        plain.fill(0);
      }
    });
  }

  /** Removes machine m from every variable's machines, the guard's
   * exemptions and any workspace links (a removed machine), and returns
   * the names it left. Without the key it is forgotten: no list lets it
   * read, and it leaves them at the next unlock or change. */
  forgetMachine(m: string): Promise<string[]> {
    return this.#run(async () => {
      if (m === '' || m === ALL_MACHINES) return [];
      const names = this.#f.entries.filter((e) => e.machines.includes(m)).map((e) => e.name);
      const linked = this.#f.workspaceLinks.some((l) => l.machine === m);
      // Without the key the guard cannot be read: it may exempt an app there.
      let exempt = !!this.#f.guard;
      if (this.#key) {
        const g = await this.#guardWith(this.#key).catch(() => null);
        if (g) exempt = !!g.exempt?.some((x) => x.machine === m);
      }
      if (!names.length && !exempt && !linked) return [];
      if (!this.#f.forgotten.includes(m)) this.#commit({ forgotten: [...this.#f.forgotten, m] });
      if (this.#key) await this.#applyForgotten(this.#key).catch(() => {});
      return names;
    });
  }

  /** Takes the forgotten machines out of every list, exemption and
   * workspace link and empties the list; a value that does not open loses
   * them too and stays unreadable. A failure changes nothing (the list
   * still applies). */
  async #applyForgotten(k: Key): Promise<void> {
    const gone = this.#f.forgotten;
    if (!gone.length) return;
    let guard = this.#f.guard;
    const g = await this.#guardWith(k).catch(() => null);
    if (g?.exempt?.some((x) => gone.includes(x.machine))) {
      g.exempt = g.exempt.filter((x) => !gone.includes(x.machine));
      guard = await sealGuard(k, g);
    }
    const entries: Entry[] = [];
    for (const e of this.#f.entries) {
      if (!e.machines.some((x) => gone.includes(x))) {
        entries.push(e);
        continue;
      }
      const n = { ...e, machines: e.machines.filter((x) => !gone.includes(x)) };
      const plain = await open(k, e.value, adOf(e)).catch(() => null);
      if (plain) {
        n.value = await seal(k, plain, adOf(n));
        plain.fill(0);
      }
      entries.push(n);
    }
    const linksChanged = this.#f.workspaceLinks.some((l) => gone.includes(l.machine));
    if (linksChanged) await this.#verifyPolicy(k);
    const workspaceLinks = linksChanged ? this.#f.workspaceLinks.filter((l) => !gone.includes(l.machine)) : this.#f.workspaceLinks;
    const policy = linksChanged ? await sealPolicy(k, entries, this.#f.presets, workspaceLinks) : this.#f.policy;
    this.#commit({ entries, workspaceLinks, policy, forgotten: [], guard });
  }

  /** Removes a variable; ungrouped variables need no key (allowing recovery of
   * a corrupt entry), while grouped variables require the key and a verified
   * policy so deleting one never desyncs or blesses #policy. */
  delete(name: string): Promise<void> {
    return this.#run(async () => {
      const cur = this.#find(name);
      if (!cur) throw err.notFound();
      const entries = this.#f.entries.filter((e) => e.name !== name);
      let policy = this.#f.policy;
      if (cur.group) {
        const k = this.#need();
        await this.#verifyPolicy(k);
        policy = await sealPolicy(k, entries, this.#f.presets, this.#f.workspaceLinks);
      }
      this.#commit({ entries, policy });
      if (this.#key) await this.#applyForgotten(this.#key).catch(() => {});
    });
  }

  // ---- groups, presets and workspace links

  #findGroup(id: string): Group | undefined {
    return this.#f.groups.find((g) => g.id === id);
  }

  #findPreset(id: string): Preset | undefined {
    return this.#f.presets.find((p) => p.id === id);
  }

  /** Variable groups sorted by name. */
  listGroups(): Group[] {
    return this.#f.groups.map((g) => ({ ...g })).sort((a, b) => a.name.localeCompare(b.name));
  }

  getGroup(id: string): Group | undefined {
    const g = this.#findGroup(id);
    return g ? { ...g } : undefined;
  }

  /** Creates a variable group (needs an unlocked vault). */
  async createGroup(input: { name: string; description?: string }): Promise<Group> {
    const name = input.name.trim();
    const description = input.description?.trim() ?? '';
    if (!validLabel(name)) throw err.invalid('group name');
    if (Buffer.byteLength(description) > MAX_DESCRIPTION) throw err.invalid(`description longer than ${MAX_DESCRIPTION} bytes`);
    return this.#run(async () => {
      const k = this.#need();
      if (this.#f.groups.length >= MAX_GROUPS) throw err.tooManyGroups();
      if (this.#f.groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw err.groupExists();
      await this.#applyForgotten(k);
      const now = formatRFC3339(this.now());
      const group: Group = {
        id: 'g' + randomBytes(8).toString('hex'),
        name,
        ...(description ? { description } : {}),
        created: now,
        updated: now,
      };
      this.#commit({ groups: [...this.#f.groups, group] });
      return { ...group };
    });
  }

  /** Renames or updates a group's description. */
  async updateGroup(id: string, u: GroupUpdate): Promise<Group> {
    if (!validEntityId(id)) throw err.groupNotFound();
    const name = u.name !== undefined ? u.name.trim() : undefined;
    const description = u.description !== undefined ? u.description.trim() : undefined;
    if (name !== undefined && !validLabel(name)) throw err.invalid('group name');
    if (description !== undefined && Buffer.byteLength(description) > MAX_DESCRIPTION)
      throw err.invalid(`description longer than ${MAX_DESCRIPTION} bytes`);
    return this.#run(async () => {
      const k = this.#need();
      const cur = this.#findGroup(id);
      if (!cur) throw err.groupNotFound();
      if (name !== undefined && this.#f.groups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase()))
        throw err.groupExists();
      await this.#applyForgotten(k);
      const next: Group = {
        ...cur,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? (description ? { description } : { description: undefined }) : {}),
        updated: formatRFC3339(this.now()),
      };
      if (!next.description) delete next.description;
      this.#commit({ groups: this.#f.groups.map((g) => (g.id === id ? next : g)) });
      return { ...next };
    });
  }

  /** Deletes a group: its variables fall back to ungrouped, and presets drop it. */
  async deleteGroup(id: string): Promise<void> {
    if (!validEntityId(id)) throw err.groupNotFound();
    return this.#run(async () => {
      const k = this.#need();
      if (!this.#findGroup(id)) throw err.groupNotFound();
      await this.#verifyPolicy(k);
      await this.#applyForgotten(k);
      const now = formatRFC3339(this.now());
      const groups = this.#f.groups.filter((g) => g.id !== id);
      const entries = this.#f.entries.map((e) => {
        if (e.group !== id) return e;
        const { group: _, ...rest } = e;
        return { ...rest, updated: now };
      });
      const presets = this.#f.presets.map((p) =>
        p.groups.includes(id) ? { ...p, groups: p.groups.filter((g) => g !== id), updated: now } : p,
      );
      const policy = await sealPolicy(k, entries, presets, this.#f.workspaceLinks);
      this.#commit({ groups, entries, presets, policy });
    });
  }

  /** Assigns variables to groupId ("" for ungrouped) in one atomic write. */
  async assignGroup(names: readonly string[], groupId: string, authorize?: (v: StoreVerifier) => Promise<void>): Promise<void> {
    const uniq = dedupe(names);
    if (!uniq.length || uniq.length > MAX_ENTRIES || !uniq.every(validName)) throw err.invalid('names');
    if (groupId !== '' && !validEntityId(groupId)) throw err.invalid('group');
    await this.#beforeLock?.('assignGroup');
    return this.#run(async () => {
      const k = this.#need();
      if (groupId !== '' && !this.#findGroup(groupId)) throw err.groupNotFound();
      for (const n of uniq) if (!this.#find(n)) throw err.notFound(n);
      await this.#verifyPolicy(k);
      if (authorize && groupId !== '' && this.groupInLinkedPreset(groupId)) {
        const addsMember = uniq.some((n) => this.#find(n)?.group !== groupId);
        if (addsMember && (await this.#strictWith(k))) await authorize(this.#verifier(k));
      }
      await this.#applyForgotten(k);
      const set = new Set(uniq);
      const now = formatRFC3339(this.now());
      const entries = this.#f.entries.map((e) => {
        if (!set.has(e.name)) return e;
        const { group: _, ...rest } = e;
        return groupId ? { ...rest, group: groupId, updated: now } : { ...rest, updated: now };
      });
      const policy = await sealPolicy(k, entries, this.#f.presets, this.#f.workspaceLinks);
      this.#commit({ entries, policy });
    });
  }

  /** Presets sorted by name. */
  listPresets(): Preset[] {
    return this.#f.presets
      .map((p) => ({ ...p, variables: [...p.variables], groups: [...p.groups] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getPreset(id: string): Preset | undefined {
    const p = this.#findPreset(id);
    return p ? { ...p, variables: [...p.variables], groups: [...p.groups] } : undefined;
  }

  /** Creates a named preset of variables and/or groups. */
  async createPreset(input: {
    name: string;
    description?: string;
    variables?: readonly string[];
    groups?: readonly string[];
  }): Promise<Preset> {
    const name = input.name.trim();
    const description = input.description?.trim() ?? '';
    const variables = dedupe(input.variables ?? []);
    const groups = dedupe(input.groups ?? []);
    if (!validLabel(name)) throw err.invalid('preset name');
    if (Buffer.byteLength(description) > MAX_DESCRIPTION) throw err.invalid(`description longer than ${MAX_DESCRIPTION} bytes`);
    if (variables.length > MAX_ENTRIES || !variables.every(validName)) throw err.invalid('variables');
    if (groups.length > MAX_GROUPS || !groups.every(validEntityId)) throw err.invalid('groups');
    return this.#run(async () => {
      const k = this.#need();
      if (this.#f.presets.length >= MAX_PRESETS) throw err.tooManyPresets();
      if (this.#f.presets.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw err.presetExists();
      for (const gid of groups) if (!this.#findGroup(gid)) throw err.groupNotFound();
      await this.#verifyPolicy(k);
      await this.#applyForgotten(k);
      const now = formatRFC3339(this.now());
      const preset: Preset = {
        id: 'p' + randomBytes(8).toString('hex'),
        name,
        ...(description ? { description } : {}),
        variables,
        groups,
        created: now,
        updated: now,
      };
      const presets = [...this.#f.presets, preset];
      const policy = await sealPolicy(k, this.#f.entries, presets, this.#f.workspaceLinks);
      this.#commit({ presets, policy });
      return { ...preset, variables: [...preset.variables], groups: [...preset.groups] };
    });
  }

  /** Updates a preset's name, description, variables or groups. */
  async updatePreset(id: string, u: PresetUpdate, authorize?: (v: StoreVerifier) => Promise<void>): Promise<Preset> {
    if (!validEntityId(id)) throw err.presetNotFound();
    const name = u.name !== undefined ? u.name.trim() : undefined;
    const description = u.description !== undefined ? u.description.trim() : undefined;
    const variables = u.variables !== undefined ? dedupe(u.variables) : undefined;
    const groups = u.groups !== undefined ? dedupe(u.groups) : undefined;
    if (name !== undefined && !validLabel(name)) throw err.invalid('preset name');
    if (description !== undefined && Buffer.byteLength(description) > MAX_DESCRIPTION)
      throw err.invalid(`description longer than ${MAX_DESCRIPTION} bytes`);
    if (variables !== undefined && (variables.length > MAX_ENTRIES || !variables.every(validName))) throw err.invalid('variables');
    if (groups !== undefined && (groups.length > MAX_GROUPS || !groups.every(validEntityId))) throw err.invalid('groups');
    await this.#beforeLock?.('updatePreset');
    return this.#run(async () => {
      const k = this.#need();
      const cur = this.#findPreset(id);
      if (!cur) throw err.presetNotFound();
      if (name !== undefined && this.#f.presets.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase()))
        throw err.presetExists();
      if (groups !== undefined) for (const gid of groups) if (!this.#findGroup(gid)) throw err.groupNotFound();
      await this.#verifyPolicy(k);
      if (authorize && this.presetLinked(id)) {
        const widensPreset = !!variables?.some((n) => !cur.variables.includes(n)) || !!groups?.some((g) => !cur.groups.includes(g));
        if (widensPreset && (await this.#strictWith(k))) await authorize(this.#verifier(k));
      }
      await this.#applyForgotten(k);
      const next: Preset = {
        ...cur,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? (description ? { description } : { description: undefined }) : {}),
        ...(variables !== undefined ? { variables } : {}),
        ...(groups !== undefined ? { groups } : {}),
        updated: formatRFC3339(this.now()),
      };
      if (!next.description) delete next.description;
      const presets = this.#f.presets.map((p) => (p.id === id ? next : p));
      const policy = await sealPolicy(k, this.#f.entries, presets, this.#f.workspaceLinks);
      this.#commit({ presets, policy });
      return { ...next, variables: [...next.variables], groups: [...next.groups] };
    });
  }

  /** Deletes a preset and unlinks it from all workspaces. */
  async deletePreset(id: string): Promise<void> {
    if (!validEntityId(id)) throw err.presetNotFound();
    return this.#run(async () => {
      const k = this.#need();
      if (!this.#findPreset(id)) throw err.presetNotFound();
      await this.#verifyPolicy(k);
      await this.#applyForgotten(k);
      const now = formatRFC3339(this.now());
      const presets = this.#f.presets.filter((p) => p.id !== id);
      const workspaceLinks = this.#f.workspaceLinks
        .map((l) => (l.presets.includes(id) ? { ...l, presets: l.presets.filter((x) => x !== id), updated: now } : l))
        .filter((l) => l.presets.length > 0);
      const policy = await sealPolicy(k, this.#f.entries, presets, workspaceLinks);
      this.#commit({ presets, workspaceLinks, policy });
    });
  }

  /** Workspace preset links (excluding forgotten machines). */
  listWorkspaceLinks(machine?: string): WorkspaceLink[] {
    return this.#f.workspaceLinks
      .filter((l) => !this.#f.forgotten.includes(l.machine) && (!machine || l.machine === machine))
      .map((l) => ({ ...l, presets: [...l.presets] }));
  }

  getWorkspaceLink(machine: string, workspace: string): WorkspaceLink | undefined {
    if (this.#f.forgotten.includes(machine)) return undefined;
    const l = this.#f.workspaceLinks.find((x) => x.machine === machine && x.workspace === workspace);
    return l ? { ...l, presets: [...l.presets] } : undefined;
  }

  /** Whether presetId is linked to at least one workspace. */
  presetLinked(presetId: string): boolean {
    return this.#f.workspaceLinks.some((l) => !this.#f.forgotten.includes(l.machine) && l.presets.includes(presetId));
  }

  /** Whether groupId belongs to a preset linked to at least one workspace. */
  groupInLinkedPreset(groupId: string): boolean {
    if (!groupId) return false;
    return this.#f.presets.some((p) => p.groups.includes(groupId) && this.presetLinked(p.id));
  }

  /** Whether variable name is directly referenced by a preset linked to at least one workspace. */
  variableInLinkedPreset(name: string): boolean {
    if (!name) return false;
    return this.#f.presets.some((p) => p.variables.includes(name) && this.presetLinked(p.id));
  }

  /** Verifies that the master-key-authenticated #policy matches the cleartext
   * entry groups, presets and workspace links on disk; fails closed as corrupt
   * on any mismatch or missing seal so mutations and rekeys never bless offline
   * tampering. */
  async #verifyPolicy(k: Key): Promise<Policy | undefined> {
    const expected = canonicalPolicy(this.#f.entries, this.#f.presets, this.#f.workspaceLinks);
    if (!this.#f.policy) {
      if (expected) throw new VaultError('corrupt', 'a value cannot be decrypted');
      return undefined;
    }
    const policy = await openPolicy(k, this.#f.policy);
    if (!expected || JSON.stringify(policy) !== JSON.stringify(expected)) throw new VaultError('corrupt', 'a value cannot be decrypted');
    return policy;
  }

  /** Links presetIds (empty removes the link) to a workspace on machine. */
  async setWorkspacePresets(
    machine: string,
    workspace: string,
    presetIds: readonly string[],
    authorize?: (v: StoreVerifier) => Promise<void>,
  ): Promise<WorkspaceLink | null> {
    if (!validMachineID(machine) || machine === ALL_MACHINES) throw err.invalid('machine');
    if (!validWorkspaceId(workspace)) throw err.invalid('workspace');
    const presets = dedupe(presetIds);
    if (presets.length > MAX_PRESETS_PER_WORKSPACE || !presets.every(validEntityId)) throw err.invalid('presets');
    await this.#beforeLock?.('setWorkspacePresets');
    return this.#run(async () => {
      const k = this.#need();
      for (const pid of presets) if (!this.#findPreset(pid)) throw err.presetNotFound();
      await this.#verifyPolicy(k);
      if (authorize) {
        const cur = this.getWorkspaceLink(machine, workspace);
        const addsPreset = presets.some((pid) => !cur?.presets.includes(pid));
        if (addsPreset && (await this.#strictWith(k))) await authorize(this.#verifier(k));
      }
      await this.#applyForgotten(k);
      const rest = this.#f.workspaceLinks.filter((l) => !(l.machine === machine && l.workspace === workspace));
      if (presets.length > 0 && rest.length >= MAX_WORKSPACE_LINKS) throw err.tooManyLinks();
      const link: WorkspaceLink | null = presets.length ? { machine, workspace, presets, updated: formatRFC3339(this.now()) } : null;
      const workspaceLinks = link ? [...rest, link] : rest;
      const policy = await sealPolicy(k, this.#f.entries, this.#f.presets, workspaceLinks);
      this.#commit({ workspaceLinks, policy });
      return link ? { ...link, presets: [...link.presets] } : null;
    });
  }

  /** Resolves all variables from presets linked to (machine, workspace).
   * Uses only the master-key-authenticated policy while unlocked so disk
   * edits to vault.json cannot inject variables. Returns locked: true when
   * presets are linked but the vault is locked. Missing variables are
   * reported without failing resolution of the remaining variables. */
  resolveWorkspaceEnv(machine: string, workspace: string): Promise<ResolvedWorkspaceEnv> {
    return this.#run(async () => {
      const empty: ResolvedWorkspaceEnv = { presets: [], env: {}, names: [], missing: [], locked: false };
      if (!machine || !workspace || this.#f.forgotten.includes(machine)) return empty;
      if (!this.#key) {
        const clear = this.#f.workspaceLinks.find((l) => l.machine === machine && l.workspace === workspace);
        if (!clear?.presets.length) return empty;
        return { presets: [...clear.presets], env: {}, names: [], missing: [], locked: true };
      }
      const policy = await this.#verifyPolicy(this.#key);
      if (!policy) return empty;
      const link = policy.workspaceLinks.find((l) => l.machine === machine && l.workspace === workspace);
      if (!link?.presets.length) return empty;
      const wanted = new Set<string>();
      for (const pid of link.presets) {
        const p = policy.presets.find((x) => x.id === pid);
        if (!p) continue;
        for (const gid of p.groups) {
          const members = Object.entries(policy.entryGroups)
            .filter(([, g]) => g === gid)
            .map(([n]) => n)
            .sort();
          for (const n of members) wanted.add(n);
        }
        for (const n of p.variables) wanted.add(n);
      }
      const env: Record<string, string> = {};
      const names: string[] = [];
      const missing: string[] = [];
      for (const n of wanted) {
        const e = this.#find(n);
        if (!e) {
          missing.push(n);
          continue;
        }
        const b = await open(this.#key, e.value, adOf(e));
        env[n] = b.toString('utf8');
        b.fill(0);
        names.push(n);
      }
      return { presets: [...link.presets], env, names, missing, locked: false };
    });
  }

  async #guardWith(k: Key): Promise<Guard> {
    if (!this.#f.guard) return {};
    const b = await open(k, this.#f.guard, GUARD_AD);
    try {
      const r = guardSchema.safeParse(JSON.parse(b.toString('utf8')));
      if (!r.success) throw new Error();
      return dropNulls(r.data) as Guard;
    } catch {
      throw new VaultError('corrupt', 'a value cannot be decrypted');
    }
  }

  async #strictWith(k: Key): Promise<boolean> {
    try {
      return !!(await this.#guardWith(k)).verifyEachAllow;
    } catch (e) {
      return !isCode(e, 'vault_locked') && !isCode(e, 'no_passphrase');
    }
  }

  #verifier(k: Key): StoreVerifier {
    return {
      status: () => this.status(),
      guard: () => this.#guardWith(k),
      strict: () => this.#strictWith(k),
      recordProof: async (id, at, count) => {
        await this.#recordProof(k, await this.#guardWith(k), id, at, count);
      },
      verifyPassphrase: async (passphrase, w) => {
        await this.#checked(passphrase);
        if (w && this.#key) await this.#passphraseChecked(this.#key, w);
      },
    };
  }

  /** Runs an Allow authorization (e.g. answering a pending MCP request) inside
   * #mu so strict-mode toggles or locks cannot interleave with verification. */
  async authorizeAllow<T>(fn: (v: StoreVerifier) => Promise<T>): Promise<T> {
    await this.#beforeLock?.('authorizeAllow');
    return this.#run(async () => {
      if (!this.#key) {
        const closed = () => Promise.reject(this.#f.mode === '' ? err.noPassphrase() : err.locked());
        return fn({
          status: () => this.status(),
          guard: closed,
          strict: async () => false,
          recordProof: closed,
          verifyPassphrase: closed,
        });
      }
      return fn(this.#verifier(this.#key));
    });
  }

  /** What guards the vault; vault_locked while it is locked. */
  guard(): Promise<Guard> {
    return this.#run(() => this.#guardWith(this.#need()));
  }

  /** The user's change of the guard: fn changes it (its error leaves it as
   * it was) and it is written, with the unlock entries of authenticators
   * fn removed. Exemptions of forgotten machines go first. */
  async updateGuard(fn: (g: Guard) => void, authorize?: (v: StoreVerifier, strict: boolean) => Promise<void>): Promise<void> {
    if (authorize) await this.#beforeLock?.('updateGuard');
    return this.#run(async () => {
      const k = this.#need();
      if (authorize) await authorize(this.#verifier(k), await this.#strictWith(k));
      await this.#guardWith(k);
      await this.#applyForgotten(k);
      const g = await this.#guardWith(k);
      fn(g);
      if ((g.authenticators?.length ?? 0) > MAX_AUTHENTICATORS)
        throw new VaultError('invalid', `invalid: at most ${MAX_AUTHENTICATORS} authenticators`);
      if ((g.exempt?.length ?? 0) > MAX_EXEMPTIONS) throw new VaultError('invalid', `invalid: at most ${MAX_EXEMPTIONS} exemptions`);
      for (const x of g.exempt ?? [])
        if (!validApp(x.app) || !validMachineID(x.machine) || x.machine === ALL_MACHINES)
          throw new VaultError('invalid', `invalid: exemption ${JSON.stringify(x.app)} on ${JSON.stringify(x.machine)}`);
      const guard = await sealGuard(k, g);
      this.#commit({ guard, unlock: this.#f.unlock.filter((e) => ownerOf(g, e) >= 0) });
    });
  }

  /** Notes authenticator id's proof at at, with the counter it signed. */
  recordProof(id: string, at: Date, count?: number): Promise<void> {
    return this.#run(async () => {
      const k = this.#need();
      await this.#recordProof(k, await this.#guardWith(k), id, at, count);
    });
  }

  async #recordProof(k: Key, g: Guard, id: string, at: Date, count?: number): Promise<void> {
    const a = g.authenticators?.find((x) => x.id === id);
    if (!a) throw err.notFound();
    a.lastUsed = formatRFC3339(at);
    if (count !== undefined) a.signCount = count || undefined;
    this.#commit({ guard: await sealGuard(k, g) });
  }

  /** Whether app's requests on machine m read without asking: the guard
   * names them, the machine was not forgotten, the vault is unlocked. */
  async exempt(m: string, app: string): Promise<boolean> {
    if (!m || !app) return false;
    return this.#run(async () => {
      if (!this.#key || this.#f.forgotten.includes(m)) return false;
      const g = await this.#guardWith(this.#key).catch(() => null);
      return !!g?.exempt?.some((x) => x.machine === m && x.app === app);
    });
  }

  /** Forgets the key until an unlock. */
  lock(): Promise<void> {
    return this.#run(() => {
      this.#key = null;
    });
  }

  /** Takes the key of the passphrase (an unlocked vault only checks it),
   * and starts the window w of unlocks without it. */
  unlock(passphrase: string, w: Window): Promise<void> {
    return this.#run(async () => {
      const k = await this.#checked(passphrase);
      this.#key ??= k;
      await this.#passphraseChecked(this.#key, w);
      await this.#applyForgotten(this.#key).catch(() => {});
    });
  }

  /** Checks a passphrase; with w, of an unlocked vault, it also starts the
   * window w. */
  verify(passphrase: string, w?: Window): Promise<void> {
    return this.#run(async () => {
      await this.#checked(passphrase);
      if (w && this.#key) await this.#passphraseChecked(this.#key, w);
    });
  }

  /** The key of passphrase when it opens the check. */
  async #checked(passphrase: string, extractable = false): Promise<Key> {
    if (this.#f.mode !== MODE_PASSPHRASE) throw err.noPassphrase();
    const k = await derive(passphrase, this.#f.kdf!, extractable);
    await this.#checkKey(k);
    return k;
  }

  async #checkKey(k: Key): Promise<void> {
    const b = await open(k, this.#f.check, CHECK_AD).catch(() => null);
    const want = Buffer.from(CHECK_TEXT);
    if (!b || b.length !== want.length || !timingSafeEqual(b, want)) throw err.passphrase();
  }

  /** A new vault's first passphrase (at least 8 characters), which unlocks
   * it and starts the window w. */
  async setPassphrase(passphrase: string, w: Window): Promise<void> {
    if (runes(passphrase) < 8) throw err.weak();
    return this.#run(async () => {
      if (this.#f.mode !== '') throw new VaultError('has_passphrase', 'the vault has a passphrase; change it with the current one');
      await this.#rekey(null, passphrase, w);
    });
  }

  /** Replaces the passphrase after checking the current one: every value
   * is sealed again under the new key, which then unlocks the vault. */
  async changePassphrase(old: string, passphrase: string, w: Window): Promise<void> {
    if (runes(passphrase) < 8) throw err.weak();
    return this.#run(async () => this.#rekey(await this.#checked(old), passphrase, w));
  }

  /** Seals every value, the check and the window under the key of
   * passphrase with a new salt; only once all is written is it installed.
   * A new passphrase ends every authenticator, unlock entry and exemption:
   * whoever knew the old one may have added theirs. The rule stays. */
  async #rekey(cur: Key | null, passphrase: string, w: Window): Promise<void> {
    const kdf: KDF = { salt: b64(randomBytes(KDF_BOUNDS.salt)), ...this.kdf };
    const nk = await derive(passphrase, kdf);
    const entries: Entry[] = [];
    for (const e of this.#f.entries) {
      if (!cur) throw new VaultError('corrupt', 'a value cannot be decrypted');
      const plain = await open(cur, e.value, adOf(e));
      entries.push({ ...e, value: await seal(nk, plain, adOf(e)) });
      plain.fill(0);
    }
    let guard: Sealed | undefined;
    if (this.#f.guard) {
      if (!cur) throw new VaultError('corrupt', 'a value cannot be decrypted');
      if ((await this.#guardWith(cur)).verifyEachAllow) guard = await sealGuard(nk, { verifyEachAllow: true });
    }
    let policy: Sealed | undefined;
    if (this.#f.policy || canonicalPolicy(entries, this.#f.presets, this.#f.workspaceLinks)) {
      if (!cur) throw new VaultError('corrupt', 'a value cannot be decrypted');
      await this.#verifyPolicy(cur);
      policy = await sealPolicy(nk, entries, this.#f.presets, this.#f.workspaceLinks);
    }
    const check = await seal(nk, Buffer.from(CHECK_TEXT), CHECK_AD);
    const win = await this.#sealWindow(nk, w);
    this.#commit({
      entries,
      version: FILE_VERSION,
      mode: MODE_PASSPHRASE,
      kdf,
      check,
      passphraseSet: formatRFC3339(this.now()),
      guard,
      policy,
      unlock: [],
      passphraseAt: win.at,
      passphraseHint: win.hint,
    });
    this.#key = nk;
    await this.#applyForgotten(nk).catch(() => {});
  }

  // The passphrase's window: an authenticator unlocks only within some days
  // of the last time the passphrase was checked with the key. When, and the
  // window then (days and auto-lock), is sealed under the key, so a program
  // that can write the file can only put back an older one; its end is in
  // the clear too (passphraseHint), for the UI only.

  async #sealWindow(k: Key, w: Window): Promise<{ at: Sealed; hint: string }> {
    const at = new Date(Math.floor(this.now().getTime() / 1000) * 1000);
    const days = clampDays(w.days);
    const p = { at: formatRFC3339(at), days, autoLock: Math.floor(Math.max(w.autoLockMs, 0) / 1000) };
    return {
      at: await seal(k, Buffer.from(JSON.stringify(p)), PASSPHRASE_AT_AD),
      hint: formatRFC3339(new Date(at.getTime() + days * DAY)),
    };
  }

  /** Starts the window w; a write that fails leaves the previous one. */
  async #passphraseChecked(k: Key, w: Window): Promise<void> {
    try {
      const win = await this.#sealWindow(k, w);
      this.#commit({ passphraseAt: win.at, passphraseHint: win.hint });
    } catch {
      // the previous window stays
    }
  }

  /** The sealed window, when an unlock by an authenticator now is within
   * it (the days the lesser of days and those sealed); passphrase_due
   * otherwise. */
  async #window(k: Key, days: number): Promise<Window> {
    const b = this.#f.passphraseAt && (await open(k, this.#f.passphraseAt, PASSPHRASE_AT_AD).catch(() => null));
    if (!b) throw err.due();
    let p: { at?: unknown; days?: unknown; autoLock?: unknown };
    try {
      p = JSON.parse(b.toString('utf8'));
    } catch {
      throw err.due();
    } finally {
      b.fill(0);
    }
    const at = typeof p.at === 'string' ? parseRFC3339(p.at) : null;
    if (!at || typeof p.days !== 'number' || p.days < MIN_PASSPHRASE_DAYS || typeof p.autoLock !== 'number' || p.autoLock < 0)
      throw err.due();
    const now = this.now().getTime();
    const limit = Math.min(clampDays(days), p.days);
    if (at.getTime() <= new Date(ZERO_TIME).getTime() || now < at.getTime() || now >= at.getTime() + limit * DAY) throw err.due();
    return { days: p.days, autoLockMs: p.autoLock * 1000 };
  }

  /** When the window ends, by its hint in the clear: for what the UI
   * offers, never for what is allowed. */
  passphraseDue(): Date | null {
    return this.#f.passphraseHint ? parseRFC3339(this.#f.passphraseHint) : null;
  }

  /** Ends the window: the next unlock needs the passphrase. No key needed. */
  forgetPassphrase(): Promise<void> {
    return this.#run(() => {
      if (!this.#f.passphraseAt && !this.#f.passphraseHint) return;
      this.#commit({ passphraseAt: undefined, passphraseHint: undefined });
    });
  }

  /** Copies of the unlock entries; no key needed. */
  unlockEntries(): UnlockEntry[] {
    return structuredClone(this.#f.unlock);
  }

  /** Adds the enclave entry of the desktop authenticator for install: an
   * ephemeral P-256 key's ECDH secret with sePub and the shell's secret make
   * the KEK, and the ephemeral private key is dropped. An entry of the same
   * install is replaced. The key wrapped is the passphrase's, which the
   * request that adds an authenticator carries: the vault's own key cannot
   * be exported. */
  async addEnclave(
    authenticator: string,
    install: string,
    blob: Uint8Array,
    sePub: Uint8Array,
    shellSecret: Uint8Array,
    passphrase: string,
  ): Promise<UnlockEntry> {
    if (!validInstall(install) || blob.length < 1 || blob.length > 4 << 10 || !validPoint(sePub) || shellSecret.length !== 32)
      throw new VaultError('invalid', 'invalid: enclave unlock');
    const eph = await ecdhEphemeral(sePub);
    if (!eph) throw new VaultError('invalid', 'invalid: enclave key');
    const kek = enclaveKEK(eph.z, shellSecret, eph.ephPub, sePub);
    eph.z.fill(0);
    const enclave = { install, blob: b64(blob), sePub: b64(sePub), ephPub: b64(eph.ephPub) };
    return this.#addUnlock({ authenticator, kind: UNLOCK_ENCLAVE, enclave }, kek, passphrase);
  }

  /** Adds the hello entry of the desktop authenticator for install, from
   * its Windows Hello key's signature of challenge. No signature is
   * verified with publicKey: it tells the key apart and is bound into the
   * wrap's additional data; the key signs deterministically, so only its
   * signature opens the entry again. */
  addHello(
    authenticator: string,
    install: string,
    keyName: string,
    challenge: Uint8Array,
    publicKey: Uint8Array,
    signature: Uint8Array,
    shellSecret: Uint8Array,
    passphrase: string,
  ): Promise<UnlockEntry> {
    if (
      !validInstall(install) ||
      keyName !== helloKeyName(install) ||
      challenge.length !== 32 ||
      publicKey.length < 1 ||
      publicKey.length > 2 << 10 ||
      signature.length < 1 ||
      signature.length > MAX_SIGNATURE ||
      shellSecret.length !== 32
    )
      throw new VaultError('invalid', 'invalid: hello unlock');
    const hello = { install, keyName, challenge: b64(challenge), publicKey: b64(publicKey) };
    return this.#addUnlock({ authenticator, kind: UNLOCK_HELLO, hello }, helloKEK(signature, shellSecret, challenge), passphrase);
  }

  /** Adds the prf entry of webauthn authenticator, from its PRF output for
   * salt. An entry of the same credential is replaced. */
  addPRF(
    authenticator: string,
    origin: string,
    rpId: string,
    credential: Uint8Array,
    salt: Uint8Array,
    output: Uint8Array,
    passphrase: string,
  ): Promise<UnlockEntry> {
    const prf = { origin, rpId, credential: b64(credential), salt: b64(salt) };
    if (!validPRF(prf) || output.length !== 32) throw new VaultError('invalid', 'invalid: prf unlock');
    return this.#addUnlock({ authenticator, kind: UNLOCK_PRF, prf }, prfKEK(output, salt), passphrase);
  }

  /** Wraps the key under kekRaw (wiped) as e and writes it: e's
   * authenticator must be in the guard (not_found), an entry of the same
   * install or credential is replaced, the bounds are kept. */
  async #addUnlock(e: Omit<UnlockEntry, 'id' | 'created' | 'check' | 'wrapped'>, kekRaw: Buffer, passphrase: string): Promise<UnlockEntry> {
    try {
      if (!validText(e.authenticator, MAX_AUTH_ID)) throw new VaultError('invalid', 'invalid: authenticator');
      return await this.#run(async () => {
        const k = this.#need();
        const entry: UnlockEntry = {
          id: randomBytes(16).toString('base64url'),
          ...e,
          created: formatRFC3339(this.now()),
          check: checkHash(this.#f.check),
          wrapped: null,
        };
        if (ownerOf(await this.#guardWith(k), entry) < 0)
          throw new VaultError('not_found', `no such variable: authenticator ${JSON.stringify(e.authenticator)}`);
        const exportable = await this.#checked(passphrase, true);
        entry.wrapped = await wrap(await kekKey(kekRaw), exportable, entryAD(entry, FILE_VERSION));
        const list = this.#f.unlock.filter((o) => !clash(o, entry));
        if (list.filter((o) => isDesktop(o) === isDesktop(entry)).length >= (isDesktop(entry) ? MAX_DESKTOP_UNLOCKS : MAX_AUTHENTICATORS))
          throw new VaultError('invalid', 'invalid: too many unlock entries');
        this.#commit({ unlock: [...list, entry] });
        return structuredClone(entry);
      });
    } finally {
      kekRaw.fill(0);
    }
  }

  /** Removes an unlock entry; no key needed. */
  removeUnlock(id: string): Promise<void> {
    return this.#run(() => {
      if (!VALID_UNLOCK_ID.test(id) || !this.#f.unlock.some((e) => e.id === id)) throw new VaultError('not_found', 'no such unlock entry');
      this.#commit({ unlock: this.#f.unlock.filter((e) => e.id !== id) });
    });
  }

  /** Unlocks with unlock entry id's KEK (wiped), in this order: the entry
   * is there (unlock_stale); the key unwraps (vault_proof, why "wrap") and
   * opens the check (vault_proof); the guard it opens holds the entry's
   * authenticator (else the entry goes: unlock_stale, why "orphan");
   * verify accepts the authenticator's proof (vault_proof); the passphrase
   * was checked less than min(days, the days sealed then) ago
   * (passphrase_due). Only then is the key installed and the use recorded.
   * It returns the window sealed with the passphrase. */
  async unlockWith(id: string, kekRaw: Buffer, days: number, verify?: (a: Authenticator) => Promise<number | undefined>): Promise<Window> {
    try {
      return await this.#run(async () => {
        if (this.#f.mode !== MODE_PASSPHRASE) throw err.noPassphrase();
        const e = this.#f.unlock.find((x) => x.id === id);
        if (!VALID_UNLOCK_ID.test(id) || !e) throw err.stale();
        if (kekRaw.length !== 32 || !e.wrapped) throw err.proof();
        const cand = await unwrap(await kekKey(kekRaw), e.wrapped, entryAD(e, FILE_VERSION));
        if (!cand) throw err.proof('wrap');
        await this.#checkKey(cand).catch(() => {
          throw err.proof();
        });
        const g = await this.#guardWith(cand).catch(() => {
          throw err.proof();
        });
        const a = g.authenticators?.[ownerOf(g, e)];
        if (!a) {
          this.#commit({ unlock: this.#f.unlock.filter((x) => x.id !== id) });
          throw err.stale('orphan');
        }
        let count: number | undefined;
        if (verify)
          count = await verify(a).catch((x: unknown) => {
            throw err.proof(x instanceof Error ? x.message : '');
          });
        const w = await this.#window(cand, days);
        await this.#recordProof(cand, g, a.id, this.now(), count);
        this.#key ??= cand;
        await this.#applyForgotten(this.#key).catch(() => {});
        return w;
      });
    } finally {
      kekRaw.fill(0);
    }
  }

  /** The variables of names with their values and their machines without
   * those forgotten; a name not there or a value that does not open fails
   * it all. */
  exportVariables(names: readonly string[]): Promise<ExportVariable[]> {
    return this.#run(async () => {
      const k = this.#need();
      const out: ExportVariable[] = [];
      for (const n of names) {
        const e = this.#find(n);
        if (!e) throw err.notFound(n);
        const b = await open(k, e.value, adOf(e)).catch(() => {
          throw new VaultError('corrupt', `${n}: a value cannot be decrypted`, { variable: n });
        });
        const i = info(e, this.#f.forgotten);
        out.push({
          name: i.name,
          value: b.toString('utf8'),
          ...(i.description ? { description: i.description } : {}),
          machines: i.machines,
          ...(i.injectOnly ? { injectOnly: true } : {}),
          created: i.created,
          updated: i.updated,
        });
        b.fill(0);
      }
      return out;
    });
  }

  /** Adds or replaces the variables of list in one write: a name taken
   * without overwrite, an invalid variable or the bound refuses it all. */
  async importVariables(list: readonly Import[]): Promise<void> {
    const seen = new Set<string>();
    for (const im of list) {
      const bad = checkImport(im);
      if (bad) throw bad;
      if (seen.has(im.name)) throw err.exists(im.name);
      seen.add(im.name);
    }
    return this.#run(async () => {
      const k = this.#need();
      await this.#verifyPolicy(k);
      await this.#applyForgotten(k);
      const entries = [...this.#f.entries];
      const nowDate = this.now();
      const now = formatRFC3339(nowDate);
      for (const im of list) {
        const i = entries.findIndex((e) => e.name === im.name);
        if (i >= 0 && !im.overwrite) throw err.exists(im.name);
        if (i < 0 && entries.length >= MAX_ENTRIES) throw err.full();
        const c = parseRFC3339(im.created);
        const created =
          c && c.getTime() > new Date(ZERO_TIME).getTime() && c <= nowDate
            ? im.created.endsWith('Z')
              ? im.created
              : formatRFC3339(c)
            : now;
        const n: Entry = {
          name: im.name,
          ...(im.description ? { description: im.description } : {}),
          ...(i >= 0 && entries[i].group ? { group: entries[i].group } : {}),
          machines: dedupe(im.machines),
          ...(im.injectOnly ? { injectOnly: true } : {}),
          value: null,
          created: i >= 0 ? entries[i].created : created,
          updated: now,
        };
        n.value = await seal(k, Buffer.from(im.value, 'utf8'), adOf(n));
        if (i >= 0) entries[i] = n;
        else entries.push(n);
      }
      const policy = this.#f.policy ? await sealPolicy(k, entries, this.#f.presets, this.#f.workspaceLinks) : undefined;
      this.#commit({ entries, policy });
    });
  }

  /** Applies a change of the file's state and writes it; a write that
   * fails leaves the state as it was and throws. A file someone else wrote
   * since the operation took it (#run) is not written over: vault_changed,
   * and the next operation takes it. */
  #commit(change: Partial<FileState>): void {
    if (!userfile.sameSig(userfile.stat(this.path), this.#sig)) throw err.changed();
    const prev = this.#f;
    this.#f = { ...prev, ...change };
    try {
      this.#save();
    } catch (e) {
      this.#f = prev;
      throw new VaultError('failed', `writing the vault: ${(e as Error).message}`);
    }
  }

  #save(): void {
    const f = this.#f;
    const out: Record<string, unknown> = { ...f.rest, version: f.version, entries: f.entries };
    if (f.mode) out.mode = f.mode;
    if (f.kdf) out.kdf = f.kdf;
    if (f.check) out.check = f.check;
    if (f.passphraseSet) out.passphraseSet = f.passphraseSet;
    if (f.groups.length) out.groups = f.groups;
    if (f.presets.length) out.presets = f.presets;
    if (f.workspaceLinks.length) out.workspaceLinks = f.workspaceLinks;
    if (f.policy) out.policy = f.policy;
    if (f.forgotten.length) out.forgotten = f.forgotten;
    if (f.guard) out.guard = f.guard;
    if (f.unlock.length) out.unlock = f.unlock;
    if (f.passphraseAt) out.passphraseAt = f.passphraseAt;
    if (f.passphraseHint) out.passphraseHint = f.passphraseHint;
    const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
    this.#sig = userfile.write(this.path, JSON.stringify(sorted, null, 2) + '\n');
  }
}

const DAY = 24 * 3600 * 1000;
const clampDays = (d: number) => Math.min(Math.max(Math.trunc(d) || 0, MIN_PASSPHRASE_DAYS), MAX_PASSPHRASE_DAYS);

export function kdfProblem(k: KDF): string | undefined {
  if (unb64(k.salt).length !== KDF_BOUNDS.salt) return `kdf salt of ${unb64(k.salt).length} bytes`;
  if (k.time < 1 || k.time > KDF_BOUNDS.maxTime) return `kdf time ${k.time}`;
  if (k.memory < KDF_BOUNDS.minMemory || k.memory > KDF_BOUNDS.maxMemory) return `kdf memory ${k.memory} KiB`;
  if (k.threads < 1 || k.threads > KDF_BOUNDS.maxThreads) return `kdf threads ${k.threads}`;
  return undefined;
}

/** The guard sealed under k; none when it holds nothing. */
async function sealGuard(k: Key, g: Guard): Promise<Sealed | undefined> {
  if (!g.authenticators?.length && !g.verifyEachAllow && !g.exempt?.length) return undefined;
  const plain: Guard = {
    ...(g.authenticators?.length ? { authenticators: g.authenticators } : {}),
    ...(g.verifyEachAllow ? { verifyEachAllow: true } : {}),
    ...(g.exempt?.length ? { exempt: g.exempt } : {}),
  };
  return seal(k, Buffer.from(JSON.stringify(plain)), GUARD_AD);
}

/** Canonical form of the policy fields kept in vault.json; undefined when empty. */
function canonicalPolicy(
  entries: readonly Entry[],
  presets: readonly Preset[],
  workspaceLinks: readonly WorkspaceLink[],
): Policy | undefined {
  const entryGroups: Record<string, string> = {};
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (e.group) entryGroups[e.name] = e.group;
  }
  const ps = [...presets]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => ({ id: p.id, variables: [...p.variables], groups: [...p.groups] }));
  const ls = [...workspaceLinks]
    .sort((a, b) =>
      a.machine !== b.machine ? (a.machine < b.machine ? -1 : 1) : a.workspace < b.workspace ? -1 : a.workspace > b.workspace ? 1 : 0,
    )
    .map((l) => ({ machine: l.machine, workspace: l.workspace, presets: [...l.presets] }));
  if (!Object.keys(entryGroups).length && !ps.length && !ls.length) return undefined;
  return { entryGroups, presets: ps, workspaceLinks: ls };
}

/** The authoritative preset membership and workspace links sealed under k;
 * none when there are no grouped entries, presets or workspace links. */
async function sealPolicy(
  k: Key,
  entries: readonly Entry[],
  presets: readonly Preset[],
  workspaceLinks: readonly WorkspaceLink[],
): Promise<Sealed | undefined> {
  const pol = canonicalPolicy(entries, presets, workspaceLinks);
  if (!pol) return undefined;
  const plain = Buffer.from(JSON.stringify(pol));
  try {
    return await seal(k, plain, POLICY_AD);
  } finally {
    plain.fill(0);
  }
}

async function openPolicy(k: Key, s: Sealed): Promise<Policy> {
  const b = await open(k, s, POLICY_AD);
  try {
    const r = policySchema.safeParse(JSON.parse(b.toString('utf8')));
    if (!r.success) throw new Error();
    return r.data;
  } catch {
    throw new VaultError('corrupt', 'a value cannot be decrypted');
  } finally {
    b.fill(0);
  }
}

/** The index in g of e's authenticator; -1 for none. */
export function ownerOf(g: Guard, e: UnlockEntry): number {
  return (g.authenticators ?? []).findIndex((a) => {
    if (a.id !== e.authenticator) return false;
    if (isDesktop(e)) return a.kind === KIND_DESKTOP;
    if (e.kind === UNLOCK_PRF && e.prf)
      return (
        a.kind === KIND_WEBAUTHN &&
        unb64(a.credential).equals(unb64(e.prf.credential)) &&
        a.origin === e.prf.origin &&
        a.rpId === e.prf.rpId
      );
    return false;
  });
}

/** v without its null members (zod's nullish), recursively. */
function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== null && x !== undefined)
        .map(([k, x]) => [k, dropNulls(x)]),
    );
  return v;
}
