// @vitest-environment jsdom
//
// The chat plugin on the page (plugins/chat): its switch and settings, its
// pane kind, the leaf's checked chat id and agent, the protocol's mirror
// of the chat host's values, and what it adds to the app (a new-tab item
// for each agent with chats, its panel, its status bar item, its command,
// the panes' statuses). Its views are in chatPane.test.tsx, its connection
// in chatConnection.test.ts, the rest in chatPlugin.test.tsx.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import registry from '../../../spec/generated/registry.json';
import { hasMessage, setLocale, t } from '../i18n';
import { chatPlugin } from '../plugins/chat';
import * as P from '../plugins/chat/protocol';
import { chatRef } from '../plugins/chat/view';
import { allPlugins, definePlugins, enableSetting, newTabGroups, pluginOn } from '../plugins/registry';
import { useSettings } from '../settings';
import type { PluginView } from '../term/layout';

const saved = [...allPlugins()];
beforeAll(() => setLocale('en'));
afterEach(() => {
  definePlugins(saved);
  useSettings.setState({ values: {} });
});

const ID = 'c0123456789abcdef';
const view = (extra: Record<string, unknown>): PluginView => ({ id: 'v1', plugin: 'chat', kind: 'chat', ...extra });

describe('the chat plugin', () => {
  it('is on by default, with its settings page, a new-tab item for each agent with chats, a panel and a status item', () => {
    expect(enableSetting(chatPlugin, 'browser')).toBe('plugins.chat.enabled');
    expect(pluginOn(chatPlugin)).toBe(true);
    expect(chatPlugin.settings?.section).toBe('chat');
    const defaults = registry.settings as Record<string, unknown>;
    expect(defaults['plugins.chat.enabled']).toBe(true);
    expect(defaults['chat.permissionMode']).toBe('default');
    expect(defaults['chat.allowFullAccess']).toBe(false);
    expect(Object.keys(defaults).filter((k) => k.startsWith('chat.'))).toEqual([
      'chat.allowFullAccess',
      'chat.idleStopMinutes',
      'chat.maxChatMB',
      'chat.maxChats',
      'chat.maxLive',
      'chat.maxTotalMB',
      'chat.permissionMode',
      'chat.retentionDays',
    ]);
    for (const mode of P.MODES) expect(registry.i18n).toContain(`settings.chat.permissionMode.${mode}`);
    definePlugins([chatPlugin]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    expect(newTabGroups('a').map((g) => g.map((i) => i.id))).toEqual([['chat.claude', 'chat.codex', 'chat.kimi', 'chat.grok']]);
    vi.unstubAllGlobals();
    expect(chatPlugin.panels?.map((p) => p.id)).toEqual(['chat']);
    expect(chatPlugin.statusItems?.map((i) => (typeof i === 'object' ? i.id : ''))).toEqual(['chat.usage']);
    expect(Object.keys(chatPlugin.commands ?? {})).toEqual(['chat.new']);
    expect(chatPlugin.viewStatus).toBeDefined();
  });

  it('takes a leaf’s chat id only in the host’s form, and its agent only when the host runs it', () => {
    expect(chatRef(view({ chat: ID, agent: 'claude' }))).toEqual({ chat: ID, agent: 'claude' });
    expect(chatRef(view({ chat: ID, agent: 'kimi' }))).toEqual({ chat: ID, agent: 'kimi' });
    for (const bad of [
      '',
      'c0123',
      ID.toUpperCase(),
      `${ID}0`,
      `../${ID}`,
      `${ID}\n`,
      'd0123456789abcdef',
      7,
      null,
      undefined,
      { id: ID },
    ]) {
      expect(chatRef(view({ chat: bad, agent: 'codex' })).chat, String(bad)).toBeUndefined();
      expect(P.isChatId(bad)).toBe(false);
    }
    for (const bad of ['opencode', 'gemini', 'nobody', '', 3, undefined]) {
      expect(chatRef(view({ chat: ID, agent: bad })).agent, String(bad)).toBeUndefined();
    }
    const pane = chatPlugin.paneViews!.chat;
    expect(pane.title('m', view({ chat: ID, agent: 'codex' }))).toBe('Codex');
    expect(pane.title('m', view({ chat: ID, agent: 'rm -rf ~' }))).toBe(t('chat.pane'));
  });

  it('mirrors the chat host’s values', () => {
    expect(P.PROTO).toBe(2);
    expect(P.CHAT_STATES).toEqual(['starting', 'idle', 'working', 'waiting', 'sleeping', 'failed', 'closed']);
    expect(P.STATE_DELETED).toBe('deleted');
    expect(P.CHAT_STATUSES).toEqual(['working', 'blocked', 'done', 'idle']);
    expect(P.MODES).toEqual(['default', 'acceptEdits', 'plan', 'full']);
    expect(P.planOption('acceptEdits')).toBe('plan:acceptEdits');
    expect([P.OPTION_ALLOW_ONCE, P.OPTION_ALLOW_SESSION, P.OPTION_REJECT_ONCE]).toEqual(['allow_once', 'allow_session', 'reject_once']);
    expect(P.MAX_CLIENT_MESSAGE).toBeGreaterThan(P.MAX_PROMPT);
    expect(P.WS_PATH).toBe('/api/p/chat/ws');
    expect(P.STATES_PATH).toBe('/api/p/chat/states');
    expect([P.MAX_SUBS, P.MAX_SUBS_PER_MACHINE, P.MAX_PAGE_ID]).toEqual([32, 16, 64]);
    expect(P.MAX_STDERR).toBe(2048);
    expect(P.REQUEST_OPS).toContain('trust');
  });

  it('says every code of an error the page may receive in words, but the generic ones', () => {
    // failed and transport: what failed says it in its message.
    for (const code of P.ERROR_CODES.filter((c) => c !== 'failed' && c !== 'transport'))
      expect(hasMessage(`conversation.error.${code}`) || hasMessage(`chat.error.${code}`), code).toBe(true);
    for (const code of ['not_allowed', 'not_running', 'upgrading', 'no_terminal_core', 'start_failed', 'lost', 'not_attached'])
      expect(P.ERROR_CODES, code).toContain(code);
  });
});
