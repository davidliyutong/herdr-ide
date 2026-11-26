import { expect, test } from 'bun:test';
import type { AddressInfo, Server } from 'node:net';
import { inUse, listenTCP, loopbackFamily, noAddress, other, type Listen } from './loopback.ts';

const close = (s: Server | null) => new Promise<void>((r) => (s ? s.close(() => r()) : r()));
const addr = (s: Server) => s.address() as AddressInfo;

async function hasIPv6(): Promise<boolean> {
  try {
    await close(await listenTCP('::1', 0));
    return true;
  } catch {
    return false;
  }
}

// The other loopback address of a listener's port is taken, so "localhost"
// leads here; held by another program it is not, and the caller is told.
test.skipIf(!(await hasIPv6()))('TestOther', async () => {
  const ln = await listenTCP('127.0.0.1', 0);
  try {
    const r = await other(ln.address());
    expect(r.err).toBeUndefined();
    expect(r.owned).toBe(true);
    expect(r.other).not.toBeNull();
    const a = addr(r.other!);
    expect(loopbackFamily(a.address)).toBe(6);
    expect(a.port).toBe(addr(ln).port);
    // Asked again, this program's own listener holds it: in use.
    const again = await other(ln.address());
    expect(again.other).toBeNull();
    expect(again.owned).toBe(false);
    expect(inUse(again.err)).toBe(true);
    await close(r.other);
  } finally {
    await close(ln);
  }
  // From ::1 the other is 127.0.0.1.
  const six = await listenTCP('::1', 0);
  try {
    const r = await other(six.address());
    expect(r.err).toBeUndefined();
    expect(r.owned).toBe(true);
    expect(loopbackFamily(addr(r.other!).address)).toBe(4);
    await close(r.other);
  } finally {
    await close(six);
  }
  // A listener on every address has no other loopback address to take.
  const all = await listenTCP('0.0.0.0', 0);
  try {
    expect(await other(all.address())).toEqual({ other: null, owned: false });
  } finally {
    await close(all);
  }
});

/** An error as the system reports a listen's failure: a code, or (raw
 * Windows sockets) only a number. */
function sysErr(code: string | number): Error {
  const e = new Error(`listen ${code}`) as NodeJS.ErrnoException;
  if (typeof code === 'string') e.code = code;
  else e.errno = code;
  e.syscall = 'listen';
  return e;
}

const failing =
  (err: Error): Listen<Server> =>
  () =>
    Promise.reject(err);

// Without the second listener the port is this program's on "localhost"
// only when the host has no such address or family: any other failure
// leaves the address to whoever holds or takes it, and the caller is told.
test('TestOtherNotTaken', async () => {
  const ln: AddressInfo = { address: '127.0.0.1', family: 'IPv4', port: 4242 };
  for (const code of ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 10049, 10047]) {
    const e = sysErr(code);
    expect(await other(ln, failing(e))).toEqual({ other: null, owned: true });
    expect([code, noAddress(e), inUse(e)]).toEqual([code, true, false]);
  }
  for (const e of [
    sysErr('EADDRINUSE'),
    sysErr(10048),
    sysErr('EACCES'),
    sysErr('EMFILE'),
    sysErr('ENOBUFS'),
    sysErr('EINVAL'),
    new Error('anything else'),
  ]) {
    const r = await other(ln, failing(e));
    expect(r.other).toBeNull();
    expect(r.owned).toBe(false);
    expect(r.err).toBe(e);
    expect(noAddress(e)).toBe(false);
  }
  expect(inUse(sysErr('EADDRINUSE'))).toBe(true);
  expect(inUse(sysErr(10048))).toBe(true);
  expect(inUse(sysErr('EACCES'))).toBe(false);
  // Wrapped, as errors.Is looks through wrapping.
  expect(inUse(new Error('serve', { cause: sysErr('EADDRINUSE') }))).toBe(true);
});

test('loopback addresses', () => {
  const cases: Array<[string, 4 | 6 | null]> = [
    ['127.0.0.1', 4],
    ['127.1.2.3', 4],
    ['::1', 6],
    ['0:0:0:0:0:0:0:1', 6],
    ['::ffff:127.0.0.1', 4],
    ['::ffff:10.0.0.1', null],
    ['0.0.0.0', null],
    ['::', null],
    ['10.0.0.1', null],
    ['fe80::1%lo0', null],
    ['localhost', null],
  ];
  for (const [a, want] of cases) expect([a, loopbackFamily(a)]).toEqual([a, want]);
});
