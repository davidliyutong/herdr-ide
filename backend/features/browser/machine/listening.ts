// The TCP ports the user's programs listen on, where a dial to the
// machine's loopback reaches them: bound to loopback or to every address.
// Linux: the kernel's tables (/proc/net/tcp, tcp6), the programs named by
// finding the sockets among the descriptors of the user's processes;
// macOS: lsof.
import { opendir, readFile, readlink, stat } from 'node:fs/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { execa } from 'execa';

/** A TCP port something of the user listens on; process names the
 * listening program when it is known. */
export interface Port {
  port: number;
  process?: string;
}

/** Bounds the list of ports. */
export const MAX_PORTS = 200;
/** Bounds the descriptors looked at to name the listening programs. */
const MAX_FDS = 20_000;

/** The ports sorted, one entry per port (the one that names its program),
 * no number that is no port, at most MAX_PORTS. */
export function tidy(ports: Port[]): Port[] {
  const by = new Map<number, Port>();
  for (const p of ports) {
    if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) continue;
    const cur = by.get(p.port);
    if (!cur || (!cur.process && p.process)) by.set(p.port, p);
  }
  return [...by.values()]
    .sort((a, b) => a.port - b.port)
    .slice(0, MAX_PORTS)
    .map((p) => (p.process ? { port: p.port, process: p.process } : { port: p.port }));
}

/** Whether a socket bound to the kernel's hex address answers on loopback:
 * every address, 127.0.0.0/8, ::1 or a mapped 127.0.0.0/8. The kernel
 * prints each 32-bit word in host byte order (little-endian on the
 * machines the agent runs on). */
export function reachable(hexAddr: string): boolean {
  if (!/^[0-9A-Fa-f]*$/.test(hexAddr) || (hexAddr.length !== 8 && hexAddr.length !== 32)) return false;
  const b = Buffer.from(hexAddr, 'hex');
  for (let i = 0; i + 4 <= b.length; i += 4) b.subarray(i, i + 4).reverse();
  if (b.every((x) => x === 0)) return true;
  if (b.length === 4) return b[0] === 127;
  const v4mapped = b.subarray(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (v4mapped) return b[12] === 127 || b.subarray(12).every((x) => x === 0);
  return b.subarray(0, 15).every((x) => x === 0) && b[15] === 1;
}

/** The listening sockets of user uid in a kernel table (the text of
 * /proc/net/tcp or tcp6) that a dial to loopback reaches, added to inodes:
 * the port of each by its inode. */
export function listeners(table: string, uid: string, inodes: Map<string, number>): void {
  const lines = table.split('\n');
  for (const line of lines.slice(1)) {
    // sl local_address rem_address st tx rx tr tm->when retrnsmt uid timeout inode
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A' || f[7] !== uid) continue;
    const colon = f[1].indexOf(':');
    if (colon < 0) continue;
    const addr = f[1].slice(0, colon);
    const port = f[1].slice(colon + 1);
    if (!/^[0-9A-Fa-f]{1,4}$/.test(port) || !reachable(addr)) continue;
    inodes.set(f[9], parseInt(port, 16));
  }
}

/** The programs holding the sockets of these inodes, by inode: the user's
 * processes' descriptors, at most MAX_FDS of them, until signal ends. */
async function processes(inodes: Map<string, number>, signal: AbortSignal, uid: number): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (inodes.size === 0) return names;
  const pids = await opendir('/proc').catch(() => null);
  if (!pids) return names;
  let seen = 0;
  for await (const pid of pids) {
    if (signal.aborted || names.size === inodes.size || seen >= MAX_FDS) break;
    if (!/^\d+$/.test(pid.name)) continue;
    const dir = `/proc/${pid.name}`;
    if ((await stat(dir).catch(() => null))?.uid !== uid || signal.aborted) continue;
    const fds = await opendir(`${dir}/fd`).catch(() => null);
    if (!fds) continue;
    try {
      for await (const fd of fds) {
        if (signal.aborted || names.size === inodes.size || seen >= MAX_FDS) break;
        seen++;
        const link = await readlink(`${dir}/fd/${fd.name}`).catch(() => '');
        const m = /^socket:\[(\d+)\]$/.exec(link);
        if (!m || !inodes.has(m[1]) || names.has(m[1]) || signal.aborted) continue;
        const name = await readFile(`${dir}/comm`, { encoding: 'utf8', signal }).catch(() => '');
        if (name) names.set(m[1], name.trim());
      }
    } catch {
      // gone, or not ours to read
    }
  }
  return names;
}

async function listeningLinux(signal: AbortSignal): Promise<Port[]> {
  const uid = process.getuid!();
  const inodes = new Map<string, number>();
  for (const name of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (signal.aborted) break;
    try {
      listeners(await readFile(name, { encoding: 'utf8', signal }), String(uid), inodes);
    } catch {
      // no IPv6, or no /proc
    }
  }
  const names = signal.aborted ? new Map<string, string>() : await processes(inodes, signal, uid);
  return [...inodes].map(([inode, port]) => ({ port, ...(names.get(inode) ? { process: names.get(inode) } : {}) }));
}

/** The address of lsof's n field is one a dial to loopback reaches. */
function reachableName(host: string): boolean {
  if (host === '*') return true;
  const h = host.replace(/^\[|\]$/g, '');
  if (isIPv4(h)) return h === '0.0.0.0' || h.startsWith('127.');
  if (!isIPv6(h)) return false;
  // The address as the URL parser writes it: compressed, mapped IPv4 in hex.
  const v = new URL(`http://[${h}]/`).hostname.slice(1, -1);
  return v === '::' || v === '::1' || v === '::ffff:0:0' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(v);
}

/** lsof's fields p (the process), c (its command) and n (the address) of
 * the user's listening TCP sockets, the ports reachable from loopback. */
export function parseLsof(out: string): Port[] {
  const ports: Port[] = [];
  let command = '';
  for (const line of out.split('\n')) {
    if (line === '') continue;
    if (line[0] === 'c') command = line.slice(1);
    else if (line[0] === 'n') {
      const at = line.lastIndexOf(':');
      if (at < 0) continue;
      const host = line.slice(1, at);
      const port = line.slice(at + 1);
      if (!/^\d+$/.test(port) || !reachableName(host)) continue;
      ports.push({ port: Number(port), process: command });
    }
  }
  return ports;
}

async function listeningDarwin(signal: AbortSignal): Promise<Port[]> {
  const r = await execa('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-u', String(process.getuid!()), '-F', 'pcn'], {
    env: { PATH: '/usr/sbin:/usr/bin:/bin', LC_ALL: 'C' },
    extendEnv: false,
    reject: false,
    cancelSignal: signal,
    stdin: 'ignore',
  });
  return parseLsof(typeof r.stdout === 'string' ? r.stdout : '');
}

/** The listening ports of the machine, as far as signal lets the search
 * go; none where the system's list cannot be read. */
export async function listening(signal: AbortSignal): Promise<Port[]> {
  if (process.platform === 'linux') return listeningLinux(signal);
  if (process.platform === 'darwin') return listeningDarwin(signal);
  return [];
}
