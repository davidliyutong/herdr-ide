// This process's build, named by a digest of its file, as nodes and their
// clients tell it each other (agentproto.NodeInfo); and the command that
// runs it again. A machine runs the machine side as one executable compiled
// with Bun (hosts/machine/compile.ts): the build is that file. A run from
// the sources (tests, development) is the entry module run by bun.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { VERSION, type NodeInfo } from '#shared/proto/agentproto/index.ts';

/** Whether this process is the compiled machine executable. */
export const compiled = (): boolean => Bun.isStandaloneExecutable;

/** The file of this build: the executable, or the entry module of a run
 * from the sources. */
export const buildFile = (): string => (compiled() ? process.execPath : Bun.main);

let info: NodeInfo | undefined;

/** This process's build: a digest of its file (12 hex digits, as the Go
 * build names its executable's), the version and when the file was written
 * (Unix nanoseconds, which order two builds of one version). */
export function selfInfo(): NodeInfo {
  if (!info) {
    const file = buildFile();
    const build = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
    info = { build, version: VERSION, exe_time: Number(statSync(file, { bigint: true }).mtimeNs), pid: process.pid };
  }
  return info;
}

/** The command line that runs this build again: the executable alone (its
 * execArgv would be what BUN_OPTIONS gave, which the executable reads as
 * its own arguments), or bun with its flags and the entry module. */
export const selfCommand = (): string[] => (compiled() ? [process.execPath] : [process.execPath, ...process.execArgv, buildFile()]);

/** What makes a compiled Bun executable run other code or be another
 * program: its own runtime flags (BUN_OPTIONS, which it honours as bun
 * does), its debugger (BUN_INSPECT*), and BUN_BE_BUN, which turns it into
 * the bun command. The machine executable takes none of them: the core
 * starts it without them (the ssh command, the local spawn), and it
 * removes them from its own environment at once, so the processes it
 * starts (another node, the terminal core, helpers) never get them. A
 * compiled executable reads no .env and no bunfig.toml (compiled without
 * their autoloading), ignores NODE_OPTIONS and transpiles nothing at run
 * time, so it writes no transpiler cache. */
export const FOREIGN_RUNTIME_VARS = [
  'BUN_OPTIONS',
  'BUN_BE_BUN',
  'BUN_INSPECT',
  'BUN_INSPECT_CONNECT_TO',
  'BUN_INSPECT_NOTIFY',
  'BUN_INSPECT_PRELOAD',
] as const;

/** Removes FOREIGN_RUNTIME_VARS from env. */
export function dropForeignRuntimeVars(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of FOREIGN_RUNTIME_VARS) delete env[k];
}
