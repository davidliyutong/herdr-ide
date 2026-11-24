// The two loopback addresses of a host: the name "localhost" leads to
// 127.0.0.1 and to ::1, and a browser tries either first. A program that
// listens on one of them for a port leaves the other to whoever takes it,
// who then answers under the same name and port.
import { createServer, isIPv4, isIPv6, type AddressInfo, type Server } from 'node:net';

/** Windows' sockets report their own codes (WSAEAFNOSUPPORT,
 * WSAEADDRINUSE, WSAEADDRNOTAVAIL) where others report EAFNOSUPPORT,
 * EADDRINUSE and EADDRNOTAVAIL. libuv maps them to the same codes, so a
 * Node error has the POSIX code; an error that carries the raw Windows
 * number is mapped here. */
const wsa: Record<number, string> = { 10047: 'EAFNOSUPPORT', 10048: 'EADDRINUSE', 10049: 'EADDRNOTAVAIL' };

/** The system error codes of err and of the errors it wraps (cause,
 * AggregateError's errors), as Go's errors.Is looks through wrapping. */
function codes(err: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (!err || typeof err !== 'object' || depth > 8) return out;
  const e = err as { code?: unknown; errno?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === 'string') out.add(e.code);
  if (typeof e.errno === 'number' && wsa[e.errno]) out.add(wsa[e.errno]);
  codes(e.cause, out, depth + 1);
  if (Array.isArray(e.errors)) for (const x of e.errors) codes(x, out, depth + 1);
  return out;
}

/** Whether err says that another program holds the address. */
export function inUse(err: unknown): boolean {
  return codes(err).has('EADDRINUSE');
}

/** Whether err says that the host has no such address or no such family
 * of addresses: nobody listens there. */
export function noAddress(err: unknown): boolean {
  const c = codes(err);
  return c.has('EADDRNOTAVAIL') || c.has('EAFNOSUPPORT');
}

/** Listens on host and port; resolves with the listener once it listens. */
export type Listen<T> = (host: string, port: number) => Promise<T>;

/** Listens with a net.Server of its own on host (an IPv6 address only on
 * IPv6) and port. */
export const listenTCP: Listen<Server> = (host, port) =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen({ host, port, ipv6Only: host.includes(':'), exclusive: true }, () => {
      s.off('error', reject);
      resolve(s);
    });
  });

/** What other found: the second listener, whether "localhost" leads to
 * this program, and why not. */
export interface OtherResult<T> {
  other: T | null;
  owned: boolean;
  err?: Error;
}

/** Listens on the other loopback address for the port of addr, the
 * address of a listener on 127.0.0.1 or ::1 (a server's address()). owned
 * says whether "localhost" with that port then leads to this program
 * whichever address is tried: true with the second listener, and when the
 * host has no such address or family (noAddress: nobody listens there).
 * Any other failure leaves the address to whoever holds or takes it:
 * owned is false and err says why (inUse when another program holds it).
 * A listener that is not on a loopback address has no other one: false,
 * without an error. */
export async function other<T = Server>(addr: AddressInfo | string | null, listen?: Listen<T>): Promise<OtherResult<T>> {
  if (!addr || typeof addr === 'string') return { other: null, owned: false };
  const family = loopbackFamily(addr.address);
  if (family === null) return { other: null, owned: false };
  const host = family === 4 ? '::1' : '127.0.0.1';
  try {
    const l = await (listen ?? (listenTCP as unknown as Listen<T>))(host, addr.port);
    return { other: l, owned: true };
  } catch (e) {
    if (noAddress(e)) return { other: null, owned: true };
    return { other: null, owned: false, err: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** 4 or 6 for a loopback address of that family (an IPv4-mapped one is of
 * IPv4), null for any other address. */
export function loopbackFamily(address: string): 4 | 6 | null {
  const a = address.replace(/%.*$/, ''); // a zone
  if (isIPv4(a)) return a.startsWith('127.') ? 4 : null;
  if (!isIPv6(a)) return null;
  const groups = expandIPv6(a);
  if (groups === null) return null;
  // ::ffff:a.b.c.d
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return groups[6] >> 8 === 127 ? 4 : null;
  return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1 ? 6 : null;
}

/** The eight 16-bit groups of IPv6 address a (which isIPv6 accepted). */
function expandIPv6(a: string): number[] | null {
  let s = a;
  const tail: number[] = [];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    tail.push((Number(v4[1]) << 8) | Number(v4[2]), (Number(v4[3]) << 8) | Number(v4[4]));
    s = s.slice(0, v4.index) + '0'; // a placeholder group, dropped below
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const h = parse(head);
  const r = rest === undefined ? [] : parse(rest);
  if (v4) (rest === undefined ? h : r).pop();
  const fill = 8 - tail.length - h.length - r.length;
  if (fill < 0 || (rest === undefined && fill !== 0)) return null;
  return [...h, ...new Array<number>(fill).fill(0), ...r, ...tail];
}
