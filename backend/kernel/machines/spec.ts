// What a machine is to the core: its record (Spec), and what the pages see
// of it (State).
import type { Info } from '#shared/proto/agentproto/index.ts';

/** The id of the machine the core runs on. */
export const LOCAL_ID = 'local';

export type Kind = 'local' | 'ssh';

/** One machine: the record the core keeps in its machines file. */
export interface Spec {
  id: string;
  label: string;
  kind: Kind;
  /** An ssh machine's target as configured; absent for the local one. */
  target?: string;
  enabled: boolean;
}

export type Status = 'connecting' | 'ready' | 'auth_required' | 'error' | 'disabled';

/** Why a machine in error is never dialed. */
export const Unusable = {
  /** A stored ssh target validTarget refuses. */
  InvalidTarget: 'invalid_target',
  /** The local machine where no agent runs (Windows). */
  LocalUnsupported: 'local_unsupported',
} as const;

/** What the core's connection to a machine's terminal core is doing. */
export interface HCState {
  state: 'starting' | 'ready' | 'error';
  code?: string;
  version?: string;
}

/** What the pages see of one machine (the /ws machine messages). */
export interface State extends Spec {
  status: Status;
  /** Why a machine in error is never dialed (Unusable). */
  code?: string;
  /** What ssh or the agent said when a connection failed. */
  error?: string;
  platform?: string;
  info?: Info;
  hc?: HCState;
  /** Milliseconds since the epoch. */
  updated_at: number;
}

export const MAX_TARGET_LEN = 255;

const ASCII_OK = /^[A-Za-z0-9#%+,\-./:=@[\]^_~]$/;
const UNICODE_OK = /^[\p{L}\p{M}\p{N}]$/u;

/** An ssh target the core passes to ssh: a ~/.ssh/config alias, host,
 * user@host, ssh:// URL or IPv6 literal, of at most MAX_TARGET_LEN bytes of
 * UTF-8, not starting with "-" (which ssh would read as an option; every
 * ssh command also puts "--" before it). Its characters are ASCII letters,
 * digits and # % + , - . / : = @ [ ] ^ _ ~, and outside ASCII Unicode
 * letters, marks and numbers: no whitespace, control or format character
 * and no shell metacharacter. spec/vectors/machines/targets.json holds the
 * vectors the web UI's check runs too. */
export function validTarget(t: string): boolean {
  if (t === '' || t.startsWith('-') || Buffer.byteLength(t, 'utf8') > MAX_TARGET_LEN) return false;
  for (const ch of t) {
    if (ch.charCodeAt(0) < 0x80 ? !ASCII_OK.test(ch) : !UNICODE_OK.test(ch)) return false;
  }
  return true;
}

/** The local machine, the stored ssh machines and the extra (--ssh) ones
 * not stored, each once. The local machine's stored record gives its
 * enabled flag and, when it has one, its label (else the host's name).
 * Stored machines whose target validTarget refuses are kept (they show an
 * error and are never dialed); extra ones are left out (the core refuses
 * to start with one). */
export function loadSpecs(stored: readonly Spec[], extra: readonly Partial<Spec>[], hostname: string): Spec[] {
  const local: Spec = { id: LOCAL_ID, label: `${hostname.replace(/\.local$/, '')} (local)`, kind: 'local', enabled: true };
  const specs: Spec[] = [local];
  const seen = new Set([LOCAL_ID]);
  for (const s of stored) {
    if (s.id === LOCAL_ID) {
      local.enabled = s.enabled;
      if (s.label) local.label = s.label;
      continue;
    }
    if (seen.has(s.id) || s.kind !== 'ssh') continue;
    specs.push(s);
    seen.add(s.id);
  }
  for (const e of extra) {
    const target = e.target ?? '';
    const id = e.id || target;
    if (seen.has(id) || !validTarget(target)) continue;
    specs.push({ id, label: e.label || target, kind: 'ssh', target, enabled: e.enabled ?? true });
    seen.add(id);
  }
  return specs;
}

/** ids sorted by order: those order names first, in its order, then the
 * others as they were. */
export function sortByOrder(ids: readonly string[], order: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of order) if (ids.includes(id) && !out.includes(id)) out.push(id);
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}
