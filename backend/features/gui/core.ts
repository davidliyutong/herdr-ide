// Program windows (docs/features/14-gui-windows.md): windows of programs
// on remote Linux machines in browser windows. The core prepares each
// machine's virtual display through its agent and attaches to its window
// manager (manager.ts), routes windows, frames and input between the agent
// and the browser windows showing them (router.ts, routes.ts), tells every
// page each machine's state (/ws "gui" messages) and gives new terminals
// the display's environment (paneEnv, which the terminals feature adds to
// the terminal core's terminal.run). The machine's side is the agent's op
// gui (agent.ts).
//
// Its switch is gui.enabled, which machines can have of their own: the
// feature applies it per machine, so its routes are always there.
import { defineFeature, type FeatureDef } from '#kernel/feature.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import type { DisplayAgent } from './agent.ts';
import type { Shells } from './enable.ts';
import { Manager } from './manager.ts';
import { routes } from './routes.ts';
import { settings } from './settings.ts';
import type { Limits, Timing } from './timing.ts';

export interface GUIOptions {
  /** The video encoder this build carries for a platform (Payloads.encoder);
   * without it windows are sent as pictures. */
  encoder?: (os: string, arch: string) => Promise<{ gz: Uint8Array; digest: string }>;
  /** The shells of a machine's terminals, while its terminal core is
   * connected (the terminals feature's shells), for enabling the display
   * in open terminals. */
  shells?: (machine: string) => Shells | undefined;
  /** The machines' side; their agents by default. */
  agent?: DisplayAgent;
  timing?: Partial<Timing>;
  limits?: Partial<Limits>;
  now?: () => number;
}

export interface GUIFeature extends FeatureDef {
  /** The variables of m's display that new terminals get; undefined while
   * it has none (the terminals feature's paneEnv). */
  paneEnv(m: Machine): Record<string, string> | undefined;
  /** Follows whether m's terminal core is ready (the terminals feature's
   * onReady): the machine keeps its display while the terminal core runs. */
  terminalReady(m: Machine, ready: boolean): void;
  /** The manager, once the core set the feature up (tests). */
  manager(): Manager | undefined;
}

export function guiFeature(o: GUIOptions = {}): GUIFeature {
  let mgr: Manager | undefined;
  const def = defineFeature({
    id: 'gui',
    toggle: false,
    settings,
    setup(ctx) {
      const now = o.now ?? Date.now;
      const m = new Manager({
        machines: ctx.machines,
        settings: ctx.settings,
        readOnly: ctx.readOnly,
        audit: ctx.audit,
        logger: ctx.logger,
        publish: (state) => ctx.pages.broadcast({ t: 'gui', state }),
        agent: o.agent,
        encoder: o.encoder,
        timing: o.timing,
        limits: o.limits,
        now,
      });
      mgr = m;
      routes(ctx, m, { shells: o.shells, now });
      // Each page starts from every machine's state.
      ctx.pages.onOpen((p) => {
        for (const state of m.states()) p.send({ t: 'gui', state });
      });
      ctx.onForget((id) => m.forget(id));
      ctx.service('displays', (signal) => m.run(signal));
    },
  });
  return Object.assign(def, {
    paneEnv: (m: Machine) => mgr?.paneEnv(m),
    terminalReady: (m: Machine, ready: boolean) => mgr?.terminalReady(m, ready),
    manager: () => mgr,
  });
}
