// The vault's hub side: the store (store.ts) behind the pages' routes
// (hub.ts) and the requests of the MCP servers on machines (op vault).
//
// One gate stands before everything that reads a value or lets one be read,
// for every caller, the hub host's own programs included: a machine's MCP
// server gets a value only for a variable that lists it, with the user's
// approval, or for an app the user exempted there; the pages' approvals,
// reveals and changes need a vault session, which a page gets only with the
// passphrase or an authenticator's proof, so a program that calls the
// hub's API cannot approve its own request or read a value. A lock forgets
// the key; the passphrase, or an authenticator that keeps it wrapped,
// unlocks again. docs/features/30-variable-vault.md has the design.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { dirname, basename, join } from 'node:path';
import { Fail } from '#kernel/fail.ts';
import type { FeatureContext } from '#kernel/feature.ts';
import type { Client, Ctx } from '#kernel/http/env.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { formatRFC3339 } from '#shared/lib/gotime.ts';
import {
  MAX_VAULT_PROCESSES,
  readLine,
  VaultTool,
  writeLine,
  type Header,
  type VaultProcess,
  type VaultRequest,
  type VaultResponse,
  type VaultRun,
} from '#shared/proto/agentproto/index.ts';
import { hubDBBeside, noisy, released, Result, type Access, type AccessLogOptions } from './accesslog.ts';
import { WorkerAccessLog } from './accesslog-worker.ts';
import { b64url, isCode, Mutex, unb64, unb64url, VaultError } from './crypto.ts';
import { desktopOf, proofMessage, relayAD, type Desktop } from './desktop.ts';
import { Gate, since, type Nonce, type Purpose, type Stamp } from './gate.ts';
import {
  allows,
  KIND_DESKTOP,
  KIND_WEBAUTHN,
  MAX_APP,
  MAX_NAME,
  MODE_PASSPHRASE,
  OpenError,
  Store,
  type Authenticator,
  type Guard,
  type StoreOptions,
  type StoreVerifier,
  type Window,
} from './store.ts';
import {
  UNLOCK_ENCLAVE,
  UNLOCK_HELLO,
  UNLOCK_PRF,
  helloKeyName,
  isDesktop,
  validInstall,
  enclaveKEK,
  helloKEK,
  prfKEK,
  type UnlockEntry,
} from './unlock.ts';
import { verifyAssertion, type Assertion } from './webauthn.ts';

export const SESSION_HEADER = 'X-Vault-Session';
const MAX_PENDING = 32;
const MAX_PENDING_PER_MACHINE = 4;
export const MAX_NAMES = 64;
const NOISY_EVERY = 60_000;
const CHANGED_EVERY = 1000;
const LOCK_CHECK_EVERY = 60_000;

export const Answer = { Once: 'once', Always: 'always', Deny: 'deny' } as const;

/** The proof's purposes. */
export const For = { Session: 'session', Answer: 'answer', Register: 'register', Reveal: 'reveal', Change: 'change' } as const;

export interface VaultOptions {
  /** The desktop app's verify key of this launch (its hello); without one
   * no desktop proof or relay is taken. */
  verifyKey?: string;
  /** The vault's file; by default beside the settings file. */
  path?: string;
  /** Tests: the store's new derivation, the clocks, the limits that are
   * settings otherwise, and steps run inside the key's lock. */
  store?: StoreOptions;
  mono?: () => number;
  approvalTimeoutMs?: number;
  autoLockMs?: number;
  lockCheckMs?: number;
  noisyEveryMs?: number;
  changedEveryMs?: number;
  /** How often the file is looked at for what other hubs of the namespace
   * wrote (Vault.reload). */
  fileCheckMs?: number;
  accessLog?: Partial<AccessLogOptions>;
  keyStep?: () => void | Promise<void>;
  /** Run inside the key's lock between an authenticator's write and its
   * unlock entry's. */
  addStep?: () => void | Promise<void>;
}

/** A request of an MCP server waiting for the user's answer. */
export interface PendingRequest {
  id: string;
  m: string;
  tool: string;
  names: string[];
  client?: string;
  terminal?: string;
  cwd?: string;
  process?: VaultProcess[];
  created: string;
  expires: string;
}
interface Pending {
  req: PendingRequest;
  createdAt: number;
  expiresAt: number;
  waiters: number;
  answer: string;
  announced: boolean;
  wake: Array<() => void>;
}

/** A proof as a page sends it: the desktop shell's MAC (hex), or a
 * WebAuthn assertion (base64url). */
export interface ProofBody {
  nonce: string;
  mac?: string | null;
  credential?: string | null;
  clientDataJSON?: string | null;
  authenticatorData?: string | null;
  signature?: string | null;
}
/** The user's word for one action: a proof made for it, or the passphrase. */
export interface Fresh {
  proof?: ProofBody | null;
  passphrase?: string | null;
}

/** A proof that does not hold; a counter that did not grow is a copy of
 * the authenticator. */
export class ProofError extends Error {}
class CounterError extends ProofError {}
export const proofError = () => new ProofError('the proof does not hold');

export const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n) : (s ?? ''));
const route = (c: Ctx) => `${c.req.method} ${c.req.path}`;

export const assertionOf = (p: ProofBody): Assertion => ({
  credential: unb64url(p.credential),
  clientDataJSON: unb64url(p.clientDataJSON),
  authenticatorData: unb64url(p.authenticatorData),
  signature: unb64url(p.signature),
});

export class Vault {
  readonly ctx: FeatureContext;
  readonly o: VaultOptions;
  readonly desktop: Desktop | undefined;
  readonly gate: Gate;
  /** Installing or dropping the key is one step with its sessions: an
   * unlock and the session it opens, a lock and the end of every session. */
  readonly keyMu = new Mutex();
  #store: Store | undefined;
  #alog: WorkerAccessLog | undefined;
  #pending = new Map<string, Pending>();
  #noisy = new Map<
    string,
    { last: number; suppressed: number; pending?: Record<string, unknown>; flush?: ReturnType<typeof setTimeout> }
  >();
  #changedAt = 0;
  #changedLater: ReturnType<typeof setTimeout> | null = null;
  /** The auto-lock: the last use, the timer while unlocked, and the most
   * this unlock lasts without use (undefined: the setting's). */
  #lastUse: Stamp | null = null;
  #lockTimer: ReturnType<typeof setTimeout> | null = null;
  #lockCap: number | undefined;
  #fileWork = false;
  #stopped = false;

  constructor(ctx: FeatureContext, o: VaultOptions) {
    this.ctx = ctx;
    this.o = o;
    this.desktop = desktopOf(o.verifyKey ?? '');
    const start = performance.now();
    const mono = o.mono ?? (() => performance.now() - start);
    this.gate = new Gate(() => ({ wall: this.now().getTime(), mono: mono() }));
  }

  now(): Date {
    return this.o.store?.now?.() ?? new Date();
  }

  // ---- the store and the settings

  /** The vault's file: the option, or vault.json beside the settings
   * file, shared with the other hubs of the namespace; "" when the hub
   * keeps none. */
  path(): string {
    if (this.o.path) return this.o.path;
    const sp = this.ctx.settings.path;
    return sp ? join(dirname(sp), basename(sp).replace('settings', 'vault')) : '';
  }

  /** The store, opened at its first use; a file that does not open is 503
   * with its code and is tried again at the next use. */
  open(): Store {
    if (this.#store) return this.#store;
    const path = this.path();
    if (!path) throw new Fail('unavailable', 503, 'the vault has no file (the hub keeps no settings)');
    try {
      this.#store = Store.open(path, { ...this.o.store, lockedElsewhere: () => this.#lockedElsewhere() });
    } catch (e) {
      const oe = e instanceof OpenError ? e : new OpenError('failed', String(e));
      this.ctx.logger(`vault: ${oe.message}`);
      throw new Fail(oe.code, 503, oe.message);
    }
    return this.#store;
  }

  accessLog(): WorkerAccessLog {
    this.#alog ??= new WorkerAccessLog({ db: hubDBBeside(this.path()), logger: this.ctx.logger, ...this.o.accessLog });
    return this.#alog;
  }

  /** A number setting, def without it, kept within lo and hi. */
  #setting(key: string, def: number, lo: number, hi: number): number {
    let v = def;
    try {
      const n = this.ctx.settings.number(key as never);
      if (typeof n === 'number' && Number.isFinite(n)) v = n;
    } catch {
      // not a setting of these settings
    }
    return Math.min(Math.max(v, lo), hi);
  }

  approvalTimeout(): number {
    return this.o.approvalTimeoutMs ?? this.#setting('vault.approvalTimeout', 60, 10, 600) * 1000;
  }

  sessionLimits(): { idle: number; most: number } {
    return {
      idle: this.#setting('vault.sessionIdle', 30, 1, 240) * 60_000,
      most: this.#setting('vault.sessionMax', 12, 1, 24) * 3600_000,
    };
  }

  /** vault.passphraseDays: the store takes at most the days it sealed with
   * the passphrase, so the setting shortens the window, never lengthens it. */
  passphraseDays(): number {
    return this.#setting('vault.passphraseDays', 14, 1, 90);
  }

  /** The window a passphrase checked now opens, with the auto-lock an
   * unlock by an authenticator within it may have at most. */
  window(autoLockMs: number): Window {
    return { days: this.passphraseDays(), autoLockMs };
  }

  autoLockSetting(): number {
    return this.o.autoLockMs ?? this.#setting('vault.autoLock', 60, 0, 1440) * 60_000;
  }

  /** How long the vault stays unlocked unused (0: never): the setting's
   * time, at most this unlock's cap. */
  autoLockAfter(): number {
    const after = this.autoLockSetting();
    return this.#lockCap === undefined ? after : shorter(after, this.#lockCap);
  }

  runLimits(): VaultRun {
    return {
      timeout: this.#setting('vault.runTimeout', 120, 5, 3600),
      max_timeout: this.#setting('vault.runMaxTimeout', 600, 5, 3600),
      max_output: this.#setting('vault.runOutput', 64, 4, 1024) * 1024,
    };
  }

  /** Tells the pages to load the vault again. */
  changed(): void {
    this.ctx.broadcast({ type: 'changed' });
  }

  audit(c: Ctx | null, event: string, fields: Record<string, unknown>): void {
    this.ctx.audit.log(c ? c.var.who : null, event, fields);
  }

  // ---- sessions and the gate

  sessionKind(c: Ctx, use: boolean): { open: boolean; byProof: boolean } {
    const r = this.gate.session(c.req.header(SESSION_HEADER) ?? '', this.sessionLimits(), use);
    if (r.open && use) this.touch();
    return r;
  }

  newSession(epoch: number, byProof: boolean): string {
    return this.gate.open(epoch, this.sessionLimits(), byProof);
  }

  refuseSession(c: Ctx): never {
    this.audit(c, 'denied.vault_session', { route: route(c) });
    throw new Fail('vault_session', 401, "the vault's passphrase is needed (a vault session)");
  }

  /** A request that needs a session the passphrase opened. */
  refusePassphraseSession(c: Ctx, open: boolean): never {
    if (!open) this.refuseSession(c);
    this.audit(c, 'denied.vault_passphrase', { route: route(c) });
    throw new Fail('vault_passphrase', 401, "this needs a session opened with the vault's passphrase");
  }

  /** Reserves a passphrase check, or refuses with 429: wait after wrong
   * passphrases, busy while another check runs. Every reservation ends
   * with tried. */
  slowDown(c: Ctx): void {
    const r = this.gate.beginGuess(this.now().getTime());
    if (r.ok) return;
    c.header('Retry-After', String(Math.floor(r.wait / 1000) + 1));
    if (r.wait <= 0) throw new Fail('busy', 429, 'another passphrase is being checked; try again in a moment');
    throw new Fail('wait', 429, 'too many wrong passphrases; try again later');
  }

  tried(e: unknown, wrongCode = 'wrong_passphrase'): void {
    this.gate.tried(!e, isCode(e, wrongCode), this.now().getTime());
  }

  /** Checks a passphrase a request brought, which starts the window again
   * (of an unlocked vault), sealing this unlock's auto-lock with it;
   * slowed down as every check. */
  async passphraseChecked(c: Ctx, s: Store, passphrase: string): Promise<void> {
    this.slowDown(c);
    let e: unknown = null;
    try {
      await s.verify(passphrase, this.window(this.autoLockAfter()));
    } catch (x) {
      e = x;
    }
    this.tried(e);
    if (e) throw e;
  }

  async passphraseCheckedWith(c: Ctx, sv: StoreVerifier, passphrase: string): Promise<void> {
    this.slowDown(c);
    let e: unknown = null;
    try {
      await sv.verifyPassphrase(passphrase, this.window(this.autoLockAfter()));
    } catch (x) {
      e = x;
    }
    this.tried(e);
    if (e) throw e;
  }

  /** Whether every Allow is verified: the guard's rule, or a guard that
   * does not open (which cannot say the rule is off). */
  async strict(s: Store): Promise<boolean> {
    try {
      return !!(await s.guard()).verifyEachAllow;
    } catch (e) {
      return !isCode(e, 'vault_locked') && !isCode(e, 'no_passphrase');
    }
  }

  needFresh(c: Ctx): never {
    this.audit(c, 'denied.vault_proof', { route: route(c) });
    throw new Fail('vault_proof', 401, "every Allow is verified: an authenticator's proof or the vault's passphrase is needed");
  }

  /** A proof that does not hold (a store's error as it is). */
  refuseProof(c: Ctx, e: unknown, p: Purpose): never {
    this.audit(c, 'vault.proved', { ok: false, for: p.for });
    if (!(e instanceof ProofError)) throw e;
    throw new Fail('vault_proof', 401, "the proof does not hold; the vault's passphrase works");
  }

  /** What f brings for want: false when nothing; a refusal is thrown. */
  async verified(c: Ctx, s: Store, f: Fresh, want: Purpose): Promise<boolean> {
    if (f.proof) {
      let kind: string;
      try {
        kind = await this.checkProof(c, s, f.proof, want);
      } catch (e) {
        this.refuseProof(c, e, want);
      }
      this.audit(c, 'vault.proved', { ok: true, for: want.for, kind });
      this.touch();
      return true;
    }
    if (f.passphrase) {
      const st = s.status();
      if (st.mode !== MODE_PASSPHRASE || st.locked) throw new VaultError('vault_locked', 'the vault is locked');
      await this.passphraseChecked(c, s, f.passphrase);
      this.touch();
      return true;
    }
    return false;
  }

  /** Lock-held variant of verified() for atomic policy checks inside Store.#mu. */
  async verifiedWith(c: Ctx, sv: StoreVerifier, f: Fresh, want: Purpose): Promise<boolean> {
    if (f.proof) {
      let kind: string;
      try {
        kind = await this.checkProofWith(c, sv, f.proof, want);
      } catch (e) {
        this.refuseProof(c, e, want);
      }
      this.audit(c, 'vault.proved', { ok: true, for: want.for, kind });
      this.touch();
      return true;
    }
    if (f.passphrase) {
      const st = sv.status();
      if (st.mode !== MODE_PASSPHRASE || st.locked) throw new VaultError('vault_locked', 'the vault is locked');
      await this.passphraseCheckedWith(c, sv, f.passphrase);
      this.touch();
      return true;
    }
    return false;
  }

  /** The passphrase again with a request that lets more out than a session
   * decides alone: none is 403 passphrase_required. */
  async passphraseAgain(c: Ctx, s: Store, passphrase: string | null | undefined): Promise<void> {
    if (await this.verified(c, s, { passphrase }, { for: '' })) return;
    this.audit(c, 'denied.passphrase_required', { route: route(c) });
    throw new Fail('passphrase_required', 403, "this needs the vault's passphrase with the request");
  }

  // ---- proofs

  /** The origin of the page when the hub vouches for it, and the host
   * name its credentials are for; "" for any other. */
  originOf(c: Ctx): { origin: string; rpId: string } {
    try {
      const u = new URL(c.var.trustedOrigin);
      if (c.var.trustedOrigin && u.hostname) return { origin: c.var.trustedOrigin, rpId: u.hostname.toLowerCase() };
    } catch {
      // none
    }
    return { origin: '', rpId: '' };
  }

  /** The desktop shell's word is taken from the desktop client only. */
  desktopCan(c: Ctx): boolean {
    return c.var.client === 'desktop' && !!this.desktop;
  }

  /** Checks pb as a proof for want and returns the kind of authenticator
   * that made it; ProofError when it does not hold. A proof marks its
   * authenticator used. */
  async checkProof(c: Ctx, s: Store, pb: ProofBody, want: Purpose): Promise<string> {
    return this.checkProofCore(
      c,
      pb,
      want,
      () => s.guard(),
      (id, count) => this.used(s, id, count),
    );
  }

  async checkProofWith(c: Ctx, sv: StoreVerifier, pb: ProofBody, want: Purpose): Promise<string> {
    return this.checkProofCore(
      c,
      pb,
      want,
      () => sv.guard(),
      (id, count) =>
        sv.recordProof(id, this.now(), count).catch((e) => {
          throw isCode(e, 'not_found') ? proofError() : e;
        }),
    );
  }

  private async checkProofCore(
    c: Ctx,
    pb: ProofBody,
    want: Purpose,
    readGuard: () => Promise<Guard>,
    markUsed: (id: string, count?: number) => Promise<void>,
  ): Promise<string> {
    const n = this.gate.take(pb.nonce, want, false);
    if (!n) throw proofError();
    const g = await readGuard();
    if (pb.mac) {
      const mac = /^[0-9a-fA-F]*$/.test(pb.mac) && pb.mac.length % 2 === 0 ? Buffer.from(pb.mac, 'hex') : null;
      if (!mac || !this.desktopCan(c) || !this.desktop!.proof(proofMessage(pb.nonce, want), mac)) throw proofError();
      const a = g.authenticators?.findLast((x) => x.kind === KIND_DESKTOP);
      if (!a) throw proofError();
      await markUsed(a.id);
      return KIND_DESKTOP;
    }
    const { origin, rpId } = this.originOf(c);
    const cred = unb64url(pb.credential);
    if (!origin || !cred.length) throw proofError();
    // The credential of this very page: the same origin, not only the host.
    const a = g.authenticators?.find(
      (x) => x.kind === KIND_WEBAUTHN && x.origin === origin && x.rpId === rpId && unb64(x.credential).equals(cred),
    );
    if (!a) throw proofError();
    await markUsed(a.id, await assertionCount(a, pb, n.challenge));
    return KIND_WEBAUTHN;
  }

  async used(s: Store, id: string, count?: number): Promise<void> {
    await s.recordProof(id, this.now(), count).catch((e) => {
      throw isCode(e, 'not_found') ? proofError() : e;
    });
  }

  /** What guards the vault as this page sees it; null while locked.
   * Without a session only what offering biometrics needs: the kinds of
   * authenticator this page can prove with, never ids, labels, origins,
   * the rule or the exempt apps. */
  async guardState(c: Ctx, s: Store, full: boolean): Promise<Record<string, unknown> | null> {
    let g: Guard;
    try {
      g = await s.guard();
    } catch {
      return null;
    }
    const { origin } = this.originOf(c);
    const desktop = this.desktopCan(c);
    const list = g.authenticators ?? [];
    if (!full) {
      const ways: Array<Record<string, string>> = [];
      for (const a of list)
        if (a.kind === KIND_DESKTOP && desktop && !ways.some((w) => w.kind === a.kind)) ways.push({ kind: a.kind });
        else if (a.kind === KIND_WEBAUTHN && origin && a.origin === origin && !ways.some((w) => w.kind === a.kind))
          ways.push({ kind: a.kind, origin });
      return { authenticators: ways, desktop, webauthn: !!origin };
    }
    const wraps = new Set(s.unlockEntries().map((e) => e.authenticator));
    return {
      full: true,
      authenticators: list.map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        ...(a.origin ? { origin: a.origin } : {}),
        ...(a.rpId ? { rpId: a.rpId } : {}),
        created: a.created,
        ...(a.lastUsed ? { lastUsed: a.lastUsed } : {}),
        unlock: wraps.has(a.id),
      })),
      verifyEachAllow: !!g.verifyEachAllow,
      exempt: g.exempt ?? [],
      desktop,
      webauthn: !!origin,
    };
  }

  /** How this page may unlock without the passphrase, and until when by
   * the hint in the clear: no ids, labels or times. */
  unlockState(c: Ctx, s: Store): { ways: string[]; due: string } {
    const { origin, rpId } = this.originOf(c);
    const ways: string[] = [];
    for (const e of s.unlockEntries()) {
      const ok = isDesktop(e) ? this.desktopCan(c) : e.kind === UNLOCK_PRF && !!origin && e.prf?.origin === origin && e.prf.rpId === rpId;
      if (ok && !ways.includes(e.kind)) ways.push(e.kind);
    }
    const due = s.passphraseDue();
    return { ways, due: due ? formatRFC3339(due) : '' };
  }

  // ---- unlocking

  /** What follows an unlock of a locked vault, with the key's lock held:
   * the auto-lock's cap (sealed: the time sealed with the window, 0 for the
   * passphrase) and the end of the nonces issued while locked. */
  unlocked(sealedMs: number): void {
    this.#lockCap = shorter(this.autoLockSetting(), sealedMs);
    this.gate.dropLockedNonces();
  }

  /** Locks the vault, with the key's lock held: the key, every session and
   * nonce, and the unlock's cap go. */
  async lockStore(s: Store): Promise<void> {
    await s.lock();
    this.gate.endAll();
    this.#lockCap = undefined;
  }

  /** Takes the file as another hub of the namespace left it
   * (Store.reload): the pages load the vault again. */
  async reload(): Promise<void> {
    const s = this.#store;
    if (!s || this.#stopped) return;
    try {
      if (await s.reload()) this.changed();
    } catch (e) {
      this.ctx.logger(`vault: rereading the file: ${(e as Error).message}`);
    }
  }

  /** The store took a file another hub of the namespace wrote with another
   * passphrase, which locked it: this hub's sessions end as a lock's do. */
  #lockedElsewhere(): void {
    this.gate.endAll();
    this.#lockCap = undefined;
    this.audit(null, 'vault.locked', { reason: 'passphrase_elsewhere' });
    this.changed();
  }

  // ---- the automatic lock: a use is an unlock, a page's action through
  // the gate, a value released to a machine; lists and refusals are not.

  touch(): void {
    this.#lastUse = this.gate.at();
    if (!this.#lockTimer) this.#armAutoLock(0);
  }

  #armAutoLock(wait: number): void {
    const every = this.o.lockCheckMs ?? LOCK_CHECK_EVERY;
    if (wait <= 0 || wait > every) wait = every;
    if (this.#lockTimer || this.#stopped) return;
    this.#lockTimer = setTimeout(() => void this.#autoLock(), wait);
  }

  #idle(): number {
    return this.#lastUse ? since(this.#lastUse, this.gate.at()) : Infinity;
  }

  async #autoLock(): Promise<void> {
    this.#lockTimer = null;
    const s = this.#store;
    if (!s || s.status().locked) return;
    const after = this.autoLockAfter();
    if (after <= 0 || this.#idle() < after) {
      this.#armAutoLock(after > 0 ? after - this.#idle() : 0);
      return;
    }
    // As a lock does: after a check that runs; a use meanwhile keeps it.
    const locked = await this.keyMu.run(async () => {
      if (this.#idle() < after || s.status().locked) return false;
      await this.lockStore(s);
      return true;
    });
    if (!locked) {
      if (!s.status().locked) this.#armAutoLock(after - this.#idle());
      return;
    }
    this.audit(null, 'vault.locked', { reason: 'idle', minutes: after / 60_000 });
    this.changed();
  }

  /** What the pages show of the auto-lock: its time and the setting's
   * (seconds; 0 never), and while unlocked when it will lock unused. */
  autoLockState(s: Store): Record<string, unknown> {
    const after = this.autoLockAfter();
    const st = s.status();
    const out: Record<string, unknown> = { after: after / 1000, setting: this.autoLockSetting() / 1000 };
    if (!st.locked && !st.setup && after > 0 && this.#lastUse) {
      const now = this.gate.at();
      out.lockAt = formatRFC3339(new Date(Math.floor((now.wall + after - since(this.#lastUse, now)) / 1000) * 1000));
    }
    return out;
  }

  // ---- unlock entries

  auditRemoved(c: Ctx, id: string, kind: string, reason: string): void {
    this.audit(c, 'vault.unlock_removed', { id, kind, reason });
  }

  /** Audits, with reason, every entry of before s no longer has. */
  auditRemovedSince(c: Ctx, s: Store, before: UnlockEntry[], reason: string): void {
    const after = new Set(s.unlockEntries().map((e) => e.id));
    for (const e of before) if (!after.has(e.id)) this.auditRemoved(c, e.id, e.kind, reason);
  }

  /** The desktop app's entries as its shell needs them to unlock. */
  desktopEntries(s: Store): Array<Record<string, unknown>> {
    return s.unlockEntries().flatMap<Record<string, unknown>>((e) => {
      if (e.kind === UNLOCK_ENCLAVE && e.enclave)
        return [
          {
            id: e.id,
            kind: e.kind,
            install: e.enclave.install,
            enclave: { blob: b64url(unb64(e.enclave.blob)), ephPub: b64url(unb64(e.enclave.ephPub)) },
          },
        ];
      if (e.kind === UNLOCK_HELLO && e.hello)
        return [
          {
            id: e.id,
            kind: e.kind,
            install: e.hello.install,
            hello: { keyName: e.hello.keyName, challenge: b64url(unb64(e.hello.challenge)) },
          },
        ];
      return [];
    });
  }

  /** Unlocks with an authenticator's entry, with the key's lock held. err
   * is ProofError for what guesses nothing (a nonce, a client or a relay
   * that does not hold), the store's vault_proof for a key that does not
   * open or verify, unlock_stale for an entry gone, passphrase_due outside
   * the window. */
  async unlockWith(c: Ctx, s: Store, ub: UnlockBody): Promise<UnlockResult> {
    const res: UnlockResult = {
      id: '',
      kind: ub.prf ? UNLOCK_PRF : '',
      reason: '',
      removed: '',
      window: { days: 0, autoLockMs: 0 },
      err: null,
    };
    const n = this.gate.take(ub.nonce, { for: For.Session }, true);
    if (!n || !s.status().locked) return { ...res, err: proofError() };
    const days = this.passphraseDays();
    const run = async (fn: () => Promise<Window>) => {
      try {
        res.window = await fn();
      } catch (e) {
        res.err = e;
      }
      return res;
    };
    if (ub.prf) {
      const { origin, rpId } = this.originOf(c);
      const cred = unb64url(ub.prf.credential);
      const output = unb64url(ub.prf.output);
      try {
        if (!origin || !cred.length || output.length !== 32 || !ub.assertion || !unb64url(ub.assertion.credential).equals(cred))
          return { ...res, err: proofError() };
        const e = s
          .unlockEntries()
          .find((x) => x.kind === UNLOCK_PRF && x.prf?.origin === origin && x.prf.rpId === rpId && unb64(x.prf.credential).equals(cred));
        if (!e) return { ...res, err: new VaultError('unlock_stale', 'the unlock entry or its authenticator is gone') };
        res.id = e.id;
        // Called once the output opened the wrap and the key its guard.
        const verify = async (a: Authenticator) => {
          try {
            return await assertionCount(a, ub.assertion!, n.challenge);
          } catch (x) {
            res.reason = x instanceof CounterError ? 'prf_counter' : 'prf_signature';
            throw x;
          }
        };
        return await run(() => s.unlockWith(e.id, prfKEK(output, unb64(e.prf!.salt)), days, verify));
      } finally {
        output.fill(0);
      }
    }
    if (!this.desktopCan(c)) return { ...res, err: proofError() };
    const e = s.unlockEntries().find((x) => x.id === ub.id);
    if (!e) return { ...res, err: new VaultError('unlock_stale', 'the unlock entry or its authenticator is gone') };
    if (!isDesktop(e)) return { ...res, err: proofError() };
    res.id = e.id;
    res.kind = e.kind;
    const relay = unb64url(ub.relay);
    const plain = relay.length ? this.desktop!.relay(relayAD(For.Session, ub.nonce, e.id), relay) : null;
    if (!plain) return { ...res, err: proofError() };
    let r: { z?: unknown; signature?: unknown; shellSecret?: unknown; invalidated?: unknown };
    try {
      r = JSON.parse(plain.toString('utf8'));
    } catch {
      return { ...res, err: proofError() };
    } finally {
      plain.fill(0);
    }
    if (r?.invalidated === true) {
      // The shell's word that the install's key can never open it again.
      await this.removeEntry(s, res, 'invalidated');
      return res;
    }
    const z = unb64url(r?.z);
    const sig = unb64url(r?.signature);
    const secret = unb64url(r?.shellSecret);
    let kek: Buffer;
    if (e.kind === UNLOCK_ENCLAVE && e.enclave && z.length === 32 && secret.length === 32)
      kek = enclaveKEK(z, secret, unb64(e.enclave.ephPub), unb64(e.enclave.sePub));
    else if (e.kind === UNLOCK_HELLO && e.hello && sig.length > 0 && sig.length <= 1024 && secret.length === 32)
      kek = helloKEK(sig, secret, unb64(e.hello.challenge));
    else return { ...res, err: proofError() };
    z.fill(0);
    sig.fill(0);
    secret.fill(0);
    // The relay is its proof: the store checks the rest.
    await run(() => s.unlockWith(e.id, kek, days));
    // The relay opened, so it is the shell's, made by its install's key just
    // now: a wrap that does not open with it never will, and it is no guess.
    if (res.err instanceof VaultError && res.err.why === 'wrap') await this.removeEntry(s, res, 'wrap');
    return res;
  }

  async removeEntry(s: Store, res: UnlockResult, reason: string): Promise<void> {
    res.err = new VaultError('unlock_stale', 'the unlock entry or its authenticator is gone');
    try {
      await s.removeUnlock(res.id);
      res.removed = reason;
    } catch (e) {
      if (!isCode(e, 'not_found')) this.ctx.logger(`vault: removing unlock entry ${res.id}: ${(e as Error).message}`);
    }
  }

  /** Adds the desktop authenticator a, or its entry for another install to
   * the one there is: relay is the shell's, sealed for the registration's
   * nonce; the Hello key signs the nonce's challenge. Without a relay only
   * a desktop authenticator there already is kept (its label changed). */
  async addDesktop(c: Ctx, s: Store, a: Authenticator, nonce: string, relay: string, n: Nonce, passphrase: string): Promise<void> {
    let reg: Record<string, unknown> = {};
    if (relay) {
      const raw = unb64url(relay);
      const plain = this.desktopCan(c) && raw.length ? this.desktop!.relay(relayAD(For.Register, nonce, ''), raw) : null;
      if (!plain) this.refuseProof(c, proofError(), n.purpose);
      try {
        reg = JSON.parse(plain.toString('utf8')) ?? {};
      } catch {
        reg = {};
      } finally {
        plain.fill(0);
      }
      const install = String(reg.install ?? '');
      if (
        !validInstall(install) ||
        (reg.kind !== UNLOCK_ENCLAVE && reg.kind !== UNLOCK_HELLO) ||
        (reg.kind === UNLOCK_HELLO && reg.keyName !== helloKeyName(install))
      )
        throw new Fail('invalid', 400, "the desktop app's unlock key is not one the hub takes");
    }
    let id = '';
    let made = false;
    const before = s.unlockEntries();
    await this.keyMu.run(async () => {
      try {
        await s.updateGuard((g) => {
          const d = g.authenticators?.find((x) => x.kind === KIND_DESKTOP);
          if (d) {
            id = d.id;
            if (a.label) d.label = a.label;
            return;
          }
          if (!relay) throw new Fail('bad_request', 400, "the desktop app's unlock key (relay) is needed");
          g.authenticators = [...(g.authenticators ?? []), a];
          id = a.id;
          made = true;
        });
        if (!relay) return;
        await this.o.addStep?.();
        const secret = unb64url(reg.shellSecret);
        if (reg.kind === UNLOCK_ENCLAVE)
          await s.addEnclave(id, String(reg.install), unb64url(reg.blob), unb64url(reg.sePub), secret, passphrase);
        else
          await s.addHello(
            id,
            String(reg.install),
            String(reg.keyName),
            n.register!,
            unb64url(reg.publicKey),
            unb64url(reg.signature),
            secret,
            passphrase,
          );
      } catch (e) {
        if (made) await this.dropAuthenticator(s, id);
        throw e;
      }
    });
    // The entry this install had, replaced by the new one.
    this.auditRemovedSince(c, s, before, 'stale');
    if (relay) Object.assign(c.var.audit, { unlock: reg.kind, install: reg.install });
    c.var.audit.authenticator = id;
  }

  /** Removes an authenticator just added whose entry could not be made. */
  async dropAuthenticator(s: Store, id: string): Promise<void> {
    await s
      .updateGuard((g) => {
        g.authenticators = g.authenticators?.filter((x) => x.id !== id);
      })
      .catch((e) => this.ctx.logger(`vault: removing authenticator ${id}: ${(e as Error).message}`));
  }

  // ---- the requests of machines

  /** Serves an MCP server's request an agent relayed (op vault): the
   * machine is the stream's, the process chain the header's. */
  async serveAgent(machine: string, conn: AgentStream, h: Header): Promise<void> {
    const { stream, reader } = conn;
    const gone = new AbortController();
    try {
      await writeLine(stream, { ok: true });
      const req = await within(readLine<VaultRequest>(reader), 30_000);
      if (!req || typeof req !== 'object' || typeof req.tool !== 'string') return;
      // The MCP server going away (its stream closed) ends a wait.
      void reader.chunk().then(
        () => gone.abort(),
        () => gone.abort(),
      );
      const resp = await this.handle(machine, req, h.process ?? [], gone.signal);
      await within(writeLine(stream, resp), 10_000);
    } catch {
      // the stream broke
    } finally {
      gone.abort();
      closeStream(stream);
    }
  }

  /** Answers req of machine m and records it; values leave only once their
   * record is written. */
  async handle(m: string, req: VaultRequest, process: VaultProcess[], gone: AbortSignal): Promise<VaultResponse> {
    const names = (Array.isArray(req.names) ? req.names : []).slice(0, MAX_NAMES).map((n) => clip(String(n), MAX_NAME));
    const rec: Omit<Access, 'id'> = {
      time: formatRFC3339(new Date()),
      m,
      tool: clip(req.tool, 16),
      ...(names.length ? { names } : {}),
      ...(req.client ? { client: clip(req.client, 64) } : {}),
      ...(req.terminal ? { terminal: clip(req.terminal, 64) } : {}),
      ...(req.cwd ? { cwd: clip(req.cwd, 1024) } : {}),
      ...(process.length ? { process: clipProcess(process) } : {}),
      result: '',
    };
    const [resp, result] = await this.#answer(m, req, process, rec, gone);
    rec.result = result;
    if (!(await this.record(null, 'vault.access', rec)))
      return { ok: false, code: Result.LogFailed, error: 'the access could not be recorded, so the values were not released' };
    if (released(result)) {
      this.touch();
      if (req.tool === VaultTool.Env) resp.run = this.runLimits();
    }
    return resp;
  }

  async #answer(
    m: string,
    req: VaultRequest,
    process: VaultProcess[],
    rec: Omit<Access, 'id'>,
    gone: AbortSignal,
  ): Promise<[VaultResponse, string]> {
    const refuse = (code: string, error: string): [VaultResponse, string] => [{ ok: false, code, error }, code];
    let s: Store;
    try {
      s = this.open();
    } catch (e) {
      return refuse('unavailable', (e as Error).message);
    }
    // The app that asked, as the machine's kernel names it: the parent of
    // the process connected to vault.sock; a name longer than an exempted
    // one can be is none (cut, it would be every name it begins).
    const app = process.length >= 2 && Buffer.byteLength(process[1].name ?? '') <= MAX_APP ? (process[1].name ?? '') : '';
    const exempt = await s.exempt(m, app);
    if (req.tool === VaultTool.List) {
      const variables = s.list().map((i) => ({
        name: i.name,
        ...(i.description ? { description: i.description } : {}),
        ...(i.injectOnly ? { inject_only: true } : {}),
        ...(!allows(i, m) && !exempt ? { approval: true } : {}),
      }));
      return [{ ok: true, ...(variables.length ? { variables } : {}) }, Result.Listed];
    }
    const given = Array.isArray(req.names) ? req.names.map(String) : [];
    if (req.tool === VaultTool.Get) {
      if (given.length !== 1) return refuse('bad_request', 'get takes one name');
    } else if (req.tool === VaultTool.Env) {
      if (!given.length || given.length > MAX_NAMES) return refuse('bad_request', 'env takes 1 to 64 names');
    } else return refuse('bad_request', 'unknown tool');
    const names = [...new Set(given)];
    rec.names = names;
    const ask: string[] = [];
    for (const n of names) {
      const i = s.get(n);
      if (!i) return refuse('not_found', `no variable ${n}`);
      if (req.tool === VaultTool.Get && i.injectOnly)
        return refuse('inject_only', `${n} can only be injected into a command (run_with_env)`);
      if (!allows(i, m)) ask.push(n);
    }
    if (s.status().locked) return refuse('vault_locked', 'the vault is locked; unlock it in the UI');
    let result: string = Result.Allowed;
    if (ask.length && exempt) result = Result.Exempted;
    else if (ask.length) {
      const answer = await this.ask(m, req, ask, process, gone);
      switch (answer) {
        case Answer.Once:
          result = Result.Approved;
          break;
        case Answer.Always:
          result = Result.ApprovedAlways;
          for (const n of ask) await s.allow(n, m).catch((e) => this.ctx.logger(`vault: allowing ${n} on ${m}: ${(e as Error).message}`));
          break;
        case 'timeout':
          return [{ ok: false, code: 'denied', error: 'nobody approved the request within the time allowed' }, Result.Expired];
        case 'gone':
          return [{ ok: false, code: 'denied', error: 'the request was cancelled' }, Result.Cancelled];
        case 'busy':
          return refuse('busy', 'too many requests of this machine wait for an answer; answer them or try again later');
        default:
          return refuse(Result.Denied, 'the user denied the request');
      }
    }
    const values: Record<string, string> = {};
    for (const n of names) {
      try {
        values[n] = await s.value(n);
      } catch (e) {
        return refuse(e instanceof Fail ? e.code : 'failed', (e as Error).message);
      }
    }
    return [{ ok: true, values }, result];
  }

  /** Shows the request on every page and waits for the first answer, the
   * timeout or the requester's leaving. An identical waiting request
   * (machine, tool, names) shares the prompt; past 4 of a machine or 32 in
   * all a request is busy. Whatever comes first decides, so a page's answer
   * that was taken is what the requesters get. */
  async ask(m: string, req: VaultRequest, names: string[], process: VaultProcess[], gone: AbortSignal): Promise<string> {
    let p = [...this.#pending.values()].find(
      (x) => x.req.m === m && x.req.tool === req.tool && x.req.names.length === names.length && names.every((n) => x.req.names.includes(n)),
    );
    const fresh = !p;
    if (!p) {
      const mine = [...this.#pending.values()].filter((x) => x.req.m === m).length;
      if (mine >= MAX_PENDING_PER_MACHINE || this.#pending.size >= MAX_PENDING) return 'busy';
      const now = Date.now();
      const expiresAt = now + this.approvalTimeout();
      const r: PendingRequest = {
        id: randomBytes(12).toString('hex'),
        m,
        tool: req.tool,
        names,
        ...(req.client ? { client: clip(req.client, 64) } : {}),
        ...(req.terminal ? { terminal: clip(req.terminal, 64) } : {}),
        ...(req.cwd ? { cwd: clip(req.cwd, 1024) } : {}),
        ...(process.length ? { process: clipProcess(process) } : {}),
        created: formatRFC3339(new Date(now)),
        expires: formatRFC3339(new Date(expiresAt)),
      };
      p = { req: r, createdAt: now, expiresAt, waiters: 0, answer: '', announced: false, wake: [] };
      this.#pending.set(r.id, p);
    }
    const pr = p;
    pr.waiters++;
    if (fresh) this.ctx.broadcast({ type: 'request', request: pr.req }, m);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onGone: (() => void) | undefined;
    const outcome = await new Promise<'done' | 'timeout' | 'gone'>((resolve) => {
      if (pr.answer) return resolve('done');
      pr.wake.push(() => resolve('done'));
      timer = setTimeout(() => resolve('timeout'), Math.max(0, pr.expiresAt - Date.now()));
      onGone = () => resolve('gone');
      if (gone.aborted) onGone();
      else gone.addEventListener('abort', onGone, { once: true });
    });
    clearTimeout(timer);
    if (onGone) gone.removeEventListener('abort', onGone);
    if (outcome === 'timeout') this.resolve(pr, 'timeout');
    if (outcome === 'gone' && --pr.waiters === 0) this.resolve(pr, Answer.Deny);
    const answer = pr.answer;
    if (answer && !pr.announced) {
      pr.announced = true;
      this.ctx.broadcast({ type: 'resolved', id: pr.req.id, answer }, m);
    }
    // This requester left: others may still wait, or it was the last.
    if (outcome === 'gone' && (!answer || answer === Answer.Deny)) return 'gone';
    return answer;
  }

  /** Gives a request its answer unless it has one. */
  resolve(p: Pending, answer: string): boolean {
    if (p.answer) return false;
    p.answer = answer;
    this.#pending.delete(p.req.id);
    for (const w of p.wake.splice(0)) w();
    return true;
  }

  /** Answers a pending request: the first answer wins; later ones, and
   * answers after it expired, find none. */
  answerRequest(id: string, answer: string): PendingRequest | undefined {
    const p = this.#pending.get(id);
    return p && this.resolve(p, answer) ? p.req : undefined;
  }

  pendingRequest(id: string): PendingRequest | undefined {
    return this.#pending.get(id)?.req;
  }

  pending(): PendingRequest[] {
    return [...this.#pending.values()].sort((a, b) => a.createdAt - b.createdAt).map((p) => p.req);
  }

  // ---- the access log and the audit

  /** Writes rec to the access log and to the audit log as event (c: a
   * page's request). A release's record is committed first: false when it
   * could not be, and the values must not leave. Lists and refusals are
   * merged and rate-limited. */
  async record(c: Ctx | null, event: string, rec: Omit<Access, 'id'>): Promise<boolean> {
    const quiet = noisy(rec.result);
    const { kept, ok } = await this.accessLog().add(rec, quiet, released(rec.result));
    const fields = accessFields(kept);
    if (!quiet || this.#auditNoisy(`${kept.m}\x00${kept.result}`, fields)) this.audit(c, event, fields);
    if (!quiet) this.#changedThrottled();
    return ok;
  }

  /** Whether a noisy record of key is audited now: the first, then one a
   * while, with the number not written since; the last of a burst is
   * written when the while is over. */
  #auditNoisy(key: string, fields: Record<string, unknown>): boolean {
    const every = this.o.noisyEveryMs ?? NOISY_EVERY;
    const at = Date.now();
    const na = this.#noisy.get(key);
    if (!na) {
      this.#noisy.set(key, { last: at, suppressed: 0 });
      return true;
    }
    if (at - na.last < every) {
      na.suppressed++;
      na.pending = fields;
      if (!na.flush && !this.#stopped)
        na.flush = setTimeout(
          () => {
            na.flush = undefined;
            if (!na.pending) return;
            const f = na.pending;
            if (na.suppressed > 1) f.suppressed = na.suppressed - 1;
            Object.assign(na, { last: Date.now(), suppressed: 0, pending: undefined });
            this.audit(null, 'vault.access', f);
          },
          every - (at - na.last),
        );
      return false;
    }
    if (na.flush) clearTimeout(na.flush);
    na.flush = undefined;
    if (na.suppressed > 0) fields.suppressed = na.suppressed;
    Object.assign(na, { last: at, suppressed: 0, pending: undefined });
    return true;
  }

  /** Makes the pages load the vault again after an access record, at most
   * once a while, the last change included. */
  #changedThrottled(): void {
    const every = this.o.changedEveryMs ?? CHANGED_EVERY;
    const wait = every - (Date.now() - this.#changedAt);
    if (wait > 0) {
      if (!this.#changedLater && !this.#stopped)
        this.#changedLater = setTimeout(() => {
          this.#changedLater = null;
          this.#changedAt = Date.now();
          this.changed();
        }, wait);
      return;
    }
    this.#changedAt = Date.now();
    this.changed();
  }

  /** The record of values a page takes (a reveal, an export). */
  pageAccess(c: Ctx, tool: string, names: string[], result: string): Omit<Access, 'id'> {
    let remote = c.env.remote ?? '';
    const fwd = c.req.header('X-Forwarded-For');
    if (fwd) remote = `${clip(fwd, 256)} via ${remote}`;
    const ua = clip(c.req.header('User-Agent'), 256);
    return {
      time: formatRFC3339(new Date()),
      m: '',
      tool,
      names,
      ...(remote ? { remote } : {}),
      ...(ua ? { userAgent: ua } : {}),
      result,
    };
  }

  /** A release whose record could not be written: the value stays. */
  failLog(): never {
    throw new Fail(Result.LogFailed, 500, 'the access could not be recorded, so the value was not released');
  }

  // ---- export and import: one file's key derivation at a time

  async fileWork<T>(c: Ctx, fn: () => Promise<T>): Promise<T> {
    if (this.#fileWork) {
      c.header('Retry-After', '1');
      throw new Fail('busy', 429, 'another file is being encrypted or read; try again in a moment');
    }
    this.#fileWork = true;
    try {
      return await fn();
    } finally {
      this.#fileWork = false;
    }
  }

  // ---- a removed machine: an id that comes back asks again

  async forgetMachine(id: string): Promise<void> {
    let s: Store;
    try {
      s = this.open();
    } catch {
      return;
    }
    try {
      const names = await s.forgetMachine(id);
      if (names.length) this.audit(null, 'vault.machine_forgotten', { machine: id, names });
    } catch (e) {
      this.ctx.logger(`vault: forgetting machine ${id}: ${(e as Error).message}`);
      return;
    }
    this.changed();
  }

  /** Ends the timers (the hub stops). */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#lockTimer) clearTimeout(this.#lockTimer);
    if (this.#changedLater) clearTimeout(this.#changedLater);
    for (const na of this.#noisy.values()) if (na.flush) clearTimeout(na.flush);
    this.#lockTimer = this.#changedLater = null;
    await this.#alog?.close();
  }

  /** Resolves workspace-linked vault presets for injection into a new
   * terminal or chat panel on machine, opened by a client of that kind.
   * Never releases values while the vault plugin is disabled for that
   * client, the vault is locked, the sealed policy is
   * tampered, or the durable access log write fails. */
  async workspaceEnv(machine: string, workspace: string, source: 'terminal' | 'chat', client: Client): Promise<WorkspaceEnvResult> {
    const empty: WorkspaceEnvResult = { presets: [], env: {}, names: [], missing: [], locked: false };
    if (!machine || !workspace) return empty;
    if (!this.ctx.enabledFor(client)) return empty;
    let s: Store;
    try {
      s = this.open();
    } catch {
      return empty;
    }
    let res: Awaited<ReturnType<Store['resolveWorkspaceEnv']>>;
    try {
      res = await s.resolveWorkspaceEnv(machine, workspace);
    } catch (e) {
      const corrupt = isCode(e, 'corrupt');
      this.ctx.logger(`vault: resolving workspace presets for ${machine}/${workspace}: ${(e as Error).message}`);
      if (corrupt) {
        await this.record(null, 'vault.access', {
          time: formatRFC3339(new Date()),
          m: machine,
          tool: source,
          client: clip(workspace, 64),
          result: 'corrupt',
        }).catch(() => {});
        return { ...empty, corrupt: true };
      }
      return empty;
    }
    if (!res.presets.length) return res;
    if (res.locked) {
      await this.record(null, 'vault.access', {
        time: formatRFC3339(new Date()),
        m: machine,
        tool: source,
        client: clip(workspace, 64),
        result: 'vault_locked',
      }).catch(() => {});
      return res;
    }
    if (res.names.length > 0) {
      const rec: Omit<Access, 'id'> = {
        time: formatRFC3339(new Date()),
        m: machine,
        tool: source,
        names: res.names,
        client: clip(workspace, 64),
        result: Result.Injected,
      };
      // Values leave only once the release record is durably written.
      if (!(await this.record(null, 'vault.injected', rec))) {
        for (const k of Object.keys(res.env)) res.env[k] = '';
        return { presets: res.presets, env: {}, names: [], missing: res.missing, locked: false, logFailed: true };
      }
      this.touch();
    }
    return res;
  }
}

export interface WorkspaceEnvResult {
  presets: string[];
  env: Record<string, string>;
  names: string[];
  missing: string[];
  locked: boolean;
  logFailed?: boolean;
  corrupt?: boolean;
}

/** An unlock as a page sends it in POST session: the desktop app's entry
 * and relay, or a credential's PRF output with its assertion. */
export interface UnlockBody {
  nonce: string;
  id?: string | null;
  relay?: string | null;
  prf?: { credential?: string | null; output?: string | null } | null;
  assertion?: ProofBody | null;
}

export interface UnlockResult {
  id: string;
  kind: string;
  /** Why a wrap that opened was refused (its secret left the authenticator). */
  reason: string;
  /** Why the entry was removed (vault.unlock_removed). */
  removed: string;
  window: Window;
  err: unknown;
}

/** The counter an assertion of authenticator a for challenge signed: one
 * that does not grow is a copy of the authenticator (those that do not
 * count always say 0). */
async function assertionCount(a: Authenticator, pb: ProofBody, challenge: Buffer): Promise<number> {
  let count: number;
  try {
    count = await verifyAssertion(a.alg ?? 0, unb64(a.publicKey), assertionOf(pb), {
      challenge,
      origin: a.origin ?? '',
      rpId: a.rpId ?? '',
    });
  } catch {
    throw proofError();
  }
  const last = a.signCount ?? 0;
  if ((count !== 0 || last !== 0) && count <= last) throw new CounterError('the counter did not grow');
  return count;
}

/** The shorter of two auto-lock times, where 0 is never (the longest). */
export function shorter(a: number, b: number): number {
  if (a <= 0) return Math.max(b, 0);
  if (b <= 0) return a;
  return Math.min(a, b);
}

const clipProcess = (ps: VaultProcess[]): VaultProcess[] =>
  ps.slice(0, MAX_VAULT_PROCESSES).map((x) => ({ pid: Number(x.pid) || 0, ...(x.name ? { name: clip(String(x.name), 64) } : {}) }));

/** An access's fields in the audit log: names, never values. */
function accessFields(a: Access): Record<string, unknown> {
  const f: Record<string, unknown> = { tool: a.tool, names: a.names ?? null, result: a.result };
  for (const [k, v] of [
    ['machine', a.m],
    ['client', a.client],
    ['terminal', a.terminal],
    ['cwd', a.cwd],
    ['user_agent', a.userAgent],
  ] as const)
    if (v) f[k] = v;
  if (a.process?.length) f.process = a.process;
  return f;
}

/** p, or a failure after ms. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error('timed out')), ms)))]).finally(() =>
    clearTimeout(t),
  );
}
