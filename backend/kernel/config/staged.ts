// The settings of the features whose core side is still the Go program's
// (internal/codeserver, internal/gui, internal/plugins/*), defined here so
// that the core's registry (spec/generated/registry.json, the reference's
// tables, /api/settings) is complete while the features move to
// features/<id>: a feature that moves takes its module into its definition
// (FeatureDef.settings) and leaves this file.
import { posix } from 'node:path';
import { GUIDisplay } from '#shared/proto/agentproto/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { bool, defineModule, enumOf, int, stringList, text, type Setting } from './settings/index.ts';
import type { Switchable } from './toggles.ts';

/** The features with a switch, in the order the UIs list them (Go's
 * internal/registry Plugins). */
export const STAGED_FEATURES: readonly Switchable[] = [
  // VS Code's windows run on the UI's origin: off until the user turns
  // them on, and in browsers only with a switch of their own.
  { id: 'vscode', defaultOff: true, browserRisk: true },
  { id: 'browser' },
  { id: 'files' },
  { id: 'search' },
  { id: 'git' },
  { id: 'monitor' },
  { id: 'usage' },
  { id: 'vault' },
  { id: 'agents' },
  { id: 'chat' },
  { id: 'history' },
];

export const CODE_SERVER = defineModule({
  sections: [{ id: 'codeServer', order: 60, advanced: true, plugin: 'vscode' }],
  settings: {
    'codeServer.install': enumOf(['push', 'download', 'existing'], {
      default: 'push',
      scope: 'machine',
      section: 'codeServer',
      order: 10,
      flag: 'code-server-install',
      usage:
        "how machines get code-server: push (the core downloads, verifies and uploads it), download (the machine downloads it, verified) or existing (use the machine's own code-server); the last two fall back to push",
    }),
    'codeServer.path': text({
      default: '',
      scope: 'machine',
      section: 'codeServer',
      order: 20,
      flag: 'code-server-path',
      usage:
        'code-server executable on machines for --code-server-install=existing (absolute or ~/ path); empty searches PATH and the usual install locations',
      check: (s) => (s !== '' && !posix.isAbsolute(s) && !s.startsWith('~/') ? 'must be an absolute or ~/ path' : undefined),
    }),
  },
});

export const GUI = defineModule({
  sections: [{ id: 'gui', order: 70, advanced: true }],
  settings: {
    'gui.enabled': bool({
      default: true,
      scope: 'remote-machine',
      section: 'gui',
      order: 10,
      flag: 'gui',
      usage:
        'show windows of programs on remote Linux machines: new panes get a virtual display (DISPLAY), Xvfb is fetched in user space when missing; true or false (on or off); also per machine in the UI',
    }),
    'gui.display': enumOf([GUIDisplay.Auto, GUIDisplay.Xvfb], {
      default: GUIDisplay.Auto,
      scope: 'remote-machine',
      section: 'gui',
      order: 15,
      flag: 'gui-display',
      usage:
        'the virtual display: auto (Xwayland drawing with a GPU where the machine has one and an Xwayland, so that OpenGL and Vulkan programs render on the GPU; Xvfb elsewhere) or xvfb (always Xvfb); a display changes kind while no program uses it; also per machine in the UI',
    }),
    'gui.gpu': enumOf(['vglrun', 'all'], {
      default: 'vglrun',
      scope: 'remote-machine',
      section: 'gui',
      order: 20,
      flag: 'gui-gpu',
      usage:
        'OpenGL on machines with VirtualGL: vglrun (programs started with vglrun render on the GPU) or all (every program in new panes runs under VirtualGL); also per machine in the UI',
    }),
    'gui.gpuPick': bool({
      default: false,
      scope: 'remote-machine',
      section: 'gui',
      order: 25,
      flag: 'gui-gpu-pick',
      usage:
        "on machines with several NVIDIA GPUs, preload a library into the programs of new panes that leaves a program started with CUDA_VISIBLE_DEVICES only the GPUs it names (indices are rewritten to count among those), so that a Vulkan program can show its window from the chosen GPU instead of only from the driver's first one; true or false; also per machine in the UI",
    }),
    'gui.video': bool({
      default: true,
      scope: 'remote-machine',
      section: 'gui',
      order: 30,
      flag: 'gui-video',
      usage:
        'send program windows that keep changing as video (H.264 on NVIDIA, Intel or AMD GPUs, else VP8 on the CPU) to browsers that decode it, encoded on the machine by the encoder the core brings; pictures otherwise (false: always pictures); also per machine in the UI',
    }),
  },
});

export const BROWSER = defineModule({
  sections: [{ id: 'browser', order: 65, plugin: 'browser' }],
  settings: {
    'browser.openLinks': enumOf(['loopback', 'all', 'external'], { default: 'loopback', section: 'browser', order: 10 }),
    'browser.forwardIdle': int({ default: 30, min: 0, max: 1440, section: 'browser', order: 20 }),
  },
});

/** The names the file explorer hides by default, as VS Code's. */
const DEFAULT_EXCLUDE = ['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db'];

// A pattern of names as path.Match reads them: '*', '?', classes
// ('[^a-z]') and escapes ('\*').
const escaped = String.raw`(?:\\[\s\S]|[^\\\-\]])`;
const pattern = new RegExp(String.raw`^(?:\[\^?(?:${escaped}(?:-${escaped})?)+\]|\\[\s\S]|[^[\\])*$`);

function validExclude(list: string[]): string | undefined {
  if (list.length > 100) return 'at most 100 patterns';
  for (const p of list) {
    const name = p.startsWith('**/') ? p.slice(3) : p;
    if (name === '' || Buffer.byteLength(p) > 200) return 'a pattern is 1 to 200 bytes';
    if (name.includes('/')) return 'patterns match names, without /';
    if (!pattern.test(name)) return `not a pattern: ${p}`;
  }
  return undefined;
}

export const FILES = defineModule({
  sections: [{ id: 'files', order: 66, plugin: 'files' }],
  settings: {
    'files.showHidden': bool({ default: false, section: 'files', order: 10 }),
    'files.exclude': stringList({
      default: DEFAULT_EXCLUDE,
      options: [...DEFAULT_EXCLUDE, 'node_modules', '__pycache__', '*.pyc', '.venv'],
      section: 'files',
      order: 20,
      check: validExclude,
    }),
    'files.sortOrder': enumOf(['default', 'mixed', 'filesFirst', 'type', 'modified'], { default: 'default', section: 'files', order: 30 }),
    'files.followFocus': bool({ default: true, section: 'files', order: 40 }),
    'files.confirmTrash': bool({ default: false, section: 'files', order: 50 }),
  },
});

export const GIT = defineModule({
  sections: [{ id: 'git', order: 67, plugin: 'git' }],
  settings: {
    'git.mixedLineEndings': enumOf(['keep', 'unify', 'readOnly'], { default: 'keep', section: 'git', order: 10 }),
    'git.changesView': enumOf(['list', 'tree'], { default: 'list', section: 'git', order: 20 }),
    'git.untrackedChanges': enumOf(['mixed', 'separate'], { default: 'mixed', section: 'git', order: 21 }),
    'git.autoFetch': int({ default: 0, min: 0, max: 240, section: 'git', order: 30 }),
    'git.confirmSync': bool({ default: false, section: 'git', order: 31 }),
    'git.graphPageSize': int({ default: 300, min: 50, max: 1000, step: 50, section: 'git', order: 40 }),
  },
});

export const MONITOR = defineModule({
  sections: [{ id: 'monitor', order: 68, plugin: 'monitor' }],
  settings: {
    'monitor.refreshSeconds': int({ default: 2, min: 1, max: 30, section: 'monitor', order: 10 }),
    'monitor.statusBar': bool({ default: true, section: 'monitor', order: 20 }),
    'monitor.confirmKill': bool({ default: true, section: 'monitor', order: 30 }),
  },
});

/** The AI usage plugin's providers, in the order the UIs list them. */
const PROVIDERS = ['claude', 'codex', 'grok', 'antigravity', 'kimi', 'deepseek', 'opencode'] as const;

function validThresholds(list: string[]): string | undefined {
  if (list.length > 8) return 'at most 8 thresholds';
  if (!list.every((s) => /^[+-]?\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 100))
    return 'thresholds are whole percentages from 1 to 100';
  return undefined;
}

/** The user's prices: one model per line, "<model> <input> <cached>
 * <output> [<cache write>]", in USD per million tokens. */
function validPrices(lines: string[]): string | undefined {
  if (lines.length > 50) return 'at most 50 prices';
  const seen = new Set<string>();
  for (const l of lines) {
    const f = l.split(/[\s\u0085 ]+/).filter(Boolean);
    if (f.length === 0) continue;
    if (f.length < 4 || f.length > 5 || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/.test(f[0]!)) {
      return `${JSON.stringify(l)}: a price is: model input cached output [cache write], in USD per million tokens`;
    }
    if (!f.slice(1).every((x) => /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(x) && Number(x) >= 0 && Number(x) <= 10000)) {
      return `${JSON.stringify(l)}: prices are numbers from 0 to 10000`;
    }
    if (seen.has(f[0]!)) return `a model has two prices: ${f[0]}`;
    seen.add(f[0]!);
  }
  return undefined;
}

export const USAGE = defineModule({
  sections: [{ id: 'usage', order: 68, plugin: 'usage' }],
  settings: {
    'usage.refresh': enumOf(['manual', '1', '2', '5', '15', '30', '60', 'adaptive'], {
      default: 'adaptive',
      section: 'usage',
      group: 'usageRefresh',
      order: 10,
    }),
    'usage.refreshOpen': int({ default: 5, min: 1, max: 60, section: 'usage', group: 'usageRefresh', order: 11 }),
    'usage.refreshWorking': int({ default: 10, min: 1, max: 120, section: 'usage', group: 'usageRefresh', order: 12 }),
    'usage.refreshIdle': int({ default: 30, min: 5, max: 240, section: 'usage', group: 'usageRefresh', order: 13 }),
    // Read by the pages: how old the spend may get while the panel is
    // open, and the status bar item.
    'usage.costRefresh': int({ default: 15, min: 1, max: 1440, section: 'usage', group: 'usageRefresh', order: 15 }),
    'usage.statusBar': bool({ default: true, section: 'usage', group: 'usageAlerts', order: 18 }),
    'usage.alerts': bool({ default: true, section: 'usage', group: 'usageAlerts', order: 19 }),
    'usage.thresholds': stringList({
      default: ['80', '95'],
      options: ['50', '80', '90', '95'],
      section: 'usage',
      group: 'usageAlerts',
      order: 20,
      check: validThresholds,
    }),
    // The user's prices, for models the price table does not know yet or
    // prices it has wrong.
    'usage.prices': stringList({ default: [], section: 'usage', group: 'usageSpend', order: 22, check: validPrices }),
    // One group per provider: its switch, then its own options.
    ...Object.fromEntries(
      PROVIDERS.flatMap((p, i): [string, Setting][] => {
        const group = 'usage' + p[0]!.toUpperCase() + p.slice(1);
        const order = 30 + 4 * i;
        const own: [string, Setting][] = [[`usage.providers.${p}`, bool({ default: true, section: 'usage', group, order })]];
        if (p === 'claude') own.push(['usage.claudeKeychain', bool({ default: true, section: 'usage', group, order: order + 1 })]);
        if (p === 'codex') own.push(['usage.codexHomes', stringList({ default: [], section: 'usage', group, order: order + 1 })]);
        if (p === 'kimi') own.push(['usage.kimiRefresh', bool({ default: true, section: 'usage', group, order: order + 1 })]);
        return own;
      }),
    ),
  },
});

const vaultNumber = (def: number, min: number, max: number, order: number, group?: string) =>
  int({ default: def, min, max, section: 'vault', order, ...(group ? { group } : {}) });

export const VAULT = defineModule({
  // The plugin's own page in Settings, under the plugins.
  sections: [{ id: 'vault', order: 69, plugin: 'vault' }],
  settings: {
    'vault.approvalTimeout': vaultNumber(60, 10, 600, 10),
    'vault.autoLock': vaultNumber(60, 0, 1440, 20),
    'vault.passphraseDays': vaultNumber(14, 1, 90, 25),
    'vault.sessionIdle': vaultNumber(30, 1, 240, 30, 'vaultSessions'),
    'vault.sessionMax': vaultNumber(12, 1, 24, 31, 'vaultSessions'),
    'vault.runTimeout': vaultNumber(120, 5, 3600, 40, 'vaultRun'),
    'vault.runMaxTimeout': vaultNumber(600, 5, 3600, 41, 'vaultRun'),
    'vault.runOutput': vaultNumber(64, 4, 1024, 42, 'vaultRun'),
  },
});

const perMachine = (section: string) => (def: number, min: number, max: number, step: number, order: number) =>
  int({ default: def, min, max, step, scope: 'machine', section, order });

const historyNumber = perMachine('history');

export const HISTORY = defineModule({
  sections: [{ id: 'history', order: 71, plugin: 'history' }],
  settings: {
    'history.capture': bool({
      default: false,
      scope: 'machine',
      section: 'history',
      order: 10,
      flag: 'history-capture',
      usage:
        "keep snapshots of the terminals' output on each machine's disk (in the agent's data directory there), to show what a terminal held after its terminal core started again; the output can hold secrets such as keys and passwords printed in a terminal; true or false; also per machine in the UI",
    }),
    'history.interval': historyNumber(30, 10, 600, 10, 20),
    'history.lines': historyNumber(2000, 100, 10000, 100, 30),
    'history.maxTerminals': historyNumber(32, 1, 128, 1, 40),
    'history.maxTotalMB': historyNumber(64, 1, 512, 1, 50),
    'history.days': historyNumber(7, 1, 30, 1, 60),
  },
});

const chatNumber = perMachine('chat');

// Each per machine: they bound what the machine's chat host runs and keeps
// (chatproto's host settings, whose bounds these are).
export const CHAT = defineModule({
  sections: [{ id: 'chat', order: 72, plugin: 'chat' }],
  settings: {
    'chat.permissionMode': enumOf(chat.MODES, { default: chat.Mode.Default, scope: 'machine', section: 'chat', order: 10 }),
    'chat.allowFullAccess': bool({ default: false, scope: 'machine', section: 'chat', order: 15 }),
    'chat.idleStopMinutes': chatNumber(chat.IDLE_STOP_MINUTES_DEFAULT, chat.IDLE_STOP_MINUTES_MIN, chat.IDLE_STOP_MINUTES_MAX, 5, 20),
    'chat.maxLive': chatNumber(chat.MAX_LIVE_DEFAULT, chat.MAX_LIVE_MIN, chat.MAX_LIVE_MAX, 1, 30),
    'chat.maxChats': chatNumber(chat.MAX_CHATS_DEFAULT, chat.MAX_CHATS_MIN, chat.MAX_CHATS_MAX, 50, 40),
    'chat.retentionDays': chatNumber(chat.RETENTION_DAYS_DEFAULT, chat.RETENTION_DAYS_MIN, chat.RETENTION_DAYS_MAX, 1, 50),
    'chat.maxTotalMB': chatNumber(chat.MAX_TOTAL_MB_DEFAULT, chat.MAX_TOTAL_MB_MIN, chat.MAX_TOTAL_MB_MAX, 64, 60),
    'chat.maxChatMB': chatNumber(chat.MAX_CHAT_MB_DEFAULT, chat.MAX_CHAT_MB_MIN, chat.MAX_CHAT_MB_MAX, 8, 70),
  },
});
