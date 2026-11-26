// Preparing code-server on a machine: installing it as the machine's
// setting says (codeServer.install: the hub uploads the release, the
// machine downloads it, or the machine's own code-server), the bridge
// extension and the default extensions, then starting it; stopping and
// releasing it. Each is the agent's op code-server; code-server listens on
// a unix socket of the agent's (cs.sock), which the proxy reaches through
// the agent (proxy.ts). Preparing reports its phase, which the loading page
// and the UI show.
import { stat } from 'node:fs/promises';
import { BRIDGE_EXT, SLUG } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { ChunkWriter, Op, readLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { AgentError, closeStream, type Session } from '#kernel/machines/transport/session.ts';
import { extensionFile, platformAsset, readRegular, sha256File, tarballFile, type Artifacts } from './artifacts.ts';
import { Install } from './settings.ts';
import type { Timing } from './timing.ts';
import { vsixContentHash } from './vsix.ts';

/** The phases of preparing code-server; the UI translates them. */
export const Phase = {
  Idle: 'idle',
  Check: 'check',
  Download: 'download',
  MachineDownload: 'machine_download',
  Upload: 'upload',
  InstallBridge: 'install_bridge',
  InstallExt: 'install_ext',
  Start: 'start',
  Ready: 'ready',
  Error: 'error',
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

/** What the UI is told of preparing code-server on a machine. */
export interface Status {
  phase: Phase;
  /** Qualifies the phase: a version, an extension's id. */
  detail?: string;
  error?: string;
  ready: boolean;
  /** Bytes of the current download or upload. */
  done?: number;
  total?: number;
}

interface MachineState {
  status: Status;
  /** The agent session code-server was made ready on: after a reconnect
   * its process may be gone. */
  session: Session | null;
  /** Header.bin of the requests: "" for the release in the agent's
   * directory, else the machine's own code-server in use. */
  bin: string;
  /** Serializes preparing, stopping and releasing. */
  lock: Promise<void>;
}

export interface ProvisionOptions {
  artifacts: Artifacts;
  logger: Logger;
  timing: Timing;
  /** How a machine gets code-server, and the Header.bin that finds its own
   * (Install.Existing: its codeServer.path, "auto" when empty). */
  install: (machine: string) => { mode: Install; bin: string };
  /** The bridge extension; none when null. */
  bridgeVSIX?: () => Promise<Uint8Array | null>;
}

const session = (m: Machine): Session | null => (m.connected ? m.live() : null);

/** What went wrong, as the UI shows it: an agent's refusal is its text. */
const errorText = (e: unknown) => (e instanceof AgentError && e.reply?.error ? e.reply.error : e instanceof Error ? e.message : String(e));

/** code-server on each machine, as this hub prepared it. */
export class CodeServers {
  private readonly o: ProvisionOptions;
  private readonly states = new Map<string, MachineState>();

  constructor(o: ProvisionOptions) {
    this.o = o;
  }

  private state(id: string): MachineState {
    let s = this.states.get(id);
    if (!s) {
      s = { status: { phase: Phase.Idle, ready: false }, session: null, bin: '', lock: Promise.resolve() };
      this.states.set(id, s);
    }
    return s;
  }

  /** Changes a machine's status, unless it was forgotten meanwhile. */
  private set(id: string, fn: (st: Status) => Status | void): void {
    const s = this.states.get(id);
    if (!s) return;
    const next = fn(s.status);
    if (next) s.status = next;
  }

  private phase(id: string, phase: Phase, detail: string): void {
    this.set(id, () => ({ phase, detail, ready: false }));
  }

  /** Runs fn after what runs for the machine already. */
  private async locked<T>(id: string, fn: (s: MachineState) => Promise<T>): Promise<T> {
    const s = this.state(id);
    const before = s.lock;
    let release!: () => void;
    s.lock = new Promise((r) => (release = r));
    await before;
    try {
      return await fn(s);
    } finally {
      release();
    }
  }

  /** The preparation status of a machine; ready on its current session
   * only. */
  status(m: Machine): Status {
    const s = this.state(m.id);
    return { ...s.status, ready: this.ready(m) };
  }

  /** Whether code-server is usable on the machine's current agent
   * session. */
  ready(m: Machine): boolean {
    const s = this.states.get(m.id);
    return !!s && s.status.ready && s.session !== null && s.session === session(m);
  }

  /** The machines whose code-server this hub considers ready. */
  running(): string[] {
    return [...this.states].filter(([, s]) => s.status.ready).map(([id]) => id);
  }

  /** Marks code-server as needing a check (a proxied request failed). */
  invalidate(id: string): void {
    this.set(id, (st) => (st.ready ? { phase: Phase.Idle, ready: false } : undefined));
  }

  /** Drops what is kept of a removed machine: one added again under the
   * same id is prepared afresh, and a preparation still running for it
   * changes nothing. */
  forget(id: string): void {
    this.states.delete(id);
  }

  /** Installs and starts code-server on m unless it is ready; callers
   * wait for each other, and a later one finds it ready. Fails with what
   * went wrong, which the status keeps. */
  ensure(m: Machine, signal: AbortSignal): Promise<void> {
    return this.locked(m.id, async (s) => {
      if (this.ready(m)) return;
      const sess = session(m);
      try {
        await this.prepare(m, s, signal);
      } catch (e) {
        this.set(m.id, (st) => ({ ...st, phase: Phase.Error, error: errorText(e), ready: false }));
        this.o.logger(`code-server on ${m.label}: ${errorText(e)}`);
        throw e;
      }
      this.set(m.id, () => ({ phase: Phase.Ready, ready: true }));
      s.session = sess;
    });
  }

  /** Stops code-server on m to free its memory; the next ensure starts it
   * again. */
  stop(m: Machine, signal: AbortSignal): Promise<void> {
    return this.end(m, 'stop', signal);
  }

  /** Lets code-server on m go after this hub's idle timeout: the machine
   * stops it unless another hub it serves has a VS Code window
   * connected. */
  release(m: Machine, signal: AbortSignal): Promise<void> {
    return this.end(m, 'release', signal);
  }

  private end(m: Machine, action: 'stop' | 'release', signal: AbortSignal): Promise<void> {
    return this.locked(m.id, async () => {
      this.set(m.id, () => ({ phase: Phase.Idle, ready: false }));
      if (!m.connected) return;
      await this.request(m, { op: Op.CodeServer, action }, signal, this.o.timing.stopMs);
    });
  }

  /** The header of a code-server request for m. */
  private header(m: Machine, h: Header): Header {
    return { ...h, op: Op.CodeServer, version: this.o.artifacts.version, bin: h.bin || (this.states.get(m.id)?.bin ?? '') };
  }

  private async request(m: Machine, h: Header, signal: AbortSignal, timeoutMs = this.o.timing.requestMs): Promise<Reply> {
    return m.request(this.header(m, h), { signal, timeoutMs });
  }

  /** Sends body as chunks on a request whose agent answers twice: once
   * before reading it, once after. The stream ends with signal. */
  private async upload(
    m: Machine,
    h: Header,
    body: AsyncIterable<Uint8Array> | Uint8Array,
    signal: AbortSignal,
    progress?: (n: number) => void,
  ): Promise<Reply> {
    const { conn } = await m.open(this.header(m, h), { signal, timeoutMs: this.o.timing.requestMs });
    const end = () => conn.stream.destroy();
    signal.addEventListener('abort', end, { once: true });
    try {
      const cw = new ChunkWriter(conn.stream);
      let done = 0;
      for await (const b of body instanceof Uint8Array ? [body] : body) {
        signal.throwIfAborted();
        await cw.write(b);
        done += b.length;
        progress?.(done);
      }
      await cw.finish();
      const timer = setTimeout(() => conn.stream.destroy(new Error('no answer in time')), this.o.timing.installMs);
      let rep: Reply;
      try {
        rep = await readLine<Reply>(conn.reader);
      } finally {
        clearTimeout(timer);
      }
      if (!rep.ok) throw new AgentError(rep.error ?? 'failed', rep);
      return rep;
    } catch (e) {
      signal.throwIfAborted();
      throw e;
    } finally {
      signal.removeEventListener('abort', end);
      conn.reader.release();
      closeStream(conn.stream);
    }
  }

  private async prepare(m: Machine, s: MachineState, signal: AbortSignal): Promise<void> {
    const info = m.state().info;
    if (!m.connected || !info) throw new Error('machine not connected');
    const { version } = this.o.artifacts;
    const { mode, bin } = this.o.install(m.id);
    s.bin = '';
    this.phase(m.id, Phase.Check, version);
    if (mode === Install.Existing) {
      const rep = await this.request(m, { op: Op.CodeServer, action: 'status', bin }, signal);
      if (rep.cs?.installed) s.bin = bin;
      else this.o.logger(`code-server on ${m.label}: ${rep.cs?.error ?? 'not found'}; installing a release instead`);
    }
    if (!s.bin) await this.installRelease(m, info.os, info.arch, mode === Install.Download, signal);
    try {
      await this.installExtensions(m, signal);
    } catch (e) {
      // VS Code works without them.
      signal.throwIfAborted();
      this.o.logger(`code-server extensions on ${m.label}: ${errorText(e)}`);
    }
    this.phase(m.id, Phase.Start, version);
    await this.request(m, { op: Op.CodeServer, action: 'start' }, signal, this.o.timing.startMs);
  }

  /** Makes sure the release is in the agent's directory: the machine
   * downloads it when allowed, else the hub uploads it. */
  private async installRelease(m: Machine, os: string, arch: string, machineDownload: boolean, signal: AbortSignal): Promise<void> {
    const rep = await this.request(m, { op: Op.CodeServer, action: 'status' }, signal);
    if (rep.cs?.installed) return;
    const asset = platformAsset(os, arch);
    const { artifacts } = this.o;
    if (machineDownload && !artifacts.offline) {
      try {
        await this.machineDownload(m, asset, signal);
        return;
      } catch (e) {
        signal.throwIfAborted();
        this.o.logger(`code-server download on ${m.label} failed, uploading from the hub instead: ${errorText(e)}`);
      }
    }
    this.phase(m.id, Phase.Download, artifacts.version);
    let path: string;
    try {
      path = await artifacts.tarball(asset, {
        signal,
        progress: (done, total) => this.set(m.id, (st) => ({ ...st, done, ...(total > 0 ? { total } : {}) })),
      });
    } catch (e) {
      signal.throwIfAborted();
      throw new Error(`code-server ${asset}: ${errorText(e)}`);
    }
    const { size } = await stat(path);
    // The machine checks the tarball against it before unpacking it: the
    // digest it was verified against, or (a file used unverified) its own.
    const digest = (await artifacts.knownDigest(tarballFile(artifacts.version, asset))) || (await sha256File(path));
    this.set(m.id, () => ({ phase: Phase.Upload, detail: artifacts.version, ready: false, total: size }));
    try {
      await this.upload(m, { op: Op.CodeServer, action: 'install', digest }, await readRegular(path), signal, (done) =>
        this.set(m.id, (st) => ({ ...st, done })),
      );
    } catch (e) {
      signal.throwIfAborted();
      throw new Error(`install code-server: ${errorText(e)}`);
    }
  }

  /** Has the machine fetch the release itself, verified against the digest
   * the hub knows; an unknown digest is recorded on first use, as for the
   * hub's own downloads. */
  private async machineDownload(m: Machine, asset: string, signal: AbortSignal): Promise<void> {
    const { artifacts } = this.o;
    const file = tarballFile(artifacts.version, asset);
    const want = await artifacts.knownDigest(file);
    this.phase(m.id, Phase.MachineDownload, artifacts.version);
    // The agent answers once the release is installed, and stops the
    // download when the stream ends.
    const rep = await this.request(
      m,
      { op: Op.CodeServer, action: 'download', url: artifacts.tarballURL(asset), digest: want },
      signal,
      this.o.timing.machineDownloadMs,
    );
    if (!want && rep.cs?.digest) {
      this.o.logger(
        `warning: no pinned checksum for ${file}; recorded sha256 ${rep.cs.digest} downloaded by ${m.label} (trust on first use)`,
      );
      await artifacts.recordDigest(file, rep.cs.digest);
    }
  }

  /** Whether the marker file name exists in the machine's extensions
   * directory; set creates it. */
  private async marker(m: Machine, name: string, set: boolean, signal: AbortSignal): Promise<boolean> {
    try {
      const rep = await this.request(m, { op: Op.CodeServer, action: 'marker', path: name, ...(set ? { args: ['set'] } : {}) }, signal);
      return rep.ok;
    } catch {
      return false;
    }
  }

  /** The bridge extension and the default extensions, each installed once
   * per build (a marker remembers it). */
  private async installExtensions(m: Machine, signal: AbortSignal): Promise<void> {
    const vsix = await this.o.bridgeVSIX?.();
    if (vsix && vsix.length > 0) {
      const name = `.${BRIDGE_EXT}-${vsixContentHash(vsix)}`;
      if (!(await this.marker(m, name, false, signal))) {
        this.phase(m.id, Phase.InstallBridge, BRIDGE_EXT);
        try {
          await this.upload(m, { op: Op.CodeServer, action: 'install-ext', path: `${BRIDGE_EXT}.vsix` }, vsix, signal);
        } catch (e) {
          throw new Error(`bridge extension: ${errorText(e)}`);
        }
        await this.marker(m, name, true, signal);
      }
    }
    const errors: string[] = [];
    for (const ext of this.o.artifacts.extensions) {
      const name = `.${SLUG}-ext-${ext.id}-${ext.version}`;
      if (await this.marker(m, name, false, signal)) continue;
      this.phase(m.id, Phase.InstallExt, ext.id);
      try {
        const path = await this.o.artifacts.extension(ext, { signal });
        await this.upload(m, { op: Op.CodeServer, action: 'install-ext', path: extensionFile(ext) }, await readRegular(path), signal);
      } catch (e) {
        signal.throwIfAborted();
        errors.push(`${ext.id}: ${errorText(e)}`);
        continue;
      }
      await this.marker(m, name, true, signal);
    }
    if (errors.length > 0) throw new Error(errors.join('\n'));
  }
}
