// The hub: the kernel's machinery with the features set up on it. A host
// (hosts/bun, hosts/electron) builds one, hands it each request with what
// it knows of the connection (Peer) and runs it until it stops.
import { Hono, type MiddlewareHandler } from 'hono';
import type { Logger } from '#shared/lib/log.ts';
import { writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { call, open } from './agent.ts';
import type { Audit } from './audit.ts';
import type { Store as Settings } from './config/settings/index.ts';
import { enableSetting, type FeatureContext, type FeatureDef } from './feature.ts';
import { Fail, featureOff } from './fail.ts';
import { Http } from './http/app.ts';
import type { Client, Env, Peer } from './http/env.ts';
import type { Guard } from './http/guard.ts';
import type { Machine } from './machines/machine.ts';
import type { Machines } from './machines/manager.ts';
import { closeStream, type AgentStream } from './machines/transport/session.ts';
import { Pages } from './pages.ts';

export interface HubOptions {
  guard: Guard;
  audit: Audit;
  readOnly: boolean;
  /** The header naming the authenticated user (--user-header). */
  userHeader?: string;
  logger: Logger;
  machines: Machines;
  settings: Settings;
  features: readonly FeatureDef[];
}

export interface Hub {
  readonly http: Http;
  readonly pages: Pages;
  readonly machines: Machines;
  /** Answers a request. */
  fetch(req: Request, peer: Peer): Promise<Response>;
  /** Runs the machines and the features' services until signal ends. */
  run(signal: AbortSignal): Promise<void>;
  /** Drops what features keep for a removed machine. */
  forget(machine: string): void;
}

type AgentServe = (m: Machine, conn: AgentStream, h: Header) => void;

/** The requests a route's path takes: a parameter is one segment, a
 * wildcard anything (Hono's /x/* takes /x too). */
function pathPattern(path: string): RegExp {
  const segs = path.split('/').slice(1);
  const re = segs
    .map((s, i) => {
      if (s === '*') return i === segs.length - 1 ? '(?:/.*)?' : '/[^/]*';
      if (s.startsWith(':')) return '/[^/]+';
      return '/' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${re || '/'}$`);
}

/** Fails when a route of one feature takes requests of another's route:
 * its gate and middleware would run before the other's handler. */
function checkOverlaps(mounts: ReadonlyArray<{ feature: FeatureDef; prefix: string; sub: Hono<Env> }>): void {
  const routes = mounts.flatMap(({ feature, prefix, sub }) =>
    sub.routes.map((r) => {
      const path = r.path === '/' ? prefix : prefix + r.path;
      return { feature, method: r.method, path, pattern: pathPattern(path), sample: path.replace(/:[^/]+/g, 'x') };
    }),
  );
  for (const x of routes)
    for (const y of routes)
      if (x.feature !== y.feature && (x.method === 'ALL' || y.method === 'ALL' || x.method === y.method) && x.pattern.test(y.sample))
        throw new Error(
          `feature ${x.feature.id}: ${x.method} ${x.path} takes the requests of ${y.method} ${y.path} of feature ${y.feature.id}`,
        );
}

export function createHub(o: HubOptions): Hub {
  const http = new Http({
    guard: o.guard,
    audit: o.audit,
    readOnly: o.readOnly,
    userHeader: o.userHeader,
    logger: o.logger,
    machine: (id) => o.machines.get(id),
  });
  const pages = new Pages({ logger: o.logger, audit: o.audit });
  const services: Array<{ name: string; fn: (signal: AbortSignal) => Promise<void> }> = [];
  const forgetters: Array<(id: string) => void> = [];
  const streams = new Map<string, { feature: FeatureDef; serve: AgentServe }>();
  const mounts: Array<{ feature: FeatureDef; prefix: string; sub: Hono<Env>; pre: MiddlewareHandler<Env>[] }> = [];

  const forget = (machine: string) => {
    for (const fn of forgetters) {
      try {
        fn(machine);
      } catch (e) {
        o.logger(`forget ${machine}: ${(e as Error).message}`);
      }
    }
  };
  const enabledFor = (f: FeatureDef, c: Client): boolean => {
    const key = enableSetting(f, c);
    return key === undefined || o.settings.bool(key);
  };
  /** On for any client: the features' streams and services. */
  const enabled = (f: FeatureDef) => enabledFor(f, 'desktop') || enabledFor(f, 'browser');

  for (const f of o.features) {
    const gate: MiddlewareHandler<Env> = async (c, next) => {
      if (!enabledFor(f, c.var.client)) throw featureOff();
      await next();
    };
    const route = (prefix: string): Hono<Env> => {
      const sub = new Hono<Env>();
      const pre: MiddlewareHandler<Env>[] = [];
      if (f.toggle !== false) pre.push(gate);
      if (prefix.includes(':id')) pre.push(http.machine);
      mounts.push({ feature: f, prefix, sub, pre });
      return sub;
    };
    const prefix = f.audit ?? f.id;
    const ctx: FeatureContext = {
      id: f.id,
      logger: o.logger,
      readOnly: o.readOnly,
      machines: o.machines,
      settings: o.settings,
      pages,
      audit: o.audit,
      enabledFor: (c) => enabledFor(f, c),
      api: route(`/api/p/${f.id}`),
      machineApi: route(`/api/m/:id/p/${f.id}`),
      route,
      machine: http.machine,
      mutating: (event) =>
        http.mutating((c) => [prefix, c.var.event ?? event].filter(Boolean).join('.'), f.toggle === false ? {} : { plugin: f.id }),
      writable: http.writable,
      forget: (machine) => forget(machine),
      broadcast: (data, machine = '') => pages.broadcast({ t: 'plugin', plugin: f.id, m: machine, data }),
      call: (m, proto, action, params, opts) => call(m, proto, action, params, opts),
      open: (m, proto, action, params, opts) => open(m, proto, action, params, opts),
      agentStream: (op, serve) => {
        if (streams.has(op)) throw new Error(`agent op ${op} is served by ${streams.get(op)!.feature.id} already`);
        streams.set(op, { feature: f, serve });
      },
      service: (name, fn) => services.push({ name: `${f.id}: ${name}`, fn }),
      onForget: (fn) => forgetters.push(fn),
    };
    f.setup(ctx);
  }
  // Each route of a feature is registered on its own, its gate and machine
  // first: prefixes are shared (/api, /api/m/:id), so middleware of one
  // feature must not reach the routes of another, as a mounted app's would.
  // A route that would (a use() or all('/*') under a shared prefix, or the
  // same route twice) is refused here.
  checkOverlaps(mounts);
  for (const { prefix, sub, pre } of mounts) {
    const seen = new Set<string>();
    for (const r of sub.routes) {
      const path = r.path === '/' ? prefix : prefix + r.path;
      const key = `${r.method} ${path}`;
      const handlers = seen.has(key) ? [r.handler] : [...pre, r.handler];
      seen.add(key);
      if (r.method === 'ALL') http.app.all(path, ...(handlers as [MiddlewareHandler<Env>]));
      else http.app.on(r.method, path, ...(handlers as [MiddlewareHandler<Env>]));
    }
  }

  // The pages' event channel (pages.ts).
  http.app.get('/ws', (c) => {
    if (!c.env.upgrade) throw new Fail('upgrade_required', 426);
    return c.env.upgrade((ch) => pages.connect(ch, { client: c.var.client, readOnly: o.readOnly, who: c.var.who }), { compress: true });
  });

  o.machines.setStreamHandler((m, conn, h) => {
    const s = streams.get(h.op);
    const refuse = async (rep: Reply) => {
      await writeLine(conn.stream, rep).catch(() => {});
      conn.reader.release();
      closeStream(conn.stream);
    };
    if (!s) return void refuse({ ok: false, error: 'unsupported op' });
    if (!enabled(s.feature)) return void refuse({ ok: false, error: 'plugin is off', code: 'plugin_disabled' });
    s.serve(m, conn, h);
  });

  return {
    http,
    pages,
    machines: o.machines,
    fetch: (req, peer) => Promise.resolve(http.app.fetch(req, peer)),
    async run(signal) {
      await Promise.all([
        o.machines.run(signal),
        ...services.map(({ name, fn }) => fn(signal).catch((e) => o.logger(`${name}: ${(e as Error).message}`))),
      ]);
    },
    forget,
  };
}
