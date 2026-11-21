// The proof of the user's presence for the variable vault (the core's
// internal/plugins/vault/proof.go): the page hands over a nonce, this shell
// asks the core what the nonce is for, shows that in the system's prompt
// (Touch ID, Windows Hello) and, once the user answered it, signs the nonce
// with the key of this launch. The text of the prompt comes from the core's
// answer, never from the page, so a page cannot show the user one thing and
// have another signed. The key stays in the main process's memory.
import { createHmac } from 'node:crypto';
import type { MessageKey } from '../../web/src/i18n/en';
import type { Platform } from './platform';

/** What a nonce is for, as the core tells it. */
export interface Purpose {
  for: 'session' | 'register' | 'answer' | 'reveal' | 'change';
  /** The request an answer is for; with `answer` only. `target` is the
   * machine's ssh address, empty for the local machine. */
  request?: { id: string; machine: string; target: string; tool: string; names: string[] };
  answer?: 'once' | 'always';
  /** The variable a reveal or a change is for. */
  name?: string;
}

export interface HelloPrompt {
  available(): Promise<boolean>;
  request(message: string): Promise<boolean>;
}

export interface VerifyDeps {
  platform: Platform;
  canPromptTouchID(): boolean;
  promptTouchID(reason: string): Promise<void>;
  hello: HelloPrompt;
  /** The JSON of GET /api/p/vault/proof/{nonce}; undefined when the core
   * does not know the nonce. */
  purpose(nonce: string): Promise<unknown>;
  t(key: MessageKey, vars?: Record<string, string>): string;
}

export interface Verifier {
  available(): Promise<'touchid' | 'hello' | null>;
  /** The proof's MAC (hex), or null: anything invalid, an unknown nonce, a
   * prompt that was cancelled or failed, or another prompt being open. */
  prove(nonce: unknown): Promise<string | null>;
}

const NONCE = /^[A-Za-z0-9_-]{20,128}$/;
const MAX_NAMES = 16;
/** Bounds on user-chosen text before it goes into a prompt. */
const MAX_MACHINE = 60;
const MAX_TARGET = 60;
/** A variable's name as the core allows it, at most this long in a prompt. */
const MAX_NAME = 64;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAMES_TEXT = 120;

/** The proof's MAC: the core's proofMessage, signed with HMAC-SHA-256. The
 * request's place is the request's id for an answer and the variable's name
 * for a reveal or a change. */
export function proofMac(key: string, nonce: string, p: Purpose): string {
  const message = 'vault-proof\n' + nonce + '\n' + p.for + '\n' + (p.request?.id ?? p.name ?? '') + '\n' + (p.answer ?? '');
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(message).digest('hex');
}

const isString = (v: unknown): v is string => typeof v === 'string';

/** The purpose as the core sent it, or undefined when its shape is not
 * exactly one the core sends. */
function parsePurpose(value: unknown): Purpose | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.for === 'session' || v.for === 'register') {
    // The core sends an empty answer here; nothing else belongs to these.
    if (v.request !== undefined || v.name !== undefined || (v.answer !== undefined && v.answer !== '')) return undefined;
    return { for: v.for };
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

/** The verifier of a launch; without a key it has no way. */
export function verifier(key: string, deps: VerifyDeps): Verifier {
  let busy = false;
  const available: Verifier['available'] = async () => {
    if (!key) return null;
    if (deps.platform === 'darwin') return deps.canPromptTouchID() ? 'touchid' : null;
    if (deps.platform === 'win32') return (await deps.hello.available()) ? 'hello' : null;
    return null;
  };
  return {
    available,
    async prove(nonce) {
      if (typeof nonce !== 'string' || !NONCE.test(nonce) || !key || busy) return null;
      // One prompt at a time, from the moment the purpose is fetched.
      busy = true;
      try {
        const kind = await available();
        if (!kind) return null;
        const p = parsePurpose(await deps.purpose(nonce));
        if (!p) return null;
        const text = promptText(p, deps.platform, deps.t);
        if (kind === 'touchid') await deps.promptTouchID(text);
        else if (!(await deps.hello.request(text))) return null;
        return proofMac(key, nonce, p);
      } catch {
        return null;
      } finally {
        busy = false;
      }
    },
  };
}
