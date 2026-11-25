// The Git feature's routes: reads and changes, their guards and audit
// records, the parameters that reach a machine (a fake of the machine's
// plugin op) and what passes back to the page; and its settings.
import { afterEach, expect, test } from 'bun:test';
import { write } from '#shared/lib/streamio.ts';
import { MAX_INLINE, Op, readBody, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { Settings } from '#kernel/config/settings/index.ts';
import { closeStream, type AgentStream } from '#kernel/machines/transport/session.ts';
import { agentDialer, checkGuarded, running, sshSpec, testCore, testMachines, waitFor } from '#kernel/testing.ts';
import { auditFields, gitFeature, MAX_BODY, queryParams } from './hub.ts';
import { gitProtocol, READ_MS, READS, WRITE_MS, WRITES } from './protocol.ts';
import { settings } from './settings.ts';

const ON = { 'plugins.git.enabled': true };
const offlineCore = (readOnly = false) =>
  testCore({ features: [gitFeature()], machines: testMachines([sshSpec('x', 'x', 'x', false)]), readOnly, settings: { ...ON } });

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

interface Call {
  action: string;
  params: Record<string, unknown>;
}

/** A core whose machine x answers the git actions with reply. */
async function withMachine(reply: (action: string, params: Record<string, unknown>) => Reply) {
  const calls: Call[] = [];
  const serve = async (h: Header, conn: AgentStream) => {
    try {
      if (h.op !== Op.Plugin || h.plugin !== 'git') return void (await writeLine(conn.stream, { ok: false, error: 'unsupported' }));
      const params = (h.params_length ? await readBody(conn.reader, h.params_length) : (h.params ?? {})) as Record<string, unknown>;
      calls.push({ action: h.action ?? '', params });
      // A large result follows its line as a body, as the Go agent sends it.
      const rep = reply(h.action ?? '', params);
      const body = rep.ok && rep.plugin !== undefined ? Buffer.from(JSON.stringify(rep.plugin)) : undefined;
      if (body && body.length > MAX_INLINE) {
        await writeLine(conn.stream, { ok: true, plugin_length: body.length });
        await write(conn.stream, body);
      } else await writeLine(conn.stream, rep);
    } finally {
      conn.reader.release();
      closeStream(conn.stream);
    }
  };
  const machines = testMachines([sshSpec('x')], { dial: agentDialer({ serve }) });
  const tc = testCore({ features: [gitFeature()], machines, settings: { ...ON } });
  stops.push(running(tc.core));
  await waitFor('x ready', () => machines.get('x')!.ready);
  return { tc, calls };
}

// Reads are GETs, not guarded; every change is a POST, refused to other
// sites and in read-only mode.
test('routes', async () => {
  const { problems, checked } = await checkGuarded(offlineCore(), offlineCore(true), { machine: 'x' });
  expect(problems).toEqual([]);
  expect(checked.sort()).toEqual(WRITES.map((w) => `POST /api/m/:id/p/git/${w}`).sort());
  const reads = offlineCore(true)
    .core.http.app.routes.filter((r) => r.method === 'GET' && r.path.startsWith('/api/m/:id/p/git/'))
    .map((r) => r.path.slice('/api/m/:id/p/git/'.length));
  expect([...new Set(reads)].sort()).toEqual([...READS].sort());
  expect(new Set([...READS, ...WRITES]).size).toBe(READS.length + WRITES.length);
  // Each is an action of the machine's side, with its time limit.
  for (const a of READS) expect([a, gitProtocol.actions[a].timeoutMs]).toEqual([a, READ_MS]);
  for (const a of WRITES) expect([a, gitProtocol.actions[a].timeoutMs]).toEqual([a, WRITE_MS]);
});

// A change's audit record names what it acted on and how it ended, never
// its patch or message, and paths only by their number.
test('change audit', async () => {
  const tc = offlineCore();
  const body = {
    repo: '/home/u/r',
    name: 'topic',
    remote: 'origin',
    force: true,
    forceWithLease: true,
    amend: true,
    all: false,
    mode: 'hard',
    rev: 'abc123',
    hash: 'def456',
    paths: ['a', 'b'],
    untracked: ['c'],
    message: 'SECRET-MESSAGE',
    patch: 'SECRET-PATCH',
  };
  const res = await tc.request('POST', '/api/m/x/p/git/commit', { body: JSON.stringify(body) });
  expect(res.status).toBe(409);
  const recs = tc.audit.records();
  expect(recs.map((r) => r.event)).toEqual(['git.commit.done', 'git.commit']);
  const { time: _, ...done } = recs[0]!;
  expect(done).toEqual({
    event: 'git.commit.done',
    repo: '/home/u/r',
    name: 'topic',
    // The change's remote, over the request's address, as the Go core
    // recorded it.
    remote: 'origin',
    force: true,
    forceWithLease: true,
    amend: true,
    mode: 'hard',
    rev: 'abc123',
    hash: 'def456',
    paths: 3,
    machine: 'x',
    ok: false,
    code: 'offline',
  });
  expect(tc.audit.text()).not.toContain('SECRET');
  const { time: __, ...route } = recs[1]!;
  expect(route).toEqual({ event: 'git.commit', remote: '127.0.0.1', plugin: 'git', machine: 'x', status: 409, error: 'offline' });
  expect(auditFields({ repo: 'é'.repeat(300) }).repo).toBe('é'.repeat(256));
});

test('query params', () => {
  const q = new URLSearchParams('repo=/r&skip=300&limit=10&branch=main&branch=dev&remotes=1&rev=abc&parent=2&other=x&path=');
  expect(queryParams(q)).toEqual({ repo: '/r', skip: 300, limit: 10, branches: ['main', 'dev'], remotes: true, rev: 'abc', parent: 2 });
  for (const bad of ['skip=a', 'limit=1.5', 'parent=99999999999999999999'])
    expect(() => queryParams(new URLSearchParams(bad))).toThrow(expect.objectContaining({ code: 'bad_request', status: 400 }));
});

// A change's body is a JSON object of at most MAX_BODY bytes (bad_request
// before the machine is asked); a member of another type than the agent
// reads fails with its code, bad_params.
test('change bodies', async () => {
  const { tc, calls } = await withMachine(() => ({ ok: true, plugin: {} }));
  for (const body of ['', 'not json', '[]', '"x"', JSON.stringify({ message: 'x'.repeat(MAX_BODY) })]) {
    const res = await tc.request('POST', '/api/m/x/p/git/stage', { body });
    expect([body.slice(0, 10), res.status, ((await res.json()) as { error: string }).error]).toEqual([
      body.slice(0, 10),
      400,
      'bad_request',
    ]);
  }
  expect(tc.audit.records().filter((r) => r.event === 'git.stage.done')).toEqual([]);
  const res = await tc.request('POST', '/api/m/x/p/git/stage', { body: '{"repo":"/r","paths":"a"}' });
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, 'bad_params']);
  expect(tc.audit.records().find((r) => r.event === 'git.stage.done')).toMatchObject({ ok: false, code: 'bad_params' });
  expect(calls).toEqual([]);
  // null is no body, a null member none.
  expect((await tc.request('POST', '/api/m/x/p/git/fetch', { body: 'null' })).status).toBe(200);
  expect((await tc.request('POST', '/api/m/x/p/git/fetch', { body: '{"repo":"/r","remote":null,"x":1}' })).status).toBe(200);
  expect(calls).toEqual([
    { action: 'fetch', params: {} },
    { action: 'fetch', params: { repo: '/r' } },
  ]);
});

// What the machine answers passes to the page as it is, members the
// protocol does not name too; its failures keep their codes.
test('through the machine', async () => {
  const log = {
    commits: [{ hash: 'a', parents: [], author: 'u', email: 'e', date: 1, subject: 's', extra: 1 }],
    more: false,
    future: true,
  };
  const { tc, calls } = await withMachine((action, p) => {
    switch (action) {
      case 'log':
        return { ok: true, plugin: log };
      case 'branches':
        return { ok: true, plugin: null };
      case 'blob':
        return { ok: true, plugin: { exists: true, text: 'x'.repeat(3 << 20), size: 3 << 20 } };
      case 'push':
        return { ok: false, code: 'auth_required', error: 'git push: terminal prompts disabled' };
      case 'checkout':
        return { ok: true, plugin: { output: `switched to ${String(p.name)}` } };
    }
    return { ok: false, code: 'not_a_repo', error: '/r is not the top level of a repository' };
  });
  let res = await tc.request('GET', '/api/m/x/p/git/log?repo=/r&skip=300&branch=main');
  expect([res.status, res.headers.get('Cache-Control'), await res.json()]).toEqual([200, 'no-store', log]);
  // An empty list (Go's nil slice) is null.
  res = await tc.request('GET', '/api/m/x/p/git/branches?repo=/r');
  expect([res.status, await res.text()]).toEqual([200, 'null']);
  // A result larger than a line comes as a body.
  res = await tc.request('GET', '/api/m/x/p/git/blob?repo=/r&path=a&source=head');
  expect(((await res.json()) as { text: string }).text.length).toBe(3 << 20);
  res = await tc.request('GET', '/api/m/x/p/git/status?repo=/r');
  expect([res.status, await res.json()]).toEqual([400, { error: 'not_a_repo', message: '/r is not the top level of a repository' }]);
  res = await tc.request('POST', '/api/m/x/p/git/push', { body: '{"repo":"/r","remote":"origin","forceWithLease":true}' });
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, 'auth_required']);
  res = await tc.request('POST', '/api/m/x/p/git/checkout', { body: '{"repo":"/r","name":"dev"}' });
  expect([res.status, await res.json()]).toEqual([200, { output: 'switched to dev' }]);
  expect(calls).toEqual([
    { action: 'log', params: { repo: '/r', skip: 300, branches: ['main'] } },
    { action: 'branches', params: { repo: '/r' } },
    { action: 'blob', params: { repo: '/r', path: 'a', source: 'head' } },
    { action: 'status', params: { repo: '/r' } },
    { action: 'push', params: { repo: '/r', remote: 'origin', forceWithLease: true } },
    { action: 'checkout', params: { repo: '/r', name: 'dev' } },
  ]);
  const done = tc.audit.records().filter((r) => String(r.event).endsWith('.done'));
  expect(done.map((r) => [r.event, r.ok, r.code])).toEqual([
    ['git.push.done', false, 'auth_required'],
    ['git.checkout.done', true, undefined],
  ]);
  // Off, every route answers plugin_disabled.
  tc.settings['plugins.git.enabled'] = false;
  res = await tc.request('GET', '/api/m/x/p/git/status?repo=/r');
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([404, 'plugin_disabled']);
});

// The results are typed as the agent writes them (a Go slice may be
// null), and keep what a later agent adds, also in nested objects.
test('results', () => {
  const detail = { hash: 'a', parents: null, author: 'u', email: 'e', date: 1, subject: 's' };
  const commit = { ...detail, committer: 'c', committerEmail: 'ce', commitDate: 2, message: 'm', x: 1 };
  const show = { commit, base: 'b', target: 't', files: null, y: 2 };
  expect(gitProtocol.actions.show.result.parse(show)).toEqual(show);
  const repo = { root: '/r', gitDir: '/r/.git', commonDir: '/r/.git', ahead: 0, behind: 0, remotes: null };
  expect(gitProtocol.actions.repo.result.parse(repo)).toEqual(repo);
  expect(gitProtocol.actions.status.result.safeParse({ ahead: 0, behind: 0, files: [{ path: 'a', x: '.', y: 'M' }] }).success).toBe(false);
  expect(gitProtocol.actions.diffStat.result.parse({ worktree: { a: [1, 2] }, staged: null })).toEqual({
    worktree: { a: [1, 2] },
    staged: null,
  });
  expect(gitProtocol.actions.tags.result.parse(null)).toBeNull();
  expect(gitProtocol.actions.stage.result.parse({})).toEqual({});
});

// The settings: their defaults (what the UI does without them), and values
// out of their range refused.
test('settings', () => {
  const st = new Settings('', { modules: [settings] });
  expect(Object.fromEntries(st.defs().map((d) => [d.key, st.get(d.key)]))).toEqual({
    'git.mixedLineEndings': 'keep',
    'git.changesView': 'list',
    'git.untrackedChanges': 'mixed',
    'git.autoFetch': 0,
    'git.confirmSync': false,
    'git.graphPageSize': 300,
  });
  for (const [k, bad] of [
    ['git.mixedLineEndings', 'lf'],
    ['git.autoFetch', -1],
    ['git.graphPageSize', 10],
  ] as const)
    expect(() => st.set(k, '', bad)).toThrow();
  st.set('git.graphPageSize', '', 500);
  expect(st.get('git.graphPageSize')).toBe(500);
});
