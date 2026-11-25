// Terminals: the machines' terminal cores (herdr-core, features 21 and 22)
// for clients that draw terminals themselves. The WebSocket /api/v1/term
// carries calls and events as JSON text messages and terminal bytes as
// binary frames (messages.ts); a backend per machine holds the hub's
// connection to the machine's terminal core (backend.ts). The terminal
// core's status, its start, stop and restart from the UI, and what macOS's
// Full Disk Access lets a machine's processes do are routes of their own.
import { Op, type PrivacyStatus } from '#shared/proto/agentproto/index.ts';
import { defineFeature, type FeatureDef } from '#kernel/feature.ts';
import { Fail } from '#kernel/fail.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { SSH_ENV } from '#kernel/config/ui/index.ts';
import { Backend } from './backend.ts';
import { Switchboard } from './switchboard.ts';
import { hcAction, hcStatus, online, type HCSource } from './lifecycle.ts';
import { Code } from './messages.ts';
import { shells, type Shells } from './shells.ts';
import { sshEnv } from './sshenv.ts';
import { DEFAULT_TIMING, type Timing } from './timing.ts';

export interface TerminalsOptions {
  /** herdr-core for a machine's platform (Payloads.hc); without it, or
   * when the build has none for the platform, the hub installs nothing
   * and uses the terminal core the machine has. */
  hc?: HCSource;
  /** The herdr-core digests a TypeScript build recorded
   * (Payloads.embeddedHC): a machine build that carries another is not
   * run. */
  embeddedHC?: (os: string, arch: string) => Promise<string | null>;
  /** The variables of a machine's virtual display that new terminals get
   * (program windows, feature 14); none by default. */
  paneEnv?: (m: Machine) => Record<string, string> | undefined;
  /** Whether the machines resolve the sessions of the agents in their
   * terminals: while the agents feature is on (plugins.agents.enabled; on
   * when no such setting is registered). */
  sessions?: () => boolean;
  /** Told whether a machine's terminal core is ready, at each change of
   * the backend's state (program windows follow it). */
  onReady?: (m: Machine, ready: boolean) => void;
  timing?: Partial<Timing>;
  /** Bytes a client's channel may hold unsent before the client is
   * disconnected (64 MiB). */
  maxBuffered?: number;
}

export interface TerminalsFeature extends FeatureDef {
  /** A machine's backend, once a client followed the machine. */
  existing(machine: string): Backend | undefined;
  /** The shells of a machine's terminals, while its backend is connected. */
  shells(machine: string): Shells | undefined;
}

const ACTIONS = new Set(['start', 'stop', 'restart']);

/** A request's own signal, bounded by ms. */
const bounded = (req: Request, ms: number) => AbortSignal.any([req.signal, AbortSignal.timeout(ms)]);

/** Fails with machine_offline unless the machine has an agent session. */
function mustBeOnline(m: Machine): void {
  if (!online(m)) throw new Fail(Code.Offline, 409, 'machine not connected');
}

export function terminalsFeature(o: TerminalsOptions = {}): TerminalsFeature {
  let board: Switchboard | undefined;
  const def = defineFeature({
    id: 'terminals',
    toggle: false,
    audit: 'term',
    setup(ctx) {
      const timing: Timing = { ...DEFAULT_TIMING, ...o.timing };
      // A setting the hub does not have takes its default: on.
      const setting = (key: string, machine = '') => {
        try {
          return ctx.settings.bool(key, machine);
        } catch {
          return true;
        }
      };
      const h = new Switchboard({
        machines: ctx.machines,
        logger: ctx.logger,
        audit: ctx.audit,
        readOnly: ctx.readOnly,
        hc: o.hc,
        ...(o.embeddedHC ? { embeddedHC: o.embeddedHC } : {}),
        paneEnv: o.paneEnv ?? (() => undefined),
        // SSH_CONNECTION and SSH_CLIENT as the ssh session of the agent of
        // an ssh machine has them (sshenv.ts).
        sshEnv: (m) => (m.local || !setting(SSH_ENV, m.id) ? null : sshEnv(m.sshConnection)),
        sessions: o.sessions ?? (() => setting('plugins.agents.enabled')),
        onReady: o.onReady,
        timing,
        maxBuffered: o.maxBuffered ?? 64 << 20,
      });
      board = h;

      ctx.route('/api/v1').get('/term', (c) => {
        if (!c.env.upgrade) throw new Fail('upgrade_required', 426);
        const who = c.var.who;
        return c.env.upgrade((ch) => h.connect(ch, who));
      });

      const api = ctx.route('/api');
      // The terminal core of a machine: the installed executable's digest,
      // whether a core answers, its version, session and socket.
      api.get('/m/:id/hc', ctx.machine, async (c) => {
        const m = c.var.machine;
        mustBeOnline(m);
        try {
          return c.json(await hcStatus(m, bounded(c.req.raw, timing.statusMs), timing.statusMs));
        } catch {
          throw new Fail('transport', 502);
        }
      });

      // Starts, stops or restarts a machine's terminal core. Starting
      // installs the build's executable when the machine has another one;
      // restarting keeps the programs (the core's successor adopts them);
      // stopping ends every program of the core and keeps the core stopped
      // until it is started again, also while clients stay subscribed. The
      // answer is the core's status.
      api.post('/m/:id/hc/:action', ctx.writable, ctx.machine, async (c) => {
        const m = c.var.machine;
        const action = c.req.param('action');
        if (!ACTIONS.has(action)) throw new Fail('unknown_action', 404, 'unknown action');
        mustBeOnline(m);
        const signal = bounded(c.req.raw, timing.actionMs);
        const b = h.backend(m.id);
        b.stopped = action === 'stop';
        let code = '';
        if (action === 'stop') {
          try {
            await hcAction(m, 'stop', '', signal, timing.actionMs);
          } catch {
            code = 'transport';
          }
        } else code = await b.ensure(action === 'restart', signal);
        b.wakeUp();
        ctx.audit.log(c.var.who, `hc.${action}`, { machine: m.id, ...(code ? { error: code } : {}) });
        if (code) throw new Fail(code, 502);
        try {
          return c.json(await hcStatus(m, signal, timing.actionMs));
        } catch {
          throw new Fail('transport', 502);
        }
      });

      // What macOS's Full Disk Access lets the machine's processes do:
      // files, for the agent's own process (on the local machine the
      // hub's), and terminals, for the terminal core's; each granted,
      // denied or unknown, with the terminal core's executable, which a
      // grant for terminals names. The agent only opens and closes
      // protected folders, and in a terminal core that runs; it starts none.
      api.get('/m/:id/privacy', ctx.machine, async (c) => {
        const m = c.var.machine;
        mustBeOnline(m);
        let privacy: PrivacyStatus | undefined;
        try {
          privacy = (await m.request({ op: Op.Privacy }, { signal: bounded(c.req.raw, timing.statusMs), timeoutMs: timing.statusMs }))
            .privacy;
        } catch {
          // answered below
        }
        if (!privacy) throw new Fail('transport', 502);
        return c.json(privacy);
      });

      // A removed machine's backend goes; one added again starts afresh.
      ctx.onForget((id) => h.forget(id));

      ctx.service('backends', async (signal) => {
        // A machine that connects (again) ends the wait of its backend.
        const ready = new Map<string, boolean>();
        const unsubscribe = ctx.machines.subscribe({
          state: (st) => {
            const now = st.status === 'ready';
            const before = ready.get(st.id) ?? false;
            ready.set(st.id, now);
            if (now && !before) h.wakeUp(st.id);
          },
        });
        await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })));
        unsubscribe();
        h.close();
      });
    },
  });
  return Object.assign(def, {
    existing: (machine: string) => board?.existing(machine),
    shells: (machine: string) => {
      const b = board?.existing(machine);
      return b?.connection() ? shells(b) : undefined;
    },
  });
}
