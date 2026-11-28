// Claude Code's sessions and their import, from transcripts in temporary
// homes: the recorded transcript of a headless session
// (spec/vectors/chat/claude/claude-transcript-headless.jsonl) gives the
// events of the golden file testdata/golden/history.golden.json.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_MAX_NAME, claudeEscape } from '#machine/agents/sessions.ts';
import { ChatProtoError, Code, EventType, TurnState, type Event } from '#shared/proto/chatproto/index.ts';
import type { HistoryParams, SessionsParams } from '../adapter.ts';
import { claudeAdapter } from './adapter.ts';
import { headOf, isChunk } from './items.ts';
import { GOLDEN, VECTORS, devSdk, isolateHome, tempDir } from './testing.ts';

isolateHome();

/** The session of the recorded transcript. */
const HEADLESS = '00000000-0000-4000-8000-000000000001';

/** A home with the recorded transcript in the projects directory of /work. */
function claudeHome(): { home: string; env: Record<string, string>; dir: string } {
  const home = tempDir('chh');
  const dir = join(home, '.claude', 'projects', '-work');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, HEADLESS + '.jsonl'), readFileSync(join(VECTORS, 'claude-transcript-headless.jsonl')), { mode: 0o600 });
  return { home, env: { HOME: home }, dir };
}

const sig = () => AbortSignal.timeout(20_000);
const hp = (env: Record<string, string>, o: Partial<HistoryParams> = {}): HistoryParams => ({
  kind: 'claude',
  argv: [],
  env,
  cwd: '/work',
  procs: null as never,
  logger: () => {},
  sessionId: HEADLESS,
  after: '',
  ...o,
});

async function readHistory(p: HistoryParams): Promise<Event[]> {
  const evs: Event[] = [];
  await claudeAdapter({ sdk: devSdk }).history(
    p,
    (ev) => {
      expect(ev.seq).toBeUndefined();
      expect(ev.live).toBeUndefined();
      evs.push(ev);
    },
    sig(),
  );
  return evs;
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no error';
  } catch (e) {
    return e instanceof ChatProtoError ? e.code : String(e);
  }
};

/** A small transcript of a session in cwd. */
const transcriptLines = (cwd: string, prompt: string, ...extra: string[]): string =>
  [
    '{"type":"session-owner","sessionId":"x"}',
    JSON.stringify({ type: 'user', cwd, timestamp: '2026-11-22T10:00:00Z', message: { role: 'user', content: prompt } }),
    ...extra,
  ].join('\n') + '\n';

describe('history', () => {
  test("the recorded transcript is the chat's stored events, as the golden file has", async () => {
    const { env } = claudeHome();
    const evs = await readHistory(hp(env));
    let starts = 0;
    let ends = 0;
    let open = false;
    for (const ev of evs) {
      if (ev.t === EventType.Turn) {
        if (ev.state === TurnState.Start) {
          expect(open).toBe(false);
          starts++;
        } else {
          expect(open).toBe(true);
          ends++;
        }
        open = ev.state === TurnState.Start;
      }
      if (ev.t === EventType.Update) {
        const h = headOf(ev.update);
        expect(h.sessionUpdate).not.toBe('usage_update');
        if (isChunk(h.sessionUpdate) || h.toolCallId !== '') expect(ev.item ?? '').not.toBe('');
      }
    }
    expect([starts, ends, open]).toEqual([22, 22, false]);
    const want = (JSON.parse(readFileSync(join(GOLDEN, 'history.golden.json'), 'utf8')) as { events: Event[] }).events;
    const got = evs.map((e) => {
      const { at: _, ...rest } = e;
      return JSON.parse(JSON.stringify(rest)) as Event;
    });
    // Go writes the whole of an info event's chat; it has a title only.
    expect(got[0]).toEqual({ t: EventType.Info, chat: { title: want[0]!.chat!.title } } as Event);
    expect(got.slice(1)).toEqual(want.slice(1));
    // The items of the live session: the thinking and the reply of the first
    // response are its blocks 0 and 1.
    const items = new Set(evs.map((e) => e.item));
    for (const want of ['msg_0001/0', 'msg_0001/1', 'msg_0015/0', 'toolu_0001']) expect(items.has(want)).toBe(true);
  });

  test("after an item, what came after it without the end of the turn the chat has; another item, directory or session isn't", async () => {
    const { env } = claudeHome();
    const all = await readHistory(hp(env));
    const at = all.map((e) => e.item).lastIndexOf('msg_0030/0');
    expect(at).toBeGreaterThanOrEqual(0);
    const after = await readHistory(hp(env, { after: 'msg_0030/0' }));
    expect(after[0]).toMatchObject({ t: EventType.Turn, state: TurnState.Start });
    let rest = all.slice(at + 1);
    while (rest.length > 0 && rest[0]!.t === EventType.Turn && rest[0]!.state !== TurnState.Start) rest = rest.slice(1);
    expect(after).toEqual(rest);
    expect(await codeOf(readHistory(hp(env, { after: 'msg_9999/0' })))).toBe(Code.NotFound);
    expect(await codeOf(readHistory(hp(env, { cwd: '/elsewhere' })))).toBe(Code.BadRequest);
    expect(await codeOf(readHistory(hp(env, { sessionId: '00000000-0000-4000-8000-000000000099' })))).toBe(Code.NotFound);
    expect(await codeOf(readHistory(hp(env, { sessionId: '../../etc/passwd' })))).toBe(Code.BadRequest);
  });

  test("a whole conversation starts with the session's title, the user's own first; none without one, nor after an item", async () => {
    const { env, dir } = claudeHome();
    const answer = JSON.stringify({
      type: 'assistant',
      cwd: '/work',
      message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });
    const titled = '00000000-0000-4000-8000-000000000011';
    const untitled = '00000000-0000-4000-8000-000000000012';
    writeFileSync(
      join(dir, titled + '.jsonl'),
      transcriptLines(
        '/work',
        'the first prompt',
        answer,
        '{"type":"ai-title","aiTitle":"Made by Claude"}',
        '{"type":"custom-title","customTitle":"  Mine  "}',
      ),
    );
    writeFileSync(join(dir, untitled + '.jsonl'), transcriptLines('/work', 'the first prompt', answer));
    const title = async (id: string, after = ''): Promise<[string, number]> => {
      const evs = await readHistory(hp(env, { sessionId: id, after }));
      const infos = evs.map((e, i) => [e, i] as const).filter(([e]) => e.t === EventType.Info);
      for (const [, i] of infos) expect(i).toBe(0);
      return [infos[0]?.[0].chat?.title ?? '', infos.length];
    };
    expect(await title(titled)).toEqual(['Mine', 1]);
    expect((await title(untitled))[1]).toBe(0);
    expect(await title(HEADLESS)).toEqual(['回复问候语', 1]);
    expect((await title(titled, 'msg_1/0'))[1]).toBe(0);
  });

  test('records top-level transcript entryUuid across chunk boundaries, ignores nested uuid strings, and supports partial fork with emitted entryUuid', async () => {
    const home = tempDir('chuuid');
    const work = tempDir('chwork');
    const proj = join(home, '.claude', 'projects', claudeEscape(work));
    mkdirSync(proj, { recursive: true });
    const sessId = '66666666-6666-4666-8666-666666666666';
    const u1 = '20000000-0000-4000-8000-000000000001';
    const a1 = '20000000-0000-4000-8000-000000000002';
    const tr1 = '20000000-0000-4000-8000-000000000003';
    const a2 = '20000000-0000-4000-8000-000000000004';
    const u2 = '20000000-0000-4000-8000-000000000005';
    const a3 = '20000000-0000-4000-8000-000000000006';
    // Include a >70 KiB line with nested {"uuid":"fake-nested"} BEFORE the real top-level "uuid"
    // so UuidProxy is exercised across >64 KiB read chunks and nested JSON objects.
    const bigPad = 'x'.repeat(70_000);
    const lines = [
      {
        type: 'user',
        parentUuid: null,
        sessionId: sessId,
        cwd: work,
        timestamp: '2026-11-22T10:00:00Z',
        message: { role: 'user', content: 'first {"uuid":"fake-user-nested"} ' + bigPad },
        uuid: u1,
      },
      {
        type: 'assistant',
        parentUuid: u1,
        sessionId: sessId,
        cwd: work,
        timestamp: '2026-11-22T10:00:01Z',
        message: {
          id: 'msg_01',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'echo {"uuid":"fake-tool"}', uuid: 'fake-input' } },
          ],
        },
        uuid: a1,
      },
      {
        type: 'user',
        parentUuid: a1,
        sessionId: sessId,
        cwd: work,
        timestamp: '2026-11-22T10:00:02Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"uuid":"fake-out"}', is_error: false }],
        },
        uuid: tr1,
      },
      {
        type: 'assistant',
        parentUuid: tr1,
        sessionId: sessId,
        cwd: work,
        timestamp: '2026-11-22T10:00:03Z',
        message: { id: 'msg_02', role: 'assistant', content: [{ type: 'text', text: 'answer one' }] },
        uuid: a2,
      },
      {
        type: 'user',
        parentUuid: a2,
        sessionId: sessId,
        cwd: work,
        timestamp: '2026-11-22T10:00:04Z',
        message: { role: 'user', content: 'second prompt' },
        uuid: u2,
      },
      {
        type: 'assistant',
        parentUuid: u2,
        sessionId: sessId,
        cwd: work,
        timestamp: '2026-11-22T10:00:05Z',
        message: { id: 'msg_03', role: 'assistant', content: [{ type: 'text', text: 'answer two' }] },
        uuid: a3,
      },
    ];
    writeFileSync(join(proj, `${sessId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { mode: 0o600 });

    const env = { HOME: home };
    const evs = await readHistory(hp(env, { cwd: work, sessionId: sessId }));
    const users = evs.filter((e) => e.t === EventType.User);
    expect(users.map((e) => [e.item, e.entryUuid])).toEqual([
      [u1, u1],
      [u2, u2],
    ]);
    const updates = evs.filter((e) => e.t === EventType.Update);
    expect(updates.map((e) => [e.item, e.entryUuid])).toEqual([
      ['toolu_01', a1],
      ['toolu_01', tr1],
      ['msg_02/0', a2],
      ['msg_03/0', a3],
    ]);

    // Partial fork up to turn 1's emitted entryUuid (a2) succeeds and drops turn 2.
    const a = claudeAdapter({ sdk: devSdk });
    const forked = await a.fork!(
      {
        kind: 'claude',
        argv: [],
        env,
        cwd: work,
        procs: null as never,
        logger: () => {},
        sessionId: sessId,
        upToMessageId: updates[2]!.entryUuid,
        client: { name: 'test', version: '0' },
      },
      sig(),
    );
    const forkedText = await Bun.file(join(proj, `${forked.sessionId}.jsonl`)).text();
    expect(forkedText).toContain('answer one');
    expect(forkedText).not.toContain('second prompt');
    expect(forkedText).not.toContain('answer two');
  });
});

describe('sessions', () => {
  test("a directory's transcripts, the latest first, a page at a time; another directory's, files not the user's own and names no session's left out", async () => {
    const { env, dir } = claudeHome();
    const write = (name: string, content: string, mod: Date) => {
      const p = join(dir, name);
      writeFileSync(p, content, { mode: 0o600 });
      utimesSync(p, mod, mod);
    };
    const base = Date.UTC(2026, 10, 22, 10);
    const at = (h: number) => new Date(base + h * 3_600_000);
    utimesSync(join(dir, HEADLESS + '.jsonl'), at(0), at(0));
    write(
      '00000000-0000-4000-8000-000000000002.jsonl',
      transcriptLines(
        '/work',
        'fix the\n  tests',
        '{"type":"ai-title","aiTitle":"Fix tests"}',
        '{"type":"custom-title","customTitle":"My name"}',
      ),
      at(2),
    );
    write('00000000-0000-4000-8000-000000000003.jsonl', transcriptLines('/work', 'first prompt'), at(1));
    // Another directory of the same escaped name.
    write('00000000-0000-4000-8000-000000000004.jsonl', transcriptLines('/wo-rk', 'other'), at(3));
    write('not-a-session.jsonl', transcriptLines('/work', 'x'), at(4));
    // No conversation yet.
    write('00000000-0000-4000-8000-000000000005.jsonl', '{"type":"session-owner"}\n', at(5));
    // A link to a transcript elsewhere.
    const outside = join(tempDir('cho'), 'o.jsonl');
    writeFileSync(outside, transcriptLines('/work', 'linked'));
    symlinkSync(outside, join(dir, '00000000-0000-4000-8000-000000000006.jsonl'));

    const sp = (o: Partial<SessionsParams> = {}): SessionsParams => ({
      kind: 'claude',
      argv: [],
      env,
      cwd: '/work',
      procs: null as never,
      logger: () => {},
      cursor: '',
      ...o,
    });
    const { sessions, next } = await claudeAdapter({ sdk: devSdk }).sessions(sp(), sig());
    expect(next).toBe('');
    expect(sessions.map((s) => s.sessionId.slice(-1))).toEqual(['2', '3', '1']);
    expect(sessions.map((s) => s.title)).toEqual(['My name', 'first prompt', '回复问候语']);
    for (const s of sessions) {
      expect(s.cwd).toBe('/work');
      expect(s.updatedAt).toMatch(/^2026-11-22T1[0-2]:00:00Z$/);
    }

    // A page at a time.
    const paged: string[] = [];
    let cursor = '';
    const one = claudeAdapter({ sdk: devSdk, sessionsPage: 1 });
    for (let i = 0; i < 5; i++) {
      const page = await one.sessions(sp({ cursor }), sig());
      paged.push(...page.sessions.map((s) => s.sessionId.slice(-1)));
      if (page.next === '') break;
      cursor = page.next;
    }
    expect(paged).toEqual(['2', '3', '1']);
    expect(await codeOf(claudeAdapter({ sdk: devSdk }).sessions(sp({ cursor: 'x' }), sig()))).toBe(Code.BadRequest);
    expect(await codeOf(claudeAdapter({ sdk: devSdk }).sessions(sp({ cwd: 'relative' }), sig()))).toBe(Code.BadRequest);
    expect((await claudeAdapter({ sdk: devSdk }).sessions(sp({ cwd: '/nowhere' }), sig())).sessions).toEqual([]);
  });

  test("a long directory's transcripts are in the directories that start with the first 200 characters of its escaped name", async () => {
    const { env, home } = claudeHome();
    const long = '/' + 'a'.repeat(230);
    const dir = join(home, '.claude', 'projects', claudeEscape(long).slice(0, CLAUDE_MAX_NAME) + '-h4sh');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '00000000-0000-4000-8000-000000000007.jsonl'), transcriptLines(long, 'long'));
    const { sessions } = await claudeAdapter({ sdk: devSdk }).sessions(
      { kind: 'claude', argv: [], env, cwd: long, procs: null as never, logger: () => {}, cursor: '' },
      sig(),
    );
    expect(sessions.map((s) => s.title)).toEqual(['long']);
  });
});
