// The pinned schema of Codex's app-server and the types made of it: the
// types are those of the schema kept (its digest and version); every
// message of the recordings of that version (spec/vectors/chat/codex) is
// what the schema allows (the client's requests and answers, the
// app-server's notifications, requests and answers); and so is what the
// adapter sends (each mode's turns, its threads, its other requests, its
// answers and refusals). The typecheck holds the adapter's code to the
// types besides.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NAME } from '#shared/lib/brand.ts';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { MODES } from '#shared/proto/chatproto/index.ts';
import { CODEX_VERSION, SCHEMA_SHA256 } from './appserver.gen.ts';
import { modelListParams, policy, threadParams, turnParams } from './config.ts';
import { toUserInput } from './mapping.ts';
import { ServerRequest, type Conn } from './rpc.ts';
import { initialize, refuse } from './session.ts';
import { SCHEMA_FILE, SPEC, invalid, paramsOf, resultOf } from './testing.ts';

const VECTORS = join(REPO_ROOT, 'spec', 'vectors', 'chat', 'codex');

type Wire = { id?: unknown; method?: string; params?: unknown; result?: unknown; error?: unknown };

/** The lines of a recording. */
function lines(name: string): Array<{ dir: string; msg?: Wire }> {
  return readFileSync(join(VECTORS, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { dir: string; msg?: Wire });
}

describe("Codex's app-server schema", () => {
  test('the types are made of the schema kept, of the version recorded', () => {
    expect(
      createHash('sha256')
        .update(readFileSync(join(SPEC, SCHEMA_FILE)))
        .digest('hex'),
    ).toBe(SCHEMA_SHA256);
    expect(readFileSync(join(SPEC, 'VERSION'), 'utf8').trim()).toBe(CODEX_VERSION);
    // The recordings are of that version (spec/vectors/chat/README.md).
    expect(readFileSync(join(VECTORS, '..', 'README.md'), 'utf8')).toContain(`Codex ${CODEX_VERSION}`);
  });

  test('every message of the recordings is what the schema allows', () => {
    const counts = { requests: 0, results: 0, notifications: 0, serverRequests: 0, answers: 0 };
    const problems: string[] = [];
    for (const name of readdirSync(VECTORS).sort()) {
      // What the client asked, by its ids; what the app-server asked, by its.
      const asked = new Map<string, string>();
      const served = new Map<string, string>();
      // 15-errors sends unknown methods and values on purpose.
      const wrong = name.startsWith('15-errors');
      for (const { dir, msg } of lines(name)) {
        if (!msg) continue;
        const at = `${name}: ${JSON.stringify(msg).slice(0, 120)}`;
        const check = (def: string, v: unknown) => {
          const why = invalid(def, v);
          if (why) problems.push(`${at}: ${why}`);
        };
        const id = JSON.stringify(msg.id);
        if (dir === 'out' && msg.method !== undefined && msg.id !== undefined) {
          asked.set(id, msg.method);
          if (wrong) continue;
          check('ClientRequest', msg);
          counts.requests++;
        } else if (dir === 'out' && msg.method !== undefined) {
          check('ClientNotification', msg);
        } else if (dir === 'out') {
          const method = served.get(id);
          if (method === undefined) {
            if (!wrong) problems.push(`${at}: an answer to no request`);
          } else if (msg.error === undefined) {
            check(resultOf('ServerRequest', method), msg.result);
            counts.answers++;
          }
        } else if (msg.method !== undefined && msg.id !== undefined) {
          served.set(id, msg.method);
          check('ServerRequest', msg);
          counts.serverRequests++;
        } else if (msg.method !== undefined) {
          check('ServerNotification', msg);
          counts.notifications++;
        } else {
          const method = asked.get(id);
          if (method === undefined) {
            if (!wrong) problems.push(`${at}: an answer to no request`);
          } else if (msg.error === undefined && !wrong) {
            check(resultOf('ClientRequest', method), msg.result);
            counts.results++;
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(counts).toEqual({ requests: 74, results: 72, notifications: 1087, serverRequests: 5, answers: 5 });
  });

  test("a message the schema does not allow is told: the validators read Codex's definitions", () => {
    expect(paramsOf('ServerNotification', 'turn/started')).toBe('TurnStartedNotification');
    expect(invalid('ServerNotification', { method: 'turn/started', params: { threadId: 3 } })).not.toBe('');
    expect(
      invalid('ClientRequest', { id: 1, method: 'turn/start', params: { threadId: 't', input: [], approvalPolicy: 'sometimes' } }),
    ).not.toBe('');
    expect(invalid('ClientRequest', { id: 1, method: 'no/such', params: {} })).not.toBe('');
  });

  test('what the adapter sends is what the schema allows', async () => {
    const request = (method: string, params: unknown) => invalid('ClientRequest', { id: 1, method, params });
    const input = toUserInput([
      { type: 'text', text: 'x' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'resource_link', uri: 'file:///w/a.go', name: 'a.go' },
    ]);
    for (const mode of MODES) {
      expect(request('turn/start', turnParams('t', '/w', 'm1', input, { model: 'm', effort: 'low', mode }))).toBe('');
      expect(request('turn/start', turnParams('t', '/w', '', input, { model: '', effort: '', mode }))).toBe('');
      // The policies are the schema's values.
      const p = policy(mode, '/w');
      expect(invalid('AskForApproval', p.approval)).toBe('');
      expect(invalid('SandboxPolicy', p.sandbox)).toBe('');
    }
    for (const model of ['', 'm']) {
      expect(request('thread/start', threadParams('', '/w', model))).toBe('');
      expect(request('thread/resume', threadParams('t', '/w', model))).toBe('');
    }
    expect(request('turn/steer', { threadId: 't', expectedTurnId: 'u', clientUserMessageId: 'm', input })).toBe('');
    expect(request('turn/interrupt', { threadId: 't', turnId: 'u' })).toBe('');
    expect(request('thread/compact/start', { threadId: 't' })).toBe('');
    expect(request('thread/list', { cwd: '/w', limit: 50, cursor: 'c' })).toBe('');
    expect(request('thread/list', { includedThreadIds: ['t'], limit: 1 })).toBe('');
    expect(request('thread/turns/list', { threadId: 't', limit: 20, sortDirection: 'desc', itemsView: 'full', cursor: 'c' })).toBe('');
    expect(request('model/list', modelListParams('c'))).toBe('');
    expect(request('account/read', { refreshToken: false })).toBe('');

    // The handshake, as initialize writes it.
    const sent: Array<{ method: string; params?: unknown }> = [];
    const conn = {
      call: (method: string, params: unknown) => {
        sent.push({ method, params });
        return Promise.resolve({ userAgent: 'codex/0.171.0' });
      },
      notify: (method: string) => sent.push({ method }),
    } as unknown as Conn;
    expect(await initialize(conn, { name: NAME, version: '1.2.3' }, new AbortController().signal)).toBe('0.171.0');
    expect(request('initialize', sent[0]!.params)).toBe('');
    expect(invalid('ClientNotification', sent[1])).toBe('');

    // The answers to the app-server's requests the user does not answer.
    for (const method of [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
      'item/permissions/requestApproval',
      'item/tool/call',
    ]) {
      const written: unknown[] = [];
      refuse(new ServerRequest({ write: (v: unknown) => written.push(v) } as unknown as Conn, 1, method, {}));
      expect([method, invalid(resultOf('ServerRequest', method), (written[0] as { result: unknown }).result)]).toEqual([method, '']);
    }
    // The decisions an approval is answered with.
    for (const d of ['accept', 'acceptForSession', 'decline', 'cancel']) {
      expect(invalid('CommandExecutionRequestApprovalResponse', { decision: d })).toBe('');
      expect(invalid('FileChangeRequestApprovalResponse', { decision: d })).toBe('');
    }
  });
});
