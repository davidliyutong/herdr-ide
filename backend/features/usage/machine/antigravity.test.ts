// Antigravity: its language server found among the user's own processes
// (fake ps and lsof), asked on loopback only, remembered while it answers;
// agy as the fallback, at most every agyEveryMs, backed off after a
// failure, its account from its log, its process group killed.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { FakeAPI, TEST_NOW, removeHomes, script, tempHome, testEnv, testNowSec, write } from '../testdata/machine.ts';
import { hashId, type Account, type UsageEnv } from './env.ts';
import { parseAgy, parsePS, procPorts } from './antigravity.ts';
import { limits } from './limits.ts';
import { run } from './run.ts';

// Fake programs may start slowly on a loaded machine (a new script is
// assessed on its first run on macOS).
setDefaultTimeout(60_000);

const apis: FakeAPI[] = [];
afterEach(() => {
  for (const a of apis.splice(0)) a.stop();
});
afterAll(removeHomes);

const one = async (e: UsageEnv, o: Record<string, unknown> = {}): Promise<Account> => {
  const accs = await limits(e, { providers: ['antigravity'], ...o });
  expect(accs).toHaveLength(1);
  return accs[0]!;
};

const count = (f: string) => {
  try {
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

/** A language server on loopback answering GetUserStatus to csrf. */
function languageServer(csrf: string, body: string): FakeAPI {
  const ls = new FakeAPI();
  apis.push(ls);
  ls.replies.set('/exa.language_server_pb.LanguageServerService/GetUserStatus', (req) =>
    req.method === 'POST' && req.headers.get('X-Codeium-Csrf-Token') === csrf && req.headers.get('Connect-Protocol-Version') === '1'
      ? new Response(body, { headers: { 'Content-Type': 'application/json' } })
      : new Response(null, { status: 403 }),
  );
  return ls;
}

describe('the language server', () => {
  test('found among the user’s own processes, asked on its loopback port', async () => {
    const ls = languageServer(
      'tok-1',
      `{"userStatus":{"email":"ag@example.com","planStatus":{"planInfo":{"planName":"Pro"}},
        "cascadeModelConfigData":{"clientModelConfigs":[
          {"label":"Gemini 3 Pro","quotaInfo":{"remainingFraction":0.25,"resetTime":"2026-11-16T17:00:00Z"}},
          {"label":"Claude Sonnet","quotaInfo":{"resetTime":"2026-11-16T18:00:00Z"}},
          {"label":"No quota"}]}}}`,
    );
    const home = tempHome();
    const e = testEnv(home, { platform: 'darwin' });
    e.programs.ps = script(
      join(home, 'bin/ps'),
      `[ "$*" = "-ax -o uid=,pid=,command=" ] || exit 9
cat <<'EOF'
  501    12 /usr/bin/zsh
  502   300 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token other-user
  501   345 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token tok-1 --random_port
EOF`,
    );
    e.programs.lsof = script(
      join(home, 'bin/lsof'),
      `[ "$*" = "-nP -a -p 345 -iTCP -sTCP:LISTEN -Fn" ] || exit 9
printf 'p345\\nf20\\nn127.0.0.1:${ls.port}\\nf21\\nn10.0.0.2:9999\\n'`,
    );
    const a = await one(e);
    expect(a).toMatchObject({
      status: 'ok',
      email: 'ag@example.com',
      plan: 'Pro',
      source: 'ls',
      id: hashId('ag@example.com'),
      asOf: testNowSec,
    });
    expect(a.windows).toEqual([
      { kind: 'model', label: 'Gemini 3 Pro', usedPct: 75, resetsAt: Date.UTC(2026, 10, 16, 17) / 1000 },
      { kind: 'model', label: 'Claude Sonnet', usedPct: 100, resetsAt: Date.UTC(2026, 10, 16, 18) / 1000 },
    ]);
  });

  test('remembered while it answers; found again after it restarted elsewhere', async () => {
    const home = tempHome();
    const state = join(home, 'state');
    const runs = join(home, 'runs');
    const e = testEnv(home, { platform: 'darwin' });
    e.programs.ps = script(
      join(home, 'bin/ps'),
      `echo ps >> ${runs}.ps\nprintf '  501   345 /x/language_server_macos_arm --csrf_token %s antigravity\\n' "$(cut -d' ' -f1 ${state})"`,
    );
    e.programs.lsof = script(join(home, 'bin/lsof'), `echo lsof >> ${runs}.lsof\nprintf 'n127.0.0.1:%s\\n' "$(cut -d' ' -f2 ${state})"`);
    const body = (rem: number) =>
      `{"userStatus":{"email":"ag@example.com","cascadeModelConfigData":{"clientModelConfigs":[{"label":"M","quotaInfo":{"remainingFraction":${rem}}}]}}}`;
    const ls1 = languageServer('tok-1', body(0.6));
    write(state, `tok-1 ${ls1.port}`);
    expect((await one(e)).windows?.[0]?.usedPct).toBe(40);
    expect([count(`${runs}.ps`), count(`${runs}.lsof`)]).toEqual([1, 1]);
    expect((await one(e)).windows?.[0]?.usedPct).toBe(40);
    expect([count(`${runs}.ps`), count(`${runs}.lsof`)]).toEqual([1, 1]);
    ls1.stop();
    const ls2 = languageServer('tok-2', body(0.25));
    write(state, `tok-2 ${ls2.port}`);
    expect((await one(e)).windows?.[0]?.usedPct).toBe(75);
    expect([count(`${runs}.ps`), count(`${runs}.lsof`)]).toEqual([2, 2]);
    expect((await one(e)).windows?.[0]?.usedPct).toBe(75);
    expect([count(`${runs}.ps`), count(`${runs}.lsof`)]).toEqual([2, 2]);
  });

  test('ps: only the user’s own servers', () => {
    const out =
      '  0   10 /opt/antigravity/language_server_linux_x64 --csrf_token=root-tok\n' +
      '1001   20 /opt/antigravity/language_server_linux_x64 --csrf_token=other-tok\n' +
      '1000   30 /opt/antigravity/language_server_linux_x64 --csrf_token=mine\n' +
      'bad    40 /opt/antigravity/language_server_linux_x64 --csrf_token=junk\n';
    expect(parsePS(out, 1000)).toEqual([{ pid: 30, csrf: 'mine' }]);
  });

  test('/proc: the loopback ports the process listens on', async () => {
    const root = join(tempHome(), 'proc');
    const fd = join(root, '77/fd');
    mkdirSync(fd, { recursive: true });
    symlinkSync('socket:[1111]', join(fd, '3'));
    symlinkSync('socket:[2222]', join(fd, '4'));
    symlinkSync('/dev/null', join(fd, '5'));
    write(
      join(root, 'net/tcp'),
      `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:A1B2 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3333 1 0000000000000000 100 0 0 10 0
   2: 0200000A:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2222 1 0000000000000000 100 0 0 10 0
`,
    );
    expect(await procPorts(root, 77)).toEqual([0xa1b2]);
  });
});

const agyOut =
  '{"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"name":"Weekly","window":"weekly","remaining_fraction":0.5}]}]}}}';

/** A home with agy on its PATH printing out (or failing), counting its
 * runs and keeping its environment. */
function agyHome(out: string | null) {
  const home = tempHome();
  const runs = join(home, 'runs');
  script(
    join(home, 'agybin/agy'),
    `echo run >> ${runs}\n/usr/bin/env > ${home}/env\n[ "$*" = "-p /usage --output-format json" ] || exit 9\n${out === null ? 'exit 1' : `echo 'Loading…'\necho '${out}'`}`,
  );
  let now = TEST_NOW;
  const e = testEnv(home, { env: { PATH: join(home, 'agybin') }, now: () => now });
  return { home, e, runs: () => count(runs), at: (t: number) => (now = t) };
}

describe('agy', () => {
  test('without a language server: agy’s numbers, with automatic updates off', async () => {
    const h = agyHome(
      '{"email":"ag@example.com","models":[{"model":"Gemini 3 Flash","remainingFraction":0.9,"resetTime":"2026-11-16T17:00:00Z"}]}',
    );
    const a = await one(h.e);
    expect(a).toMatchObject({ status: 'ok', source: 'cli', email: 'ag@example.com', id: hashId('ag@example.com') });
    expect(a.windows).toEqual([{ kind: 'model', label: 'Gemini 3 Flash', usedPct: 10, resetsAt: Date.UTC(2026, 10, 16, 17) / 1000 }]);
    const env = readFileSync(join(h.home, 'env'), 'utf8');
    expect(env).toContain('AGY_CLI_DISABLE_AUTO_UPDATE=true');
    expect(env).toContain('NO_COLOR=1');
    // Nothing runs and there is no agy: missing.
    expect(await one(testEnv(tempHome()))).toMatchObject({ status: 'missing', code: 'not_running' });
  });

  test('at most every agyEveryMs; the polls in between get its answer', async () => {
    const h = agyHome(agyOut);
    const a = await one(h.e);
    expect(a).toMatchObject({ status: 'ok', asOf: testNowSec });
    expect(a.windows?.[0]).toMatchObject({ kind: 'weekly', usedPct: 50 });
    h.at(TEST_NOW + h.e.t.agyEveryMs - 1000);
    expect((await one(h.e)).asOf).toBe(testNowSec);
    expect(h.runs()).toBe(1);
    h.at(TEST_NOW + h.e.t.agyEveryMs);
    expect((await one(h.e)).asOf).toBe((TEST_NOW + h.e.t.agyEveryMs) / 1000);
    expect(h.runs()).toBe(2);
  });

  test('a failure is not run again for agyBackoffMs; a run cut short is not kept', async () => {
    const h = agyHome(null);
    for (let i = 0; i < 3; i++) {
      h.at(TEST_NOW + i * h.e.t.agyEveryMs);
      expect(await one(h.e)).toMatchObject({ status: 'error', code: 'agy_failed' });
    }
    expect(h.runs()).toBe(1);
    h.at(TEST_NOW + h.e.t.agyBackoffMs);
    await one(h.e);
    expect(h.runs()).toBe(2);
    const c = agyHome(agyOut);
    const ac = new AbortController();
    ac.abort();
    await one({ ...c.e, signal: ac.signal });
    expect(c.e.memo.agy.size).toBe(0);
  });

  test('its account from its log; skipped by it', async () => {
    const h = agyHome(agyOut);
    write(
      join(h.home, '.gemini/antigravity-cli/cli.log'),
      'I1116 18:36:40.004176 1 server_oauth.go:221] applyAuthResult: email=old@example.com, authMethod=consumer\n' +
        'I1116 18:36:40.004185 1 server_oauth.go:226] OAuth: authenticated successfully as AG@Example.com\n',
    );
    const a = await one(h.e);
    expect(a).toMatchObject({ status: 'ok', email: 'AG@Example.com', id: hashId('ag@example.com') });
    const b = await one(h.e, { skip: [`antigravity:${hashId('ag@example.com')}`] });
    expect(b).toMatchObject({ status: 'skipped', id: a.id });
    expect((await one(agyHome(agyOut).e)).id).toBeUndefined();
    // This machine's account without an id: nothing runs.
    const c = agyHome(agyOut);
    expect((await one(c.e, { skipLocal: ['antigravity'] })).status).toBe('skipped');
    expect(c.runs()).toBe(0);
  });

  test('agy 1.5’s groups of buckets', () => {
    const out =
      '{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\\tWeekly Limit Remaining\\t85%\\n","command":{"name":"usage","data":{"groups":[' +
      '{"name":"Gemini Models","buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.85,"reset_time":"2026-11-21T06:22:44Z"},' +
      '{"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.65,"reset_time":"2026-11-15T19:55:53Z"}]},' +
      '{"name":"Gemini 4 Argon","buckets":[{"id":"argon-weekly","name":"Gemini 4 Argon Weekly Limit","window":"monthly-ish","remaining_fraction":1,"reset_time":"2026-11-22T19:48:33Z"}]}]}}}';
    const a: Account = { provider: 'antigravity', status: '' };
    expect(parseAgy(a, out + '\ntrailing text')).toBe(true);
    expect(a.windows).toEqual([
      { kind: 'weekly', label: 'Gemini Models', usedPct: 15, resetsAt: 1795242164, windowSec: 7 * 86400 },
      { kind: 'session', label: 'Gemini Models', usedPct: 35, resetsAt: Date.UTC(2026, 10, 15, 19, 55, 53) / 1000, windowSec: 5 * 3600 },
      { kind: 'model', label: 'Gemini 4 Argon Weekly Limit', usedPct: 0, resetsAt: Date.UTC(2026, 10, 22, 19, 48, 33) / 1000 },
    ]);
  });
});

describe('a program’s process group', () => {
  /** A program that leaves sleep behind (recording its pid) and exits, or
   * waits for it. */
  function leaver(wait: boolean) {
    const home = tempHome();
    const pidFile = join(home, 'sleep.pid');
    const bin = script(join(home, 'agy'), `sleep 300 >/dev/null 2>&1 &\necho $! > ${pidFile}\n${wait ? 'wait' : 'echo done'}`);
    return { bin, pidFile };
  }

  async function gone(pidFile: string) {
    let pid = 0;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !pid) {
      try {
        pid = Number(readFileSync(pidFile, 'utf8').trim());
      } catch {
        await Bun.sleep(20);
      }
    }
    expect(pid).toBeGreaterThan(0);
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await Bun.sleep(20);
    }
    process.kill(pid, 'SIGKILL');
    throw new Error(`process ${pid} outlived the program`);
  }

  /** Aborts ac once the program recorded its helper. */
  async function abortWhenStarted(pidFile: string, ac: AbortController) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        if (readFileSync(pidFile, 'utf8').trim()) break;
      } catch {
        // not yet
      }
      await Bun.sleep(20);
    }
    ac.abort();
  }

  test('killed once the program exited', async () => {
    const { bin, pidFile } = leaver(false);
    const r = await run(bin, [], { env: {}, ms: 10_000 });
    expect(r).toEqual({ out: 'done\n', ok: true });
    await gone(pidFile);
  }, 30_000);

  test('killed when it times out', async () => {
    const { bin, pidFile } = leaver(true);
    const start = Date.now();
    expect((await run(bin, [], { env: {}, ms: 3000 })).ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(10_000);
    await gone(pidFile);
  }, 30_000);

  test('killed when its request ends', async () => {
    const { bin, pidFile } = leaver(true);
    const ac = new AbortController();
    void abortWhenStarted(pidFile, ac);
    expect((await run(bin, [], { env: {}, ms: 30_000, signal: ac.signal })).ok).toBe(false);
    await gone(pidFile);
  }, 30_000);
});
