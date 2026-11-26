// What both hosts compose (Node's APIs only): the hub's features, its
// settings and keybindings, the machines file and the machines this run
// connects, and the host's own routes. The command line (hosts/bun) adds
// its flags and listens; the desktop app's utility process
// (hosts/electron) serves its windows over MessagePorts.
import { hostname } from 'node:os';
import { NAME, SLUG } from '#shared/lib/brand.ts';
import type { Logger } from '#shared/lib/log.ts';
import { userConfigDir, userHomeDir } from '#shared/host/hostdirs.ts';
import { VERSION } from '#shared/proto/agentproto/index.ts';
import type { Audit } from '#kernel/audit.ts';
import { Keybindings } from '#kernel/config/keybindings/index.ts';
import { hubWorker } from '#shared/lib/hub-worker.ts';
import { StateWorker } from '#shared/lib/state-worker.ts';
import type { maintenance } from './hub-state-worker.ts';
import { besideSettings, settingsPath } from '#kernel/config/paths.ts';
import { hubModules } from '#kernel/config/registry.ts';
import { settingsRoutes } from '#kernel/config/routes.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import type { FeatureDef } from '#kernel/feature.ts';
import { createHub, type Hub } from '#kernel/hub.ts';
import type { Guard } from '#kernel/http/guard.ts';
import { serveUI } from '#kernel/http/static.ts';
import { payloads as payloadsOf, type Files, type Payloads } from '#kernel/payloads.ts';
import type { SpawnPty } from '#kernel/pty.ts';
import { Machines } from '#kernel/machines/manager.ts';
import { Registry } from '#kernel/machines/registry.ts';
import { loadSpecs, validTarget, type Spec } from '#kernel/machines/spec.ts';
import { dialNode } from '#kernel/machines/transport/local.ts';
import { DownloadFailures, dialSSH } from '#kernel/machines/transport/ssh.ts';
import { DOWNLOAD } from '#features/machines/settings.ts';
import { machinesFeature } from '#features/machines/hub.ts';
import { terminalsFeature } from '#features/terminals/hub.ts';
import { guiFeature } from '#features/gui/hub.ts';
import { browserFeature } from '#features/browser/hub.ts';
import { searchFeature } from '#features/search/hub.ts';
import { gitFeature } from '#features/git/hub.ts';
import { monitorFeature } from '#features/monitor/hub.ts';
import { usageFeature } from '#features/usage/hub.ts';
import { vaultFeature } from '#features/vault/hub.ts';
import { agentsFeature } from '#features/agents/hub.ts';
import { historyFeature } from '#features/history/hub.ts';
import { fileTransfersFeature, filesFeature } from '#features/files/hub.ts';
import { chatFeature } from '#features/chat/hub.ts';
import { vscodeFeatures } from '#features/vscode/hub.ts';

/** What the features take from the host. */
export interface FeatureInputs {
  payloads: Payloads;
  /** The directory of ssh's control sockets; empty on Windows. */
  controlDir: string;
  /** The desktop app's key for its proofs; empty on the command line. */
  verifyKey: string;
  /** A terminal on the hub's host, for an interactive ssh login. */
  pty?: SpawnPty;
  codeServer: Omit<Parameters<typeof vscodeFeatures>[0], 'bridgeVSIX'>;
  /** Where machines get Anthropic's Agent SDK for Claude Code's chats:
   * the operator's directories (--seed-dir, as code-server's), offline, the
   * npm registry (--npm-registry). */
  chatSdk?: { seedDirs?: readonly string[]; offline?: boolean; registry?: string };
}

/** The hub's features, as both hosts run them (also what
 * scripts/reference.ts lists the routes of and scripts/registry.ts the
 * settings of), in the order the UIs list their switches and settings
 * (kernel/config/registry.ts hubModules). */
export function hubFeatures(o: FeatureInputs): FeatureDef[] {
  const { payloads } = o;
  // Variable vault provides workspace-linked presets for new terminals and chats.
  const vault = vaultFeature({ verifyKey: o.verifyKey });
  // Program windows give new terminals their display and follow the
  // terminal cores; they type into the terminals' shells.
  const gui = guiFeature({ encoder: (os, arch) => payloads.encoder(os, arch), shells: (m) => terminals.shells(m) });
  const terminals = terminalsFeature({
    embeddedHC: (os, arch) => payloads.embeddedHC(os, arch),
    paneEnv: gui.paneEnv,
    workspaceEnv: (m, ws) => vault.workspaceEnv(m.id, ws, 'terminal'),
    onReady: gui.terminalReady,
  });
  return [
    machinesFeature({ home: () => userHomeDir(), controlDir: o.controlDir, pty: o.pty }),
    terminals,
    gui,
    ...vscodeFeatures({ ...o.codeServer, bridgeVSIX: () => payloads.bridgeVSIX() }),
    browserFeature(),
    fileTransfersFeature(),
    filesFeature(),
    searchFeature(),
    gitFeature(),
    monitorFeature(),
    usageFeature(),
    vault,
    agentsFeature(),
    chatFeature({ sdk: o.chatSdk, workspaceEnv: (m, ws) => vault.workspaceEnv(m, ws, 'chat') }),
    historyFeature(),
  ];
}

/** The features with placeholder inputs (no payloads, machines or
 * launcher): what they define, their settings, switches and routes, for
 * what describes the hub without running it (scripts/registry.ts,
 * scripts/reference.ts, the registry's tests). */
export function describedFeatures(): FeatureDef[] {
  return hubFeatures({
    payloads: payloadsOf({ files: { get: async () => null }, web: null }),
    controlDir: '/nonexistent',
    verifyKey: '',
    codeServer: { seedDirs: [], offline: false, idle: 0 },
  });
}

/** The routes of the host beside the features': settings and
 * keybindings, the configuration, the web UI. Returns what stops the
 * settings' pushes. */
export function hostRoutes(
  hub: Hub,
  o: { settings: Settings; keybindings: Keybindings; readOnly: boolean; sshLogin: boolean; web: Files | null },
): () => void {
  const stop = settingsRoutes(hub.http, { settings: o.settings, keybindings: o.keybindings, pages: hub.pages });
  hub.http.app.get('/api/config', (c) =>
    c.json({ name: NAME, slug: SLUG, version: VERSION, read_only: o.readOnly, ssh_login: o.sshLogin, client: c.var.client }),
  );
  serveUI(hub.http.app, o.web);
  return stop;
}

/** --local-only and --machine: which machines this run connects. */
export function selectSpecs(specs: Spec[], localOnly: boolean, extraSSH: readonly string[], only: readonly string[]): Spec[] {
  return specs.filter((s, i) => {
    const named = (list: readonly string[]) => list.some((v) => v === s.id || v === s.label || v === s.target);
    if (localOnly && i !== 0 && !named(extraSSH)) return false;
    return only.length === 0 || named(only);
  });
}

export interface ComposeOptions {
  /** The hub's instance: its settings, machines and database files. */
  instance: string;
  /** The instance of the machines' nodes. */
  nodeInstance: string;
  features: FeatureDef[];
  /** The settings given on the command line (settingFlags). */
  flags?: Record<string, string>;
  payloads: Payloads;
  controlDir: string;
  /** Connects the local machine only, and the ssh targets of ssh. */
  localOnly: boolean;
  /** ssh targets connected besides the stored machines (--ssh). */
  ssh?: readonly string[];
  /** Connects only the machines named (--machine). */
  only?: readonly string[];
  guard: Guard;
  audit: Audit;
  readOnly: boolean;
  userHeader?: string;
  /** Delay before running one-off old-database maintenance in a worker thread
   * so it does not compete with startup I/O and CPU (default 5000 ms). */
  maintenanceDelayMs?: number;
  logger: Logger;
}

export interface Composed {
  readonly hub: Hub;
  readonly settings: Settings;
  readonly specs: readonly Spec[];
  /** Connects the machines and runs the features' services until signal
   * ends, then waits for the machines' sessions to end (so that the local
   * agent stops what it started) for at most 15 s. */
  run(signal: AbortSignal): Promise<void>;
}

/** The hub with its settings, keybindings and machines, not running yet:
 * a host binds what it serves on first, so that a failed launch starts no
 * agent. */
export function composeHub(o: ComposeOptions): Composed {
  const { logger, instance, nodeInstance, payloads, controlDir } = o;
  const modules = hubModules(o.features);
  let settingsFile = '';
  try {
    settingsFile = settingsPath(userConfigDir(), instance);
  } catch (e) {
    logger(`settings are not saved: ${(e as Error).message}`);
  }
  const settings = new Settings(settingsFile, { modules, flags: o.flags ?? {} });
  const keybindings = new Keybindings(settingsFile && besideSettings(settingsFile, 'keybindings'));
  try {
    keybindings.load();
  } catch (e) {
    logger(`ignoring keybindings: ${(e as Error).message}`);
  }
  try {
    settings.load();
  } catch (e) {
    logger(`ignoring settings: ${(e as Error).message}`);
  }
  const machinesFile = settingsFile && besideSettings(settingsFile, 'machines');

  let registry: Registry;
  try {
    registry = machinesFile ? Registry.open(machinesFile) : Registry.memory();
  } catch (e) {
    logger(`machines are not stored: ${(e as Error).message}`);
    registry = Registry.memory();
  }
  if (registry.kept() > 0)
    logger(`${machinesFile}: ${registry.kept()} entries are not machines this version can use; they are kept in the file as they are`);
  for (const s of registry.specs())
    if (s.kind === 'ssh' && !validTarget(s.target ?? ''))
      logger(`machine ${s.id}: its ssh target is refused (invalid_target); it is shown in error and never connected`);
  const ssh = o.ssh ?? [];
  const extra = ssh.map((t) => ({ id: t, label: t, target: t, enabled: true }));
  const specs = selectSpecs(loadSpecs(registry.specs(), extra, hostname()), o.localOnly, ssh, o.only ?? []);

  const builds = payloads.machine.bind(payloads);
  const downloadFailures = new DownloadFailures();
  const machines = new Machines({
    specs,
    registry,
    logger,
    dial: async (spec, signal, progress) => {
      if (spec.kind === 'local') {
        const session = await dialNode({ instance: nodeInstance, builds, sshConnection: process.env.SSH_CONNECTION, logger, signal });
        return { session, platform: `${process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}` };
      }
      const { session, platform } = await dialSSH(
        {
          target: spec.target ?? '',
          controlDir,
          builds,
          logger,
          instance: nodeInstance,
          machineDownload: settings.bool(DOWNLOAD, spec.id),
          downloadFailures,
          progress,
        },
        signal,
      );
      return { session, platform: `${platform.os}/${platform.arch}` };
    },
  });

  const hub = createHub({
    guard: o.guard,
    audit: o.audit,
    readOnly: o.readOnly,
    userHeader: o.userHeader,
    logger,
    machines,
    settings,
    features: o.features,
  });
  const stopSettingsPush = hostRoutes(hub, {
    settings,
    keybindings,
    readOnly: o.readOnly,
    sshLogin: controlDir !== '',
    web: payloads.web,
  });

  return {
    hub,
    settings,
    specs,
    async run(signal) {
      // Defer one-off database maintenance so spawning a worker thread and
      // scanning SQLite files does not compete with initial UI hydration.
      const delayMs = o.maintenanceDelayMs ?? 5_000;
      const tidying = settingsFile
        ? (async () => {
            if (delayMs > 0) {
              const aborted = await new Promise<boolean>((resolve) => {
                if (signal.aborted) return resolve(true);
                const onAbort = () => {
                  clearTimeout(t);
                  resolve(true);
                };
                const t = setTimeout(() => {
                  signal.removeEventListener('abort', onAbort);
                  resolve(false);
                }, delayMs);
                t.unref?.();
                signal.addEventListener('abort', onAbort, { once: true });
              });
              if (aborted) return;
            }
            const cleanup = new StateWorker<typeof maintenance>(() => hubWorker({ kind: 'maintenance' }), logger);
            try {
              await cleanup.request('tidy', signal, settingsFile);
            } catch (e) {
              if (!signal.aborted) logger(`databases of earlier releases or other hosts: ${(e as Error).message}`);
            } finally {
              await cleanup.close();
            }
          })()
        : undefined;
      // Edits of the files by hand apply without a restart.
      const watching = Promise.all([settings.watch(signal), keybindings.watch(signal)]).catch(() => {});
      const running = hub.run(signal);
      await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true })));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = await Promise.race([
        running.then(() => false),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(true), 15_000);
        }),
      ]);
      clearTimeout(timer);
      if (late) logger('machines did not disconnect within 15s');
      await tidying;
      await watching;
      stopSettingsPush();
    },
  };
}
