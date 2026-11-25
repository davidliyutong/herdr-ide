// The limits' requests: to the providers' fixed hosts with fetch, which
// goes through the proxy of HTTPS_PROXY / HTTP_PROXY unless NO_PROXY names
// the host (Bun's fetch reads them from the agent's environment at each
// request), keeps its connections for the next poll, follows no redirect
// (a 3xx is an error, http_<n>, so credentials reach the fixed hosts
// only), times out after UsageTiming.requestMs and reads at most MAX_BODY
// of an answer; and to Antigravity's language server on 127.0.0.1 only,
// through no proxy, its own certificate accepted there alone.
//
// No error carries a request's headers or an answer's body: they hold
// tokens.
import * as http from 'node:http';
import * as https from 'node:https';
import { isObj, type Account, type UsageEnv } from './env.ts';

/** Bounds a provider's answer. */
export const MAX_BODY = 4 << 20;

/** A request that failed: code for the account (network, unauthorized,
 * rate_limited, http_<n>, bad_response), retryAfter in seconds for a 429. */
export class HttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number;

  constructor(code: string, status = 0, retryAfter = 0) {
    super(code);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Reads at most max bytes of a response's body; null when it breaks off.
 * Past max the rest is not read (the answer then does not decode). */
async function bodyOf(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = max - n;
      parts.push(value.length > room ? value.subarray(0, room) : value);
      n += Math.min(value.length, room);
      if (n >= max) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    return null;
  }
  return Buffer.concat(parts);
}

/** The JSON object of a body; undefined when it is none. */
function objectOf(b: Buffer): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(b.toString('utf8'));
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Asks url and returns the JSON object it answers; HttpError otherwise. */
export async function getJSON(
  e: UsageEnv,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', 'User-Agent': 'usage-monitor', ...headers },
      body,
      redirect: 'manual',
      signal: AbortSignal.any([e.signal, AbortSignal.timeout(e.t.requestMs)]),
    });
  } catch {
    throw new HttpError('network');
  }
  const data = await bodyOf(res, MAX_BODY);
  if (data === null) throw new HttpError('network');
  if (res.status === 401 || res.status === 403) throw new HttpError('unauthorized', res.status);
  if (res.status === 429) throw new HttpError('rate_limited', res.status, retryAfter(res.headers.get('Retry-After') ?? '', e.now()));
  if (res.status < 200 || res.status > 299) throw new HttpError(`http_${res.status}`, res.status);
  const m = objectOf(data);
  if (!m) throw new HttpError('bad_response');
  return m;
}

/** Posts a form to url and returns the status and the JSON object it
 * answers ({} when it is none). The request is not ended with the poll
 * once sent (UsageEnv.signal is not its): an answer that spends a refresh
 * token must be read. Network failures are HttpError network. */
export async function postForm(
  e: UsageEnv,
  url: string,
  headers: Record<string, string>,
  form: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form,
      redirect: 'manual',
      signal: AbortSignal.timeout(e.t.requestMs),
    });
  } catch {
    throw new HttpError('network');
  }
  const data = await bodyOf(res, 1 << 20);
  if (data === null) throw new HttpError('network');
  return { status: res.status, body: objectOf(data) ?? {} };
}

/** Reads a Retry-After header (seconds or an HTTP date): 60 s when it says
 * nothing usable, at most a day. now in ms. */
export function retryAfter(h: string, now: number): number {
  h = h.trim();
  let s = 60;
  if (/^\d+$/.test(h) && Number(h) > 0) s = Number(h);
  else if (h !== '' && !/^\d+$/.test(h)) {
    const t = Date.parse(h);
    if (!Number.isNaN(t) && Math.trunc((t - now) / 1000) > 0) s = Math.trunc((t - now) / 1000);
  }
  return Math.min(s, 86_400);
}

/** a marked with the error of a request. */
export function failed(a: Account, err: unknown): Account {
  if (!(err instanceof HttpError)) return { ...a, status: 'error', code: 'failed' };
  if (err.code === 'unauthorized') return { ...a, status: 'unauth', code: err.code };
  return { ...a, status: 'error', code: err.code, retryAfter: err.retryAfter || undefined };
}

/** Posts body to the local language server on 127.0.0.1:port, whatever a
 * URL would name, through no proxy (node:http dials the address itself),
 * its self-signed certificate accepted (over https: on loopback only), no
 * connection kept; the JSON object it answers, or HttpError (network when
 * it could not be asked). */
export function localPost(
  port: number,
  scheme: 'https' | 'http',
  path: string,
  headers: Record<string, string>,
  body: string,
  ms: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const o: https.RequestOptions = {
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { Accept: 'application/json', 'User-Agent': 'usage-monitor', ...headers, 'Content-Length': Buffer.byteLength(body) },
      agent: false,
      timeout: ms,
    };
    let settled = false;
    const done = (f: () => void) => {
      if (!settled) {
        settled = true;
        f();
      }
    };
    const onResponse = (res: http.IncomingMessage) => {
      const parts: Buffer[] = [];
      let n = 0;
      res.on('data', (d: Buffer) => {
        if (n < MAX_BODY) parts.push(d.subarray(0, MAX_BODY - n));
        n += d.length;
      });
      res.on('error', () => done(() => reject(new HttpError('network'))));
      res.on('end', () =>
        done(() => {
          const st = res.statusCode ?? 0;
          if (st < 200 || st > 299) return reject(new HttpError(`http_${st}`, st));
          const m = objectOf(Buffer.concat(parts));
          return m ? resolve(m) : reject(new HttpError('bad_response'));
        }),
      );
    };
    const req = scheme === 'https' ? https.request({ ...o, rejectUnauthorized: false }, onResponse) : http.request(o, onResponse);
    const timer = setTimeout(() => req.destroy(new Error('timeout')), ms);
    req.on('close', () => clearTimeout(timer));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => done(() => reject(new HttpError('network'))));
    req.end(body);
  });
}
