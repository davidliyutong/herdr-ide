// A machine's terminal core as its agent runs it (op hc): its status, the
// executable this build carries installed where it differs, started when
// none runs, restarted when another build runs (its successor adopts the
// programs). The agent hashes the executable again and runs it only when
// it is the build's.
import type { Logger } from '#shared/lib/log.ts';
import { ChunkWriter, Op, readLine, type HCStatus, type Reply } from '#shared/proto/agentproto/index.ts';
import type { Audit } from '#kernel/audit.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { AgentError, closeStream } from '#kernel/machines/transport/session.ts';
import { Code } from './messages.ts';

/** herdr-core for a platform (Go's os/arch names): gzip-compressed, and
 * the SHA-256 of the executable (kernel/payloads.ts). */
export type HCSource = (os: string, arch: string) => Promise<{ gz: Uint8Array; digest: string }>;

export interface LifecycleDeps {
  readOnly: boolean;
  hc?: HCSource;
  logger: Logger;
  audit: Audit;
}

/** Whether the machine has an agent session. */
export const online = (m: Machine): boolean => m.connected;

/** The terminal core's status (action status); throws when the agent does
 * not answer with one. */
export async function hcStatus(m: Machine, signal: AbortSignal, timeoutMs: number): Promise<HCStatus> {
  const rep = await m.request({ op: Op.HC, action: 'status' }, { signal, timeoutMs });
  if (!rep.hc) throw new Error('hc status: no status in the reply');
  return rep.hc;
}

/** Runs an action of the terminal core (start, restart, stop); throws when
 * the agent refuses it or does not answer. */
export async function hcAction(m: Machine, action: string, digest: string, signal: AbortSignal, timeoutMs: number): Promise<Reply> {
  return m.request({ op: Op.HC, action, ...(digest ? { digest } : {}) }, { signal, timeoutMs });
}

/** Uploads the executable (gz, of digest) as ChunkWriter chunks after the
 * agent's first reply, and returns its second reply. */
async function install(m: Machine, gz: Uint8Array, digest: string, signal: AbortSignal, timeoutMs: number): Promise<Reply> {
  const { conn } = await m.open({ op: Op.HC, action: 'install', digest }, { signal, timeoutMs });
  const stop = () => conn.stream.destroy(new Error('aborted'));
  signal.addEventListener('abort', stop, { once: true });
  try {
    const cw = new ChunkWriter(conn.stream);
    await cw.write(gz);
    await cw.finish();
    return await readLine<Reply>(conn.reader);
  } finally {
    signal.removeEventListener('abort', stop);
    conn.reader.release();
    closeStream(conn.stream);
  }
}

export interface EnsureOptions {
  /** Restarts a core that runs (its successor adopts the programs). */
  restart: boolean;
  /** The core was stopped from the UI: none is started until it is started
   * again. */
  stopped: () => boolean;
  /** Who the backend is, for the log. */
  id: string;
  signal: AbortSignal;
  timeoutMs: number;
}

/** Makes the machine's terminal core run the executable this build carries
 * and returns once it answers: "" when it runs, else the code of why not.
 * A read-only core installs and starts nothing: it uses a core that runs
 * already. */
export async function ensure(m: Machine, o: EnsureOptions, d: LifecycleDeps): Promise<string> {
  const info = m.state().info;
  if (!online(m) || !info) return Code.Offline;
  const signal = AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]);
  let st: HCStatus;
  try {
    st = await hcStatus(m, signal, o.timeoutMs);
  } catch {
    return Code.Offline;
  }
  let gz: Uint8Array | null = null;
  let digest = '';
  if (d.hc)
    try {
      ({ gz, digest } = await d.hc(info.os, info.arch));
    } catch {
      // none in this build for the machine's platform
    }
  let installed = false;
  if (digest && gz && st.digest !== digest && !d.readOnly) {
    let r: Reply | undefined;
    let err: unknown;
    try {
      r = await install(m, gz, digest, signal, o.timeoutMs);
    } catch (e) {
      err = e;
    }
    if (!r?.ok || !r.hc) {
      d.logger(`term ${o.id}: install: ${err ? (err as Error).message : ''} ${r?.error ?? ''}`);
      return Code.Install;
    }
    d.audit.log(null, 'term.install', { machine: o.id, digest });
    st = r.hc;
    installed = true;
  }
  if (!st.digest && !st.running) return Code.NotBundled;
  // The running core is from another build (or a restart was asked for):
  // its successor adopts the programs, which keep running.
  const action = !st.running ? 'start' : installed || o.restart ? 'restart' : '';
  if (!action) return '';
  if (d.readOnly) return Code.NotRunning;
  if (o.stopped() && !st.running) return Code.Stopped;
  let rep: Reply | undefined;
  let err: unknown;
  try {
    rep = await hcAction(m, action, digest, signal, o.timeoutMs);
  } catch (e) {
    err = e;
    if (e instanceof AgentError) rep = e.reply;
  }
  if (err || !rep?.hc?.running) {
    d.logger(`term ${o.id}: ${action}: ${err ? (err as Error).message : ''} ${rep?.error ?? ''}`);
    return Code.Start;
  }
  d.audit.log(null, `term.${action}`, { machine: o.id, version: rep.hc.version ?? '' });
  return '';
}
