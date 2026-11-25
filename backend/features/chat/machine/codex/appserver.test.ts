// The pinned schema of Codex's app-server and the types made of it: the
// types are those of the schema kept (its digest and version), and every
// message of the recordings of that version (spec/vectors/chat/codex) is
// what the schema allows: the client's requests and answers, the
// app-server's notifications, requests and answers.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '#shared/lib/repo.ts';
import { CODEX_VERSION, SCHEMA_SHA256 } from './appserver.gen.ts';
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
});
