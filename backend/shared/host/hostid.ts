// Names the host a process runs on, for files that must be kept per host
// although the directory holding them may be on a home that several hosts
// share (NFS): databases, logs, executables, runtime directories and the
// terminal core's session (as the Go program of earlier releases named it:
// both must name a host alike, or the one would not find the other's
// files).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** A machine id: the system's text, or its bytes when they are not UTF-8
 * (a binary /etc/hostid), which are hashed as they are, as Go does. */
export type MachineID = string | Uint8Array;

let thisKey: string | undefined;
let thisID: string | undefined;

/** This host's key: its whole name (name) and, when the system has one,
 * "-" with the first 8 hex digits of the SHA-256 of its machine id
 * (machineID). Two hosts of one name (cloned machines, or node01 of two
 * clusters that share a home) get different keys; the name is there for
 * people looking at the files. The id is hashed (systemd asks programs not
 * to show it), with a prefix of its own, so that the hash names no id
 * elsewhere. Without an id (a container without /etc/machine-id) the key
 * is the host's name alone. */
export function key(): string {
  thisKey ??= keyOf(hostname(), machineID());
  return thisKey;
}

/** The key of host name h with machine id id ("" for none). */
export function keyOf(h: string, id: MachineID): string {
  let k = name(h);
  id = trimID(id);
  if (id.length) k += '-' + idHash('store host', id);
  return k;
}

/** A short id of this host that does not change with its name: the first
 * 8 hex digits of a hash of its machine id; without one, its name (name),
 * or a hash of it when it is longer than 24 bytes. It names what a host
 * must find again after its name changed (macOS changes it with the
 * network): its runtime directory when it has no /run/user, and its
 * terminal core's session. */
export function id(): string {
  thisID ??= idOf(hostname(), machineID());
  return thisID;
}

/** id for host name h with machine id id ("" for none). */
export function idOf(h: string, id: MachineID): string {
  id = trimID(id);
  if (id.length) return idHash('host id', id);
  const n = name(h);
  return n.length <= 24 ? n : idHash('host name', n);
}

function idHash(prefix: string, s: MachineID): string {
  return createHash('sha256')
    .update(prefix + '\0')
    .update(s)
    .digest('hex')
    .slice(0, 8);
}

/** Go's unicode.IsSpace, which strings.TrimSpace trims (JavaScript's trim
 * also trims U+FEFF, Go's does not). */
const goSpace = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const goTrim = new RegExp(`^[${goSpace}]+|[${goSpace}]+$`, 'g');

/** s without white space at its ends, as Go's strings.TrimSpace. */
export function trimSpace(s: string): string {
  return s.replace(goTrim, '');
}

/** id without white space at its ends; bytes that are not UTF-8 lose
 * ASCII white space only. */
function trimID(id: MachineID): MachineID {
  if (typeof id === 'string') return trimSpace(id);
  let a = 0;
  let b = id.length;
  const space = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  while (a < b && space(id[a])) a++;
  while (b > a && space(id[b - 1])) b--;
  return id.subarray(a, b);
}

/** The machine's own id, which the system keeps on the machine (not on a
 * home that hosts share), "" for none. */
export function machineID(): MachineID {
  if (process.platform === 'win32') return windowsMachineID();
  if (process.platform === 'darwin') return platformUUID();
  return machineIDOfFiles(MACHINE_ID_FILES);
}

/** Where systems other than macOS keep the machine's id: systemd's (and
 * dbus's, which systemd links to it) and FreeBSD's. */
export const MACHINE_ID_FILES: readonly string[] = ['/etc/machine-id', '/var/lib/dbus/machine-id', '/etc/hostid'];

/** The id in the first of files that has one (at most 256 bytes). */
export function machineIDOfFiles(files: readonly string[]): MachineID {
  for (const p of files) {
    let b: Buffer;
    try {
      b = readFileSync(p);
    } catch {
      continue;
    }
    const s = b.toString('utf8');
    // Bytes that are not UTF-8 stay bytes: their hash is Go's.
    const id = Buffer.from(s, 'utf8').equals(b) ? trimSpace(s) : trimID(b);
    const bytes = typeof id === 'string' ? Buffer.byteLength(id) : id.length;
    if (bytes > 0 && bytes <= 256) return id;
  }
  return '';
}

/** macOS's hardware UUID, as ioreg shows it, "" when it cannot be read in
 * 5 s. */
function platformUUID(): string {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return ioregUUID(out);
  } catch {
    return '';
  }
}

/** The IOPlatformUUID of ioreg's output. */
export function ioregUUID(out: string): string {
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq >= 0 && trimSpace(line.slice(0, eq)) === '"IOPlatformUUID"') return trimQuotes(trimSpace(line.slice(eq + 1)));
  }
  return '';
}

const trimQuotes = (s: string) => s.replace(/^"+|"+$/g, '');

/** The id Windows gives the installation (MachineGuid, in the registry's
 * 64-bit view), "" when it cannot be read. reg.exe reads it: Node has no
 * registry API. */
function windowsMachineID(): string {
  try {
    const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
    const out = execFileSync(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return regQueryValue(out, 'MachineGuid');
  } catch {
    return '';
  }
}

/** The string value of name in the output of reg query:
 *
 *     HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography
 *         MachineGuid    REG_SZ    0b6e…
 */
export function regQueryValue(out: string, name: string): string {
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line);
    if (m && m[1].toLowerCase() === name.toLowerCase()) return m[2].trim();
  }
  return '';
}

/** The length of a host's name in keys at most: with the hash and a
 * file's name, a file name stays far below the 255 bytes file systems
 * take. */
export const MAX_NAME = 128;

/** Host name h as keys have it: the whole name, lowercase, with what is
 * not a letter, a digit, -, _ or . replaced by _, without dots at its
 * ends, at most MAX_NAME bytes; "localhost" for none. */
export function name(h: string): string {
  let b = '';
  for (const ch of trimSpace(h)) {
    if (b.length >= MAX_NAME) break;
    const c = lowerASCII(ch);
    b += c !== '' && /^[a-z0-9_.-]$/.test(c) ? c : '_';
  }
  const n = b.replace(/^\.+|\.+$/g, '');
  return n !== '' ? n : 'localhost';
}

/** The lowercase of ch when it is ASCII, as Go's unicode.ToLower has it
 * (its simple mapping: U+0130 and the Kelvin sign become ASCII letters);
 * "" for any other. */
function lowerASCII(ch: string): string {
  const c = ch.codePointAt(0)!;
  if (c < 0x80) return ch.toLowerCase();
  if (c === 0x130) return 'i';
  if (c === 0x212a) return 'k';
  return '';
}

/** Whether k may be a host's key (key of some host, or of an earlier
 * version: the host's first label): of the letters, digits, -, _ and .
 * name leaves, without a dot at its ends, at most as long as a name and a
 * hash. */
export function validKey(k: string): boolean {
  return k !== '' && k.length <= MAX_NAME + 9 && !k.startsWith('.') && !k.endsWith('.') && /^[a-z0-9_.-]+$/.test(k);
}
