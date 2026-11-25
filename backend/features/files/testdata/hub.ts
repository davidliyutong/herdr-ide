// The files features in a core over machines whose agents serve the real
// file system (agent.ts), behind Bun.serve, so that requests end and break
// off as a browser sees them; and pages on its /ws.
import type { Channel } from '#kernel/channel.ts';
import { isBreakable } from '#kernel/http/breakable.ts';
import { abortable } from '#hosts/bun/abortable.ts';
import type { Core } from '#kernel/hub.ts';
import { agentDialer, localSpec, running, testCore, testMachines, waitFor, type TestCore } from '#kernel/testing.ts';
import type { Spec } from '#kernel/machines/spec.ts';
import type { Machines } from '#kernel/machines/manager.ts';
import type { Info } from '#shared/proto/agentproto/index.ts';
import { fileTransfersFeature, filesFeature } from '../hub.ts';
import { Downloads, type DownloadEvent } from '../downloads.ts';
import { fsAgent, type PluginHandler } from './agent.ts';

export interface FilesCoreOptions {
  plugin?: PluginHandler;
  readOnly?: boolean;
  specs?: Spec[];
  info?: Info;
  platform?: string;
  /** Switches the explorer on (true). */
  explorer?: boolean;
}

export interface FilesCore {
  tc: TestCore;
  machines: Machines;
  dial: ReturnType<typeof agentDialer>;
  downloads: Downloads;
  /** The server's origin, http://127.0.0.1:<port>. */
  url: string;
  stop(): Promise<void>;
}

export async function filesCore(o: FilesCoreOptions = {}): Promise<FilesCore> {
  const downloads = new Downloads({ everyMs: 0 });
  const dial = agentDialer({ serve: fsAgent(o.plugin), ...(o.info ? { info: o.info } : {}) });
  const machines = testMachines(o.specs ?? [localSpec()], { dial });
  const tc = testCore({
    features: [fileTransfersFeature({ downloads }), filesFeature({ platform: o.platform ?? 'linux' })],
    machines,
    readOnly: o.readOnly,
    settings: { 'plugins.files.enabled': o.explorer ?? true },
  });
  const stopCore = running(tc.core);
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    // As the host's: past the uploads' limit, which the core answers itself.
    maxRequestBodySize: 8 * 2 ** 30,
    // As the Bun host passes them on (hosts/bun/serve.ts).
    fetch: async (req, srv) => {
      const res = await tc.core.fetch(req, { remote: srv.requestIP(req)?.address, desktop: false });
      return isBreakable(res) ? abortable(res) : res;
    },
  });
  for (const m of machines.list()) if (m.state().enabled) await waitFor(`${m.id} ready`, () => m.ready);
  return {
    tc,
    machines,
    dial,
    downloads,
    url: `http://127.0.0.1:${server.port}`,
    async stop() {
      await server.stop(true);
      await stopCore();
    },
  };
}

/** A page connected to a core's /ws: what it was sent, and its messages. */
export function testPage(core: Core) {
  const sent: Array<Record<string, unknown>> = [];
  const ch: Channel = {
    send: (d) => void sent.push(JSON.parse(String(d))),
    buffered: 0,
    close() {},
  };
  const h = core.pages.connect(ch, { client: 'browser', readOnly: false, who: { remote: '127.0.0.1' } });
  const seen = new Map<string, number>();
  const events = (id: string) => sent.filter((m) => m.t === 'download' && m.id === id) as unknown as DownloadEvent[];
  return {
    sent,
    send: (m: object) => h.message(JSON.stringify(m)),
    close: () => h.close?.(1000, ''),
    events,
    /** The next event of download id this page was sent. */
    async next(id: string, timeoutMs = 10_000): Promise<DownloadEvent> {
      const at = seen.get(id) ?? 0;
      await waitFor(`an event of ${id}`, () => events(id).length > at, timeoutMs);
      seen.set(id, at + 1);
      return events(id)[at];
    },
    /** The events of id up to its end (a state other than running). */
    async ending(id: string): Promise<DownloadEvent[]> {
      const out: DownloadEvent[] = [];
      for (;;) {
        const e = await this.next(id);
        out.push(e);
        if (e.state !== 'running') return out;
      }
    },
  };
}
