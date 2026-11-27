// The hub's side of the machines' chat hosts, which the routes and the
// pages share: the connections to the hosts (HostLink), their settings
// (Configurer), the watches of them (Watcher) and the pages' WebSockets.
//
// A change (a POST or DELETE route) and a page's subscription start the
// machine's host when none serves, but a read-only hub's, which reads what
// runs; a GET route and the watch never do. Before a request that may start
// an agent, the hub gives the host the machine's settings unless that host
// process took them already.
import type { Logger } from '#shared/lib/log.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import type { Audit, Who } from '#kernel/audit.ts';
import type { ChannelHandlers, Channel } from '#kernel/channel.ts';
import type { Change, Store } from '#kernel/config/settings/index.ts';
import type { AgentEvent, Machines } from '#kernel/machines/manager.ts';
import { Adapter, chatSpec } from '#shared/agents/kinds.ts';
import { Configurer } from './configure.ts';
import {
  AGENTS_CACHE_TTL_MS,
  ProbeCache,
  SESSIONS_CACHE_MAX,
  SESSIONS_CACHE_TTL_MS,
  machinePrefix,
  overlaySessionChats,
  sessionsCacheKey,
  type CachedAgent,
  type CachedSessions,
} from './cache.ts';
import type { EnsureOptions, SdkProvision } from './sdkprovision.ts';
import { HostLink, readError, type HostConn, type Opener, type Response } from './hostconn.ts';
import { ChatPage } from './page.ts';
import { hostSettings } from './settings.ts';
import type { Limits, Timing } from './timing.ts';
import { Watcher } from './watch.ts';
import { HubCode, type StatesData } from './wire.ts';

export interface SwitchboardOptions {
  machines: Machines;
  settings: Store;
  readOnly: boolean;
  audit: Audit;
  logger: Logger;
  /** Whether the feature is on (for any client). */
  enabled: () => boolean;
  broadcast: (data: StatesData, m: string) => void;
  publishAgent: (ev: AgentEvent) => void;
  open: Opener;
  version: () => string;
  /** Anthropic's Agent SDK on the machines, for Claude Code's chats. */
  sdk: SdkProvision;
  now: () => number;
  timing: Timing;
  limits: Limits;
}

/** The literal Go writes for the largest sequence number (an attach after
 * every stored event): a JavaScript number cannot hold it. */
const AFTER_ALL = '18446744073709551615';

/** The id of the one command of a handoff's connection. */
const HANDOFF_ID = 'handoff';

export class ChatSwitchboard {
  readonly o: SwitchboardOptions;
  readonly link: HostLink;
  readonly config: Configurer;
  readonly watch: Watcher;
  /** The pages' WebSockets. */
  readonly pages = new Set<ChatPage>();
  /** Hub-side bounded TTL + in-flight coalescing caches for expensive probes. */
  readonly sessionsCache: ProbeCache<CachedSessions>;
  readonly agentsCache: ProbeCache<CachedAgent[]>;

  constructor(o: SwitchboardOptions) {
    this.o = o;
    this.sessionsCache = new ProbeCache<CachedSessions>({
      ttlMs: SESSIONS_CACHE_TTL_MS,
      maxEntries: SESSIONS_CACHE_MAX,
      now: o.now,
    });
    this.agentsCache = new ProbeCache<CachedAgent[]>({
      ttlMs: AGENTS_CACHE_TTL_MS,
      maxEntries: 256,
      now: o.now,
    });
    this.link = new HostLink({
      open: o.open,
      helloMs: o.timing.helloMs,
      writeMs: o.timing.writeMs,
      maxHostConns: o.limits.maxHostConns,
      reservedConns: o.limits.reservedConns,
    });
    this.config = new Configurer({
      link: this.link,
      readOnly: o.readOnly,
      settings: (m) => hostSettings(o.settings, m),
      logger: o.logger,
      shortMs: o.timing.shortMs,
    });
    this.watch = new Watcher({
      link: this.link,
      config: this.config,
      machines: o.machines,
      enabled: o.enabled,
      broadcast: o.broadcast,
      publishAgent: o.publishAgent,
      turnedOff: () => this.closePages(HubCode.PluginDisabled),
      version: o.version,
      now: o.now,
      logger: o.logger,
      timing: o.timing,
    });
  }

  get readOnly(): boolean {
    return this.o.readOnly;
  }

  /** Whether machine m is connected. */
  isReady(m: string): boolean {
    return this.o.machines.get(m)?.ready ?? false;
  }

  /** A connection to machine m's chat host for a route or a page: with
   * start (and a hub that may), to a host the machine starts when none
   * serves, else not_running then. One that may start an agent (agent)
   * goes to a host that took the machine's settings. Reaching the host
   * counts as a use of it. */
  async connect(m: string, o: { start: boolean; agent: boolean; signal: AbortSignal }): Promise<HostConn> {
    const start = o.start && !this.o.readOnly;
    if (o.agent) await this.config.prepare(m, start, o.signal);
    const c = await this.link.dial(m, { start, reserved: false, signal: o.signal });
    this.watch.used(m);
    if (o.agent) await this.config.ensure(m, c, o.signal);
    return c;
  }

  /** Makes sure machine m can run a chat of kind: Claude Code's chats run on
   * Anthropic's Agent SDK, which the machine gets before one starts
   * (sdkprovision.ts). A read-only hub installs nothing. Fails with
   * sdk_unavailable when the machine could not get it; o says whether to
   * ask again after a failure (a new chat) and who to audit the install
   * as. */
  async ensureSdk(m: string, kind: string, signal: AbortSignal, o: EnsureOptions = {}): Promise<void> {
    if (this.o.readOnly || chatSpec(kind)?.adapter !== Adapter.Claude) return;
    const mc = this.o.machines.get(m);
    if (!mc?.connected) return;
    await this.o.sdk.ensure(mc, signal, o);
  }

  /** Sends one request to machine m's chat host and returns its answer. */
  async request(m: string, req: chat.Request, o: { start: boolean; agent: boolean; signal: AbortSignal }): Promise<Response> {
    const c = await this.connect(m, o);
    try {
      return await c.send(req);
    } finally {
      c.close();
    }
  }

  /** Lists available chat agent kinds for machine m with hub-side TTL caching
   * and in-flight coalescing. Never caches errors (e.g. not_running). A
   * listing that starts the chat host is never answered by one that does
   * not (which fails with not_running while the host is down). */
  async agents(m: string, o: { kinds: string[]; start: boolean; refresh?: boolean; signal: AbortSignal }): Promise<CachedAgent[]> {
    const key = `${m}\0${o.start ? 'start' : 'peek'}\0${o.kinds.join(',')}`;
    const list = await this.agentsCache.get(
      key,
      { refresh: o.refresh, signal: o.signal, timeoutMs: this.o.timing.shortMs },
      async (sharedSignal) => {
        const res = await this.request(m, { op: chat.Op.Agents, kinds: o.kinds }, { start: o.start, agent: false, signal: sharedSignal });
        return (res.agents ?? [])
          .filter((a) => o.kinds.includes(a.kind))
          .map((a) => ({
            kind: a.kind,
            available: a.available ?? false,
            ...(a.version ? { version: a.version } : {}),
            ...(a.reason ? { reason: a.reason } : {}),
          }));
      },
    );
    return list.map((a) => ({ ...a }));
  }

  /** Lists an agent's earlier sessions for (m, kind, cwd, cursor) with hub-side
   * TTL + LRU caching, in-flight deduplication, and live chat-id overlay. */
  async sessions(
    m: string,
    o: { kind: string; cwd: string; cursor: string; refresh?: boolean; signal: AbortSignal },
  ): Promise<CachedSessions> {
    const key = sessionsCacheKey(m, o.kind, o.cwd, o.cursor);
    const cached = await this.sessionsCache.get(
      key,
      { refresh: o.refresh, signal: o.signal, timeoutMs: this.o.timing.sessionsMs },
      async (sharedSignal) => {
        const res = await this.request(
          m,
          { op: chat.Op.Sessions, kind: o.kind, cwd: o.cwd, ...(o.cursor ? { cursor: o.cursor } : {}) },
          { start: true, agent: true, signal: sharedSignal },
        );
        return {
          sessions: (res.sessions ?? []) as unknown as chat.Session[],
          nextCursor: res.nextCursor ?? '',
        };
      },
    );
    const states = this.watch.snapshot().machines[m]?.states;
    return {
      sessions: overlaySessionChats(cached.sessions, o.kind, states),
      nextCursor: cached.nextCursor,
    };
  }

  /** Invalidates all hub-side probe caches for machine m (host stop, disconnect, forget). */
  invalidateMachine(m: string): void {
    const prefix = machinePrefix(m);
    this.sessionsCache.invalidatePrefix(prefix);
    this.agentsCache.invalidatePrefix(prefix);
  }

  /** Attaches to a chat without its log, sends it a handoff and waits for
   * the answer. The attach may catch the chat up with what its session did
   * meanwhile, which runs the agent: the host takes the machine's settings
   * first. */
  async handoff(m: string, id: string, signal: AbortSignal): Promise<void> {
    const c = await this.connect(m, { start: true, agent: true, signal });
    try {
      await c.sendLine(`{"op":${JSON.stringify(chat.Op.Attach)},"chat":${JSON.stringify(id)},"from":${AFTER_ALL}}\n`);
      try {
        await c.write(chat.line({ op: chat.CommandOp.Handoff, id: HANDOFF_ID }));
      } catch (e) {
        throw c.broken(e);
      }
      for (;;) {
        let line: Buffer;
        try {
          line = await c.readLine();
        } catch (e) {
          if (e === chat.ERR_TOO_LARGE)
            throw new chat.ChatProtoError({ code: chat.Code.Protocol, message: 'a line longer than the protocol takes' });
          throw c.broken(e);
        }
        let head: { t?: unknown; id?: unknown; error?: unknown };
        try {
          head = JSON.parse(line.toString('utf8'));
        } catch {
          continue;
        }
        if (typeof head !== 'object' || head === null || head.t !== chat.EventType.Ack || head.id !== HANDOFF_ID) continue;
        const e = readError(head.error);
        if (e) throw new chat.ChatProtoError(e);
        return;
      }
    } finally {
      c.close();
    }
  }

  /** Adopts a page's WebSocket. */
  connectPage(ch: Channel, who: Who): ChannelHandlers {
    const p = new ChatPage(ch, {
      board: this,
      audit: (event, fields) => this.o.audit.log(who, event, fields),
      now: this.o.now,
      timing: this.o.timing,
      limits: this.o.limits,
    });
    this.pages.add(p);
    return p.handlers(() => this.pages.delete(p));
  }

  /** Tells each page's subscriptions that they ended with code (none for
   * ""), then closes the pages: the feature was turned off, the hub stops. */
  closePages(code: string): void {
    for (const p of [...this.pages]) p.finish(code);
  }

  /** Configures the watched hosts the changes concern, and looks at the
   * watches when the feature was turned on or off. */
  settingsChanged(changes: readonly Change[], signal: AbortSignal): void {
    let all = false;
    const some = new Set<string>();
    for (const c of changes) {
      if (c.key.startsWith('plugins.')) this.watch.poke();
      else if (c.key.startsWith('chat.')) {
        if (c.machine === '') all = true;
        else some.add(c.machine);
      }
    }
    if (!all && some.size === 0) return;
    this.config.invalidate(all ? undefined : some);
    for (const m of this.watch.known()) if ((all || some.has(m)) && this.watch.isUp(m)) this.config.configure(m, signal);
  }

  /** Watches the machines' chat hosts until signal ends; the pages are
   * closed then (they connect to the next hub). */
  async run(signal: AbortSignal): Promise<void> {
    const unsubscribe = this.o.settings.onChange((changes) => this.settingsChanged(changes, signal));
    try {
      await this.watch.run(signal);
    } finally {
      unsubscribe();
      this.closePages('');
    }
  }

  /** Drops what the hub keeps of a removed machine. */
  forget(m: string): void {
    this.invalidateMachine(m);
    this.watch.forget(m);
    this.config.forget(m);
  }
}
