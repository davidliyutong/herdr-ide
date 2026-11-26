// The proof of the user's presence for the variable vault (the hub's
// backend/features/vault/desktop.ts): the page hands over a nonce, this shell
// asks the hub what the nonce is for, shows that in the system's prompt
// (Touch ID, Windows Hello) and, once the user answered it, signs the nonce
// with the key of this launch. The text of the prompt comes from the hub's
// answer, never from the page, so a page cannot show the user one thing and
// have another signed. The key stays in the main process's memory.
//
// The same key unlocks a locked vault through this install's unlock entry
// (unlock) and makes that entry (enroll): the Secure Enclave on macOS
// (enclave.ts), a Windows Hello key on Windows (windowsHello.ts), each with
// this install's shellSecret (unlockStore.ts). What the hub needs of them
// goes in a relay (relay.ts) sealed with a key derived from the verify key,
// which the page passes on without reading. The shell, not the page, picks
// the entry: the one of its own install id.
import { createHmac } from 'node:crypto';
import { APP_SLUG } from '../../web/src/brand';
import type { MessageKey } from '../../web/src/i18n/en';
import { isX963, MAX_BLOB, type Enclave } from './enclave';
import type { Platform } from './platform';
import { fromBase64url, relayKey, sealRelay } from './relay';
import { INSTALL, type UnlockStore } from './unlockStore';
import type { HelloKeys } from './windowsHello';

/** What a nonce is for, as the hub tells it. */
export interface Purpose {
  for: 'session' | 'register' | 'answer' | 'reveal' | 'change';
  /** The request an answer is for; with `answer` only. `target` is the
   * machine's ssh address, empty for the local machine. */
  request?: { id: string; machine: string; target: string; tool: string; names: string[] };
  answer?: 'once' | 'always';
  /** The variable a reveal or a change is for. */
  name?: string;
  /** For a session nonce issued while the vault is locked: the unlock
   * entries of the desktop kinds. */
  unlock?: UnlockEntry[];
  /** For a register nonce: the challenge a new Hello key signs. */
  register?: { challenge: Buffer };
}

/** An unlock entry of the hub, as GET proof/{nonce} lists it. */
export type UnlockEntry =
  | { id: string; kind: 'enclave'; install: string; blob: Buffer; ephPub: Buffer }
  | { id: string; kind: 'hello'; install: string; keyName: string; challenge: Buffer };

export interface HelloPrompt {
  available(): Promise<boolean>;
  request(message: string): Promise<boolean>;
}

export interface VerifyDeps {
  platform: Platform;
  canPromptTouchID(): boolean;
  promptTouchID(reason: string): Promise<void>;
  hello: HelloPrompt;
  /** The JSON of GET /api/p/vault/proof/{nonce}; undefined when the hub
   * does not know the nonce. */
  purpose(nonce: string): Promise<unknown>;
  t(key: MessageKey, vars?: Record<string, string>): string;
  /** macOS: the Secure Enclave helper. */
  enclave?: Enclave;
  /** Windows: Hello keys. */
  helloKeys?: HelloKeys;
  /** This install's id and shellSecret. */
  unlockStore?: UnlockStore;
}

/** What unlock answers: the entry used and the relay for the hub. */
export interface Unlock {
  id: string;
  relay: string;
}

/** What enroll answers: the register proof's MAC and the relay. */
export interface Enroll {
  mac: string;
  relay: string;
}

export interface Verifier {
  available(): Promise<'touchid' | 'hello' | null>;
  /** The proof's MAC (hex), or null: anything invalid, an unknown nonce, a
   * prompt that was cancelled or failed, or another prompt being open. */
  prove(nonce: unknown): Promise<string | null>;
  /** Whether this install can keep an unlock key: the Secure Enclave with
   * Touch ID, or Hello keys, and safeStorage for the shellSecret. */
  canUnlock(): Promise<boolean>;
  /** For a session nonce of a locked vault: the prompt, then the relay of
   * this install's entry; 'none', without a prompt, when this install has
   * no entry (its id and shellSecret are lost, or the entries are other
   * installs'); null on a cancel or a failure, or while another prompt is
   * open. A key the system no longer has gives a relay that says so, so
   * the hub removes the entry. */
  unlock(nonce: unknown): Promise<Unlock | 'none' | null>;
  /** For a register nonce: the prompt, a new unlock key of this install,
   * and the MAC and relay; null as for unlock. */
  enroll(nonce: unknown): Promise<Enroll | null>;
}

const NONCE = /^[A-Za-z0-9_-]{20,128}$/;
const MAX_NAMES = 16;
/** Bounds on user-chosen text before it goes into a prompt. */
const MAX_MACHINE = 60;
const MAX_TARGET = 60;
/** A variable's name as the hub allows it, at most this long in a prompt. */
const MAX_NAME = 64;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAMES_TEXT = 120;

/** The proof's MAC: the hub's proofMessage, signed with HMAC-SHA-256. The
 * request's place is the request's id for an answer and the variable's name
 * for a reveal or a change. */
export function proofMac(key: string, nonce: string, p: Purpose): string {
  const message = 'vault-proof\n' + nonce + '\n' + p.for + '\n' + (p.request?.id ?? p.name ?? '') + '\n' + (p.answer ?? '');
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(message).digest('hex');
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether o has exactly these members. */
function exactly(o: Record<string, unknown>, keys: string[]): boolean {
  const got = Object.keys(o);
  return got.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

/** An unlock entry's id: 16 random bytes in base64url. */
export const ENTRY_ID = /^[A-Za-z0-9_-]{22}$/;
/** The most unlock entries of the desktop kinds a vault has. */
const MAX_ENTRIES = 4;

/** The name of this install's Windows Hello key. */
export const helloKeyName = (install: string) => `${APP_SLUG}-vault-${install}`;

/** An unlock entry of exactly the shape the hub sends, or undefined. */
function parseEntry(v: unknown): UnlockEntry | undefined {
  if (!isObject(v) || !isString(v.id) || !ENTRY_ID.test(v.id) || !isString(v.install) || !INSTALL.test(v.install)) return undefined;
  if (v.kind === 'enclave') {
    const p = v.enclave;
    if (!exactly(v, ['id', 'kind', 'install', 'enclave']) || !isObject(p) || !exactly(p, ['blob', 'ephPub'])) return undefined;
    const blob = fromBase64url(p.blob, MAX_BLOB);
    const ephPub = fromBase64url(p.ephPub, 65);
    if (!blob || blob.length === 0 || !isX963(ephPub)) return undefined;
    return { id: v.id, kind: 'enclave', install: v.install, blob, ephPub };
  }
  if (v.kind === 'hello') {
    const p = v.hello;
    if (!exactly(v, ['id', 'kind', 'install', 'hello']) || !isObject(p) || !exactly(p, ['keyName', 'challenge'])) return undefined;
    const challenge = fromBase64url(p.challenge, 32);
    if (p.keyName !== helloKeyName(v.install) || challenge?.length !== 32) return undefined;
    return { id: v.id, kind: 'hello', install: v.install, keyName: p.keyName, challenge };
  }
  return undefined;
}

/** The purpose as the hub sent it, or undefined when its shape is not
 * exactly one the hub sends. */
function parsePurpose(value: unknown): Purpose | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.for === 'session' || v.for === 'register') {
    // The hub sends an empty answer here; nothing else belongs to these
    // but a locked vault's unlock entries and a register's challenge.
    if (v.request !== undefined || v.name !== undefined || (v.answer !== undefined && v.answer !== '')) return undefined;
    if (v.for === 'session') {
      if (v.register !== undefined) return undefined;
      if (v.unlock === undefined) return { for: 'session' };
      if (!Array.isArray(v.unlock) || v.unlock.length > MAX_ENTRIES) return undefined;
      const unlock = v.unlock.map(parseEntry);
      return unlock.every((e) => e !== undefined) ? { for: 'session', unlock: unlock as UnlockEntry[] } : undefined;
    }
    if (v.unlock !== undefined) return undefined;
    if (v.register === undefined) return { for: 'register' };
    const r = v.register;
    const challenge = isObject(r) && exactly(r, ['challenge']) ? fromBase64url(r.challenge, 32) : null;
    return challenge?.length === 32 ? { for: 'register', register: { challenge } } : undefined;
  }
  if (v.for === 'reveal' || v.for === 'change') {
    if (v.request !== undefined || (v.answer !== undefined && v.answer !== '')) return undefined;
    if (!isString(v.name) || v.name.length > MAX_NAME || !NAME.test(v.name)) return undefined;
    return { for: v.for, name: v.name };
  }
  if (v.for !== 'answer' || v.name !== undefined || (v.answer !== 'once' && v.answer !== 'always')) return undefined;
  const r = v.request as Record<string, unknown> | null | undefined;
  if (typeof r !== 'object' || r === null) return undefined;
  if (!isString(r.id) || !isString(r.machine) || !isString(r.target) || !isString(r.tool)) return undefined;
  if (!Array.isArray(r.names) || r.names.length === 0 || r.names.length > MAX_NAMES || !r.names.every(isString)) return undefined;
  return { for: 'answer', answer: v.answer, request: { id: r.id, machine: r.machine, target: r.target, tool: r.tool, names: r.names } };
}

/** Text of a prompt made of user-chosen text: control and format
 * characters (line breaks, bidirectional overrides) out, cut at max. */
export function clean(text: string, max: number): string {
  const chars = Array.from(
    text
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

/** The machine as a prompt shows it: its label, then its ssh address in
 * parentheses when it has one that differs from the label (the label is the
 * user's name for it, which programs can change; the address is what the
 * request really reaches). */
function machineText(r: NonNullable<Purpose['request']>): string {
  const label = clean(r.machine, MAX_MACHINE);
  const target = clean(r.target, MAX_TARGET);
  return target && target !== label ? `${label} (${target})` : label;
}

/** The names a request asks for: as many as fit in MAX_NAMES_TEXT characters
 * (the first always), then how many more there are. Names are never left
 * out without saying so. */
function namesText(names: string[], t: VerifyDeps['t']): string {
  const shown: string[] = [];
  let length = 0;
  for (const n of names) {
    const name = clean(n, MAX_NAMES_TEXT);
    const next = length + (shown.length ? 2 : 0) + Array.from(name).length;
    if (shown.length && next > MAX_NAMES_TEXT) break;
    shown.push(name);
    length = next;
  }
  const list = shown.join(', ');
  const more = names.length - shown.length;
  return more > 0 ? `${list} ${t('desktop.verify.more', { count: String(more) })}` : list;
}

/** The prompt's text for a purpose. On macOS the system shows "<App> is
 * trying to <reason>.", so there it is a verb phrase; on Windows a full
 * sentence. */
function promptText(p: Purpose, platform: Platform, t: VerifyDeps['t']): string {
  const prefix = platform === 'win32' ? 'desktop.verify.win.' : 'desktop.verify.';
  if (p.for === 'reveal' || p.for === 'change') return t(`${prefix}${p.for}` as MessageKey, { name: p.name! });
  if (p.for !== 'answer') return t(`${prefix}${p.for}` as MessageKey);
  return t(`${prefix}${p.answer}` as MessageKey, { machine: machineText(p.request!), names: namesText(p.request!.names, t) });
}

/** The bytes as base64url, for a relay's JSON. */
const b64u = (b: Buffer) => b.toString('base64url');

/** The verifier of a launch; without a key it has no way. */
export function verifier(key: string, deps: VerifyDeps): Verifier {
  let busy = false;
  const sealing = key ? relayKey(key) : undefined;
  const available: Verifier['available'] = async () => {
    if (!key) return null;
    if (deps.platform === 'darwin') return deps.canPromptTouchID() ? 'touchid' : null;
    if (deps.platform === 'win32') return (await deps.hello.available()) ? 'hello' : null;
    return null;
  };
  /** The kind of unlock key this install can keep, if any. */
  const unlockKind = async (): Promise<'enclave' | 'hello' | null> => {
    if (!key || !deps.unlockStore || !(await deps.unlockStore.available())) return null;
    if (deps.platform === 'darwin' && deps.enclave) {
      const a = await deps.enclave.available();
      return a.enclave && a.biometry ? 'enclave' : null;
    }
    if (deps.platform === 'win32' && deps.helloKeys) return (await deps.helloKeys.supported()) ? 'hello' : null;
    return null;
  };
  /** Runs fn as the one prompt there is, from the moment the purpose is
   * fetched; null for a malformed nonce, without a key, while another
   * prompt is open, or when fn fails. */
  const once = async <T>(nonce: unknown, fn: (nonce: string) => Promise<T | null>): Promise<T | null> => {
    if (typeof nonce !== 'string' || !NONCE.test(nonce) || !key || busy) return null;
    busy = true;
    try {
      return await fn(nonce);
    } catch {
      return null;
    } finally {
      busy = false;
    }
  };
  /** Seals plaintext's JSON for the hub, wiping the bytes afterwards. */
  const seal = (purpose: 'session' | 'register', nonce: string, entry: string, plaintext: object) => {
    const bytes = Buffer.from(JSON.stringify(plaintext), 'utf8');
    try {
      return sealRelay(sealing!, purpose, nonce, entry, bytes);
    } finally {
      bytes.fill(0);
    }
  };
  return {
    available,
    prove: (nonce) =>
      once(nonce, async (n) => {
        const kind = await available();
        if (!kind) return null;
        const p = parsePurpose(await deps.purpose(n));
        if (!p) return null;
        const text = promptText(p, deps.platform, deps.t);
        if (kind === 'touchid') await deps.promptTouchID(text);
        else if (!(await deps.hello.request(text))) return null;
        return proofMac(key, n, p);
      }),
    canUnlock: async () => {
      try {
        return (await unlockKind()) !== null;
      } catch {
        return false;
      }
    },
    unlock: (nonce) =>
      once(nonce, async (n) => {
        const store = deps.unlockStore;
        if (!store || !(await store.available())) return null;
        const kind = deps.platform === 'darwin' ? 'enclave' : deps.platform === 'win32' ? 'hello' : null;
        if (!kind) return null;
        const p = parsePurpose(await deps.purpose(n));
        if (p?.for !== 'session' || !p.unlock) return null;
        const keys = await store.load();
        // No id and shellSecret of this install: no entry can be its.
        if (!keys) return 'none';
        // This install's entry: the shell's own install id decides.
        const entry = p.unlock.find((e) => e.install === keys.install && e.kind === kind);
        try {
          if (!entry) return 'none';
          let plaintext: object;
          if (entry.kind === 'enclave') {
            if (!deps.enclave) return null;
            const r = await deps.enclave.agree(entry.blob, entry.ephPub, deps.t('desktop.verify.session'));
            if (r.ok) {
              plaintext = { z: b64u(r.secret), shellSecret: b64u(keys.secret) };
              r.secret.fill(0);
            } else if (r.error === 'invalidated') plaintext = { invalidated: true };
            else return null;
          } else {
            if (!deps.helloKeys) return null;
            const r = await deps.helloKeys.sign(helloKeyName(keys.install), entry.challenge);
            if (r.ok) {
              plaintext = { signature: b64u(r.value), shellSecret: b64u(keys.secret) };
              r.value.fill(0);
            } else if (r.error === 'invalidated') plaintext = { invalidated: true };
            else return null;
          }
          return { id: entry.id, relay: seal('session', n, entry.id, plaintext) };
        } finally {
          keys.secret.fill(0);
        }
      }),
    enroll: (nonce) =>
      once(nonce, async (n) => {
        const kind = await unlockKind();
        if (!kind) return null;
        const p = parsePurpose(await deps.purpose(n));
        if (p?.for !== 'register' || !p.register) return null;
        const store = deps.unlockStore!;
        let plaintext: object;
        let secret: Buffer | undefined;
        try {
          if (kind === 'enclave') {
            // The user's yes comes first; making the key asks nothing.
            if (!deps.canPromptTouchID()) return null;
            await deps.promptTouchID(promptText(p, deps.platform, deps.t));
            const keys = await store.loadOrCreate();
            if (!keys) return null;
            secret = keys.secret;
            const made = await deps.enclave!.create();
            if (!made) return null;
            plaintext = { kind: 'enclave', install: keys.install, sePub: b64u(made.pub), blob: b64u(made.blob), shellSecret: b64u(secret) };
          } else {
            // Making a Hello key is itself a Hello prompt, and signing the
            // challenge a second: no third one for the proof.
            const keys = await store.loadOrCreate();
            if (!keys) return null;
            secret = keys.secret;
            const keyName = helloKeyName(keys.install);
            const created = await deps.helloKeys!.create(keyName);
            if (!created.ok) return null;
            const signed = await deps.helloKeys!.sign(keyName, p.register.challenge);
            if (!signed.ok) return null;
            plaintext = {
              kind: 'hello',
              install: keys.install,
              keyName,
              publicKey: b64u(created.value),
              signature: b64u(signed.value),
              shellSecret: b64u(secret),
            };
            signed.value.fill(0);
          }
          return { mac: proofMac(key, n, p), relay: seal('register', n, '', plaintext) };
        } finally {
          secret?.fill(0);
        }
      }),
  };
}
