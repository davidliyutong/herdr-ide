import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { auditText, MAX_AUDIT } from './audit.ts';
import { statusOf } from './errors.ts';
import { NOT_RUNNING } from './protocol.ts';
import { validCwd } from './routes.ts';
import { hostSettings, settings } from './settings.ts';
import {
  ack,
  attached,
  clientMessage,
  commandLine,
  HubCode,
  detached,
  eventPrefix,
  MAX_CLIENT_MESSAGE,
  MAX_PAGE_ID,
  MAX_SUBS,
  MAX_SUBS_PER_MACHINE,
  stateOf,
} from './wire.ts';

describe('wire', () => {
  // The WebSocket's messages as the page reads and writes them
  // (web/src/plugins/chat/protocol.ts), as the Go hub wrote them.
  test('messages', () => {
    expect(attached('s1', { id: 'c1' }, 1)).toBe('{"t":"attached","sub":"s1","chat":{"id":"c1"},"first":1}');
    expect(attached('s1', undefined, 0)).toBe('{"t":"attached","sub":"s1"}');
    expect(eventPrefix('s1') + '{"seq":3,"t":"turn","state":"start"}}').toBe(
      '{"t":"event","sub":"s1","ev":{"seq":3,"t":"turn","state":"start"}}',
    );
    expect(detached('s1', { code: HubCode.Offline, message: 'm' })).toBe(
      '{"t":"detached","sub":"s1","error":{"code":"offline","message":"m"}}',
    );
    expect(ack('k1')).toBe('{"t":"ack","id":"k1"}');
    expect(ack('k1', { code: HubCode.ReadOnly, message: 'm' })).toBe('{"t":"ack","id":"k1","error":{"code":"read_only","message":"m"}}');
    const st = stateOf({
      id: 'c1',
      kind: 'claude',
      title: '',
      cwd: '',
      state: 'working',
      status: 'working',
      updated: '0001-01-01T00:00:00Z',
      seq: 0,
      sessionId: '',
    });
    expect(JSON.stringify({ t: 'states', states: [st], full: true, rev: 4 })).toBe(
      '{"t":"states","states":[{"id":"c1","kind":"claude","title":"","cwd":"","state":"working","status":"working","updated":"0001-01-01T00:00:00Z","seq":0,"sessionId":""}],"full":true,"rev":4}',
    );
    expect(MAX_CLIENT_MESSAGE).toBeGreaterThan(chat.MAX_PROMPT);
    expect([MAX_SUBS, MAX_SUBS_PER_MACHINE, MAX_PAGE_ID]).toEqual([32, 16, 64]);
  });

  // A page's message is taken as the Go hub took it: members of other
  // types make it none; a command keeps chatproto's members only, those
  // that are empty left out, under the hub's id.
  test('a page message', () => {
    const m = clientMessage.parse({ op: 'command', id: 'p1', m: 'gpu', chat: 'c1', cmd: { op: 'cancel', id: 'x', extra: 1, title: null } });
    expect(m).toMatchObject({ op: 'command', id: 'p1', m: 'gpu', chat: 'c1', sub: '', from: 0 });
    expect(commandLine(m.cmd!, 'k1')).toBe('{"op":"cancel","id":"k1"}\n');
    // Empty answers ({}) on CommandOp.Answer is preserved for all-optional questions.
    const emptyAns = clientMessage.parse({
      op: 'command',
      id: 'p2',
      m: 'gpu',
      chat: 'c1',
      cmd: { op: chat.CommandOp.Answer, id: 'x', request: 'q1', answers: {} },
    });
    expect(commandLine(emptyAns.cmd!, 'k2')).toBe('{"op":"answer","id":"k2","request":"q1","answers":{}}\n');
    const p = clientMessage.parse({
      op: 'command',
      cmd: {
        op: 'permission',
        request: 'r',
        option: 'o',
        cancelled: false,
        answers: { a: ['x'] },
        content: [{ type: 'text', text: 'hi' }],
      },
    }).cmd!;
    expect(commandLine(p, 'k2')).toBe(
      '{"op":"permission","id":"k2","content":[{"type":"text","text":"hi"}],"request":"r","option":"o","answers":{"a":["x"]}}\n',
    );
    for (const bad of [
      { op: 1 },
      { op: 'attach', from: -1 },
      { op: 'attach', from: 1.5 },
      { op: 'command', cmd: { op: 'x', cancelled: 'yes' } },
    ])
      expect(clientMessage.safeParse(bad).success).toBe(false);
  });

  // The statuses of the codes the routes answer with.
  test('statuses', () => {
    const want: Record<string, number> = {
      [chat.Code.UnknownChat]: 404,
      [chat.Code.Busy]: 409,
      [chat.Code.TooMany]: 409,
      [chat.Code.BadRequest]: 400,
      [chat.Code.StartFailed]: 502,
      [chat.Code.Unsupported]: 422,
      [chat.Code.NotAllowed]: 403,
      [chat.Code.Sleeping]: 409,
      [chat.Code.TooLarge]: 413,
      [NOT_RUNNING]: 409,
      upgrading: 503,
      no_terminal_core: 503,
      [chat.Code.UnsafeFolder]: 403,
      read_only: 403,
      offline: 409,
      timeout: 504,
      transport: 502,
      '': 200,
    };
    for (const [code, status] of Object.entries(want)) expect([code, statusOf(code)]).toEqual([code, status]);
  });

  test('paths and audit values', () => {
    for (const ok of ['/', '/w', '/w/x', '/a.b/c..d']) expect([ok, validCwd(ok)]).toEqual([ok, true]);
    for (const bad of ['', 'w', '/w/', '//w', '/w/../x', '/./w', '/w/.', '/w\0', '/' + 'x'.repeat(4096)])
      expect([bad, validCwd(bad)]).toEqual([bad, false]);
    expect(auditText('abc')).toBe('abc');
    const long = 'é'.repeat(200);
    const cut = auditText(long);
    expect(Buffer.byteLength(cut)).toBe(MAX_AUDIT + Buffer.byteLength('…'));
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    const odd = 'a' + 'é'.repeat(200);
    expect(odd.startsWith(auditText(odd).slice(0, -1))).toBe(true);
  });

  // The page's mirror of the protocol lists every code an error it
  // receives may have, by where it comes from, and the bounds it relies on.
  test("the page's mirror", () => {
    const src = readFileSync(join(REPO_ROOT, 'web/src/plugins/chat/protocol.ts'), 'utf8');
    const list = (name: string) => {
      const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(src);
      if (!m) throw new Error(`${name} not found`);
      return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    };
    expect(list('HOST_CODES')).toEqual([
      chat.Code.BadRequest,
      chat.Code.UnknownChat,
      chat.Code.TooMany,
      chat.Code.Busy,
      chat.Code.NotFound,
      chat.Code.StartFailed,
      chat.Code.Protocol,
      chat.Code.AuthRequired,
      chat.Code.Unsupported,
      chat.Code.TooLarge,
      chat.Code.Ended,
      chat.Code.Failed,
      chat.Code.InTerminal,
      chat.Code.HandedOff,
      chat.Code.Sleeping,
      chat.Code.NotAllowed,
      chat.Code.UnsafeFolder,
      chat.Code.SdkUnavailable,
    ]);
    expect(list('MACHINE_CODES')).toEqual([NOT_RUNNING, 'upgrading', 'no_terminal_core', 'start_failed', 'transport']);
    expect(list('HUB_CODES')).toEqual([
      HubCode.ReadOnly,
      HubCode.Offline,
      HubCode.UnknownSub,
      HubCode.TooMany,
      HubCode.NotAttached,
      HubCode.Lost,
      HubCode.PluginDisabled,
      HubCode.Timeout,
    ]);
    for (const want of [
      'export const MAX_STDERR = 2 << 10;',
      `export const MAX_SUBS = ${MAX_SUBS};`,
      `export const MAX_SUBS_PER_MACHINE = ${MAX_SUBS_PER_MACHINE};`,
      `export const MAX_PAGE_ID = ${MAX_PAGE_ID};`,
      '  full?: boolean;',
      '  allowFull?: boolean;',
    ])
      expect(src).toContain(want);
    expect(chat.MAX_STDERR).toBe(2 << 10);
  });
});

describe('settings', () => {
  // The settings are the chat host's, with its bounds, per machine; a
  // machine's own values reach its host clamped.
  test('host settings', () => {
    const st = new Settings('', { modules: [settings] });
    expect(hostSettings(st, 'm')).toEqual(chat.defaultHostSettings());
    for (const d of st.defs()) {
      const wantScope = d.key.startsWith('chat.visibleModels.') ? 'app' : 'machine';
      expect([d.key, d.scope, d.section]).toEqual([d.key, wantScope, 'chat']);
    }
    // Per-provider visible model allowlists default to empty (= show all).
    for (const k of ['claude', 'codex', 'agy', 'kimi', 'grok']) {
      expect(st.get(`chat.visibleModels.${k}`, '')).toEqual([]);
    }
    st.set('chat.visibleModels.claude', '', ['claude-sonnet-4-6', 'claude-opus-4-6']);
    expect(st.get('chat.visibleModels.claude', '')).toEqual(['claude-sonnet-4-6', 'claude-opus-4-6']);
    expect(() => st.set('chat.visibleModels.claude', '', [''])).toThrow();
    st.set('chat.permissionMode', 'gpu', chat.Mode.Full);
    expect(hostSettings(st, 'gpu')).toEqual(chat.defaultHostSettings());
    st.set('chat.allowFullAccess', 'gpu', true);
    st.set('chat.idleStopMinutes', 'gpu', 1440);
    st.set('chat.maxLive', '', 2);
    st.set('chat.maxChats', 'gpu', 50);
    st.set('chat.retentionDays', 'gpu', 365);
    st.set('chat.maxTotalMB', 'gpu', 2048);
    st.set('chat.maxChatMB', 'gpu', 8);
    expect(hostSettings(st, 'gpu')).toEqual({
      idleStopMinutes: 1440,
      maxLive: 2,
      maxChats: 50,
      retentionDays: 365,
      maxTotalBytes: 2048 * 2 ** 20,
      maxChatBytes: 8 << 20,
      defaultMode: chat.Mode.Full,
      allowFull: true,
    });
    expect(hostSettings(st, 'other')).toMatchObject({ maxLive: 2, defaultMode: 'default', maxTotalBytes: 512 << 20 });
    expect(hostSettings(st, 'other')).not.toHaveProperty('allowFull');
    // Values beyond the host's bounds are not settings.
    for (const [key, v] of [
      ['chat.idleStopMinutes', 4],
      ['chat.maxLive', 33],
      ['chat.maxChats', 2001],
      ['chat.retentionDays', 0],
      ['chat.maxTotalMB', 4096],
      ['chat.maxChatMB', 7],
      ['chat.permissionMode', 'bypassPermissions'],
    ] as const)
      expect(() => st.set(key, '', v)).toThrow();
  });
});
