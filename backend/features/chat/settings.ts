// The chat feature's settings (section "chat"), each per machine: they bound
// what the machine's chat host runs and keeps (chatproto's host settings,
// whose bounds these are), and reach each machine's host with Op.Configure
// (hostSettings).
import { bool, defineModule, enumOf, int, stringList, type Setting, type Store } from '#kernel/config/settings/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';

const section = 'chat';

/** The chat agent kinds with per-provider settings, in UI order. */
export const CHAT_PROVIDERS = ['claude', 'codex', 'agy', 'kimi', 'grok'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

/** Selectable per-provider permission modes (`inherit` follows `chat.permissionMode`).
 * Each agent only offers the host permission modes that its adapter actually supports. */
export const PROVIDER_PERMISSION_MODES: Readonly<Record<ChatProvider, readonly [string, ...string[]]>> = {
  claude: ['inherit', chat.Mode.Default, chat.Mode.AcceptEdits, chat.Mode.Plan, chat.Mode.Full],
  codex: ['inherit', chat.Mode.Default, chat.Mode.AcceptEdits, chat.Mode.Plan, chat.Mode.Full],
  agy: ['inherit', chat.Mode.Default, chat.Mode.AcceptEdits, chat.Mode.Plan, chat.Mode.Full],
  kimi: ['inherit', chat.Mode.Default, chat.Mode.Plan, chat.Mode.Full],
  grok: ['inherit', chat.Mode.Default, chat.Mode.AcceptEdits, chat.Mode.Full],
};

function validModelList(list: string[]): string | undefined {
  for (const s of list) {
    if (s.trim() === '' || Buffer.byteLength(s) > 256) return 'model ids must be non-empty strings of at most 256 bytes';
  }
  return undefined;
}

const number = (def: number, min: number, max: number, step: number, order: number) =>
  int({ default: def, min, max, step, scope: 'machine', section, order });

export const settings = defineModule({
  sections: [{ id: section, order: 72, plugin: 'chat' }],
  settings: {
    /** The permission mode a new chat starts in; full only with
     * chat.allowFullAccess. */
    'chat.permissionMode': enumOf(chat.MODES, { default: chat.Mode.Default, scope: 'machine', section, order: 10 }),
    /** The machine's chats may give their agents full access. */
    'chat.allowFullAccess': bool({ default: false, scope: 'machine', section, order: 15 }),
    /** Minutes an agent with nothing to do keeps running. */
    'chat.idleStopMinutes': number(chat.IDLE_STOP_MINUTES_DEFAULT, chat.IDLE_STOP_MINUTES_MIN, chat.IDLE_STOP_MINUTES_MAX, 5, 20),
    /** The most agents running at once on the machine. */
    'chat.maxLive': number(chat.MAX_LIVE_DEFAULT, chat.MAX_LIVE_MIN, chat.MAX_LIVE_MAX, 1, 30),
    /** The most chats the machine keeps. */
    'chat.maxChats': number(chat.MAX_CHATS_DEFAULT, chat.MAX_CHATS_MIN, chat.MAX_CHATS_MAX, 50, 40),
    /** Days a closed chat is kept. */
    'chat.retentionDays': number(chat.RETENTION_DAYS_DEFAULT, chat.RETENTION_DAYS_MIN, chat.RETENTION_DAYS_MAX, 1, 50),
    /** The most megabytes of every chat's log. */
    'chat.maxTotalMB': number(chat.MAX_TOTAL_MB_DEFAULT, chat.MAX_TOTAL_MB_MIN, chat.MAX_TOTAL_MB_MAX, 64, 60),
    /** The most megabytes of one chat's log. */
    'chat.maxChatMB': number(chat.MAX_CHAT_MB_DEFAULT, chat.MAX_CHAT_MB_MIN, chat.MAX_CHAT_MB_MAX, 8, 70),
    /** Default UTF-8 byte budget (in KiB) for Markdown exports and cross-agent handoff digests. */
    'chat.handoffMaxKB': int({ default: 96, min: 16, max: 512, step: 16, scope: 'app', section, order: 75 }),
    /** Per-provider permission mode overrides for new chats (`inherit` follows `chat.permissionMode`). */
    ...Object.fromEntries(
      CHAT_PROVIDERS.map((k, i): [string, Setting] => [
        `chat.permissionMode.${k}`,
        enumOf(PROVIDER_PERMISSION_MODES[k], { default: 'inherit', scope: 'machine', section, group: 'chatModels', order: 80 + i }),
      ]),
    ),
    /** Per-provider enable switches for Agent Chats (default on). */
    ...Object.fromEntries(
      CHAT_PROVIDERS.map((k, i): [string, Setting] => [
        `chat.providers.${k}`,
        bool({ default: true, scope: 'app', section, group: 'chatModels', order: 90 + i }),
      ]),
    ),
    /** Per-provider model allowlists for the composer picker (empty = show all). */
    ...Object.fromEntries(
      CHAT_PROVIDERS.map((k, i): [string, Setting] => [
        `chat.visibleModels.${k}`,
        stringList({ default: [], scope: 'app', section, group: 'chatModels', order: 100 + i, check: validModelList }),
      ]),
    ),
  },
});

const MIB = 1 << 20;

/** Keys that affect hostSettings() and require Op.Configure on live chat hosts.
 * Hub/UI-only keys (chat.handoffMaxKB, chat.providers.*, chat.visibleModels.*)
 * do not affect the host process and should not trigger Op.Configure churn. */
const HOST_SETTING_KEYS = new Set<string>([
  'chat.permissionMode',
  'chat.allowFullAccess',
  'chat.idleStopMinutes',
  'chat.maxLive',
  'chat.maxChats',
  'chat.retentionDays',
  'chat.maxTotalMB',
  'chat.maxChatMB',
]);

export const isHostSettingKey = (key: string): boolean => HOST_SETTING_KEYS.has(key) || key.startsWith('chat.permissionMode.');

/** Machine m's settings for its chat host, clamped. */
export function hostSettings(store: Store, m: string): chat.ClampedHostSettings {
  const s = store.of(settings);
  const defaultModes: Record<string, string> = {};
  for (const k of CHAT_PROVIDERS) {
    const raw = store.get(`chat.permissionMode.${k}`, m);
    if (typeof raw === 'string' && raw !== 'inherit') defaultModes[k] = raw;
  }
  return chat.clampHostSettings({
    idleStopMinutes: s.number('chat.idleStopMinutes', m),
    maxLive: s.number('chat.maxLive', m),
    maxChats: s.number('chat.maxChats', m),
    retentionDays: s.number('chat.retentionDays', m),
    maxTotalBytes: s.number('chat.maxTotalMB', m) * MIB,
    maxChatBytes: s.number('chat.maxChatMB', m) * MIB,
    defaultMode: s.string('chat.permissionMode', m),
    ...(Object.keys(defaultModes).length > 0 ? { defaultModes } : {}),
    allowFull: s.bool('chat.allowFullAccess', m),
  });
}

/** Whether two settings of a host are the same. */
export const sameSettings = (a: chat.HostSettings, b: chat.HostSettings): boolean => JSON.stringify(a) === JSON.stringify(b);
