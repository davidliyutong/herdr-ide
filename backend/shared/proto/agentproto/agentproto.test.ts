import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { SLUG } from '#shared/lib/brand.ts';
import { formatRFC3339 } from '#shared/lib/gotime.ts';
import { Reader } from '#shared/lib/streamio.ts';
import {
  CHAT_HOST_NAME,
  ChunkReader,
  ChunkWriter,
  GUIEnc,
  GUIMessage,
  HIDDEN_CHAT_HOST,
  HIDDEN_LABEL,
  MAX_BODY,
  Notice,
  Op,
  RESOLVE_OTHER_CWD,
  SessionFrom,
  Transcript,
  TranscriptLimits,
  Turn,
  chatHostFallbackName,
  hidden,
  hiddenValue,
  isChatHostName,
  marshalFrameHeader,
  newer,
  noticeMethod,
  olderVersion,
  parseFrameHeader,
  parseVersion,
  readBody,
  readGUI,
  readLine,
  validHistoryAdopt,
  validHistoryTerminal,
  writeGUI,
  type DetectEvent,
  type Header,
  type HistoryEntry,
  type Reply,
  type SessionUsage,
  type TranscriptEvent,
} from './index.ts';

const fromString = (s: string | Buffer) => {
  const p = new PassThrough();
  p.end(s);
  return new Reader(p);
};
const rest = async (r: Reader) => {
  let s = '';
  for (let b = await r.chunk(); b; b = await r.chunk()) s += b;
  return s;
};

describe('proto', () => {
  test('a line leaves the bytes after it', async () => {
    const r = fromString('{"op":"hc-api","path":"p"}\nRAW-BYTES');
    const h = await readLine<Header>(r);
    expect(h).toEqual({ op: Op.HCAPI, path: 'p' });
    expect(await rest(r)).toBe('RAW-BYTES');
  });

  test('chunks round trip over 1 MiB, a reply may follow', async () => {
    const payload = Buffer.from(`${SLUG}-`.repeat(300000));
    const p = new PassThrough();
    const cw = new ChunkWriter(p);
    const writing = (async () => {
      await cw.write(payload);
      await cw.finish();
      p.end('{"ok":true}\n');
    })();
    const r = new Reader(p);
    const got: Buffer[] = [];
    for await (const b of new ChunkReader(r)) got.push(b);
    await writing;
    expect(Buffer.concat(got).equals(payload)).toBe(true);
    expect((await readLine<Reply>(r)).ok).toBe(true);
  });

  test('a truncated chunk fails', async () => {
    const cr = new ChunkReader(fromString(Buffer.from([0, 0, 0, 10, 97, 98])));
    const read = async () => {
      for await (const _ of cr);
    };
    expect(read()).rejects.toThrow('unexpected EOF');
  });

  test('a body follows its line: read in full, bounded, the bytes after it left', async () => {
    const r = fromString('{"op":"plugin","params_length":7}\n{"a":1}REST');
    const h = await readLine<Header>(r);
    expect(h.params_length).toBe(7);
    expect(await readBody(r, h.params_length!)).toEqual({ a: 1 });
    expect(await rest(r)).toBe('REST');
    expect(readBody(fromString('{}'), 5)).rejects.toThrow();
    expect(readBody(fromString(''), MAX_BODY + 1)).rejects.toThrow('body of');
  });

  test('a bad line names itself', async () => {
    expect(readLine(fromString('not json\n'))).rejects.toThrow('agentproto: bad line "not json"');
  });

  test('versions', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3, 0]);
    expect(parseVersion('v1.2.3-4-gabc')).toEqual([1, 2, 3, 4]);
    expect(parseVersion('v1.2.3-4-gabc-dirty-20261125')).toEqual([1, 2, 3, 4]);
    expect(parseVersion('v1.2.3-dirty')).toEqual([1, 2, 3, 0]);
    expect(parseVersion('dev')).toBeNull();
    expect(parseVersion('v1.2')).toBeNull();
    expect(parseVersion('v1.2.3-4')).toBeNull();
    expect(parseVersion('v1.2.3-x-gabc')).toBeNull();
    expect(olderVersion('v1.2.3', 'v1.2.3-1-gabc')).toBe(true);
    expect(olderVersion('v1.10.0', 'v1.9.9')).toBe(false);
    expect(olderVersion('dev', 'v1.0.0')).toBe(false);
  });

  // A build is newer by its version when both are known, else by when its
  // executable was written.
  test('node build order', () => {
    const a = { build: 'a', version: 'v1.2.0', exe_time: 2 };
    const b = { build: 'b', version: 'v1.3.0', exe_time: 1 };
    const dev1 = { build: 'c', version: 'dev', exe_time: 1 };
    const dev2 = { build: 'd', version: 'dev', exe_time: 2 };
    expect([newer(b, a), newer(a, b), newer(dev2, dev1), newer(dev1, dev2), newer(a, a)]).toEqual([true, false, true, false, false]);
  });

  // The detect op's additions are absent while empty.
  test('detect sessions JSON', () => {
    const ev: DetectEvent = { terminal: 't1', agent: 'claude', status: 'idle' };
    expect(JSON.stringify(ev)).toBe('{"terminal":"t1","agent":"claude","status":"idle"}');
    expect(JSON.stringify({ op: Op.Detect } satisfies Header)).toBe('{"op":"detect"}');
    expect(JSON.stringify({ op: Op.Detect, sessions: true } satisfies Header)).toBe('{"op":"detect","sessions":true}');
    expect(Object.values(SessionFrom)).toEqual(['argv', 'pid', 'fd', 'start', 'hook', 'guess']);
  });
});

describe('hidden', () => {
  // The terminal core takes the chat host's name and the label: a name is 1
  // to 32 of a-z 0-9 - _ . starting with a letter or digit and not shaped
  // like an address (t7); a label's key is not empty and has no "=".
  test('names the terminal core takes', () => {
    const name = /^[a-z0-9][a-z0-9._-]{0,31}$/;
    expect(name.test(CHAT_HOST_NAME) && !/^t[0-9]+$/.test(CHAT_HOST_NAME)).toBe(true);
    expect((HIDDEN_LABEL as string) !== '' && !/[= ]/.test(HIDDEN_LABEL)).toBe(true);
    expect(hiddenValue(CHAT_HOST_NAME)).toBe(HIDDEN_CHAT_HOST);
    const fb = chatHostFallbackName(1);
    expect(name.test(fb) && isChatHostName(fb)).toBe(true);
    expect(hiddenValue(fb)).toBe(HIDDEN_CHAT_HOST);
    expect(hiddenValue('other')).toBe('other');
  });

  test('hidden needs the name and the label both', () => {
    const cases: [string, string, boolean][] = [
      [CHAT_HOST_NAME, HIDDEN_CHAT_HOST, true],
      [chatHostFallbackName(1), HIDDEN_CHAT_HOST, true],
      [chatHostFallbackName(1), '', false],
      [CHAT_HOST_NAME, '', false],
      [CHAT_HOST_NAME, 'other', false],
      ['', HIDDEN_CHAT_HOST, false],
      ['build', HIDDEN_CHAT_HOST, false],
      ['', '', false],
    ];
    for (const [name, value, want] of cases) expect(hidden(name, value)).toBe(want);
  });
});

describe('history', () => {
  test('restored only when set', () => {
    const e: HistoryEntry = { terminal: 't1', pid: 7, at: 1, lines: 0, bytes: 0, cols: 0, rows: 0 };
    expect(JSON.stringify(e)).not.toContain('restored');
    expect(JSON.parse(JSON.stringify({ ...e, restored: true }))).toMatchObject({ restored: true, pid: 7 });
  });

  test('terminal addresses', () => {
    const cases: Record<string, boolean> = {
      t1: true,
      T: true,
      '7': true,
      't-1_x': true,
      a_: true,
      ['a'.repeat(64)]: true,
      '': false,
      '-a': false,
      _a: false,
      '.a': false,
      'a.b': false,
      't1.prev': false,
      '..': false,
      'a/b': false,
      'a b': false,
      'a\n': false,
      '\x00': false,
      é: false,
      ['a'.repeat(65)]: false,
    };
    for (const [s, ok] of Object.entries(cases)) expect([s, validHistoryTerminal(s)]).toEqual([s, ok]);
  });

  test('adopt', () => {
    expect(validHistoryAdopt({ from: 't1', to: 't2' })).toBe(true);
    for (const p of [
      { from: 't1', to: 't1' },
      { from: '', to: 't2' },
      { from: 't1', to: '' },
      { from: '../t1', to: 't2' },
      { from: 't1', to: 't2.prev' },
    ])
      expect(validHistoryAdopt(p)).toBe(false);
  });
});

describe('transcript', () => {
  // The wire form of each type of event: the web UI's conversation view
  // reads these names.
  test('events', () => {
    const at = formatRFC3339(new Date(Date.UTC(2026, 10, 2, 9, 30, 0)));
    const cases: [TranscriptEvent, string][] = [
      [
        { t: Transcript.Update, at, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } } },
        '{"t":"update","at":"2026-11-02T09:30:00Z","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hi"}}}',
      ],
      [
        { t: Transcript.User, content: [{ type: 'text', text: 'a table, please' }] },
        '{"t":"user","content":[{"type":"text","text":"a table, please"}]}',
      ],
      [{ t: Transcript.Turn, state: Turn.End, stopReason: 'end_turn' }, '{"t":"turn","state":"end","stopReason":"end_turn"}'],
      [{ t: Transcript.Turn, state: Turn.Start }, '{"t":"turn","state":"start"}'],
      [
        { t: Transcript.Notice, method: noticeMethod(Notice.Compacted), params: { trigger: 'auto' } },
        `{"t":"notice","method":"_${SLUG}/compacted","params":{"trigger":"auto"}}`,
      ],
    ];
    for (const [ev, want] of cases) {
      expect(JSON.stringify(ev)).toBe(want);
      expect(JSON.stringify(JSON.parse(want))).toBe(want);
    }
  });

  test('times as Go writes them', () => {
    expect(formatRFC3339(new Date(Date.UTC(2026, 10, 2, 9, 30, 0, 120)))).toBe('2026-11-02T09:30:00.12Z');
    expect(formatRFC3339(new Date(Date.UTC(2026, 10, 2, 9, 30, 0, 7)))).toBe('2026-11-02T09:30:00.007Z');
  });

  test('messages', () => {
    expect(JSON.stringify({ ok: false, code: RESOLVE_OTHER_CWD })).toBe('{"ok":false,"code":"other_cwd"}');
    const u: SessionUsage = {
      model: 'm',
      input: 1,
      cached: 2,
      cacheWrite: 3,
      output: 4,
      reasoning: 1,
      requests: 5,
      cost: 0.25,
      priced: true,
      contextUsed: 900,
      contextSize: 200000,
    };
    expect(JSON.stringify(u)).toBe(
      '{"model":"m","input":1,"cached":2,"cacheWrite":3,"output":4,"reasoning":1,"requests":5,"cost":0.25,"priced":true,"contextUsed":900,"contextSize":200000}',
    );
    expect([TranscriptLimits.maxTextBytes, TranscriptLimits.maxToolOutput]).toEqual([256 << 10, 32 << 10]);
  });
});

describe('gui', () => {
  test('frame headers, as the Go program encodes them', () => {
    const h = { window: 0x01020304, layer: 7, x: -2, y: 300, w: 640, h: 480, enc: GUIEnc.JPEG, seq: 0xfffffffe };
    const b = marshalFrameHeader(h);
    expect(b.toString('hex')).toBe('0102030400000007fffe012c028001e001fffffffe');
    expect(parseFrameHeader(b)).toEqual(h);
    expect(() => parseFrameHeader(b.subarray(0, 20))).toThrow('short gui frame');
  });

  test('messages', async () => {
    const p = new PassThrough();
    await writeGUI(p, GUIMessage.JSON, Buffer.from('{"ev":"gone","id":3}'));
    await writeGUI(p, GUIMessage.Frame, Buffer.from([1, 2]), Buffer.from([3]));
    p.end();
    const r = new Reader(p);
    const m1 = await readGUI(r);
    expect([m1.kind, JSON.parse(m1.payload.toString())]).toEqual([1, { ev: 'gone', id: 3 }]);
    const m2 = await readGUI(r);
    expect([m2.kind, [...m2.payload]]).toEqual([2, [1, 2, 3]]);
  });
});
