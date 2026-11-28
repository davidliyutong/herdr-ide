import { describe, expect, test } from 'bun:test';
import { PassThrough, Readable } from 'node:stream';
import { formatRFC3339 } from '#shared/lib/gotime.ts';
import { EOFError, Reader } from '#shared/lib/streamio.ts';
import {
  By,
  Category,
  ChatProtoError,
  Code,
  CommandOp,
  CONFIG_SELECT,
  ERR_TOO_LARGE,
  EventType,
  MAX_EVENT,
  MAX_IMAGE,
  MAX_LINE,
  MAX_PROMPT,
  MAX_STDERR,
  Mode,
  MODES,
  Op,
  OptionKind,
  OutcomeKind,
  PermissionKind,
  PROTO,
  QueuedState,
  Reason,
  SOCKET_NAME,
  State,
  Status,
  TOOL_OUTPUT_END,
  TurnState,
  clampHostSettings,
  defaultHostSettings,
  errorText,
  line,
  newChatID,
  readLine,
  redactedChat,
  redactedEvent,
  startModels,
  skipLine,
  stateOf,
  statusOf,
  validChatID,
  withoutStderr,
  type Chat,
  type ChatError,
  type ChatState,
  type Command,
  type ConfigValue,
  type Event,
  type Hello,
  type HostSettings,
  type Question,
  type Request,
  type Response,
} from './index.ts';

/** v as its line without the newline. */
function oneLine(v: unknown): string {
  const s = line(v);
  if (!s.endsWith('\n') || s.split('\n').length !== 2) throw new Error(`not one line: ${JSON.stringify(s)}`);
  return s.slice(0, -1);
}

const at = formatRFC3339(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)));

/** A chat with every member set. */
function testChat(): Chat {
  return {
    id: 'c0123456789abcdef',
    kind: 'claude',
    title: 'Fix it',
    cwd: '/w',
    sessionId: 's1',
    state: State.Failed,
    status: Status.Done,
    error: { code: Code.StartFailed, message: 'exited', stderr: 'boom' },
    created: at,
    updated: at,
    seq: 7,
    seen: 5,
    closed: at,
    handedOff: true,
    agentVersion: '2.1.330',
    config: [
      {
        id: 'effort',
        name: 'Effort',
        description: 'd',
        category: Category.ThoughtLevel,
        type: CONFIG_SELECT,
        currentValue: 'low',
        options: [
          { value: 'low', name: 'Low', description: 'fast' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
    commands: [{ name: 'compact', description: 'Compact', argumentHint: '<what>' }],
    usage: {
      used: 10,
      size: 100,
      percentage: 12.5,
      cost: { amount: 0.5, currency: 'USD' },
      limits: [{ id: 'five_hour', label: '5h', usedPercent: 40, resetsAt: 1700000000, windowMinutes: 300 }],
    },
    capabilities: { images: true, compact: true, queue: true, plan: true, questions: true, effort: true, model: true, cancelQueued: true },
  };
}

const chatJSON =
  '{"id":"c0123456789abcdef","kind":"claude","title":"Fix it","cwd":"/w","sessionId":"s1","state":"failed","status":"done",' +
  '"error":{"code":"start_failed","message":"exited","stderr":"boom"},' +
  '"created":"2026-01-02T03:04:05.006Z","updated":"2026-01-02T03:04:05.006Z","seq":7,"seen":5,"closed":"2026-01-02T03:04:05.006Z",' +
  '"handedOff":true,"agentVersion":"2.1.330",' +
  '"config":[{"id":"effort","name":"Effort","description":"d","category":"thought_level","type":"select","currentValue":"low",' +
  '"options":[{"value":"low","name":"Low","description":"fast"},{"value":"high","name":"High"}]}],' +
  '"commands":[{"name":"compact","description":"Compact","argumentHint":"<what>"}],' +
  '"usage":{"used":10,"size":100,"percentage":12.5,"cost":{"amount":0.5,"currency":"USD"},' +
  '"limits":[{"id":"five_hour","label":"5h","usedPercent":40,"resetsAt":1700000000,"windowMinutes":300}]},' +
  '"capabilities":{"images":true,"compact":true,"queue":true,"plan":true,"questions":true,"effort":true,"model":true,"cancelQueued":true}}';

/** A Reader over pieces of size bytes that come one after the other, the
 * stream holding at most about one piece ahead. */
function pieces(s: string | Buffer, size: number): Reader {
  const all = Buffer.from(s);
  const parts: Buffer[] = [];
  for (let i = 0; i < all.length; i += size) parts.push(all.subarray(i, i + size));
  return new Reader(Readable.from(parts, { objectMode: false, highWaterMark: size }));
}

/** The bytes up to and including the next newline, read one by one so that
 * those after it stay in the Reader. */
async function restOfLine(r: Reader): Promise<string> {
  let s = '';
  for (;;) {
    const b = await r.chunk(1);
    if (b === null) throw new EOFError(true);
    s += b.toString('latin1');
    if (s.endsWith('\n')) return s;
  }
}

const trim = (s: string, chars: string) => s.replace(new RegExp(`^[${chars}]+|[${chars}]+$`, 'g'), '');

describe('chatproto', () => {
  // The names on the wire are the protocol: clients in other languages read
  // them (web/src/plugins/chat/protocol.ts).
  test('wire names', () => {
    const chat = testChat();
    const state = stateOf(chat);
    const stateJSON =
      '{"id":"c0123456789abcdef","kind":"claude","title":"Fix it","cwd":"/w","state":"failed","status":"done",' +
      '"updated":"2026-01-02T03:04:05.006Z","seq":7,"seen":5,"unread":true,"sessionId":"s1"}';
    const settings: HostSettings = {
      idleStopMinutes: 30,
      maxLive: 8,
      maxChats: 500,
      retentionDays: 30,
      maxTotalBytes: 1 << 29,
      maxChatBytes: 1 << 26,
      defaultMode: Mode.Plan,
      allowFull: true,
    };
    const settingsJSON =
      '{"idleStopMinutes":30,"maxLive":8,"maxChats":500,"retentionDays":30,"maxTotalBytes":536870912,"maxChatBytes":67108864,"defaultMode":"plan","allowFull":true}';
    const minimal: Chat = {
      id: 'c1',
      kind: 'codex',
      title: '',
      cwd: '',
      sessionId: '',
      state: State.Starting,
      status: Status.Idle,
      created: at,
      updated: at,
      seq: 0,
      seen: 0,
      capabilities: {
        images: false,
        compact: false,
        queue: false,
        plan: false,
        questions: false,
        effort: false,
        model: false,
        cancelQueued: false,
      },
    };
    const minimalJSON =
      '{"id":"c1","kind":"codex","title":"","cwd":"","sessionId":"","state":"starting","status":"idle",' +
      '"created":"2026-01-02T03:04:05.006Z","updated":"2026-01-02T03:04:05.006Z","seq":0,"seen":0,' +
      '"capabilities":{"images":false,"compact":false,"queue":false,"plan":false,"questions":false,"effort":false,"model":false,"cancelQueued":false}}';
    const question: Question = {
      id: 'q1',
      header: 'Color',
      question: 'Which?',
      multiSelect: true,
      allowOther: true,
      secret: true,
      options: [{ label: 'red', description: 'warm', preview: '# red' }, { label: 'blue' }],
    };
    const questionJSON =
      '{"id":"q1","header":"Color","question":"Which?","multiSelect":true,"allowOther":true,"secret":true,' +
      '"options":[{"label":"red","description":"warm","preview":"# red"},{"label":"blue"}]}';

    const cases: [string, unknown, string][] = [
      ['hello', { host: { proto: PROTO, version: 'v1', pid: 42 } } satisfies Hello, '{"host":{"proto":2,"version":"v1","pid":42}}'],
      ['agents', { op: Op.Agents, kinds: ['claude', 'kimi'] } satisfies Request, '{"op":"agents","kinds":["claude","kimi"]}'],
      ['chats', { op: Op.Chats } satisfies Request, '{"op":"chats"}'],
      [
        'new',
        {
          op: Op.New,
          kind: 'claude',
          cwd: '/w',
          resume: 's0',
          import: true,
          options: { model: 'm', effort: 'low', mode: Mode.AcceptEdits },
        } satisfies Request,
        '{"op":"new","kind":"claude","cwd":"/w","resume":"s0","import":true,"options":{"model":"m","effort":"low","mode":"acceptEdits"}}',
      ],
      ['new with defaults', { op: Op.New, kind: 'codex', cwd: '/w' } satisfies Request, '{"op":"new","kind":"codex","cwd":"/w"}'],
      ['attach', { op: Op.Attach, chat: 'c1', from: 5 } satisfies Request, '{"op":"attach","chat":"c1","from":5}'],
      ['close', { op: Op.Close, chat: 'c1' } satisfies Request, '{"op":"close","chat":"c1"}'],
      ['delete', { op: Op.Delete, chat: 'c1' } satisfies Request, '{"op":"delete","chat":"c1"}'],
      [
        'sessions',
        { op: Op.Sessions, kind: 'kimi', cwd: '/w', cursor: 'x' } satisfies Request,
        '{"op":"sessions","kind":"kimi","cwd":"/w","cursor":"x"}',
      ],
      ['watch', { op: Op.Watch } satisfies Request, '{"op":"watch"}'],
      ['seen', { op: Op.Seen, chat: 'c1', seq: 9 } satisfies Request, '{"op":"seen","chat":"c1","seq":9}'],
      ['configure', { op: Op.Configure, settings } satisfies Request, '{"op":"configure","settings":' + settingsJSON + '}'],
      ['shutdown', { op: Op.Shutdown } satisfies Request, '{"op":"shutdown"}'],

      ['ok', { ok: true } satisfies Response, '{"ok":true}'],
      ['error', { error: { code: Code.Busy, message: 'm' } } satisfies Response, '{"error":{"code":"busy","message":"m"}}'],
      [
        'agents answer',
        {
          ok: true,
          agents: [
            { kind: 'claude', available: true, version: '2.1.330' },
            { kind: 'grok', available: false, reason: Reason.NotFound },
            { kind: 'gemini', available: false, reason: Reason.Unsupported },
          ],
        } satisfies Response,
        '{"ok":true,"agents":[{"kind":"claude","available":true,"version":"2.1.330"},{"kind":"grok","available":false,"reason":"not_found"},' +
          '{"kind":"gemini","available":false,"reason":"unsupported"}]}',
      ],
      // A list that is asked for is there when it is empty.
      ['no chats', { ok: true, chats: [] } satisfies Response, '{"ok":true,"chats":[]}'],
      ['no states', { ok: true, states: [] } satisfies Response, '{"ok":true,"states":[]}'],
      ['chats answer', { ok: true, chats: [minimal] } satisfies Response, '{"ok":true,"chats":[' + minimalJSON + ']}'],
      ['attach answer', { ok: true, chat, first: 3 } satisfies Response, '{"ok":true,"chat":' + chatJSON + ',"first":3}'],
      [
        'sessions answer',
        {
          ok: true,
          sessions: [
            { sessionId: 's', cwd: '/w', title: 'T', updatedAt: at, chat: 'c1' },
            { sessionId: 't', cwd: '/w' },
          ],
          nextCursor: 'n',
        } satisfies Response,
        '{"ok":true,"sessions":[{"sessionId":"s","cwd":"/w","title":"T","updatedAt":"2026-01-02T03:04:05.006Z","chat":"c1"},{"sessionId":"t","cwd":"/w"}],"nextCursor":"n"}',
      ],
      ['watch answer', { ok: true, states: [state] } satisfies Response, '{"ok":true,"states":[' + stateJSON + ']}'],
      ['chat state', state satisfies ChatState, stateJSON],

      [
        'prompt',
        {
          op: CommandOp.Prompt,
          id: 'k1',
          content: [
            { type: 'text', text: '<hi>' },
            { type: 'image', mimeType: 'image/png', data: 'AA==' },
            { type: 'resource_link', uri: 'file:///w/a.go', name: 'a.go' },
          ],
          clientId: 'm1',
        } satisfies Command,
        '{"op":"prompt","id":"k1","content":[{"type":"text","text":"<hi>"},{"type":"image","mimeType":"image/png","data":"AA=="},' +
          '{"type":"resource_link","uri":"file:///w/a.go","name":"a.go"}],"clientId":"m1"}',
      ],
      ['cancel', { op: CommandOp.Cancel, id: 'k2' } satisfies Command, '{"op":"cancel","id":"k2"}'],
      [
        'permission',
        { op: CommandOp.Permission, id: 'k3', request: 'p1', option: 'allow_once' } satisfies Command,
        '{"op":"permission","id":"k3","request":"p1","option":"allow_once"}',
      ],
      [
        'permission cancelled',
        { op: CommandOp.Permission, id: 'k3', request: 'p1', cancelled: true } satisfies Command,
        '{"op":"permission","id":"k3","request":"p1","cancelled":true}',
      ],
      [
        'answer',
        { op: CommandOp.Answer, id: 'k4', request: 'q', answers: { q1: ['red', 'my own'] } } satisfies Command,
        '{"op":"answer","id":"k4","request":"q","answers":{"q1":["red","my own"]}}',
      ],
      [
        'answer skipped',
        { op: CommandOp.Answer, id: 'k4', request: 'q', cancelled: true } satisfies Command,
        '{"op":"answer","id":"k4","request":"q","cancelled":true}',
      ],
      [
        'set_config',
        { op: CommandOp.SetConfig, id: 'k5', config: 'model', value: 'big' } satisfies Command,
        '{"op":"set_config","id":"k5","config":"model","value":"big"}',
      ],
      [
        'cancel_queued',
        { op: CommandOp.CancelQueued, id: 'k6', message: 'q7' } satisfies Command,
        '{"op":"cancel_queued","id":"k6","message":"q7"}',
      ],
      ['compact', { op: CommandOp.Compact, id: 'k7' } satisfies Command, '{"op":"compact","id":"k7"}'],
      ['rename', { op: CommandOp.Rename, id: 'k8', title: 'New' } satisfies Command, '{"op":"rename","id":"k8","title":"New"}'],
      ['handoff', { op: CommandOp.Handoff, id: 'k9' } satisfies Command, '{"op":"handoff","id":"k9"}'],
      [
        'steer_queued',
        { op: CommandOp.SteerQueued, id: 'k10', message: 'm1', delivery: 'interrupt' } satisfies Command,
        '{"op":"steer_queued","id":"k10","message":"m1","delivery":"interrupt"}',
      ],
      ['stop_task', { op: CommandOp.StopTask, id: 'k11', task: 'bg-1' } satisfies Command, '{"op":"stop_task","id":"k11","task":"bg-1"}'],
      [
        'rewind',
        { op: CommandOp.Rewind, id: 'k12', seq: 4, restoreFiles: true, content: [{ type: 'text', text: 'edited' }] } satisfies Command,
        '{"op":"rewind","id":"k12","seq":4,"restoreFiles":true,"content":[{"type":"text","text":"edited"}]}',
      ],
      ['models', { op: Op.Models, kind: 'claude', refresh: true } satisfies Request, '{"op":"models","kind":"claude","refresh":true}'],
      [
        'fork',
        { op: Op.Fork, chat: 'c1', upToSeq: 5, title: 'Branch' } satisfies Request,
        '{"op":"fork","chat":"c1","upToSeq":5,"title":"Branch"}',
      ],
      [
        'switch',
        { op: Op.Switch, chat: 'c1', targetKind: 'codex', upToSeq: 5 } satisfies Request,
        '{"op":"switch","chat":"c1","targetKind":"codex","upToSeq":5}',
      ],
      ['export', { op: Op.Export, chat: 'c1' } satisfies Request, '{"op":"export","chat":"c1"}'],
      ['reset', { t: EventType.Reset, seq: 3 } satisfies Event, '{"t":"reset","seq":3}'],
      ['trust', { op: Op.Trust, cwd: '/w' } satisfies Request, '{"op":"trust","cwd":"/w"}'],
      [
        'attach without catch-up',
        { op: Op.Attach, chat: 'c1', from: 3, noCatchUp: true } satisfies Request,
        '{"op":"attach","chat":"c1","from":3,"noCatchUp":true}',
      ],
      ['full value', { value: 'yolo', name: 'YOLO', full: true } satisfies ConfigValue, '{"value":"yolo","name":"YOLO","full":true}'],

      ['ack', { t: EventType.Ack, id: 'k1' } satisfies Event, '{"t":"ack","id":"k1"}'],
      [
        'ack error',
        { t: EventType.Ack, id: 'k1', error: { code: Code.InTerminal, message: 'm' } } satisfies Event,
        '{"t":"ack","id":"k1","error":{"code":"in_terminal","message":"m"}}',
      ],
      [
        'update',
        {
          seq: 1,
          t: EventType.Update,
          at,
          item: 'msg_1',
          parent: 'toolu_1',
          update: { sessionUpdate: 'agent_message_chunk' },
        } satisfies Event,
        '{"seq":1,"t":"update","at":"2026-01-02T03:04:05.006Z","item":"msg_1","parent":"toolu_1","update":{"sessionUpdate":"agent_message_chunk"}}',
      ],
      [
        'live update',
        { t: EventType.Update, live: true, item: 'msg_1', update: { sessionUpdate: 'agent_message_chunk' } } satisfies Event,
        '{"t":"update","live":true,"item":"msg_1","update":{"sessionUpdate":"agent_message_chunk"}}',
      ],
      [
        'user',
        { seq: 2, t: EventType.User, at, content: [{ type: 'text', text: 'hi' }], clientId: 'm1' } satisfies Event,
        '{"seq":2,"t":"user","at":"2026-01-02T03:04:05.006Z","content":[{"type":"text","text":"hi"}],"clientId":"m1"}',
      ],
      [
        'turn start',
        { seq: 3, t: EventType.Turn, at, state: TurnState.Start } satisfies Event,
        '{"seq":3,"t":"turn","at":"2026-01-02T03:04:05.006Z","state":"start"}',
      ],
      [
        'turn end',
        { seq: 4, t: EventType.Turn, at, state: TurnState.End, stopReason: 'end_turn' } satisfies Event,
        '{"seq":4,"t":"turn","at":"2026-01-02T03:04:05.006Z","state":"end","stopReason":"end_turn"}',
      ],
      [
        'turn error',
        { seq: 5, t: EventType.Turn, at, state: TurnState.Error, error: { code: Code.Failed, message: 'm' } } satisfies Event,
        '{"seq":5,"t":"turn","at":"2026-01-02T03:04:05.006Z","state":"error","error":{"code":"failed","message":"m"}}',
      ],
      [
        'permission event',
        {
          seq: 6,
          t: EventType.Permission,
          at,
          id: 'p1',
          parent: 'toolu_9',
          kind: PermissionKind.Command,
          toolCall: { toolCallId: 't' },
          options: [
            { optionId: 'allow_once', name: 'Allow', kind: OptionKind.AllowOnce },
            { optionId: 'reject_once', name: 'Reject', kind: OptionKind.RejectOnce },
          ],
        } satisfies Event,
        '{"seq":6,"t":"permission","at":"2026-01-02T03:04:05.006Z","id":"p1","parent":"toolu_9","kind":"command","toolCall":{"toolCallId":"t"},' +
          '"options":[{"optionId":"allow_once","name":"Allow","kind":"allow_once"},{"optionId":"reject_once","name":"Reject","kind":"reject_once"}]}',
      ],
      [
        'permission_done',
        {
          seq: 7,
          t: EventType.PermissionDone,
          at,
          id: 'p1',
          outcome: { outcome: OutcomeKind.Selected, optionId: 'allow' },
          by: By.User,
        } satisfies Event,
        '{"seq":7,"t":"permission_done","at":"2026-01-02T03:04:05.006Z","id":"p1","outcome":{"outcome":"selected","optionId":"allow"},"by":"user"}',
      ],
      [
        'permission_done cancelled',
        { seq: 7, t: EventType.PermissionDone, at, id: 'p1', outcome: { outcome: OutcomeKind.Cancelled }, by: By.Cancel } satisfies Event,
        '{"seq":7,"t":"permission_done","at":"2026-01-02T03:04:05.006Z","id":"p1","outcome":{"outcome":"cancelled"},"by":"cancel"}',
      ],
      [
        'question',
        { seq: 8, t: EventType.Question, at, id: 'q', questions: [question] } satisfies Event,
        '{"seq":8,"t":"question","at":"2026-01-02T03:04:05.006Z","id":"q","questions":[' + questionJSON + ']}',
      ],
      [
        'question_done',
        { seq: 9, t: EventType.QuestionDone, at, id: 'q', by: By.User, answers: { q1: ['red'] } } satisfies Event,
        '{"seq":9,"t":"question_done","at":"2026-01-02T03:04:05.006Z","id":"q","by":"user","answers":{"q1":["red"]}}',
      ],
      [
        'queued',
        {
          seq: 10,
          t: EventType.Queued,
          at,
          content: [{ type: 'text', text: 'also' }],
          clientId: 'm2',
          message: 'q7',
          state: QueuedState.Waiting,
        } satisfies Event,
        '{"seq":10,"t":"queued","at":"2026-01-02T03:04:05.006Z","content":[{"type":"text","text":"also"}],"clientId":"m2","message":"q7","state":"queued"}',
      ],
      [
        'queued taken',
        { seq: 11, t: EventType.Queued, message: 'q7', state: QueuedState.Taken } satisfies Event,
        '{"seq":11,"t":"queued","message":"q7","state":"taken"}',
      ],
      [
        'state',
        { seq: 12, t: EventType.State, at, state: State.Sleeping } satisfies Event,
        '{"seq":12,"t":"state","at":"2026-01-02T03:04:05.006Z","state":"sleeping"}',
      ],
      [
        'info',
        { seq: 13, t: EventType.Info, at, chat } satisfies Event,
        '{"seq":13,"t":"info","at":"2026-01-02T03:04:05.006Z","chat":' + chatJSON + '}',
      ],
      [
        'notice',
        { seq: 14, t: EventType.Notice, at, method: '_x/y', params: { a: 1 } } satisfies Event,
        '{"seq":14,"t":"notice","at":"2026-01-02T03:04:05.006Z","method":"_x/y","params":{"a":1}}',
      ],
    ];
    for (const [name, v, want] of cases) expect([name, oneLine(v)]).toEqual([name, want]);
  });

  // What is written is read back the same, and members this version does
  // not know are passed over: a newer host or client may add them.
  test('round trip and unknown members', () => {
    for (const [name, json] of [
      ['chat', chatJSON],
      [
        'event',
        '{"seq":6,"t":"permission","at":"2026-01-02T03:04:05.006Z","id":"p1","live":true,"item":"i","parent":"t","update":{"x":[1,2]},' +
          '"content":[{"type":"text","text":"a"}],"clientId":"m","message":"q","state":"queued","stopReason":"end_turn",' +
          '"error":{"code":"failed","message":"m"},"kind":"plan","toolCall":{"toolCallId":"t"},"options":[{"optionId":"plan:default","name":"Yes","kind":"allow_once"}],' +
          '"outcome":{"outcome":"selected","optionId":"plan:default"},"by":"user","questions":[{"id":"q","question":"?"}],"answers":{"q":["a"]},' +
          '"method":"_m","params":{"p":true}}',
      ],
      [
        'request',
        '{"op":"new","kinds":["a"],"kind":"claude","cwd":"/w","resume":"s","import":true,"options":{"model":"m","effort":"e","mode":"plan"},' +
          '"chat":"c","from":1,"seq":2,"cursor":"x","settings":{"idleStopMinutes":5,"maxLive":1,"maxChats":50,"retentionDays":1,' +
          '"maxTotalBytes":67108864,"maxChatBytes":8388608,"defaultMode":"full"}}',
      ],
      [
        'command',
        '{"op":"answer","id":"k","content":[{"type":"text","text":"a"}],"clientId":"m","request":"r","option":"o",' +
          '"answers":{"q":["a","b"]},"cancelled":true,"config":"c","value":"v","message":"q","title":"t"}',
      ],
    ]) {
      expect([name, oneLine(JSON.parse(json))]).toEqual([name, json]);
    }

    const ev = JSON.parse('{"seq":3,"t":"turn","state":"end","future":{"a":1},"z":[1]}') as Event;
    expect([ev.seq, ev.t, ev.state, ev.error, ev.chat]).toEqual([3, EventType.Turn, TurnState.End, undefined, undefined]);
    const resp = JSON.parse(
      '{"ok":true,"chats":[{"id":"c1","kind":"k","capabilities":{"images":true,"teleport":true},"later":1}],"more":2}',
    ) as Response;
    expect(resp.ok).toBe(true);
    expect(resp.chats?.length).toBe(1);
    expect(resp.chats?.[0].id).toBe('c1');
    expect(resp.chats?.[0].capabilities.images).toBe(true);
  });

  test('constants', () => {
    expect([PROTO, MAX_LINE, MAX_PROMPT, MAX_IMAGE, MAX_EVENT, TOOL_OUTPUT_END, SOCKET_NAME, MAX_STDERR]).toEqual([
      2,
      16 << 20,
      8 << 20,
      5 << 20,
      1 << 20,
      16 << 10,
      'chat.sock',
      2 << 10,
    ]);
    expect(Object.values(Code).join(' ')).toBe(
      'bad_request unknown_chat too_many busy probe_busy not_found start_failed protocol auth_required unsupported too_large ended failed in_terminal handed_off sleeping not_allowed unsafe_folder sdk_unavailable',
    );
    const states = [State.Starting, State.Idle, State.Working, State.Waiting, State.Sleeping, State.Failed, State.Closed];
    expect(states.join(' ')).toBe('starting idle working waiting sleeping failed closed');
    expect(State.Deleted).toBe('deleted');
    expect(Object.values(Status).join(' ')).toBe('working blocked done idle');
    expect(Object.values(PermissionKind).join(' ')).toBe('tool command file plan mcp other');
    expect(MODES.join(' ')).toBe('default acceptEdits plan full');
    expect(Object.values(Op).join(' ')).toBe(
      'agents chats new attach close delete archive unarchive sessions watch seen configure shutdown trust untrust trusted host_status models fork switch export',
    );
    expect(Object.values(CommandOp).join(' ')).toBe(
      'prompt cancel permission answer set_config cancel_queued steer_queued compact rename handoff stop_task rewind',
    );
    expect(Object.values(EventType).join(' ')).toBe(
      'update user turn permission permission_done question question_done queued state info notice ack reset',
    );
    expect(errorText({ code: Code.Busy, message: 'a turn runs' })).toBe('busy: a turn runs');
  });

  // A thrown ChatError reads as Go's Error() and writes as the wire's.
  test('a thrown error', () => {
    const e = new ChatProtoError({ code: Code.Busy, message: 'a turn runs' });
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('busy: a turn runs');
    expect(e.code).toBe(Code.Busy);
    expect(oneLine({ ok: false, error: e })).toBe('{"ok":false,"error":{"code":"busy","message":"a turn runs"}}');
  });

  // A chat's status follows its state, then whether a turn ended after
  // what the user saw.
  test('statusOf', () => {
    for (const [state, turnEnd, seen, want] of [
      [State.Working, 9, 3, Status.Working],
      [State.Working, 0, 0, Status.Working],
      [State.Waiting, 9, 3, Status.Blocked],
      [State.Idle, 9, 3, Status.Done],
      [State.Sleeping, 9, 3, Status.Done],
      [State.Failed, 9, 3, Status.Done],
      [State.Idle, 9, 9, Status.Idle],
      [State.Idle, 9, 12, Status.Idle],
      [State.Idle, 0, 0, Status.Idle],
      [State.Starting, 0, 0, Status.Idle],
      [State.Closed, 4, 4, Status.Idle],
    ] as const) {
      expect([state, turnEnd, seen, statusOf(state, turnEnd, seen)]).toEqual([state, turnEnd, seen, want]);
    }
    const c = testChat();
    const s = stateOf(c);
    expect([s.id, s.status, s.seq, s.sessionId, s.updated]).toEqual([c.id, c.status, c.seq, c.sessionId, c.updated]);
  });

  // stateOf leaves out what Go leaves out when empty, and tells an archived
  // chat.
  test('stateOf leaves out empty members', () => {
    const c: Chat = { ...testChat(), status: Status.Idle, seen: 0, archived: at };
    expect(oneLine(stateOf(c))).toBe(
      '{"id":"c0123456789abcdef","kind":"claude","title":"Fix it","cwd":"/w","state":"failed","status":"idle",' +
        '"updated":"2026-01-02T03:04:05.006Z","seq":7,"sessionId":"s1","archived":true}',
    );
  });

  test('chat ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = newChatID();
      expect(validChatID(id)).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    for (const bad of [
      '',
      'c',
      'c0123456789abcde',
      'c0123456789abcdef0',
      'C0123456789abcdef',
      'c0123456789ABCDEF',
      'd0123456789abcdef',
      'c0123456789abcdeg',
      'c0123456789abcdef\n',
      ' c0123456789abcdef',
      '../c0123456789abcd',
      'c0123456789abc/ef',
    ]) {
      expect([bad, validChatID(bad)]).toEqual([bad, false]);
    }
  });

  // clampHostSettings gives a member left out its default and keeps every
  // member within its bounds whatever is asked.
  test('clamp', () => {
    const mib = 1 << 20;
    expect(defaultHostSettings()).toEqual({
      idleStopMinutes: 30,
      maxLive: 8,
      maxChats: 500,
      retentionDays: 30,
      maxTotalBytes: 512 * mib,
      maxChatBytes: 64 * mib,
      defaultMode: Mode.Default,
    });
    expect(
      clampHostSettings({
        idleStopMinutes: -1,
        maxLive: -5,
        maxChats: 1,
        retentionDays: -30,
        maxTotalBytes: 1,
        maxChatBytes: -1,
        defaultMode: 'bypassPermissions',
      }),
    ).toEqual({
      idleStopMinutes: 5,
      maxLive: 1,
      maxChats: 50,
      retentionDays: 1,
      maxTotalBytes: 64 * mib,
      maxChatBytes: 8 * mib,
      defaultMode: Mode.Default,
    });
    expect(
      clampHostSettings({
        idleStopMinutes: 2 ** 30,
        maxLive: 1000,
        maxChats: 2 ** 20,
        retentionDays: 100000,
        maxTotalBytes: 2 ** 50,
        maxChatBytes: 2 ** 40,
        defaultMode: Mode.Full,
        allowFull: true,
      }),
    ).toEqual({
      idleStopMinutes: 1440,
      maxLive: 32,
      maxChats: 2000,
      retentionDays: 365,
      maxTotalBytes: 2048 * mib,
      maxChatBytes: 256 * mib,
      defaultMode: Mode.Full,
      allowFull: true,
    });
    // Full access as the default only where it is allowed.
    const full = clampHostSettings({ defaultMode: Mode.Full });
    expect([full.defaultMode, full.allowFull]).toEqual([Mode.Default, undefined]);
    expect('allowFull' in full).toBe(false);
    const within = {
      idleStopMinutes: 60,
      maxLive: 2,
      maxChats: 100,
      retentionDays: 7,
      maxTotalBytes: 100 * mib,
      maxChatBytes: 10 * mib,
      defaultMode: Mode.AcceptEdits,
    };
    expect(clampHostSettings(within)).toEqual(within);
    expect(clampHostSettings(clampHostSettings(within))).toEqual(clampHostSettings(within));
    // Settings read from JSON are not checked: what is no number counts as
    // left out, and the result has whole numbers.
    const junk = JSON.parse(
      '{"idleStopMinutes":"60","maxLive":null,"maxChats":100.7,"retentionDays":true,"maxTotalBytes":-0.5,"defaultMode":7,"allowFull":"yes"}',
    ) as HostSettings;
    expect(clampHostSettings(junk)).toEqual({ ...defaultHostSettings(), maxChats: 100, maxTotalBytes: 64 * mib });
    expect(clampHostSettings({ maxLive: NaN }).maxLive).toBe(8);
  });

  // Raw JSON goes on one line, whatever it holds.
  test('line keeps raw on one line', () => {
    const ev: Event = { seq: 1, t: EventType.Update, update: { text: 'a<b>&c\nd' } };
    expect(oneLine(ev)).toBe('{"seq":1,"t":"update","update":{"text":"a<b>&c\\nd"}}');
    // As Go writes them: the line separators escaped, members left undefined
    // left out.
    expect(oneLine({ t: EventType.Update, item: undefined, update: { text: 'a\u2028b\u2029' } })).toBe(
      '{"t":"update","update":{"text":"a\\u2028b\\u2029"}}',
    );
    // What JSON cannot hold is not written.
    const cyclic: Record<string, unknown> = { t: EventType.Update };
    cyclic.update = cyclic;
    expect(() => line(cyclic)).toThrow();
    expect(() => line({ t: EventType.Update, update: 1n })).toThrow();
    expect(() => line(undefined)).toThrow('chatproto: no JSON for undefined');
  });

  test('readLine', async () => {
    const r = pieces('{"a":1}\n\n' + 'x'.repeat(100) + '\nrest', 16);
    for (const want of ['{"a":1}', '', 'x'.repeat(100)]) expect((await readLine(r)).toString()).toBe(want);
    // What has no newline before the end is no line.
    await expect(readLine(r)).rejects.toBeInstanceOf(EOFError);
    // The bytes after a line stay in the Reader, for whoever reads on.
    const p = new PassThrough();
    p.end('{"op":"watch"}\nRAW\xff');
    const r2 = new Reader(p);
    expect(JSON.parse((await readLine(r2)).toString())).toEqual({ op: Op.Watch });
    expect((await r2.chunk())?.toString()).toBe('RAW\xff');
    // A line is bytes: a character split between two pieces is whole in it.
    const r3 = pieces('{"text":"héllo wörld ✓"}\n', 3);
    expect(JSON.parse((await readLine(r3)).toString())).toEqual({ text: 'héllo wörld ✓' });
    await expect(readLine(pieces('', 1))).rejects.toBeInstanceOf(EOFError);
  });

  test('readLine limit', async () => {
    const limit = 1000;
    const exact = 'a'.repeat(limit);
    const r = pieces(exact + '\n' + exact + 'b\nnext\n', 64);
    expect((await readLine(r, limit)).toString()).toBe(exact);
    await expect(readLine(r, limit)).rejects.toBe(ERR_TOO_LARGE);
    // The line's end is still to be read, wherever the limit was met.
    expect(trim(await restOfLine(r), 'ab')).toBe('\n');
    expect((await readLine(r, limit)).toString()).toBe('next');
    for (const size of [63, 64, 65, 127, 128, 129, 200]) {
      // The limit met in the piece with the newline, and before it.
      for (const piece of [64, 7, 1000]) {
        const r = pieces('a'.repeat(size) + '\nnext\n', piece);
        let err: unknown;
        await readLine(r, 60).catch((e) => (err = e));
        expect([size, piece, err]).toEqual([size, piece, ERR_TOO_LARGE]);
        expect(trim(await restOfLine(r), 'a')).toBe('\n');
        expect((await readLine(r, 60)).toString()).toBe('next');
      }
    }

    // A line without an end is given up at the limit, not read for ever.
    let n = 0;
    const endless = new Readable({
      highWaterMark: 64,
      read() {
        n += 64;
        this.push(Buffer.alloc(64, 'x'));
      },
    });
    let err: unknown;
    await readLine(new Reader(endless), limit).catch((e) => (err = e));
    expect(err).toBe(ERR_TOO_LARGE);
    expect(n).toBeLessThanOrEqual(2 * limit);
    endless.destroy();

    // readLine's own limit is MAX_LINE.
    const big = 'y'.repeat(MAX_LINE);
    const p = new PassThrough();
    p.end(big + '\n' + big + 'z\n');
    const rb = new Reader(p);
    expect((await readLine(rb)).length).toBe(MAX_LINE);
    await expect(readLine(rb)).rejects.toBe(ERR_TOO_LARGE);
  });

  // skipLine passes over what is left of a line, its newline too, and
  // leaves the next one.
  test('skipLine', async () => {
    const r = pieces('a'.repeat(300) + '\nnext\n' + 'b'.repeat(50) + '\nlast\nend', 16);
    await expect(readLine(r, 100)).rejects.toBe(ERR_TOO_LARGE);
    expect(await skipLine(r)).toBe(true);
    expect((await readLine(r, 100)).toString()).toBe('next');
    // Within max bytes, else false with the rest still to be read.
    expect(await skipLine(r, 10)).toBe(false);
    expect(await skipLine(r, 100)).toBe(true);
    expect((await readLine(r)).toString()).toBe('last');
    await expect(skipLine(r)).rejects.toBeInstanceOf(EOFError);
  });

  // The redacted copies leave the agent's standard error out of an event,
  // of its chat and of a chat, and change nothing else; what they were
  // given stays.
  test('redacted', () => {
    const chat = testChat();
    const ev: Event = { seq: 1, t: EventType.Info, error: { code: Code.Ended, message: 'm', stderr: 'secret' }, chat };
    const r = redactedEvent(ev);
    expect([r.error?.stderr, r.chat?.error?.stderr, r.error?.message, r.chat?.error?.code, r.chat?.title]).toEqual([
      undefined,
      undefined,
      'm',
      Code.StartFailed,
      'Fix it',
    ]);
    expect(oneLine(r)).toBe(oneLine(ev).replace(',"stderr":"secret"', '').replace(',"stderr":"boom"', ''));
    expect([ev.error?.stderr, chat.error?.stderr]).toEqual(['secret', 'boom']);
    const c = redactedChat(chat);
    expect([c.error?.stderr, chat.error?.stderr]).toEqual([undefined, 'boom']);
    const plain: ChatError = { code: Code.Failed, message: 'm' };
    expect(withoutStderr(plain)).toBe(plain);
    expect(withoutStderr(undefined)).toBeUndefined();
    const none = redactedEvent({ t: EventType.State });
    expect([none.error, none.chat, 'error' in none, 'chat' in none]).toEqual([undefined, undefined, false, false]);
  });
});

test("a new chat's models: Options.model, then Options.models, without repeats or empty values", () => {
  expect(startModels({})).toEqual([]);
  expect(startModels({ model: 'a' })).toEqual(['a']);
  expect(startModels({ model: 'b', models: ['a', 'b', '', 'c'] })).toEqual(['b', 'a', 'c']);
  expect(startModels({ models: ['a'] })).toEqual(['a']);
});
