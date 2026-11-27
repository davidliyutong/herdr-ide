// One machine: keeps a session with its agent while it is enabled, dialing
// again with backoff when it fails, and serves the streams the agent opens
// towards the hub.
import { Op, readLine, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { retryDelay } from '#shared/lib/wait.ts';
import type { Logger } from '#shared/lib/log.ts';
import { offline } from '../fail.ts';
import { AuthRequiredError, SSHTimeoutError } from './transport/ssh.ts';
import { deployCode } from './transport/errors.ts';
import { closeStream, type AgentStream, type Session } from './transport/session.ts';
import { Unusable, validTarget, type Deploy, type HCState, type Spec, type State, type Status } from './spec.ts';

/** Connects to the agent of a spec: the session and the platform
 * ("os/arch", "" when the dial does not know it); progress reports what it
 * is doing (State.deploy). */
export type Dialer = (spec: Spec, signal: AbortSignal, progress: (d: Deploy) => void) => Promise<{ session: Session; platform: string }>;

/** Serves a stream the agent opened towards the hub, after its header. */
export type StreamHandler = (m: Machine, conn: AgentStream, h: Header) => void;

export interface Timing {
  /** The first wait after a failed dial; it doubles up to backoffMaxMs. */
  backoffMinMs: number;
  backoffMaxMs: number;
  /** The wait after ssh asked for the user (an interactive login ends it). */
  authRetryMs: number;
  /** The wait after a session ended. */
  sessionRetryMs: number;
  helloTimeoutMs: number;
  /** How long a session the machine moved from (its node was taken over)
   * stays open, so that what used it opens its streams on the new one. */
  drainGraceMs: number;
  /** How long an agent may take to send the header of a stream it opened. */
  headerTimeoutMs: number;
}

export const DEFAULT_TIMING: Timing = {
  backoffMinMs: 500,
  backoffMaxMs: 120_000,
  authRetryMs: 30_000,
  sessionRetryMs: 1000,
  helloTimeoutMs: 30_000,
  drainGraceMs: 2000,
  headerTimeoutMs: 15_000,
};

const STABLE_SESSION_MS = 30_000;

/** How often the bytes of an upload are published at most (a new step is
 * published at once). */
export const DEPLOY_PUBLISH_MS = 250;

export interface MachineDeps {
  dial: Dialer;
  logger: Logger;
  /** Each new state. */
  publish: (st: State) => void;
  /** The handler of the agent's streams. */
  streams: () => StreamHandler | undefined;
  /** Whether the local machine has an agent here (not on Windows). */
  localSupported: boolean;
  timing?: Partial<Timing>;
}

/** A wait that wake() or an abort ends early. */
class Wait {
  private wakeUp: (() => void) | null = null;
  private woken = false;

  /** Ends the current wait, or the next one if none runs. */
  wake(): void {
    if (this.wakeUp) this.wakeUp();
    else this.woken = true;
  }

  /** Drops any wake queued before the next attempt began. */
  clear(): void {
    this.woken = false;
  }

  /** Resolves 'woken', 'timeout' or 'aborted'. */
  until(ms: number, signal: AbortSignal): Promise<'woken' | 'timeout' | 'aborted'> {
    if (signal.aborted) return Promise.resolve('aborted');
    if (this.woken) {
      this.woken = false;
      return Promise.resolve('woken');
    }
    return new Promise((resolve) => {
      const done = (why: 'woken' | 'timeout' | 'aborted') => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.wakeUp = null;
        resolve(why);
      };
      const timer = ms === Infinity ? undefined : setTimeout(() => done('timeout'), ms);
      const onAbort = () => done('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      this.wakeUp = () => done('woken');
    });
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Machine {
  readonly id: string;
  readonly kind: Spec['kind'];
  /** An ssh machine's target as configured; "" for the local one. */
  readonly target: string;
  /** Why the machine is never dialed (Unusable); "" for the others. */
  readonly unusable: string;

  private st: State;
  private session: Session | null = null;
  private readyAt?: number;
  /** What the agent said of its ssh session in its last hello (not part of
   * State, which the pages see). */
  private ssh = '';
  private enabled: boolean;
  /** Ends the connection loop of an enabled machine. */
  private stopRun: AbortController | null = null;
  private readonly retry = new Wait();
  private readonly enable = new Wait();
  private readonly deps: MachineDeps;
  private readonly timing: Timing;

  constructor(spec: Spec, deps: MachineDeps) {
    this.deps = deps;
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.id = spec.id;
    this.kind = spec.kind;
    this.target = spec.target ?? '';
    this.enabled = spec.enabled;
    this.unusable =
      spec.kind === 'ssh' && !validTarget(this.target)
        ? Unusable.InvalidTarget
        : spec.kind === 'local' && !deps.localSupported
          ? Unusable.LocalUnsupported
          : '';
    this.st = { ...spec, status: spec.enabled ? 'connecting' : 'disabled', updated_at: Date.now() };
    if (this.unusable) Object.assign(this.st, { status: 'error', code: this.unusable });
  }

  get label(): string {
    return this.st.label;
  }

  get local(): boolean {
    return this.kind === 'local';
  }

  /** The SSH_CONNECTION of the ssh session the agent runs in, as it last
   * reported it ("" when it did not). */
  get sshConnection(): string {
    return this.ssh;
  }

  /** The record of the machine as it is now. */
  spec(): Spec {
    return {
      id: this.id,
      label: this.st.label,
      kind: this.kind,
      ...(this.target ? { target: this.target } : {}),
      enabled: this.st.enabled,
    };
  }

  state(): State {
    return structuredClone(this.st);
  }

  get ready(): boolean {
    return this.st.status === 'ready';
  }

  /** Whether the machine has an agent session now. */
  get connected(): boolean {
    return this.session !== null;
  }

  private update(fn: (st: State) => void): void {
    fn(this.st);
    this.st.updated_at = Date.now();
    this.deps.publish(this.state());
  }

  /** Publishes what a dial is doing while the machine connects: a new step
   * at once, the bytes of the same step at most every DEPLOY_PUBLISH_MS;
   * nothing once the dial ended. */
  private deployProgress(): { report: (d: Deploy) => void; end: () => void } {
    let live = true;
    let last: Deploy | undefined;
    let at = 0;
    return {
      report: (d) => {
        if (!live || this.st.status !== 'connecting') return;
        const now = performance.now();
        const done = d.total !== undefined && d.sent === d.total;
        if (last?.step === d.step && !done && now - at < DEPLOY_PUBLISH_MS) return;
        last = d;
        at = now;
        this.update((st) => (st.deploy = { ...d }));
      },
      end: () => {
        live = false;
      },
    };
  }

  private setStatus(status: Status, err?: unknown): void {
    this.update((st) => {
      st.status = status;
      if (err === undefined) delete st.error;
      else st.error = errorText(err);
      delete st.deploy;
      // Why the machine build could not be deployed, which the UI explains.
      const failure = err === undefined ? undefined : deployCode(err);
      if (failure) st.failure = failure;
      else delete st.failure;
    });
  }

  /** Publishes the state of the hub's connection to the machine's
   * terminal core; undefined when the hub has none. */
  setHC(hc: HCState | undefined): void {
    if (JSON.stringify(hc) === JSON.stringify(this.st.hc)) return;
    this.update((st) => {
      if (hc) st.hc = { ...hc };
      else delete st.hc;
    });
  }

  /** Ends a backoff wait at once (after an interactive authentication); a
   * connected machine is not affected. */
  wake(): void {
    this.retry.wake();
  }

  /** The live agent session; fails offline without one. */
  live(): Session {
    if (!this.session) throw offline();
    return this.session;
  }

  /** Opens a stream with the agent (Session.open). */
  open(h: Header, opts?: Parameters<Session['open']>[1]): ReturnType<Session['open']> {
    return this.live().open(h, opts);
  }

  /** Opens a stream, returns the reply and closes the stream. */
  request(h: Header, opts?: Parameters<Session['request']>[1]): Promise<Reply> {
    return this.live().request(h, opts);
  }

  /** Keeps the machine connected while it is enabled, until signal ends. A
   * machine that is never dialed waits for signal only. */
  async run(signal: AbortSignal): Promise<void> {
    if (this.unusable) return;
    while (!signal.aborted) {
      if (!this.enabled) {
        await this.enable.until(Infinity, signal);
        continue;
      }
      const ac = new AbortController();
      const stop = () => ac.abort();
      signal.addEventListener('abort', stop, { once: true });
      this.stopRun = ac;
      try {
        await this.connect(ac.signal);
      } finally {
        signal.removeEventListener('abort', stop);
        this.stopRun = null;
      }
      // The session's last steps may have published a status since.
      if (!this.enabled) this.markDisabled();
    }
  }

  /** Shows the machine under a new label; whether it changed. (The
   * manager's: it checks and stores the label.) */
  setLabel(label: string): boolean {
    if (this.st.label === label) return false;
    this.update((st) => (st.label = label));
    return true;
  }

  /** Enables or disables the machine; whether that changed it. Disabling
   * ends its session (the agent exits and stops what it started, such as
   * code-server); programs keep running in its terminal core. (The
   * manager's: it stores the flag.) */
  setEnabled(on: boolean): boolean {
    if (this.enabled === on) return false;
    this.enabled = on;
    if (this.unusable) {
      // Its flag is kept; it stays in error, and is never dialed.
      this.update((st) => (st.enabled = on));
      return true;
    }
    if (on) {
      this.update((st) => {
        st.enabled = true;
        st.status = 'connecting';
        delete st.error;
      });
      this.enable.wake();
      return true;
    }
    this.stopRun?.abort();
    this.markDisabled();
    return true;
  }

  private markDisabled(): void {
    this.update((st) => {
      st.enabled = false;
      st.status = 'disabled';
      delete st.error;
      delete st.deploy;
    });
  }

  /** Keeps the machine connected until signal ends. */
  private async connect(signal: AbortSignal): Promise<void> {
    const t = this.timing;
    let backoff = t.backoffMinMs;
    while (!signal.aborted) {
      this.retry.clear();
      this.readyAt = undefined;
      this.setStatus('connecting');
      let dialed: { session: Session; platform: string };
      const progress = this.deployProgress();
      try {
        dialed = await this.deps.dial(this.spec(), signal, progress.report);
      } catch (e) {
        progress.end();
        if (signal.aborted) return;
        if (e instanceof SSHTimeoutError) {
          this.setStatus('error', e);
          this.deps.logger(`machine ${this.label}: ${errorText(e)} (waiting for retry)`);
          await this.retry.until(Infinity, signal);
          backoff = t.backoffMinMs;
          continue;
        }
        let wait = backoff;
        if (e instanceof AuthRequiredError) {
          this.setStatus('auth_required', e);
          wait = t.authRetryMs;
        } else {
          this.setStatus('error', e);
          backoff = Math.min(backoff * 2, t.backoffMaxMs);
        }
        wait = retryDelay(wait);
        this.deps.logger(`machine ${this.label}: ${errorText(e)} (retry in ${wait / 1000}s)`);
        if ((await this.retry.until(wait, signal)) === 'woken') backoff = t.backoffMinMs;
        continue;
      }
      progress.end();
      if (signal.aborted) {
        // The dial ended after the machine was stopped: not ready.
        dialed.session.close();
        return;
      }
      let err: unknown;
      try {
        await this.serve(dialed.session, dialed.platform, signal);
      } catch (e) {
        err = e;
      }
      this.session?.close();
      this.session = null;
      dialed.session.close();
      if (signal.aborted) return;
      this.setStatus('error', err ?? new Error('session ended'));
      if (err instanceof SSHTimeoutError && this.readyAt === undefined) {
        this.deps.logger(`machine ${this.label}: ${errorText(err)} (waiting for retry)`);
        await this.retry.until(Infinity, signal);
        backoff = t.backoffMinMs;
        continue;
      }
      this.deps.logger(`machine ${this.label}: session ended: ${errorText(err)}`);
      const stable = this.readyAt !== undefined && performance.now() - this.readyAt >= STABLE_SESSION_MS;
      const delay = stable ? t.sessionRetryMs : Math.max(t.sessionRetryMs, backoff);
      backoff = stable ? t.backoffMinMs : Math.min(delay * 2, t.backoffMaxMs);
      if ((await this.retry.until(retryDelay(delay), signal)) === 'woken') backoff = t.backoffMinMs;
    }
  }

  /** Serves sess until it ends; when the node drains (another took over),
   * moves to the node that serves the machine now. */
  private async serve(sess: Session, platform: string, signal: AbortSignal): Promise<void> {
    await this.hello(sess, platform, signal);
    let drained = this.accept(sess);
    for (;;) {
      const why = await Promise.race([
        sess.done().then(() => 'ended' as const),
        drained.then(() => 'drain' as const),
        new Promise<'aborted'>((r) =>
          signal.aborted ? r('aborted') : signal.addEventListener('abort', () => r('aborted'), { once: true }),
        ),
      ]);
      if (why === 'aborted') throw signal.reason;
      if (why === 'ended') throw sess.err ?? new Error('session ended');
      let next: { session: Session; platform: string };
      try {
        // The machine stays ready meanwhile: no progress to show.
        next = await this.deps.dial(this.spec(), signal, () => {});
      } catch (e) {
        this.deps.logger(`machine ${this.label}: its node drains; connecting again failed: ${errorText(e)}`);
        drained = new Promise(() => {});
        continue;
      }
      try {
        await this.hello(next.session, next.platform, signal);
      } catch (e) {
        next.session.close();
        this.deps.logger(`machine ${this.label}: its node drains; the new one did not answer: ${errorText(e)}`);
        drained = new Promise(() => {});
        continue;
      }
      this.deps.logger(`machine ${this.label}: moved to the node that took over`);
      const old = sess;
      setTimeout(() => old.close(), this.timing.drainGraceMs).unref?.();
      sess = next.session;
      drained = this.accept(sess);
    }
  }

  /** Asks sess's agent for its host and makes it the machine's session:
   * the machine is ready. */
  private async hello(sess: Session, platform: string, signal: AbortSignal): Promise<void> {
    let rep: Reply;
    try {
      rep = await sess.request({ op: Op.Hello }, { signal, timeoutMs: this.timing.helloTimeoutMs });
    } catch (e) {
      const msg = `hello: ${errorText(e)}`;
      if (this.kind === 'ssh' && errorText(e).includes('no reply in time')) throw new SSHTimeoutError(msg);
      throw new Error(msg);
    }
    this.session = sess;
    this.readyAt = performance.now();
    this.ssh = rep.ssh ?? '';
    this.update((st) => {
      if (rep.info) st.info = rep.info;
      else delete st.info;
      st.platform = platform || (rep.info ? `${rep.info.os}/${rep.info.arch}` : '');
      if (!st.platform) delete st.platform;
      st.status = 'ready';
      delete st.error;
      delete st.failure;
      delete st.deploy;
    });
  }

  /** Serves the streams the agent opens towards the hub; resolves when the
   * node announces its drain (Op.NodeDrain). */
  private accept(sess: Session): Promise<void> {
    return new Promise((drained) => {
      const loop = async () => {
        for (;;) {
          let stream;
          try {
            stream = await sess.accept();
          } catch {
            return;
          }
          void this.serveStream({ stream, reader: new Reader(stream) }, drained);
        }
      };
      void loop();
    });
  }

  private async serveStream(conn: AgentStream, drained: () => void): Promise<void> {
    const timer = setTimeout(() => conn.stream.destroy(new Error('no header in time')), this.timing.headerTimeoutMs);
    let h: Header;
    try {
      h = await readLine<Header>(conn.reader);
    } catch {
      closeStream(conn.stream);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (h.op === Op.NodeDrain) {
      await writeLine(conn.stream, { ok: true } satisfies Reply).catch(() => {});
      closeStream(conn.stream);
      drained();
      return;
    }
    const handler = this.deps.streams();
    if (!handler) {
      await writeLine(conn.stream, { ok: false, error: 'unsupported' } satisfies Reply).catch(() => {});
      closeStream(conn.stream);
      return;
    }
    handler(this, conn, h);
  }
}
