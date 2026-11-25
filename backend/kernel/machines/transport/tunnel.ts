// HTTPS through a stream the caller opens to host:port: an ssh stdio forward
// through a machine (`ssh -W`, ssh.ts sshTunnel), for a core that cannot
// reach its release directly. The TLS is this process's, end to end: the
// server's certificate is verified against the host name as fetch verifies
// it, so the machine and its network carry bytes they can neither read nor
// change. A GET of a small file only (the release's SHA256SUMS), following
// a few redirects, each to an https URL.
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';

/** Opens a byte stream to host:port. */
export type OpenStream = (host: string, port: number) => Promise<Duplex>;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Bounds a response's head. */
const MAX_HEAD = 64 << 10;

export interface TunnelGetOptions {
  /** Bounds the body. */
  max: number;
  /** Bounds each request, from opening the stream to the last byte. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Certificate authorities in place of the default ones (tests). */
  ca?: string | Buffer;
  userAgent?: string;
}

/** The body of url, a 200 answer, through streams open() gives. */
export async function tunnelGet(url: string, open: OpenStream, o: TunnelGetOptions): Promise<Buffer> {
  let u = new URL(url);
  for (let hop = 0; hop <= 5; hop++) {
    if (u.protocol !== 'https:') throw new Error(`${u.href}: not an https URL`);
    const r = await exchange(u, await open(u.hostname, Number(u.port || 443)), o);
    if (REDIRECTS.has(r.status)) {
      const to = r.headers.get('location');
      if (!to) throw new Error(`${u.href}: ${r.status} without a location`);
      u = new URL(to, u);
      continue;
    }
    if (r.status !== 200) throw new Error(`${u.href}: ${r.status}`);
    return r.body;
  }
  throw new Error(`${url}: too many redirects`);
}

interface Answer {
  status: number;
  headers: Map<string, string>;
  body: Buffer;
}

/** One GET over TLS on raw: the answer, its body bounded. */
function exchange(u: URL, raw: Duplex, o: TunnelGetOptions): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    let t: TLSSocket | undefined;
    let done = false;
    const finish = (e: Error | null, a?: Answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', abort);
      t?.destroy();
      raw.destroy();
      if (e) reject(e);
      else resolve(a!);
    };
    const timer = setTimeout(() => finish(new Error(`${u.href}: no answer within ${o.timeoutMs} ms`)), o.timeoutMs);
    const abort = () => finish((o.signal?.reason as Error) ?? new Error('aborted'));
    if (o.signal?.aborted) return abort();
    o.signal?.addEventListener('abort', abort, { once: true });
    raw.on('error', (e) => finish(e));
    t = tlsConnect({ socket: raw, servername: u.hostname, ALPNProtocols: ['http/1.1'], ...(o.ca ? { ca: o.ca } : {}) });
    t.on('error', (e) => finish(e));
    const parts: Buffer[] = [];
    let n = 0;
    t.once('secureConnect', () => {
      t!.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: ${o.userAgent ?? 'release-manifest'}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
      );
    });
    t.on('data', (c: Buffer) => {
      n += c.length;
      if (n > o.max + MAX_HEAD) return finish(new Error(`${u.href} is larger than ${o.max} bytes`));
      parts.push(c);
    });
    t.on('end', () => {
      try {
        finish(null, parse(Buffer.concat(parts), u, o.max));
      } catch (e) {
        finish(e as Error);
      }
    });
    t.on('close', () => finish(new Error(`${u.href}: the connection closed before an answer`)));
  });
}

/** An HTTP/1.1 answer read to its end (Connection: close). */
function parse(all: Buffer, u: URL, max: number): Answer {
  const end = all.indexOf('\r\n\r\n');
  if (end < 0 || end > MAX_HEAD) throw new Error(`${u.href}: not an HTTP answer`);
  const [statusLine, ...lines] = all.subarray(0, end).toString('latin1').split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine ?? '');
  if (!m) throw new Error(`${u.href}: not an HTTP answer`);
  const headers = new Map<string, string>();
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i > 0) headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
  }
  let body = all.subarray(end + 4);
  if (/\bchunked\b/i.test(headers.get('transfer-encoding') ?? '')) body = unchunk(body, u);
  else if (headers.has('content-length')) {
    const len = Number(headers.get('content-length'));
    if (!Number.isSafeInteger(len) || len < 0 || len > body.length) throw new Error(`${u.href}: a truncated answer`);
    body = body.subarray(0, len);
  }
  if (body.length > max) throw new Error(`${u.href} is larger than ${max} bytes`);
  return { status: Number(m[1]), headers, body: Buffer.from(body) };
}

/** A chunked body decoded. */
function unchunk(b: Buffer, u: URL): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  for (;;) {
    const eol = b.indexOf('\r\n', i);
    if (eol < 0) throw new Error(`${u.href}: a truncated answer`);
    const size = parseInt(b.subarray(i, eol).toString('latin1').split(';')[0]!, 16);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${u.href}: a malformed chunk`);
    if (size === 0) return Buffer.concat(out);
    if (eol + 2 + size > b.length) throw new Error(`${u.href}: a truncated answer`);
    out.push(b.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
}
