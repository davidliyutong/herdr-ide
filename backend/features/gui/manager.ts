// Prepares each remote machine's display through its agent (status,
// install, start, attach), once per connection, retrying failures with a
// backoff; keeps one attach stream per machine and routes its windows;
// tells pages each machine's state; gives new terminals the display's
// environment. A change of the settings or a reconnect starts over; a
// machine disabled, reconnecting, failing or removed is shown as
// disconnected without windows. Read-only mode attaches only to a display
// that runs: nothing is installed or started.
import type { GUICommand, GUIStatus } from '#shared/proto/agentproto/index.ts';
import { GUIMessage } from '#shared/proto/agentproto/index.ts';
import type { Logger } from '#shared/lib/log.ts';
import type { Audit } from '#kernel/audit.ts';
import { Fail } from '#kernel/fail.ts';
import type { Change, Store as Settings } from '#kernel/config/settings/index.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import type { Session } from '#kernel/machines/transport/session.ts';
import { machineAgent, type DisplayAgent } from './agent.ts';
import { Display, sessionOf } from './display.ts';
import { enableShells, type EnableResult, type Shells } from './enable.ts';
import { afterAttach, plan, retryDelay, wantKind } from './plan.ts';
import { Key } from './settings.ts';
import { displayEnv, Phase, stateOf, vulkanGPU, type PhaseName, type State } from './state.ts';
import { AttachStream } from './stream.ts';
import { DEFAULT_LIMITS, DEFAULT_TIMING, type Limits, type Timing } from './timing.ts';
import type { Viewer } from './viewer.ts';

export interface ManagerOptions {
  machines: Machines;
  settings: Settings;
  readOnly: boolean;
  audit: Audit;
  logger: Logger;
  /** Tells the pages a machine's state. */
  publish: (st: State) => void;
  /** The machines' side; their agents by default. */
  agent?: DisplayAgent;
  /** The video encoder this build carries for a platform (Payloads.encoder);
   * without it windows are sent as pictures. */
  encoder?: (os: string, arch: string) => Promise<{ gz: Uint8Array; digest: string }>;
  timing?: Partial<Timing>;
  limits?: Partial<Limits>;
  /** The clock, in milliseconds. */
  now?: () => number;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The settings whose change for a machine the manager follows. */
const FOLLOWED = new Set<string>([Key.GUI, Key.Video, Key.Display, Key.GPUPick]);

export class Manager {
  readonly timing: Timing;
  readonly limits: Limits;
  readonly readOnly: boolean;
  private readonly o: ManagerOptions;
  private readonly agent: DisplayAgent;
  private readonly now: () => number;
  private readonly displays = new Map<string, Display>();
  /** Ends with the service: every request, stream and timer the manager
   * started ends with it. */
  private readonly life = new AbortController();

  constructor(o: ManagerOptions) {
    this.o = o;
    this.readOnly = o.readOnly;
    this.agent = o.agent ?? machineAgent;
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.now = o.now ?? Date.now;
  }

  private get closed(): boolean {
    return this.life.signal.aborted;
  }

  /** The service's signal, bounded by ms. */
  private bounded(ms: number): AbortSignal {
    return AbortSignal.any([this.life.signal, AbortSignal.timeout(ms)]);
  }

  // The settings, for a machine.
  enabled(machine: string): boolean {
    return this.o.settings.bool(Key.GUI, machine);
  }
  private video(machine: string): boolean {
    return this.o.settings.bool(Key.Video, machine);
  }
  private displayKind(machine: string): string {
    return this.o.settings.string(Key.Display, machine);
  }
  private pick(machine: string): boolean {
    return this.o.settings.bool(Key.GPUPick, machine);
  }

  /** The record of m's display, made on first use. */
  display(m: Machine): Display {
    let d = this.displays.get(m.id);
    if (!d) {
      d = new Display(m, { video: () => this.video(m.id), now: this.now, timing: this.timing, limits: this.limits });
      this.displays.set(m.id, d);
    }
    d.machine = m;
    return d;
  }

  private stateOf(d: Display): State {
    return stateOf(d, this.pick(d.id));
  }

  private publish(d: Display): void {
    this.o.publish(this.stateOf(d));
  }

  private setPhase(d: Display, phase: PhaseName, err?: unknown): void {
    if (d.gone || this.closed) return;
    d.phase = phase;
    d.err = err === undefined ? '' : errorText(err);
    this.publish(d);
  }

  /** The state of every machine seen so far, by id. */
  states(): State[] {
    return [...this.displays.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((d) => this.stateOf(d));
  }

  /** The environment new panes on m get; undefined when they get none.
   * Only a display the agent verified as its own: a number without a
   * server could be taken by someone else. */
  paneEnv(m: Machine): Record<string, string> | undefined {
    if (!this.enabled(m.id) || m.local) return undefined;
    const d = this.displays.get(m.id);
    if (!d?.status?.display || d.phase !== Phase.Ready) return undefined;
    return displayEnv(d.status, { gpu: this.o.settings.string(Key.GPU, m.id), pick: this.pick(m.id) });
  }

  /** Prepares m's display and attaches to it, unless that is done, under
   * way, or was tried for the machine's current connection (it is called
   * on every state change of the machine); force also retries after a
   * preparation that did not end attached. It returns at once. */
  ensure(m: Machine, force = false): void {
    if (this.closed) return;
    const d = this.display(m);
    let sess = sessionOf(m);
    if (!sess || !d.claim(sess, force)) return;
    void (async () => {
      for (;;) {
        try {
          await this.prepare(d, sess);
        } catch (e) {
          this.o.logger(`gui ${d.machine.label}: ${errorText(e)}`);
        }
        const next = d.finish(sess, sessionOf(d.machine));
        if (!next || this.closed) return;
        sess = next;
      }
    })();
  }

  /** Whether m is still connected through sess. */
  private onSession(m: Machine, sess: Session): boolean {
    return sessionOf(m) === sess && m.ready;
  }

  /** Shows that preparing or attaching the display over sess failed and
   * retries later. A machine that lost that connection meanwhile shows no
   * error: the failure is most likely the connection's, and the next one
   * prepares the display again. */
  private fail(d: Display, sess: Session, err: unknown): void {
    if (this.closed) return;
    if (!this.onSession(d.machine, sess)) return this.setPhase(d, Phase.Disconnected);
    this.setPhase(d, Phase.Error, err);
    this.retryLater(d, sess);
  }

  /** Prepares the display again after a backoff, if the machine is still
   * on the same connection. */
  private retryLater(d: Display, sess: Session): void {
    if (d.gone) return;
    const delay = retryDelay(d.failures, this.timing);
    d.failures++;
    clearTimeout(d.retry);
    d.retry = setTimeout(() => {
      d.retry = undefined;
      if (!d.gone && sessionOf(d.machine) === sess) this.ensure(d.machine, true);
    }, delay);
  }

  private async prepare(d: Display, sess: Session): Promise<void> {
    const m = d.machine;
    if (!this.enabled(m.id)) return this.setPhase(d, Phase.Off);
    if (m.local) return this.setPhase(d, Phase.Local);
    const timeoutMs = this.timing.prepareMs;
    const signal = this.bounded(timeoutMs);
    let st: GUIStatus;
    try {
      st = await this.agent.request(m, 'status', { signal, timeoutMs });
    } catch (e) {
      return this.fail(d, sess, e);
    }
    d.status = st;
    const asked = this.displayKind(m.id);
    const { actions, stop } = plan(st, this.readOnly, asked);
    if (stop) return this.setPhase(d, stop as PhaseName);
    for (const a of actions) {
      this.setPhase(d, a === 'install' ? Phase.Installing : Phase.Starting);
      this.o.audit.log(null, `gui.${a}`, { machine: m.id });
      try {
        st = await this.agent.request(m, a, { args: a === 'start' ? [asked] : [], signal, timeoutMs });
      } catch (e) {
        return this.fail(d, sess, e);
      }
    }
    let attached: Awaited<ReturnType<DisplayAgent['attach']>>;
    try {
      attached = await this.agent.attach(m, this.life.signal);
    } catch (e) {
      return this.fail(d, sess, e);
    }
    const stream = new AttachStream(attached.conn, { maxCommands: this.limits.agentCommands, detachMs: this.timing.detachMs });
    if (this.closed || d.gone) return stream.close();
    // The setting may have been turned off while the display was prepared.
    if (!this.enabled(m.id)) {
      stream.close();
      return this.setPhase(d, Phase.Off);
    }
    d.stream?.close(); // from before a reconnect
    d.status = attached.status ?? st;
    d.sess = sess;
    d.stream = stream;
    // The keeper is asked for below; the next change with the terminal
    // hub reachable asks again, in case it was down meanwhile.
    d.up = false;
    d.router.attached();
    this.setPhase(d, Phase.Ready);
    void this.read(d, sess, stream);
    if (afterAttach(this.readOnly, false).keep) void this.keep(d);
    if (afterAttach(this.readOnly, this.video(m.id)).push) void this.prepareVideo(d);
    if (afterAttach(this.readOnly, this.pick(m.id)).push) void this.preparePick(d);
  }

  /** Handles the attach stream until it ends. */
  private async read(d: Display, sess: Session, stream: AttachStream): Promise<void> {
    const attachedAt = this.now();
    const err = await stream.read((kind, payload) => {
      if (d.stream !== stream) return; // replaced or detached
      try {
        if (kind === GUIMessage.JSON) {
          if (d.router.event(payload)) this.publish(d);
        } else if (kind === GUIMessage.Frame) d.router.frame(payload);
      } catch (e) {
        this.o.logger(`gui ${d.machine.label}: ${errorText(e)}`);
      }
    });
    if (d.stream !== stream) return;
    d.stream = null;
    d.router.detached();
    if (this.now() - attachedAt >= this.timing.stableAttachMs) d.failures = 0;
    // A machine that reconnects ensures again.
    if (sessionOf(d.machine) !== sess) return;
    this.fail(d, sess, err);
  }

  /** Follows a change of gui.enabled for m: detaches from the machine's
   * display when it is off there, and prepares it otherwise. A detached
   * display keeps running until idle; its programs keep their windows. */
  apply(m: Machine): void {
    if (this.enabled(m.id)) return this.ensure(m, true);
    const d = this.display(m);
    d.detach();
    this.setPhase(d, Phase.Off);
  }

  /** Follows a change of gui.display for m: a display of another kind than
   * now asked for is prepared anew, which replaces it unless a program
   * uses it (then it stays until it ends). */
  applyDisplay(m: Machine): void {
    if (!this.enabled(m.id) || m.local) return;
    const d = this.displays.get(m.id);
    if (d?.stream) {
      if (d.status && d.status.kind === wantKind(d.status, this.displayKind(m.id))) return;
      d.detach();
      this.setPhase(d, Phase.Starting);
    }
    this.ensure(m, true);
  }

  /** Follows a change of gui.gpuPick for m: turning it on puts the library
   * on the machine; new panes get it, or no longer. */
  applyPick(m: Machine): void {
    const d = this.displays.get(m.id);
    if (!d?.stream) return;
    this.publish(d);
    if (afterAttach(this.readOnly, this.pick(m.id)).push) void this.preparePick(d);
  }

  /** Follows a change of gui.video for m: viewed windows get the streams
   * their viewers share (none when off), and turning it on puts the
   * encoder on the machine. */
  applyVideo(m: Machine): void {
    const d = this.displays.get(m.id);
    if (!d?.stream) return;
    d.router.videoChanged();
    if (afterAttach(this.readOnly, this.video(m.id)).push) void this.prepareVideo(d);
  }

  /** Follows m leaving the connected states (disabled, reconnecting,
   * failing): it detaches and shows the display as disconnected, so an
   * earlier error or program windows do not stay on screen. The next
   * connection prepares the display again. */
  disconnected(m: Machine): void {
    const d = this.displays.get(m.id);
    if (!d || (d.phase === Phase.Disconnected && !d.stream)) return;
    d.detach();
    this.setPhase(d, Phase.Disconnected);
  }

  /** Drops the display of a removed machine: it detaches, and pages are
   * told it is disconnected. A preparation still running for it publishes
   * nothing more. */
  forget(id: string): void {
    const d = this.displays.get(id);
    if (!d) return;
    this.displays.delete(id);
    d.dispose();
    d.gone = true;
    d.phase = Phase.Disconnected;
    d.err = '';
    if (!this.closed) this.publish(d);
  }

  /** Follows the machine's terminal core, whose programs get the display:
   * each time it is reachable again (or for the first time) while the
   * display is attached, the machine is asked to keep the display while
   * the terminal core runs, since a keeper started while it was down has
   * left. */
  terminalReady(m: Machine, ready: boolean): void {
    const d = this.displays.get(m.id);
    if (!d) return;
    const start = ready && !d.up && d.stream !== null && d.phase === Phase.Ready;
    d.up = ready && (d.up || start);
    if (start && afterAttach(this.readOnly, false).keep) void this.keep(d);
  }

  /** Has the machine keep its display while its terminal core runs, also
   * after this connection ends. */
  private async keep(d: Display): Promise<void> {
    const timeoutMs = this.timing.keepMs;
    this.o.audit.log(null, 'gui.keep', { machine: d.id });
    try {
      await this.agent.request(d.machine, 'keep', { signal: this.bounded(timeoutMs), timeoutMs });
    } catch (e) {
      if (!this.closed) this.o.logger(`gui ${d.machine.label}: keeping the display: ${errorText(e)}`);
    }
  }

  /** Has a machine with several NVIDIA GPUs install the library that shows
   * a program only the GPUs of its CUDA_VISIBLE_DEVICES, which the agent
   * carries. Without it panes get the display as before. */
  private async preparePick(d: Display): Promise<void> {
    if (!d.status || !vulkanGPU(d.status) || d.status.pick) return;
    const timeoutMs = this.timing.keepMs;
    this.o.audit.log(null, 'gui.pick', { machine: d.id });
    let st: GUIStatus;
    try {
      st = await this.agent.request(d.machine, 'pick', { signal: this.bounded(timeoutMs), timeoutMs });
    } catch (e) {
      if (!this.closed) this.o.logger(`gui ${d.machine.label}: GPU selection: ${errorText(e)}`);
      return;
    }
    if (!d.status || d.gone || this.closed) return;
    d.status = { ...d.status, pick: st.pick };
    this.publish(d);
  }

  /** Puts the video encoder this build brings on the machine, so that its
   * windows can be sent as video. A build without one for the machine asks
   * for the machine build's own (the TypeScript machine build carries its
   * platform's): a video request without a digest, which the Go machine
   * build answers without video. Without either, or when it fails,
   * windows are sent as pictures. */
  private async prepareVideo(d: Display): Promise<void> {
    const m = d.machine;
    const info = m.state().info;
    if (!info) return;
    const log = (e: unknown) => !this.closed && this.o.logger(`gui ${m.label}: video: ${errorText(e)}`);
    const timeoutMs = this.timing.videoMs;
    let enc: { gz: Uint8Array; digest: string };
    try {
      if (!this.o.encoder) throw new Error(`no video encoder for ${info.os}-${info.arch} in this build`);
      enc = await this.o.encoder(info.os, info.arch);
    } catch (e) {
      try {
        const st = await this.agent.video(m, '', { signal: this.bounded(timeoutMs), timeoutMs });
        if (st?.video)
          return void this.o.logger(`gui ${m.label}: video encoders [${(st.video_encoders ?? []).join(' ')}] (the machine's own)`);
      } catch {
        // as without
      }
      return void log(e);
    }
    const signal = this.bounded(timeoutMs);
    try {
      let st = await this.agent.video(m, enc.digest, { signal, timeoutMs });
      if (!st?.video) {
        this.o.audit.log(null, 'gui.video', { machine: m.id, sha256: enc.digest });
        st = await this.agent.installVideo(m, enc.digest, enc.gz, { signal, timeoutMs });
      }
      if (st) this.o.logger(`gui ${m.label}: video encoders [${(st.video_encoders ?? []).join(' ')}]`);
    } catch (e) {
      log(e);
    }
  }

  // Browser windows (routes.ts).

  /** Adds a viewer to window id of a machine and sends it what it needs to
   * draw it; false when the window does not exist. */
  attach(machine: string, id: number, v: Viewer): boolean {
    return this.displays.get(machine)?.router.attach(id, v) ?? false;
  }

  /** Removes a viewer. */
  detach(machine: string, id: number, v: Viewer): void {
    this.displays.get(machine)?.router.detach(id, v);
  }

  /** Closes a window whose browser window was closed, after a grace. */
  closeWindow(machine: string, id: number): void {
    this.displays.get(machine)?.router.close(id);
  }

  /** Handles a message of a viewer of window id; input only when allowed. */
  command(machine: string, id: number, v: Viewer, c: GUICommand, input: boolean): void {
    this.displays.get(machine)?.router.command(id, v, c, input);
  }

  /** Gives the shells of terminals that were opened without the display the
   * display's environment (enable.ts); ids defaults to all of them. Fails
   * off or not_ready (409) before it starts; an EnableError carries what
   * it did when the agent could not be asked. */
  async enable(m: Machine, shells: Shells, ids: readonly string[], signal: AbortSignal): Promise<EnableResult> {
    if (!this.enabled(m.id)) throw new Fail('off', 409, 'program windows are off for this machine');
    const env = this.paneEnv(m);
    const d = this.displays.get(m.id);
    if (!env || !d) throw new Fail('not_ready', 409, 'the display is not ready');
    return enableShells(ids, {
      env,
      shells,
      procs: (pids) => this.agent.shells(m, pids, { signal, timeoutMs: this.timing.enableMs }),
      typed: d.typed,
      pauseMs: this.timing.interruptPauseMs,
      signal,
    });
  }

  /** Follows a change of settings for each connected machine it applies
   * to (a global change: every machine without its own value). */
  private settingsChanged(changes: readonly Change[]): void {
    for (const c of changes) {
      if (!FOLLOWED.has(c.key)) continue;
      for (const m of this.o.machines.list()) {
        if ((c.machine && m.id !== c.machine) || !m.ready) continue;
        if (c.key === Key.Video) this.applyVideo(m);
        else if (c.key === Key.Display) this.applyDisplay(m);
        else if (c.key === Key.GPUPick) this.applyPick(m);
        else this.apply(m);
      }
    }
  }

  /** Follows the machines and the settings until signal ends, then ends
   * every attachment, request and timer. */
  async run(signal: AbortSignal): Promise<void> {
    const unsubscribe = this.o.machines.subscribe({
      state: (st) => {
        const m = this.o.machines.get(st.id);
        if (!m) return;
        if (st.status === 'ready') this.ensure(m);
        // Disabled, reconnecting or failing: no display error or windows
        // stay on screen for a machine that is not connected.
        else this.disconnected(m);
      },
    });
    const unwatch = this.o.settings.onChange((changes) => this.settingsChanged(changes));
    for (const m of this.o.machines.list()) if (m.ready) this.ensure(m);
    await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })));
    unsubscribe();
    unwatch();
    this.close();
  }

  /** Ends everything the manager started. */
  close(): void {
    this.life.abort();
    for (const d of this.displays.values()) d.dispose();
  }
}
