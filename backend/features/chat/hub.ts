// Chats (docs/features/37-agent-chats.md): conversations with coding agents
// that a machine's chat host runs headless (#shared/proto/chatproto),
// relayed to the pages over one WebSocket per page (wire.ts, page.ts) and
// through the machine side's open action (protocol.ts), which gives a
// stream to the host's socket and starts the host, a hidden terminal of
// the machine's terminal core, when asked to. Its settings are in the
// section "chat", per machine, and reach each machine's host (settings.ts);
// its switch is plugins.chat.enabled.
//
// The hub watches a machine's chat host while the machine is connected,
// the feature is on and the host is in use (watch.ts); the routes
// (routes.ts) and the pages (page.ts) reach the hosts through the switchboard
// (switchboard.ts).
import { join } from 'node:path';
import { DATA_DIR_NAME } from '#shared/lib/brand.ts';
import { userHomeDir } from '#shared/host/hostdirs.ts';
import { VERSION } from '#shared/proto/agentproto/index.ts';
import { open } from '#kernel/agent.ts';
import { defineFeature, type FeatureDef } from '#kernel/feature.ts';
import { offline } from '#kernel/fail.ts';
import type { Client } from '#kernel/http/env.ts';
import type { Opener } from './hostconn.ts';
import { ChatSwitchboard } from './switchboard.ts';
import { SdkProvision, type SdkProvisionOptions } from './sdkprovision.ts';
import { chatProtocol } from './protocol.ts';
import { invalidateOverviews } from './overview.ts';
import { routes } from './routes.ts';
import { settings } from './settings.ts';
import { DEFAULT_LIMITS, DEFAULT_TIMING, type Limits, type Timing } from './timing.ts';

export interface ChatOptions {
  /** Opens a connection to a machine's chat host; the machine side's open
   * action by default. */
  open?: Opener;
  timing?: Partial<Timing>;
  limits?: Partial<Limits>;
  /** The clock, in milliseconds. */
  now?: () => number;
  /** This hub's build, whose chat host a machine's is compared to. */
  version?: () => string;
  /** How machines get Anthropic's Agent SDK for Claude Code's chats
   * (sdkprovision.ts): the operator's directories, offline, the registry,
   * the cache (~/.<slug>/cache/npm by default). */
  sdk?: Partial<SdkProvisionOptions>;
  /** Optional vault preset environment variables for a workspace's new
   * chats (feature 30); none by default. */
  workspaceEnv?: (
    machine: string,
    workspace: string,
    client: Client,
  ) => Promise<{
    presets: string[];
    env: Record<string, string>;
    names: string[];
    missing: string[];
    locked: boolean;
    logFailed?: boolean;
    corrupt?: boolean;
  }>;
}

export interface ChatFeature extends FeatureDef {
  /** The switchboard, once the hub set the feature up (tests). */
  switchboard(): ChatSwitchboard | undefined;
}

export function chatFeature(o: ChatOptions = {}): ChatFeature {
  let board: ChatSwitchboard | undefined;
  const def = defineFeature({
    id: 'chat',
    settings,
    setup(ctx) {
      const timing: Timing = { ...DEFAULT_TIMING, ...o.timing };
      const h = new ChatSwitchboard({
        machines: ctx.machines,
        settings: ctx.settings,
        readOnly: ctx.readOnly,
        audit: ctx.audit,
        logger: ctx.logger,
        enabled: () => ctx.enabledFor('desktop') || ctx.enabledFor('browser'),
        broadcast: (data, m) => ctx.broadcast(data, m),
        publishAgent: (ev) => ctx.machines.publishAgent(ev),
        open:
          o.open ??
          (async (m, start, signal) => {
            const mc = ctx.machines.get(m);
            if (!mc) throw offline();
            return (await open(mc, chatProtocol, 'open', start ? {} : { start: false }, { signal })).conn;
          }),
        version: o.version ?? (() => VERSION),
        sdk: new SdkProvision({
          cacheDir: join(userHomeDir(), DATA_DIR_NAME, 'cache', 'npm'),
          now: o.now,
          ...o.sdk,
          logger: ctx.logger,
        }),
        now: o.now ?? Date.now,
        timing,
        limits: { ...DEFAULT_LIMITS, ...o.limits },
      });
      board = h;
      routes(ctx, h, timing, o.workspaceEnv);
      ctx.service('watch', (signal) => h.run(signal));
      ctx.onForget((m) => {
        h.forget(m);
        h.o.sdk.forget(m);
        invalidateOverviews(h);
      });
    },
  });
  return Object.assign(def, { switchboard: () => board });
}
