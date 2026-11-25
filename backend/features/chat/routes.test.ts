import { afterEach, describe, expect, test } from 'bun:test';
import * as agentkinds from '#shared/agents/kinds.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { checkGuarded, type TestHub } from '#kernel/testing.ts';
import { hostSettings } from './settings.ts';
import { rig, testChat, type Rig, type RigOptions } from './testing.ts';

const rigs: Rig[] = [];
const start = async (o: RigOptions = {}) => {
  const r = await rig(o);
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.stop();
});

const m = (path: string) => `/api/m/gpu/p/chat/${path}`;
const kinds = agentkinds.chatKinds().map((k) => k.id);

describe('routes', () => {
  test('the routes, and the guards of those that change', async () => {
    const r = await start();
    const routes = r.core.http.app.routes
      .filter((x) => x.path.includes('/p/chat'))
      .map((x) => `${x.method} ${x.path}`)
      .filter((x, i, all) => all.indexOf(x) === i);
    expect(routes).toEqual([
      'GET /api/p/chat/hosts',
      'GET /api/p/chat/states',
      'GET /api/p/chat/ws',
      'GET /api/m/:id/p/chat/agents',
      'POST /api/m/:id/p/chat/agents',
      'GET /api/m/:id/p/chat/chats',
      'POST /api/m/:id/p/chat/sessions',
      'POST /api/m/:id/p/chat/new',
      'POST /api/m/:id/p/chat/close',
      'DELETE /api/m/:id/p/chat/chat',
      'POST /api/m/:id/p/chat/archive',
      'POST /api/m/:id/p/chat/unarchive',
      'POST /api/m/:id/p/chat/seen',
      'POST /api/m/:id/p/chat/handoff',
      'POST /api/m/:id/p/chat/trust',
      'POST /api/m/:id/p/chat/untrust',
      'GET /api/m/:id/p/chat/trusted',
      'POST /api/m/:id/p/chat/trusted',
      'POST /api/m/:id/p/chat/host/stop',
    ]);
    const ro = await start({ readOnly: true });
    const { problems, checked } = await checkGuarded(r as unknown as TestHub, ro as unknown as TestHub, { machine: 'gpu' });
    expect(problems).toEqual([]);
    expect(checked.length).toBe(13);
    // Off, every route answers plugin_disabled.
    r.settings.set('plugins.chat.enabled', '', false);
    expect(await r.call('GET', '/api/p/chat/states')).toEqual([404, { error: 'plugin_disabled', message: 'plugin_disabled' }]);
  });

  // Each route is one request of the machine's chat host, which a change
  // starts when none serves; what it takes is checked on the core first.
  test('requests', async () => {
    const r = await start();
    const f = r.host;
    f.running = false;
    f.agents.set('claude', true);
    f.sessions = [{ sessionId: '0c1d', cwd: '/w', title: 'earlier' }];

    // A GET finds no host and starts none.
    expect(await r.call('GET', m('agents'))).toMatchObject([409, { error: 'not_running' }]);
    expect(f.running).toBe(false);
    let [code, out] = await r.call('POST', m('agents'));
    expect(code).toBe(200);
    const agents = out.agents as Array<Record<string, unknown>>;
    expect(agents.map((a) => a.kind)).toEqual(kinds);
    expect(agents[0]).toEqual({ kind: 'claude', available: true });
    expect(f.opens).toEqual([false, true]);
    expect(f.requests[0].kinds).toEqual(kinds);
    expect(r.lastAudit()).toMatchObject({ event: 'chat.agents', plugin: 'chat', machine: 'gpu', status: 200 });
    [code, out] = await r.call('GET', m('agents'));
    expect([code, (out.agents as unknown[]).length]).toEqual([200, kinds.length]);

    [code, out] = await r.call('GET', m('chats'));
    expect([code, out]).toEqual([200, { chats: [] }]);

    for (const q of [
      'kind=bash&cwd=/w',
      'kind=claude&cwd=w',
      'kind=claude&cwd=/w/../x',
      'kind=claude&cwd=/w/',
      'kind=claude&cwd=/w&cursor=' + 'x'.repeat(4097),
    ])
      expect([q, ...(await r.call('POST', m('sessions?' + q)))]).toMatchObject([q, 400, { error: 'bad_request' }]);
    [code, out] = await r.call('POST', m('sessions?kind=codex&cwd=/w/x&cursor=c1'));
    expect([code, out]).toEqual([200, { sessions: [{ sessionId: '0c1d', cwd: '/w', title: 'earlier' }], nextCursor: 'next' }]);
    expect(r.lastAudit()).toMatchObject({ event: 'chat.sessions', kind: 'codex', cwd: '/w/x', status: 200 });
    expect(f.requests.at(-1)).toEqual({ op: 'sessions', kind: 'codex', cwd: '/w/x', cursor: 'c1' });
    // Listing sessions may run the agent: the host took the settings before.
    expect(f.requests.at(-2)?.op).toBe(chat.Op.Configure);

    for (const body of [
      '{',
      '{"kind":"bash","cwd":"/w"}',
      '{"kind":"claude","cwd":"rel"}',
      '{"kind":"claude","cwd":"/w","resume":"-x"}',
      '{"kind":"claude","cwd":"/w","import":true}',
      '{"kind":"claude","cwd":"/w","options":{"mode":"yolo"}}',
      '{"kind":"claude","cwd":"/w","options":{"model":"a\\nb"}}',
      `{"kind":"claude","cwd":"/w","pad":"${'x'.repeat(64 << 10)}"}`,
    ])
      expect([body.slice(0, 60), ...(await r.call('POST', m('new'), body))]).toMatchObject([
        body.slice(0, 60),
        400,
        { error: 'bad_request' },
      ]);
    // A host started again takes the settings anew before a new chat.
    f.pid = 2;
    let n = f.requests.length;
    [code, out] = await r.call(
      'POST',
      m('new'),
      '{"kind":"claude","cwd":"/w","resume":"5f0c","import":true,"options":{"model":"m","mode":"full"}}',
    );
    const c = out.chat as chat.Chat;
    expect(code).toBe(200);
    expect(chat.validChatID(c.id)).toBe(true);
    expect(f.requests[n]).toEqual({ op: 'configure', settings: hostSettings(r.settings, 'gpu') });
    expect(f.requests[n + 1]).toEqual({
      op: 'new',
      kind: 'claude',
      cwd: '/w',
      resume: '5f0c',
      import: true,
      options: { model: 'm', mode: 'full' },
    });
    expect(r.lastAudit()).toMatchObject({
      event: 'chat.new',
      kind: 'claude',
      cwd: '/w',
      resume: '5f0c',
      import: true,
      mode: 'full',
      chat: c.id,
    });
    n = f.requests.length;
    await r.call('POST', m('new'), '{"kind":"codex","cwd":"/w"}');
    expect(f.ops(n)).toEqual(['new']);
    // As the watch does.
    r.settings.onChange((ch) => r.board.settingsChanged(ch, AbortSignal.timeout(5000)));
    r.settings.set('chat.allowFullAccess', 'gpu', true);
    n = f.requests.length;
    await r.call('POST', m('new'), '{"kind":"codex","cwd":"/w"}');
    expect(f.ops(n)).toEqual(['configure', 'new']);
    expect(f.requests[n].settings?.allowFull).toBe(true);

    const id = c.id;
    for (const [method, path, op] of [
      ['POST', `close?chat=${id}`, 'close'],
      ['DELETE', `chat?chat=${id}`, 'delete'],
      ['POST', `archive?chat=${id}`, 'archive'],
      ['POST', `unarchive?chat=${id}`, 'unarchive'],
      ['POST', `seen?chat=${id}&seq=12`, 'seen'],
    ]) {
      expect(await r.call(method, m(path))).toEqual([200, {}]);
      expect(f.requests.at(-1)).toMatchObject({ op, chat: id });
      expect(r.lastAudit()).toMatchObject({ event: `chat.${op}`, chat: id, status: 200 });
    }
    expect(f.requests.at(-1)?.seq).toBe(12);
    expect(await r.call('POST', m('trust?cwd=/w/p'))).toEqual([200, {}]);
    expect(f.requests.at(-1)).toEqual({ op: 'trust', cwd: '/w/p' });
    expect(r.lastAudit()).toMatchObject({ event: 'chat.trust', cwd: '/w/p' });
    expect(await r.call('POST', m('untrust?cwd=/w/p'))).toEqual([200, {}]);
    expect(f.requests.at(-1)).toEqual({ op: 'untrust', cwd: '/w/p' });
    for (const path of [
      'close',
      'close?chat=x',
      `seen?chat=${id}`,
      `seen?chat=${id}&seq=-1`,
      'handoff?chat=C0123',
      'trust',
      'trust?cwd=rel',
      'trust?cwd=/a/../b',
      'untrust',
      'untrust?cwd=rel',
      'untrust?cwd=/a/../b',
    ])
      expect([path, (await r.call('POST', m(path)))[0]]).toEqual([path, 400]);
    expect((await r.call('DELETE', m('chat')))[0]).toBe(400);
  });

  // A GET route (which a browser sends without Origin from any page) never
  // starts the machine's chat host, nor does a read-only core: they answer
  // not_running; a read-only core asks no agent's program.
  test('a GET starts no host', async () => {
    const r = await start();
    r.host.running = false;
    for (const path of ['agents', 'chats']) expect(await r.call('GET', m(path))).toMatchObject([409, { error: 'not_running' }]);
    expect((await r.call('GET', '/api/p/chat/states'))[0]).toBe(200);
    expect([404, 405]).toContain((await r.call('GET', m('sessions?kind=codex&cwd=/w')))[0]);
    expect(r.host.opens).toEqual([false, false]);
    expect(r.host.running).toBe(false);
    expect(r.host.requests).toEqual([]);

    const ro = await start({ readOnly: true });
    expect(await ro.call('GET', m('agents'))).toMatchObject([403, { error: 'read_only' }]);
    expect(ro.host.opens).toEqual([]);
  });

  // A read-only core leaves out the agents' standard error, which may tell
  // what their environment holds, and starts no host.
  test('read-only redacts', async () => {
    const id = chat.newChatID();
    const failed = testChat({
      id,
      kind: 'claude',
      state: chat.State.Failed,
      error: { code: chat.Code.StartFailed, message: 'm', stderr: 'TOKEN=secret' },
    });
    const rw = await start({ host: (h) => h.chats.set(id, failed) });
    expect(JSON.stringify((await rw.call('GET', m('chats')))[1])).toContain('TOKEN=secret');
    const ro = await start({ readOnly: true, host: (h) => h.chats.set(id, failed) });
    const text = JSON.stringify((await ro.call('GET', m('chats')))[1]);
    expect(text).not.toContain('TOKEN');
    expect(text).toContain('start_failed');
    ro.host.end(false);
    expect(await ro.call('GET', m('chats'))).toMatchObject([409, { error: 'not_running' }]);
    expect(ro.host.running).toBe(false);
  });

  // The host's refusals keep their codes, with a status that fits; a host
  // of another protocol and a machine that is not connected are errors of
  // their own.
  test("a Claude Code chat waits for the machine's Agent SDK; one the machine cannot get is sdk_unavailable", async () => {
    const r = await start();
    const m = (p: string) => `/api/m/gpu/p/chat/${p}`;
    // Installed: the chat starts; another kind never asks.
    expect((await r.call('POST', m('new'), '{"kind":"claude","cwd":"/w"}'))[0]).toBe(200);
    expect(r.host.sdkAsks).toEqual([undefined]);
    expect((await r.call('POST', m('new'), '{"kind":"kimi","cwd":"/w"}'))[0]).toBe(200);
    expect(r.host.sdkAsks).toHaveLength(1);
    // Asked once per agent session.
    expect((await r.call('POST', m('new'), '{"kind":"claude","cwd":"/w"}'))[0]).toBe(200);
    expect(r.host.sdkAsks).toHaveLength(1);
    // A machine of the Go build needs none.
    r.board.o.sdk.forget('gpu');
    r.host.sdk = 'go';
    expect((await r.call('POST', m('new'), '{"kind":"claude","cwd":"/w"}'))[0]).toBe(200);
    // Without it, and with the core offline and no operator's copy, the
    // chat is refused and the host never asked.
    r.board.o.sdk.forget('gpu');
    r.host.sdk = 'missing';
    const news = r.host.requests.filter((q) => q.op === chat.Op.New).length;
    const [status, body] = await r.call('POST', m('new'), '{"kind":"claude","cwd":"/w"}');
    expect(status).toBe(503);
    expect(body.error).toBe(chat.Code.SdkUnavailable);
    expect(String(body.message)).toContain('the core is offline');
    expect(String(body.message)).toContain('--seed-dir');
    expect(r.host.requests.filter((q) => q.op === chat.Op.New)).toHaveLength(news);
  });

  // What a machine or a download says of a URL reaches the page and the
  // audit log by its origin and path only: the user information, query and
  // fragment, where credentials go, never.
  test('an sdk_unavailable answer and its audit record name URLs by their origin and path only', async () => {
    const reg = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('no', { status: 404 }) });
    try {
      const registry = `http://127.0.0.1:${reg.port}`;
      const r = await start({ sdk: { offline: false, registry } });
      r.host.sdk = 'missing';
      r.host.sdkError =
        'download https://u:s3cret@mirror.example/npm/x.tgz?token=t0ken: exit status 22 (https://u:s3cret@mirror.example/a#fr4g)';
      const [status, body] = await r.call('POST', m('new'), '{"kind":"claude","cwd":"/w"}');
      expect([status, body.error]).toEqual([503, chat.Code.SdkUnavailable]);
      expect(r.host.sdkAsks).toEqual([`${registry}/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.322.tgz`]);
      const rec = r.audit.records().filter((a) => a.event === 'chat.sdk_install');
      expect(rec).toEqual([expect.objectContaining({ plugin: 'chat', machine: 'gpu', source: 'download', ok: false })]);
      for (const text of [JSON.stringify(body), JSON.stringify(rec)]) {
        for (const secret of ['s3cret', 't0ken', 'fr4g']) expect(text).not.toContain(secret);
        expect(text).toContain('https://mirror.example/npm/x.tgz');
      }
      expect(String(body.message)).toContain(`the core could not download ${registry}/@anthropic-ai/claude-agent-sdk/-/`);
    } finally {
      reg.stop(true);
    }
  });

  test('errors', async () => {
    const r = await start();
    const f = r.host;
    const id = chat.newChatID();
    for (const [code, status] of [
      [chat.Code.UnknownChat, 404],
      [chat.Code.Busy, 409],
      [chat.Code.TooMany, 409],
      [chat.Code.BadRequest, 400],
      [chat.Code.StartFailed, 502],
      [chat.Code.Unsupported, 422],
      [chat.Code.NotAllowed, 403],
      [chat.Code.Sleeping, 409],
      ['not_running', 409],
      ['upgrading', 503],
      ['no_terminal_core', 503],
      [chat.Code.UnsafeFolder, 403],
    ] as const) {
      f.reqErr.set(chat.Op.Close, { code, message: 'm' });
      expect([code, ...(await r.call('POST', m(`close?chat=${id}`)))]).toEqual([code, status, { error: code, message: 'm' }]);
      expect(r.lastAudit()).toMatchObject({ event: 'chat.close', chat: id, status, error: code });
    }
    f.proto = 1;
    expect(await r.call('GET', m('chats'))).toMatchObject([502, { error: 'protocol' }]);
    f.proto = chat.PROTO;
    // A host that refuses its settings still gets the request.
    f.reqErr.set(chat.Op.Configure, { code: chat.Code.BadRequest, message: 'm' });
    expect((await r.call('POST', m('new'), '{"kind":"claude","cwd":"/w"}'))[0]).toBe(200);
    expect(f.count(chat.Op.New)).toBe(1);
    f.openErr = 'offline';
    expect(await r.call('GET', m('chats'))).toMatchObject([409, { error: 'offline' }]);
    f.openErr = '';
    // A machine without a session.
    await r.setEnabled('gpu', false);
    expect(await r.call('GET', m('chats'))).toMatchObject([409, { error: 'offline' }]);
    expect(await r.call('GET', '/api/m/nope/p/chat/chats')).toMatchObject([404, { error: 'unknown' }]);
  });

  // A handoff attaches without the log, sends the command and answers what
  // the host answered it.
  test('handoff', async () => {
    const id = chat.newChatID();
    const r = await start({ host: (h) => h.chats.set(id, testChat({ id, kind: 'claude' })) });
    const f = r.host;
    expect(await r.call('POST', m(`handoff?chat=${id}`))).toEqual([200, {}]);
    expect(r.lastAudit()).toMatchObject({ event: 'chat.handoff', chat: id, status: 200 });
    const req = f.requests.at(-1)!;
    expect([req.op, req.chat]).toEqual(['attach', id]);
    // The last sequence number Go takes, as Go writes it.
    expect(req.from).toBe(2 ** 64);
    expect(f.commands.map((c) => c.op)).toEqual(['handoff']);
    f.ackErr.set(chat.CommandOp.Handoff, { code: chat.Code.Busy, message: 'a turn runs' });
    expect(await r.call('POST', m(`handoff?chat=${id}`))).toMatchObject([409, { error: 'busy' }]);
    expect(await r.call('POST', m(`handoff?chat=${chat.newChatID()}`))).toMatchObject([404, { error: 'unknown_chat' }]);
  });

  test('trusted folders and the hosts', async () => {
    const r = await start();
    const f = r.host;
    f.running = false;
    f.trusted = [{ cwd: '/work/proj', at: '2026-01-01T00:00:00Z' }];

    // GET trusted never starts a stopped host; POST trusted does.
    expect((await r.call('GET', m('trusted')))[0]).toBe(409);
    expect(f.running).toBe(false);
    // GET hosts lists the machines without starting any host.
    let [code, out] = await r.call('GET', '/api/p/chat/hosts');
    expect(code).toBe(200);
    expect(out.hosts).toEqual([
      { machine: 'gpu', label: 'gpu', machineStatus: 'ready', running: false, status: 'stopped', totalChats: 0, sessions: [] },
      { machine: 'box', label: 'box', machineStatus: 'disabled', running: false, status: 'offline', totalChats: 0, sessions: [] },
    ]);
    expect(f.running).toBe(false);

    [code, out] = await r.call('POST', m('trusted'));
    expect([code, out]).toEqual([200, { trusted: [{ cwd: '/work/proj', at: '2026-01-01T00:00:00Z' }] }]);
    expect(r.lastAudit()).toMatchObject({ event: 'chat.trusted', status: 200 });
    expect((await r.call('GET', m('trusted')))[0]).toBe(200);

    f.hostStatus = {
      proto: chat.PROTO,
      version: 'v1.2.3',
      pid: 4242,
      terminalId: 't3',
      startedAt: '0001-01-01T00:00:00Z',
      conns: 0,
      watchers: 0,
      liveAgents: 1,
      totalChats: 2,
      totalBytes: 0,
      ending: 0,
      settings: chat.defaultHostSettings(),
      sessions: [
        {
          chat: 'c0123456789abcdef',
          kind: 'claude',
          title: 'Fix bug',
          cwd: '/work/proj',
          sessionId: '',
          state: chat.State.Idle,
          status: chat.Status.Idle,
          pid: 5555,
          updated: '2026-01-01T00:00:00Z',
          bytes: 0,
        },
      ],
    };
    [code, out] = await r.call('GET', '/api/p/chat/hosts');
    const [gpu, box] = out.hosts as Array<Record<string, unknown>>;
    expect(gpu).toEqual({
      machine: 'gpu',
      label: 'gpu',
      machineStatus: 'ready',
      running: true,
      status: 'running',
      pid: 4242,
      version: 'v1.2.3',
      proto: chat.PROTO,
      terminalId: 't3',
      liveAgents: 1,
      totalChats: 2,
      settings: chat.defaultHostSettings(),
      sessions: f.hostStatus.sessions,
    });
    expect(box).toMatchObject({ running: false, status: 'offline' });

    // An older host without host_status: its chats and its hello.
    f.reqErr.set(chat.Op.HostStatus, { code: chat.Code.BadRequest, message: 'unknown op' });
    const id = chat.newChatID();
    f.chats.set(id, testChat({ id, state: chat.State.Working, status: chat.Status.Working, agentVersion: '1.0' }));
    f.chats.set(chat.newChatID(), testChat({ id: chat.newChatID(), state: chat.State.Closed }));
    [code, out] = await r.call('GET', '/api/p/chat/hosts');
    expect((out.hosts as unknown[])[0]).toEqual({
      machine: 'gpu',
      label: 'gpu',
      machineStatus: 'ready',
      running: true,
      status: 'running',
      pid: 1,
      version: 'test',
      proto: chat.PROTO,
      liveAgents: 1,
      totalChats: 2,
      sessions: [
        {
          chat: id,
          kind: 'codex',
          title: '',
          cwd: '/w',
          sessionId: '',
          state: 'working',
          status: 'working',
          updated: '2026-01-01T00:00:00Z',
          bytes: 0,
          agentVersion: '1.0',
        },
      ],
    });

    // host/stop ends a host that runs nothing, refused while one works.
    f.reqErr.set(chat.Op.Shutdown, { code: chat.Code.Busy, message: 'working' });
    expect((await r.call('POST', m('host/stop')))[0]).toBe(409);
    f.reqErr.delete(chat.Op.Shutdown);
    expect((await r.call('POST', m('host/stop')))[0]).toBe(200);
    expect(r.lastAudit()).toMatchObject({ event: 'chat.host_stop', status: 200 });
    expect(f.running).toBe(false);
    expect((await r.call('POST', m('host/stop')))[0]).toBe(409);
  });
});
