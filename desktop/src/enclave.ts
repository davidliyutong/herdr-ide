// The Secure Enclave helper (desktop/helper/Enclave.swift), a small app
// bundle inside the desktop app's Contents/Helpers, so that the Touch ID
// sheet names it. It holds no state: it makes a Secure Enclave key that
// needs the current set of enrolled fingerprints and answers its blob and
// public key, and later, after a Touch ID prompt, the ECDH secret of that
// key and a peer's public key. The shell runs it by its absolute path inside
// the app (never through PATH), with one JSON line on stdin and one on
// stdout, each bounded, within a timeout, one prompt at a time. Anything but
// the exact answers below is a failure.
import { spawn as spawnProcess } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { APP_NAME } from '../../web/src/brand';
import { fromBase64url } from './relay';

/** How long a run may take (a Touch ID prompt waits for the user). */
export const HELPER_TIMEOUT_MS = 2 * 60_000;
/** The most a run may write on stdout, and the most a request may be. */
export const HELPER_MAX_OUTPUT = 64 * 1024;

/** The helper's bundle name, also the name the Touch ID sheet shows. */
export const HELPER_NAME = `${APP_NAME} Enclave`;

/** The helper's executable: in the packaged app's Contents/Helpers (beside
 * Contents/Resources), or where desktop/build.mjs puts it for unpackaged
 * development (desktop/dist/helper). */
export function helperPath(resources: string | undefined, appPath: string): string {
  const bundle = `${HELPER_NAME}.app`;
  const base = resources ? join(resources, '..', 'Helpers', bundle) : join(appPath, 'dist', 'helper', bundle);
  return join(base, 'Contents', 'MacOS', HELPER_NAME);
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutput: number;
  spawn?: typeof spawnProcess;
}

/** Runs file (an absolute path) with input on stdin; its stdout. Rejects on
 * a relative path, a timeout, more output than maxOutput or a non-zero
 * exit, and kills the process when it gives up on it. */
export function runBounded(file: string, args: string[], input: string, o: RunOptions): Promise<string> {
  if (!isAbsolute(file)) return Promise.reject(new Error('not an absolute path'));
  return new Promise((resolve, reject) => {
    const child = (o.spawn ?? spawnProcess)(file, args, {
      env: o.env ?? process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error: Error | undefined, out?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(out!);
    };
    const timer = setTimeout(() => finish(new Error('timeout')), o.timeoutMs);
    child.stdout!.on('data', (data: Buffer) => {
      size += data.length;
      if (size > o.maxOutput) return finish(new Error('too much output'));
      chunks.push(data);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish(undefined, Buffer.concat(chunks).toString('utf8'));
      else finish(new Error(`exit ${code}`));
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
  });
}

/** Runs the helper with one request line; its stdout. */
export type RunHelper = (input: string) => Promise<string>;

/** The helper at file, run with the bounds above. */
export function helperRunner(file: string): RunHelper {
  return (input) => runBounded(file, [], input, { timeoutMs: HELPER_TIMEOUT_MS, maxOutput: HELPER_MAX_OUTPUT });
}

/** Why an agreement gave no secret: the user cancelled, the key no longer
 * works (the enrolled fingerprints changed, a blob the Enclave does not
 * open), there is no Enclave or no Touch ID, anything else. */
export type AgreeError = 'cancel' | 'invalidated' | 'unavailable' | 'failed';
export type AgreeResult = { ok: true; secret: Buffer } | { ok: false; error: AgreeError };

export interface Enclave {
  /** Whether the Mac has a Secure Enclave and Touch ID with fingerprints. */
  available(): Promise<{ enclave: boolean; biometry: boolean }>;
  /** A new key (no prompt): its blob and its public key (X9.63, 65 bytes);
   * null on any failure or while another run prompts. */
  create(): Promise<{ blob: Buffer; pub: Buffer } | null>;
  /** After a Touch ID prompt with reason: the ECDH secret (32 bytes) of the
   * blob's key and peer (X9.63). */
  agree(blob: Buffer, peer: Buffer, reason: string): Promise<AgreeResult>;
}

/** The most a key blob may be. */
export const MAX_BLOB = 3 * 1024;
const AGREE_ERRORS: readonly string[] = ['cancel', 'invalidated', 'unavailable', 'failed'];

/** A P-256 public key in X9.63 uncompressed form. */
export const isX963 = (b: Buffer | null): b is Buffer => !!b && b.length === 65 && b[0] === 4;

/** The answer's object, when it is one JSON object with exactly keys. */
function answer(out: string, keys: string[]): Record<string, unknown> | undefined {
  const line = out.endsWith('\n') ? out.slice(0, -1) : out;
  if (line.includes('\n')) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const got = Object.keys(v).sort();
  const want = [...keys].sort();
  return got.length === want.length && got.every((k, i) => k === want[i]) ? (v as Record<string, unknown>) : undefined;
}

/** The helper through run. */
export function enclaveFor(run: RunHelper): Enclave {
  let busy = false;
  const ask = async (request: object): Promise<string | undefined> => {
    try {
      return await run(JSON.stringify(request) + '\n');
    } catch {
      return undefined;
    }
  };
  return {
    async available() {
      const a = answer((await ask({ op: 'available' })) ?? '', ['ok', 'enclave', 'biometry']);
      if (!a || a.ok !== true || typeof a.enclave !== 'boolean' || typeof a.biometry !== 'boolean')
        return { enclave: false, biometry: false };
      return { enclave: a.enclave, biometry: a.biometry };
    },
    async create() {
      if (busy) return null;
      busy = true;
      try {
        const a = answer((await ask({ op: 'create' })) ?? '', ['ok', 'blob', 'pub']);
        if (!a || a.ok !== true) return null;
        const blob = fromBase64url(a.blob, MAX_BLOB);
        const pub = fromBase64url(a.pub, 65);
        return blob && blob.length > 0 && isX963(pub) ? { blob, pub } : null;
      } finally {
        busy = false;
      }
    },
    async agree(blob, peer, reason) {
      if (busy || blob.length === 0 || blob.length > MAX_BLOB || !isX963(peer)) return { ok: false, error: 'failed' };
      busy = true;
      try {
        const out = (await ask({ op: 'agree', blob: blob.toString('base64url'), peer: peer.toString('base64url'), reason })) ?? '';
        const ok = answer(out, ['ok', 'secret']);
        if (ok) {
          const secret = fromBase64url(ok.secret, 32);
          return ok.ok === true && secret?.length === 32 ? { ok: true, secret } : { ok: false, error: 'failed' };
        }
        const no = answer(out, ['ok', 'error']);
        if (no && no.ok === false && typeof no.error === 'string' && AGREE_ERRORS.includes(no.error)) {
          return { ok: false, error: no.error as AgreeError };
        }
        return { ok: false, error: 'failed' };
      } finally {
        busy = false;
      }
    },
  };
}
