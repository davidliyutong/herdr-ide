// VS Code (code-server, docs/features/05-vscode-panes.md) on the hub's
// side. code-server is served on the UI's own origin, so its extensions and
// webviews can do whatever the page can: the feature is off by default and
// has a switch per kind of client (browserRisk: plugins.vscode.enabled for
// the desktop app's windows, plugins.vscode.browser for browsers). While
// it is off for a client, its routes answer plugin_disabled to that client,
// its work for that client ends (work.ts) and the bridge's messages reach
// only pages for which it is on.
//
//   GET  /api/m/:id/code/status   preparing code-server: phase, progress, error
//   POST /api/m/:id/code/start    prepares (installs, starts) code-server again
//   POST /api/m/:id/code/stop     stops it (always allowed: it frees resources)
//   ALL  /m/:id/code/…            code-server itself (proxy.ts, relay.ts)
//   POST /api/m/:id/bridge        a command for a VS Code window (bridge.ts)
//
// and on /ws the theme pages choose, which VS Code's windows follow; the
// agents' bridge streams (op bridge); idle code-servers released after
// --code-server-idle.
import { createMiddleware } from 'hono/factory';
import { Op } from '#shared/proto/agentproto/index.ts';
import { defineFeature, enableSetting, type FeatureContext, type FeatureDef } from '#kernel/feature.ts';
import { Fail, failOf, featureOff, unknownMachine } from '#kernel/fail.ts';
import { readBody } from '#kernel/http/app.ts';
import type { Ctx, Env } from '#kernel/http/env.ts';
import type { Machine } from '#kernel/machines/machine.ts';
import { Artifacts, type Extension } from './artifacts.ts';
import { Bridge, type Target } from './bridge.ts';
import { loadingPage } from './loading.ts';
import { CodeServers } from './provision.ts';
import { belowCode, CodeServerProxy, portProxyPath, requestHeaders, type Inbound } from './proxy.ts';
import { Refused, relay } from './relay.ts';
import { INSTALL, Install, PATH, settings } from './settings.ts';
import { DEFAULT_TIMING, parseDuration, type Timing } from './timing.ts';
import { Activity, Work } from './work.ts';

export const ID = 'vscode';

export interface VSCodeOptions {
  /** The code-server release machines get (--code-server-version). */
  version?: string;
  /** Download templates (--code-server-url, --extension-url). */
  tarballURL?: string;
  extensionURL?: string;
  /** Searched before the cache (--seed-dir). */
  seedDirs?: readonly string[];
  /** Never download (--offline). */
  offline?: boolean;
  /** Earlier downloads (<user cache>/<slug>/code-server). */
  cacheDir?: string;
  /** The extensions every machine gets (Git Graph). */
  extensions?: readonly Extension[];
  /** --code-server-idle: a code-server without VS Code connections for
   * this long is released; a Go duration ("20m") or milliseconds; 0: never. */
  idle?: string | number;
  /** The bridge extension (VSIX) the build carries. */
  bridgeVSIX?: () => Promise<Uint8Array | null>;
  timing?: Partial<Timing>;
  fetch?: typeof fetch;
}

/** What the feature's parts share once it is set up. */
interface Shared {
  cs: CodeServers;
  timing: Timing;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Records event once the handler answered: the machine, what the handler
 * put in c.var.audit, the status and, when it failed, the error's code. */
const audited = (ctx: FeatureContext, event: string) =>
  createMiddleware<Env>(async (c, next) => {
    await next();
    const fields: Record<string, unknown> = { machine: c.var.machine?.id, ...c.var.audit, status: c.res.status };
    if (c.res.status >= 400) fields.error = c.error ? failOf(c.error).code : 'failed';
    ctx.audit.log(c.var.who, event, fields);
  });

/** A request's own signal and another's. */
const both = (...signals: AbortSignal[]) => AbortSignal.any(signals);

/** The feature and its always-allowed stop route (a feature of its own,
 * without a switch: stopping code-server only frees resources). */
export function vscodeFeatures(o: VSCodeOptions = {}): FeatureDef[] {
  let shared: Shared | undefined;
  const timing: Timing = {
    ...DEFAULT_TIMING,
    ...(o.idle !== undefined ? { idleMs: typeof o.idle === 'number' ? o.idle : parseDuration(o.idle) } : {}),
    ...o.timing,
  };

  const vscode = defineFeature({
    id: ID,
    defaultOff: true,
    browserRisk: true,
    settings,
    setup(ctx) {
      const artifacts = new Artifacts({
        logger: ctx.logger,
        version: o.version,
        tarballURL: o.tarballURL,
        extensionURL: o.extensionURL,
        seedDirs: o.seedDirs,
        offline: o.offline,
        cacheDir: o.cacheDir,
        extensions: o.extensions,
        downloadMs: timing.downloadMs,
        fetch: o.fetch,
      });
      const cs = new CodeServers({
        artifacts,
        logger: ctx.logger,
        timing,
        bridgeVSIX: o.bridgeVSIX,
        install(machine) {
          // A hub without the settings (tests) pushes.
          const read = (key: string) => {
            try {
              return ctx.settings.string(key, machine);
            } catch {
              return '';
            }
          };
          const mode = (read(INSTALL) || Install.Push) as Install;
          return { mode, bin: mode === Install.Existing ? read(PATH) || 'auto' : '' };
        },
      });
      shared = { cs, timing };
      const work = new Work((c) => ctx.enabledFor(c), ctx.logger);
      const activity = new Activity();
      const proxies = new Map<string, CodeServerProxy>();
      const proxyOf = (m: Machine) => {
        let p = proxies.get(m.id);
        if (!p) proxies.set(m.id, (p = new CodeServerProxy(m, timing)));
        return p;
      };
      const bridge = new Bridge({
        // Only pages for which VS Code is on show it.
        broadcast: (ev) => ctx.pages.broadcast(ev, (p) => ctx.enabledFor(p.client)),
        timing,
      });

      // VS Code's windows follow the theme chosen in the pages; watchers
      // cannot use VS Code and do not change it.
      ctx.pages.on('theme', (p, m) => {
        if (!p.readOnly) bridge.setTheme(m.kind);
      });
      ctx.agentStream(Op.Bridge, (m, conn) => void bridge.serve(m.id, conn));
      ctx.onForget((id) => {
        cs.forget(id);
        activity.forget(id);
        proxies.get(id)?.close();
        proxies.delete(id);
      });

      // Turning a switch off ends its work (work.ts).
      ctx.service('switches', async (signal) => {
        const keys = new Set(['desktop', 'browser'].map((c) => enableSetting(vscode, c as 'desktop' | 'browser')));
        const off = ctx.settings.onChange((changes) => {
          if (changes.some((ch) => keys.has(ch.key))) work.follow();
        });
        await new Promise((r) => (signal.aborted ? r(null) : signal.addEventListener('abort', r, { once: true })));
        off();
        work.stopAll();
        for (const p of proxies.values()) p.close();
        proxies.clear();
      });

      // A code-server without VS Code connections or requests for
      // --code-server-idle is released: the machine stops it unless another
      // hub it serves has a VS Code window connected.
      ctx.service('idle code-servers', async (signal) => {
        if (timing.idleMs <= 0) return;
        while (!signal.aborted) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, timing.idleCheckMs);
            signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
          });
          for (const id of activity.idleAmong(cs.running(), timing.idleMs)) {
            const m = ctx.machines.get(id);
            if (!m || signal.aborted) continue;
            ctx.logger(`releasing idle code-server on ${m.label}`);
            try {
              await cs.release(m, both(signal, AbortSignal.timeout(timing.stopMs)));
            } catch (e) {
              ctx.logger(`stop code-server on ${m.label}: ${errorText(e)}`);
            }
            ctx.audit.log(null, 'code_server.idle_stop', { machine: id });
          }
        }
      });

      /** Prepares code-server on m for client c in the background, unless
       * VS Code is off for c. */
      const prepare = (c: Ctx, m: Machine) => {
        const prep = work.signal(c.var.client, false);
        if (!prep) throw featureOff();
        void cs.ensure(m, prep).catch(() => {});
      };

      const api = ctx.route('/api/m/:id');
      api.get('/code/status', (c) => {
        c.header('Cache-Control', 'no-store');
        return c.json(cs.status(c.var.machine));
      });
      api.post('/code/start', ctx.writable, (c) => {
        const m = c.var.machine;
        cs.invalidate(m.id);
        prepare(c, m);
        return c.json(cs.status(m), 202);
      });

      // A command from the UI for a VS Code window of the machine; brings
      // code-server up if no VS Code pane was shown yet. Its failures'
      // error is the text the UI shows.
      api.post('/bridge', ctx.writable, audited(ctx, 'bridge.command'), async (c) => {
        const m = c.var.machine;
        let body: unknown;
        try {
          body = JSON.parse(Buffer.from(await readBody(c.req.raw, 1 << 20)).toString('utf8'));
        } catch (e) {
          throw e instanceof Fail ? e : new Fail('bad_request', 400, errorText(e));
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Fail('bad_request', 400, 'want a JSON object');
        const { folder, window, fresh, ...cmd } = body as Record<string, unknown>;
        const t: Target = {
          folder: typeof folder === 'string' ? folder : '',
          window: typeof window === 'string' ? window : '',
          fresh: fresh === true,
        };
        c.set('audit', { cmd: cmd.cmd, folder: t.folder });
        // Turning VS Code off for this client ends the command; the switch
        // is checked again once the command follows it.
        const own = work.signal(c.var.client, true);
        if (!own) throw featureOff();
        const signal = both(c.req.raw.signal, own, AbortSignal.timeout(timing.bridgeCommandMs));
        const unavailable = (e: unknown) => new Fail(errorText(e), 503, errorText(e));
        if (!cs.ready(m)) {
          const prep = work.signal(c.var.client, false);
          if (!prep) throw featureOff();
          try {
            await cs.ensure(m, both(signal, prep));
          } catch (e) {
            throw unavailable(e);
          }
        }
        try {
          return c.json({ ok: true, window: await bridge.command(m.id, t, cmd, signal) });
        } catch (e) {
          throw unavailable(e);
        }
      });

      const code = ctx.route('/m');
      code.all('/:id/code', (c) => {
        const u = new URL(c.req.url);
        return c.redirect(`${u.pathname}/${u.search}`, 302);
      });
      code.all('/:id/code/*', ctx.writable, async (c) => {
        const url = new URL(c.req.url);
        const below = belowCode(url.pathname) ?? '/';
        let path: string;
        try {
          path = decodeURIComponent(below);
        } catch {
          throw new Fail('bad_request', 400, 'malformed path');
        }
        // Before the machine is looked up: code-server started without
        // --disable-proxy (by an earlier build) may still be running.
        if (portProxyPath(path)) {
          ctx.audit.log(c.var.who, 'denied.port_proxy', { machine: c.req.param('id'), path: `/m/${c.req.param('id')}/code${path}` });
          throw new Fail('port_proxy_disabled', 403, 'code-server port proxy disabled');
        }
        const m = ctx.machines.get(c.req.param('id') ?? '');
        if (!m) throw unknownMachine();
        const client = c.var.client;
        const own = work.signal(client, true);
        if (!own) throw featureOff();
        const upgrade = (c.req.header('Upgrade') ?? '').toLowerCase() === 'websocket';
        if (!cs.ready(m)) {
          prepare(c, m);
          if (c.req.method === 'GET' && !c.req.header('Upgrade') && below === '/') {
            ctx.audit.log(c.var.who, 'code_server.open', {
              machine: m.id,
              folder: url.searchParams.get('folder') ?? '',
              client,
              status: 200,
            });
            return loadingPage(m);
          }
          throw new Fail('starting', 503, 'code-server is starting');
        }
        const proxy = proxyOf(m);
        const inbound: Inbound = {
          headers: c.req.raw.headers,
          host: c.req.header('Host') ?? url.host,
          remote: c.env.remote,
          scheme: url.protocol.replace(/:$/, ''),
        };
        const failed = (e: unknown, signal: AbortSignal): never => {
          if (e instanceof Refused) throw new Fail('refused', e.status >= 400 && e.status < 600 ? e.status : 502, e.message);
          if (!signal.aborted) {
            ctx.logger(`code-server proxy ${m.label}: ${errorText(e)}`);
            cs.invalidate(m.id);
          }
          throw new Fail('code_server_unavailable', 502, `code-server unavailable: ${errorText(e)}`);
        };
        if (upgrade) {
          // An open WebSocket keeps the machine's code-server from being
          // released as idle.
          if (!c.env.upgrade) throw new Fail('upgrade_required', 426);
          activity.touch(m.id, 1);
          const dialing = both(c.req.raw.signal, own);
          try {
            const sock = await proxy.dial(dialing);
            const protocols = (c.req.header('Sec-WebSocket-Protocol') ?? '')
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean);
            // relay calls ended once when it answered; not when it fails.
            return await relay({
              sock,
              path: below + url.search,
              headers: requestHeaders(inbound, { websocket: true }),
              protocols,
              compress: !m.local,
              handshakeMs: timing.handshakeMs,
              upgrade: c.env.upgrade,
              signal: own,
              ended: () => activity.touch(m.id, -1),
            });
          } catch (e) {
            activity.touch(m.id, -1);
            return failed(e, dialing);
          }
        }
        activity.touch(m.id, 0);
        const signal = both(c.req.raw.signal, own);
        try {
          return await proxy.request({ ...inbound, method: c.req.method, path: below + url.search, body: c.req.raw.body }, signal);
        } catch (e) {
          return failed(e, signal);
        }
      });
    },
  });

  const stop = defineFeature({
    id: 'codestop',
    toggle: false,
    setup(ctx) {
      // Stops a machine's code-server, which frees its memory there, also in
      // read-only mode and while VS Code is off.
      ctx.route('/api/m/:id').post('/code/stop', audited(ctx, 'code_server.stop'), async (c) => {
        if (!shared) throw new Fail('unavailable', 503);
        const m = c.var.machine;
        try {
          await shared.cs.stop(m, both(c.req.raw.signal, AbortSignal.timeout(shared.timing.stopMs)));
        } catch (e) {
          throw new Fail('transport', 502, errorText(e));
        }
        return c.json({ ok: true });
      });
    },
  });

  return [vscode, stop];
}
