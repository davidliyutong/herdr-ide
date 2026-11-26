// The chat feature's settings (section "chat"), each per machine: they bound
// what the machine's chat host runs and keeps (chatproto's host settings,
// whose bounds these are), and reach each machine's host with Op.Configure
// (hostSettings).
import { bool, defineModule, enumOf, int, type Store } from '#kernel/config/settings/index.ts';
import * as chat from '#shared/proto/chatproto/index.ts';

const section = 'chat';

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
  },
});

const MIB = 1 << 20;

/** Machine m's settings for its chat host, clamped. */
export function hostSettings(store: Store, m: string): chat.ClampedHostSettings {
  const s = store.of(settings);
  return chat.clampHostSettings({
    idleStopMinutes: s.number('chat.idleStopMinutes', m),
    maxLive: s.number('chat.maxLive', m),
    maxChats: s.number('chat.maxChats', m),
    retentionDays: s.number('chat.retentionDays', m),
    maxTotalBytes: s.number('chat.maxTotalMB', m) * MIB,
    maxChatBytes: s.number('chat.maxChatMB', m) * MIB,
    defaultMode: s.string('chat.permissionMode', m),
    allowFull: s.bool('chat.allowFullAccess', m),
  });
}

/** Whether two settings of a host are the same. */
export const sameSettings = (a: chat.HostSettings, b: chat.HostSettings): boolean => JSON.stringify(a) === JSON.stringify(b);
