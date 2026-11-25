// Full Disk Access on macOS (op privacy, docs/features/16). macOS grants
// it to a process's responsible process, the one it attributes the file
// accesses to: the agent's is the core's (or the ssh session's), and so is
// code-server's, which the agent starts (VS Code has what the files side
// reports); the terminal core's is herdr-core's own (it starts as a launchd
// job), so the programs of a terminal have what herdr-core's executable
// was granted.
// Each side is checked by opening, and closing again, a folder only Full
// Disk Access opens; nothing is read.
import { closeSync, openSync } from 'node:fs';
import { posix } from 'node:path';
import { Access, type PrivacyStatus } from '#shared/proto/agentproto/index.ts';
import type { TerminalCore } from './hc.ts';
import { dialHC } from './hidden.ts';

/** Folders under home only Full Disk Access opens that a Mac has without
 * the user's doing: the user's privacy database's, and Safari's. */
export const fdaFolders = (home: string): string[] => [
  posix.join(home, 'Library', 'Application Support', 'com.apple.TCC'),
  posix.join(home, 'Library', 'Safari'),
];

/** The access an open's error tells: macOS refuses a protected folder with
 * EPERM; another error (EACCES from the folder's mode, an I/O error) says
 * nothing about Full Disk Access. */
export function accessOf(code: string | undefined): string {
  if (code === undefined) return Access.Granted;
  if (code === 'EPERM') return Access.Denied;
  return Access.Unknown;
}

/** Opens the first of folders that exists in this process. */
export function filesAccess(folders: string[]): string {
  for (const p of folders) {
    try {
      closeSync(openSync(p, 'r'));
      return Access.Granted;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      return accessOf(code);
    }
  }
  return Access.Unknown;
}

/** Exits 0 when the shell may open the first of its arguments that is a
 * folder, 1 when it may not, 3 when none is. The redirection is given to
 * true: on a special builtin such as : a failed one would end the shell. */
export const FDA_SCRIPT = `for d; do [ -d "$d" ] || continue; { true <"$d"; } 2>/dev/null && exit 0; exit 1; done; exit 3`;

/** Runs FDA_SCRIPT in the terminal core (machine.exec: its child, as a
 * terminal's holder is for the terminal's programs). Without a core
 * answering on socket it is unknown; nothing is started. */
export async function terminalsAccess(socket: string, folders: string[], signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(20_000);
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let conn;
  try {
    conn = await dialHC(socket, sig);
  } catch {
    return Access.Unknown;
  }
  try {
    const res = await conn.call<{ code?: number | null; timed_out?: boolean }>(
      'machine.exec',
      { argv: ['/bin/sh', '-c', FDA_SCRIPT, 'sh', ...folders], timeout: 10 },
      { signal: sig },
    );
    if (res?.code == null || res.timed_out) return Access.Unknown;
    return res.code === 0 ? Access.Granted : res.code === 1 ? Access.Denied : Access.Unknown;
  } catch {
    return Access.Unknown;
  } finally {
    conn.close();
  }
}

/** op privacy's answer; os is the system the probes run on. */
export async function privacyStatus(home: string, hc: TerminalCore, signal?: AbortSignal, os = process.platform): Promise<PrivacyStatus> {
  const p: PrivacyStatus = { files: Access.Unknown, terminals: Access.Unknown, hc: hc.bin };
  if (os === 'darwin') {
    const folders = fdaFolders(home);
    p.files = filesAccess(folders);
    p.terminals = await terminalsAccess(hc.socket, folders, signal);
  }
  return p;
}
