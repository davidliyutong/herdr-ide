// The feature contract. A feature is everything one part of the product
// does on the core's side: its routes, channels, background services,
// settings, the streams agents open towards the core, what it keeps per
// machine. It is defined once (defineFeature) and set up by the kernel with
// a FeatureContext that holds what it may use, never the whole core.
import type { Hono, MiddlewareHandler } from 'hono';
import type { Logger } from '#shared/lib/log.ts';
import type { Header } from '#shared/proto/agentproto/index.ts';
import type { Protocol } from '#shared/proto/protocol.ts';
import type { Audit } from './audit.ts';
import type { CallOptions } from './agent.ts';
import type { Module as SettingsModule, Settings } from './config/settings/index.ts';
import type { Client, Env } from './http/env.ts';
import type { Machine } from './machines/machine.ts';
import type { Machines } from './machines/manager.ts';
import type { AgentStream } from './machines/transport/session.ts';
import type { Pages } from './pages.ts';
import type { ParamsOf, ResultOf } from '#shared/proto/protocol.ts';

export interface FeatureDef {
  /** Lower-case letters and digits, as in routes, settings and the UI. */
  id: string;
  /** Whether the user can switch the feature off, and with which setting:
   * plugins.<id>.enabled by default; false for a feature that is always on
   * (terminals, files). */
  toggle?: string | false;
  /** Off unless the user turns it on. */
  defaultOff?: boolean;
  /** Its content runs on the UI's own origin (VS Code's windows), where its
   * scripts reach whatever the page reaches. Browsers then have a switch of
   * their own, plugins.<id>.browser, off by default, which a browser user
   * sets only after accepting that risk; the toggle is the desktop app's
   * switch. */
  browserRisk?: boolean;
  /** Its settings and sections. */
  settings?: SettingsModule;
  /** The prefix of its audit events (the id by default). */
  audit?: string;
  setup(ctx: FeatureContext): void;
}

export const defineFeature = (d: FeatureDef): FeatureDef => d;

/** The setting that turns f on for client c; undefined for a feature that
 * is always on. */
export function enableSetting(f: FeatureDef, c: Client): string | undefined {
  if (f.toggle === false) return undefined;
  if (f.browserRisk && c === 'browser') return `plugins.${f.id}.browser`;
  return f.toggle ?? `plugins.${f.id}.enabled`;
}

export interface FeatureContext {
  readonly id: string;
  readonly logger: Logger;
  readonly readOnly: boolean;
  readonly machines: Machines;
  readonly settings: Settings;
  readonly pages: Pages;
  readonly audit: Audit;

  /** Whether the feature is on for a kind of client. */
  enabledFor(c: Client): boolean;

  /** Routes below /api/p/<id>. Every route of the feature answers 404
   * plugin_disabled while it is off for the requesting client. */
  readonly api: Hono<Env>;
  /** Routes below /api/m/:id/p/<id>; c.var.machine is the machine. */
  readonly machineApi: Hono<Env>;
  /** Routes below another prefix (VS Code's /m/:id/code); ":id" in it
   * resolves the machine. */
  route(prefix: string): Hono<Env>;
  /** Resolves the machine of the path's :id (c.var.machine); fails
   * unknown (404). */
  readonly machine: MiddlewareHandler<Env>;
  /** A route that changes state: refused in read-only mode, audited as
   * <audit prefix>.<event> with its outcome (a handler may name another
   * event with c.set('event', ...)). */
  mutating(event?: string): MiddlewareHandler<Env>;
  /** Refuses a request in read-only mode, without an audit record of its
   * own (the handler audits what it does). */
  readonly writable: MiddlewareHandler<Env>;
  /** Drops what every feature keeps for a removed machine (onForget). */
  forget(machine: string): void;

  /** Sends data to every page as {t: "plugin", plugin: <id>, m, data}. */
  broadcast(data: unknown, machine?: string): void;

  /** Calls an action of a protocol on a machine (kernel/agent.ts). */
  call<P extends Protocol, K extends keyof P['actions'] & string>(
    m: Machine,
    proto: P,
    action: K,
    params: ParamsOf<P['actions'][K]>,
    opts?: CallOptions,
  ): Promise<ResultOf<P['actions'][K]>>;

  /** Serves the streams agents open towards the core with op (after the
   * header); while the feature is off they fail with plugin_disabled. */
  agentStream(op: string, serve: (m: Machine, conn: AgentStream, h: Header) => void): void;

  /** Runs fn while the core runs, whether the feature is on or off (it
   * checks enabledFor itself); signal ends it. */
  service(name: string, fn: (signal: AbortSignal) => Promise<void>): void;

  /** Runs fn when the user removes a machine (whether the feature is on or
   * off), so that an id that comes back later inherits nothing. */
  onForget(fn: (machine: string) => void): void;
}
