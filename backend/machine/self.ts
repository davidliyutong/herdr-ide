// This process's build: the machine bundle Bun runs (Bun.main), named by
// a digest of its content, as nodes and their clients tell it each other
// (agentproto.NodeInfo); and the command that runs it again.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { VERSION, type NodeInfo } from '#shared/proto/agentproto/index.ts';

/** The file of this build: the bundle, or the entry module of a run from
 * the sources. */
export const buildFile = (): string => Bun.main;

let info: NodeInfo | undefined;

/** This process's build: a digest of its bundle (12 hex digits, as the Go
 * build names its executable's), the version and when the bundle was
 * written (Unix nanoseconds, which order two builds of one version). */
export function selfInfo(): NodeInfo {
  if (!info) {
    const file = buildFile();
    const build = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
    info = { build, version: VERSION, exe_time: Number(statSync(file, { bigint: true }).mtimeNs), pid: process.pid };
  }
  return info;
}

/** The command line that runs this build again: the runtime with its own
 * flags (the launcher's: no .env files, no bunfig.toml of the working
 * directory, no installs) and the bundle. */
export const selfCommand = (): string[] => [process.execPath, ...process.execArgv, buildFile()];
