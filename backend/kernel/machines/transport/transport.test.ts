import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplexPair } from 'node:stream';
import { Op, readLine, writeLine, type Header } from '#shared/proto/agentproto/index.ts';
import { SLUG, validInstance } from '#shared/lib/brand.ts';
import { discard } from '#shared/lib/log.ts';
import { Reader } from '#shared/lib/streamio.ts';
import { Session as Yamux } from '#shared/proto/yamux.ts';
import { checkPrivateDir, controlName } from './controldir.ts';
import { Session, setReplyTimeout } from './session.ts';
import {
  AuthRequiredError,
  authCommand,
  classifySSHError,
  normArch,
  remoteSh,
  runArgs,
  shQuote,
  sshArgs,
  stopArgs,
  stopMaster,
  stopMasterIfStuck,
} from './ssh.ts';
import { createHash } from 'node:crypto';

/** A core session and a bare yamux server standing in for the agent. */
function pair(lost?: () => void) {
  const [a, b] = duplexPair();
  const s = new Session(a, undefined, lost);
  const srv = new Yamux(b, false);
  return { s, srv, peer: b };
}

describe('session', () => {
  test('lost runs only when the session ends by itself', async () => {
    let lost = 0;
    const p1 = pair(() => void lost++);
    p1.s.close();
    await p1.s.done();
    await Bun.sleep(100);
    expect(lost).toBe(0);

    const p2 = pair(() => void lost++);
    p2.peer.destroy();
    await Promise.race([p2.s.done(), Bun.sleep(5000)]);
    expect(p2.s.closed).toBe(true);
    expect(lost).toBe(1);
  });

  afterEach(() => setReplyTimeout(60_000));

  // A reply waits replyTimeoutMs without a timeout of the caller's, and the
  // caller's when it gives one, also a longer one: actions that answer
  // after their work (a scan, a push) are not cut short.
  test('open waits for the caller’s timeout', async () => {
    setReplyTimeout(100);
    const { s, srv } = pair();
    (async () => {
      for (;;) {
        const st = await srv.accept().catch(() => null);
        if (!st) return;
        (async () => {
          await readLine<Header>(new Reader(st));
          await Bun.sleep(300);
          await writeLine(st, { ok: true }).catch(() => {});
        })();
      }
    })();
    expect(s.request({ op: Op.Hello })).rejects.toThrow('no reply in time');
    expect((await s.request({ op: Op.Hello }, { timeoutMs: 2000 })).ok).toBe(true);
    s.close();
  });

  test('a refusal carries the reply; what follows a reply is left to read', async () => {
    const { s, srv } = pair();
    (async () => {
      for (;;) {
        const st = await srv.accept().catch(() => null);
        if (!st) return;
        const r = new Reader(st);
        const h = await readLine<Header>(r);
        if (h.op === Op.FsStat) await writeLine(st, { ok: false, error: 'no such file', code: 'not_found' });
        else st.end('{"ok":true,"entries_length":14}\n[{"name":"a"}]RAW');
      }
    })();
    const err = await s.request({ op: Op.FsStat, path: '/x' }).catch((e) => e);
    expect([err.message, err.reply?.code]).toEqual(['agent fs.stat: no such file', 'not_found']);
    const { conn, reply } = await s.open({ op: Op.FsList, path: '/' });
    expect(reply.entries).toEqual([{ name: 'a' } as never]);
    expect((await conn.reader.exactly(3)).toString()).toBe('RAW');
    s.close();
  });
});

describe('ssh', () => {
  test('errors that need the user', () => {
    for (const s of [
      'user@host: Permission denied (publickey,password).',
      'Host key verification failed.',
      "The authenticity of host 'x' can't be established.",
    ])
      expect(classifySSHError(s)).toBeInstanceOf(AuthRequiredError);
    expect(classifySSHError('ssh: connect to host x port 22: Connection refused')).not.toBeInstanceOf(AuthRequiredError);
  });

  test('normArch', () => {
    for (const [i, want] of Object.entries({ x86_64: 'amd64', aarch64: 'arm64', arm64: 'arm64', 'amd64\n': 'amd64' }))
      expect(normArch(i)).toBe(want);
  });

  test('shQuote', () => expect(shQuote("it's")).toBe(`'it'"'"'s'`));

  // Every ssh command ends its options with "--" right before the target,
  // so ssh parses nothing after it as an option, whatever the target says.
  test('the target follows a double dash', () => {
    const o = { target: '-oProxyCommand=touch /tmp/x', controlDir: '/tmp/c' };
    const cases: Record<string, string[]> = {
      run: runArgs(o, 'true'),
      stop: stopArgs(o),
      auth: authCommand(o.controlDir, o.target).slice(1),
    };
    for (const [name, args] of Object.entries(cases)) {
      const i = args.indexOf(o.target);
      expect([name, i >= 1 && args[i - 1] === '--' && args.indexOf('--') === i - 1]).toEqual([name, true]);
      expect(args.slice(0, i - 1)).toContain('ControlPath=' + join('/tmp/c', '%C'));
    }
    const run = runArgs(o, 'uname');
    expect(run.slice(-2)).toEqual([o.target, remoteSh('uname')]);
  });

  // Without a control directory (ssh on Windows shares no connections) no
  // Control option is passed; the other options stay.
  test('args without a control directory', () => {
    expect(sshArgs('', true).filter((a) => a.startsWith('Control'))).toEqual([]);
    expect(sshArgs('', true)).toEqual(expect.arrayContaining(['BatchMode=yes', 'ServerAliveInterval=15']));
    expect(sshArgs('/tmp/c', false)).toEqual(expect.arrayContaining(['ControlMaster=auto', 'BatchMode=no']));
  });

  // The control master is told to take no new sessions (not to exit, which
  // would end every session through it), with this core's control path.
  test.skipIf(process.platform === 'win32')('stop master arguments', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'ssh-bin-'));
    const out = join(mkdtempSync(join(tmpdir(), 'ssh-out-')), 'args');
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${out}\n`);
    chmodSync(join(bin, 'ssh'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await stopMaster({
        target: 'user@gpu',
        controlDir: '/tmp/ctl',
        logger: discard,
        builds: async () => ({ kind: 'go' as const, bin: Buffer.alloc(0), version: '' }),
        instance: '',
      });
    } finally {
      process.env.PATH = path;
    }
    expect(readFileSync(out, 'utf8')).toBe('-o\nControlPath=/tmp/ctl/%C\n-O\nstop\n--\nuser@gpu\n');
  });

  // The master is stopped only when ssh keeps running after the session
  // ended by itself.
  test('stop the master only when ssh stays up', async () => {
    let stops = 0;
    await stopMasterIfStuck(Promise.resolve(), 50, () => void stops++)();
    expect(stops).toBe(0);
    await stopMasterIfStuck(new Promise(() => {}), 10, () => void stops++)();
    expect(stops).toBe(1);
  });
});

describe.skipIf(process.platform === 'win32')('control directory', () => {
  // Each instance has a control directory of its own, also a short name
  // that is the hash of a long one, and its sockets' paths stay within
  // macOS's limit for the longest instance name.
  test('per instance', () => {
    const long = 'a'.repeat(32);
    expect(validInstance(long)).toBe(true);
    const hash = createHash('sha256').update(long).digest('hex').slice(0, 12);
    expect(validInstance(hash)).toBe(true);
    const seen = new Map<string, string>();
    for (const inst of ['', 'dev', 'desktop', 'e2e-0123abcd', long, long.slice(0, 31) + 'b', hash]) {
      const name = controlName(inst);
      expect(seen.has(name)).toBe(false);
      seen.set(name, inst);
      const parent = `/tmp/${SLUG}-${process.getuid!()}`;
      expect(join(parent, name, '0'.repeat(40)).length + 17).toBeLessThan(104);
    }
    expect(controlName('')).toBe('s');
  });

  test('a private directory only', () => {
    const d = join(mkdtempSync(join(tmpdir(), 'ctl-')), 's');
    mkdirSync(d, { mode: 0o700 });
    expect(() => checkPrivateDir(d)).not.toThrow();
    chmodSync(d, 0o777);
    expect(() => checkPrivateDir(d)).toThrow('accessible by other users');
    const link = join(mkdtempSync(join(tmpdir(), 'ctl-')), 'link');
    symlinkSync(d, link);
    expect(() => checkPrivateDir(link)).toThrow('not a directory');
  });
});
