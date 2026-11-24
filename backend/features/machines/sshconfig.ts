// The Host aliases of the user's OpenSSH client configuration on the core
// host (~/.ssh/config and the files it includes), which the Add Machine
// dialog offers (GET /api/ssh/hosts). It only reads, and keeps only each
// concrete alias with its HostName and User: patterns, Match blocks and
// every other option (keys, proxies, commands) are left out.
//
// The files are parsed by ssh-config. Includes are expanded as ssh does:
// globs, ~, paths relative to ~/.ssh; an Include inside a Host block
// applies that block to the included file's lines until its own first
// Host. What is read is bounded: files of at most MAX_FILE_SIZE bytes,
// MAX_FILES files, MAX_DEPTH levels of includes, MAX_HOSTS aliases.
import { constants, globSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import SSHConfig, { LineType, type Line } from 'ssh-config';

/** An alias and what it connects to, when the configuration says so. */
export interface Host {
  alias: string;
  hostname?: string;
  user?: string;
}

export const MAX_FILE_SIZE = 256 << 10;
export const MAX_FILES = 64;
export const MAX_DEPTH = 8;
export const MAX_HOSTS = 1000;

const values = (v: string | { val: string }[]): string[] => (typeof v === 'string' ? [v] : v.map((x) => x.val));

/** An alias that names one host: no pattern, no negation, nothing a
 * command line would split. */
const concrete = (a: string) => a !== '' && !/[*?!\s]/.test(a);

/** A value passed on to the dialog: one word. */
const word = (v: string | undefined) => (v && !/\s/.test(v) ? v : undefined);

/** The text of a regular file of at most MAX_FILE_SIZE bytes; null for
 * anything else (missing, too large, a directory, a FIFO that would
 * block). */
async function readSmall(path: string): Promise<string | null> {
  let f;
  try {
    f = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = await f.stat();
    if (!st.isFile() || st.size > MAX_FILE_SIZE) return null;
    const buf = Buffer.alloc(MAX_FILE_SIZE + 1);
    const { bytesRead } = await f.read(buf, 0, buf.length, 0);
    return bytesRead > MAX_FILE_SIZE ? null : buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await f.close();
  }
}

/** The files an Include argument names, sorted as ssh's glob(3) gives
 * them; none for another user's home (~name). */
function expandInclude(arg: string, home: string): string[] {
  if (arg.startsWith('~') && !arg.startsWith('~/')) return [];
  const p = arg.startsWith('~/') ? join(home, arg.slice(2)) : isAbsolute(arg) ? arg : join(home, '.ssh', arg);
  if (!/[*?[]/.test(p)) return [p];
  try {
    return globSync(p).sort();
  } catch {
    return [];
  }
}

/** Reads the aliases of home's ~/.ssh/config, in the order they are first
 * named; an alias named again in another case is the same one. */
export async function read(home: string): Promise<Host[]> {
  const hosts = new Map<string, Host>();
  let files = 0;

  const walk = async (lines: Line[], block: Host[] | null, depth: number): Promise<void> => {
    for (const line of lines) {
      if (line.type !== LineType.DIRECTIVE) continue;
      const param = line.param.toLowerCase();
      if (param === 'host') {
        block = [];
        for (const a of values(line.value).filter(concrete)) {
          const key = a.toLowerCase();
          let h = hosts.get(key);
          if (!h && hosts.size < MAX_HOSTS) hosts.set(key, (h = { alias: a }));
          if (h) block.push(h);
        }
      } else if (param === 'match') {
        block = null;
      } else if (param === 'hostname' || param === 'user') {
        const v = values(line.value)[0];
        for (const h of block ?? []) {
          if (param === 'hostname' && h.hostname === undefined) h.hostname = word(v?.replaceAll('%h', h.alias));
          if (param === 'user' && h.user === undefined) h.user = word(v);
        }
      } else if (param === 'include' && depth < MAX_DEPTH) {
        for (const arg of values(line.value))
          for (const path of expandInclude(arg, home)) {
            if (files >= MAX_FILES) return;
            await readFile(path, block, depth + 1);
          }
      }
      // A section's own lines follow its Host or Match line.
      if ('config' in line) await walk(line.config, block, depth);
    }
  };

  const readFile = async (path: string, block: Host[] | null, depth: number) => {
    const text = await readSmall(path);
    if (text === null) return;
    files++;
    let parsed: Line[];
    try {
      parsed = SSHConfig.parse(text);
    } catch {
      return;
    }
    await walk(parsed, block, depth);
  };

  await readFile(join(home, '.ssh', 'config'), null, 0);
  // Members in a fixed order, whichever the file gave first.
  return [...hosts.values()].map(({ alias, hostname, user }) => ({
    alias,
    ...(hostname !== undefined ? { hostname } : {}),
    ...(user !== undefined ? { user } : {}),
  }));
}
