// @vitest-environment jsdom
//
// The chat plugin on the page (plugins/chat): its switch and settings, its
// pane kind, the leaf's checked chat id and agent, the protocol's mirror
// of the chat host's values, and its pane, which says that this version
// has no chats.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../lib/conn', () => ({ conn: { setTheme: () => {} } }));

import registry from '../../../design/generated/registry.json';
import { setLocale, t } from '../i18n';
import { chatPlugin } from '../plugins/chat';
import * as P from '../plugins/chat/protocol';
import { chatRef } from '../plugins/chat/view';
import { allPlugins, definePlugins, enableSetting, newTabGroups, pluginOn } from '../plugins/registry';
import { useSettings } from '../settings';
import type { PluginView } from '../term/layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saved = [...allPlugins()];
beforeAll(() => setLocale('en'));
afterEach(() => {
  definePlugins(saved);
  useSettings.setState({ values: {} });
});

const ID = 'c0123456789abcdef';
const view = (extra: Record<string, unknown>): PluginView => ({ id: 'v1', plugin: 'chat', kind: 'chat', ...extra });

describe('the chat plugin', () => {
  it('is on by default, with its settings page and no new-tab items yet', () => {
    expect(enableSetting(chatPlugin, 'browser')).toBe('plugins.chat.enabled');
    expect(pluginOn(chatPlugin)).toBe(true);
    expect(chatPlugin.settings?.section).toBe('chat');
    const defaults = registry.settings as Record<string, unknown>;
    expect(defaults['plugins.chat.enabled']).toBe(true);
    expect(defaults['chat.permissionMode']).toBe('default');
    expect(Object.keys(defaults).filter((k) => k.startsWith('chat.'))).toEqual([
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
    expect(newTabGroups('a')).toEqual([]);
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
  });

  it('draws a pane that says chats are not available yet', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const Pane = chatPlugin.paneViews!.chat.component;
    await act(async () =>
      root.render(createElement(Pane, { m: 'm', pane: 'view:v1', view: view({ chat: ID, agent: 'claude' }), focused: true })),
    );
    expect(host.textContent).toBe(t('chat.unavailable'));
    await act(async () => root.unmount());
    host.remove();
  });
});
