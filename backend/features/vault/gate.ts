// The vault's gate in memory: the pages' sessions, the nonces proofs
// answer, the wait after wrong passphrases, and the clock its limits count
// by. Nothing here is written anywhere: a restart ends every session.
import { randomBytes } from 'node:crypto';

/** A moment by two clocks: the wall clock, which goes on while the
 * computer sleeps, and the monotonic clock, which is never set back. The
 * vault's limits count by the one that says longer. */
export interface Stamp {
  wall: number;
  mono: number;
}
export const since = (s: Stamp, now: Stamp) => Math.max(now.wall - s.wall, now.mono - s.mono);

export interface Purpose {
  for: string;
  /** For an answer: the request; for a reveal or a change: the variable. */
  request?: string;
  answer?: string;
}
export const samePurpose = (a: Purpose, b: Purpose) =>
  a.for === b.for && (a.request ?? '') === (b.request ?? '') && (a.answer ?? '') === (b.answer ?? '');

export interface Nonce {
  purpose: Purpose;
  challenge: Buffer;
  issued: Stamp;
  seq: number;
  /** Issued while the vault was locked: for an unlock only. */
  locked: boolean;
  /** A registration's: the salt a new credential's PRF is evaluated with,
   * the challenge the desktop app's Windows Hello key signs. */
  prfSalt?: Buffer;
  register?: Buffer;
}

interface Session {
  started: Stamp;
  used: Stamp;
  /** An authenticator opened it, not the passphrase. */
  proof: boolean;
}

export const PROOF_TTL = 120_000;
const MAX_PROOFS = 32;
const MAX_SESSIONS = 32;
const FAIL_FREE = 3;
const MAX_BACKOFF = 300_000;

export class Gate {
  readonly at: () => Stamp;
  #sessions = new Map<string, Session>();
  /** Bumped when every session ends (a lock, a new passphrase): a check
   * that crossed it opens none. */
  #epoch = 0;
  #proofs = new Map<string, Nonce>();
  #seq = 0;
  #fails = 0;
  #waitUntil = 0;
  #guessing = false;

  constructor(at: () => Stamp) {
    this.at = at;
  }

  get epoch(): number {
    return this.#epoch;
  }

  /** Whether token is an open session, and whether a proof opened it; use
   * marks it used. */
  session(token: string, limits: { idle: number; most: number }, use: boolean): { open: boolean; byProof: boolean } {
    const s = token ? this.#sessions.get(token) : undefined;
    const now = this.at();
    if (!s || since(s.used, now) > limits.idle || since(s.started, now) > limits.most) {
      if (s) this.#sessions.delete(token);
      return { open: false, byProof: false };
    }
    if (use) s.used = now;
    return { open: true, byProof: s.proof };
  }

  /** A new session's token, unless the sessions ended since epoch (""); the
   * oldest goes past the bound. */
  open(epoch: number, limits: { idle: number; most: number }, byProof: boolean): string {
    if (epoch !== this.#epoch) return '';
    const now = this.at();
    for (const [k, s] of this.#sessions)
      if (since(s.used, now) > limits.idle || since(s.started, now) > limits.most) this.#sessions.delete(k);
    if (this.#sessions.size >= MAX_SESSIONS) {
      let oldest = '';
      for (const [k, s] of this.#sessions)
        if (!oldest || since(s.started, now) > since(this.#sessions.get(oldest)!.started, now)) oldest = k;
      this.#sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('hex');
    this.#sessions.set(token, { started: now, used: now, proof: byProof });
    return token;
  }

  end(token: string): void {
    this.#sessions.delete(token);
  }

  /** Ends every session and nonce; returns the new epoch. */
  endAll(): number {
    this.#sessions.clear();
    this.#proofs.clear();
    return ++this.#epoch;
  }

  /** A nonce for purpose, issued while the vault is locked or not; the
   * oldest waiting gives way past the bound. */
  issue(purpose: Purpose, locked: boolean): [string, Nonce] {
    const challenge = randomBytes(32);
    const now = this.at();
    let oldest: string | undefined;
    for (const [k, n] of this.#proofs) {
      if (since(n.issued, now) > PROOF_TTL) this.#proofs.delete(k);
      else if (!oldest) oldest = k;
      else {
        const o = this.#proofs.get(oldest)!;
        const d = since(n.issued, now);
        const od = since(o.issued, now);
        if (d > od || (d === od && n.seq < o.seq)) oldest = k;
      }
    }
    if (this.#proofs.size >= MAX_PROOFS && oldest) this.#proofs.delete(oldest);
    const n: Nonce = { purpose, challenge, issued: now, seq: ++this.#seq, locked };
    if (purpose.for === 'register') {
      n.prfSalt = randomBytes(32);
      n.register = randomBytes(32);
    }
    const nonce = challenge.toString('base64url');
    this.#proofs.set(nonce, n);
    return [nonce, n];
  }

  /** Ends a nonce and returns it when it was issued for want, while the
   * vault was locked as locked says, and is not too old: one try. */
  take(nonce: string, want: Purpose, locked: boolean): Nonce | undefined {
    const n = this.#proofs.get(nonce);
    if (!n) return undefined;
    this.#proofs.delete(nonce);
    if (since(n.issued, this.at()) > PROOF_TTL || !samePurpose(n.purpose, want) || n.locked !== locked) return undefined;
    return n;
  }

  /** A nonce that still waits. */
  peek(nonce: string): Nonce | undefined {
    const n = this.#proofs.get(nonce);
    return n && since(n.issued, this.at()) <= PROOF_TTL ? n : undefined;
  }

  /** Ends the nonces issued while the vault was locked (it was unlocked). */
  dropLockedNonces(): void {
    for (const [k, n] of this.#proofs) if (n.locked) this.#proofs.delete(k);
  }

  /** Reserves the one passphrase check that may run: the wait (0 while
   * another check runs) when it may not now. */
  beginGuess(now: number): { ok: boolean; wait: number } {
    const wait = this.#waitUntil - now;
    if (wait > 0) return { ok: false, wait };
    if (this.#guessing) return { ok: false, wait: 0 };
    this.#guessing = true;
    return { ok: true, wait: 0 };
  }

  /** Ends a check with its outcome: wrong ones in a row past the free ones
   * double the next wait, up to 5 minutes; other failures count as
   * neither. */
  tried(ok: boolean, wrong: boolean, now: number): void {
    this.#guessing = false;
    if (ok) {
      this.#fails = 0;
      this.#waitUntil = 0;
    } else if (wrong && ++this.#fails > FAIL_FREE) {
      this.#waitUntil = now + Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(this.#fails - FAIL_FREE - 1, 16));
    }
  }
}
