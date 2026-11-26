// Op hc (the terminal core's status, install, start, restart and stop) and
// the pipes to unix sockets (hc-api, dial-unix).
import { connect, type Socket } from 'node:net';
import { Fail } from '#shared/lib/fail.ts';
import { HCCode, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import { validDigest, type TerminalCore } from './hc.ts';
import type { Conn } from './stream.ts';

/** Serves op hc. Before a start or restart the executable is hashed again:
 * it runs only while it is the one the hub expects (h.digest, the
 * executable the hub carries and installed; empty when it carries none). */
export async function serveHC(conn: Conn, h: Header, hc: TerminalCore, signal: AbortSignal): Promise<void> {
  const st = conn.stream;
  const failed = async (code: string, e: unknown, extra: Pick<Reply, 'hc_installed'> = {}) =>
    writeLine(st, { ok: false, error: (e as Error)?.message ?? String(e), code, hc: await hc.status(signal), ...extra } satisfies Reply);
  if (h.action === 'status') return writeLine(st, { ok: true, hc: await hc.status(signal) } satisfies Reply);
  return hc.serialized(async () => {
    signal.throwIfAborted();
    if (h.action === 'ensure') {
      await ensureHC(conn, h, hc, signal, failed);
      return;
    }
    if ((h.action === 'start' || h.action === 'restart') && h.digest) {
      const got = await hc.digest(true);
      if (got === '') return failed(HCCode.NotInstalled, new Error('herdr-core is not installed'));
      if (got !== h.digest) return failed(HCCode.BadDigest, new Error(`herdr-core's sha256 ${got} does not match expected ${h.digest}`));
    }
    switch (h.action) {
      case 'install': {
        const before = await hc.status(signal);
        await writeLine(st, { ok: true } satisfies Reply);
        try {
          await hc.install(h.digest ?? '', conn.reader);
        } catch (e) {
          return failed(HCCode.BadDigest, e);
        }
        if (before.running && h.digest && before.digest !== h.digest) hc.pendingRestart = h.digest;
        break;
      }
      case 'install-embedded':
        // The herdr-core this build carries, when it is the one the hub
        // expects (the digest this build reported).
        try {
          const before = await hc.status(signal);
          await hc.installEmbedded(h.digest ?? '');
          if (before.running && h.digest && before.digest !== h.digest) hc.pendingRestart = h.digest;
        } catch (e) {
          return failed((e as { code?: string }).code ?? HCCode.BadDigest, e);
        }
        break;
      case 'start':
      case 'restart':
        // herdr-core starts the core detached from the agent (a user service
        // or launchd job); a restart's successor adopts the programs.
        if (!h.digest && (await hc.digest()) === '') return failed(HCCode.NotInstalled, new Error('herdr-core is not installed'));
        try {
          await hc.run(['server', h.action, '--json'], signal);
        } catch (e) {
          return failed(HCCode.StartFailed, e);
        }
        await hc.privateSocket();
        hc.pendingRestart = '';
        break;
      case 'stop':
        // Ends the session's programs.
        if ((await hc.digest()) === '') return failed(HCCode.NotInstalled, new Error('herdr-core is not installed'));
        try {
          await hc.run(['server', 'stop', '--json'], signal);
        } catch (e) {
          return failed(HCCode.StopFailed, e);
        }
        hc.pendingRestart = '';
        break;
      default:
        return writeLine(st, { ok: false, error: `hc: unknown action ${JSON.stringify(h.action ?? '')}` } satisfies Reply);
    }
    return writeLine(st, { ok: true, hc: await hc.status(signal) } satisfies Reply);
  });
}

/** Rechecks the status while holding the lifecycle lock, through any upload
 * and through starting the core. Concurrent hubs see the completed state. */
async function ensureHC(
  conn: Conn,
  h: Header,
  hc: TerminalCore,
  signal: AbortSignal,
  failed: (code: string, error: unknown, extra?: Pick<Reply, 'hc_installed'>) => Promise<void>,
): Promise<void> {
  const before = await hc.status(signal);
  const expected = h.digest ?? '';
  let installed = false;
  if (expected && before.digest !== expected) {
    try {
      signal.throwIfAborted();
      if (before.embedded) await hc.installEmbedded(expected);
      else {
        if (!validDigest(expected)) throw new Error('bad digest');
        await writeLine(conn.stream, { ok: true, hc_upload: true } satisfies Reply);
        await hc.install(expected, conn.reader);
      }
      installed = true;
      if (before.running) hc.pendingRestart = expected;
    } catch (e) {
      return failed(HCCode.InstallFailed, e);
    }
  }
  const digest = expected || before.digest || '';
  const action = !before.running ? 'start' : h.restart || (digest && hc.pendingRestart === digest) ? 'restart' : undefined;
  if (!action) return writeLine(conn.stream, { ok: true, hc: before, hc_installed: installed } satisfies Reply);
  if (!digest) return failed(HCCode.NotInstalled, new Error('herdr-core is not installed'));
  const extra = { hc_installed: installed };
  if ((await hc.digest(true)) !== digest) return failed(HCCode.BadDigest, new Error("herdr-core's executable changed"), extra);
  try {
    signal.throwIfAborted();
    await hc.run(['server', action, '--json'], signal);
  } catch (e) {
    return failed(HCCode.StartFailed, e, extra);
  }
  await hc.privateSocket();
  const now = await hc.status(signal);
  if (now.running) hc.pendingRestart = '';
  await writeLine(conn.stream, { ok: true, hc: now, hc_installed: installed, hc_action: action } satisfies Reply);
}

/** Connects to the unix socket at path within 5 s. */
export function dialSocket(path: string, timeoutMs = 5000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const c = connect(path);
    const t = setTimeout(() => {
      c.destroy();
      reject(new Fail('timeout', 504, `socket ${path}: no answer`));
    }, timeoutMs);
    c.once('connect', () => {
      clearTimeout(t);
      c.removeAllListeners('error');
      resolve(c);
    });
    c.once('error', (e) => {
      clearTimeout(t);
      reject(new Error(`socket ${path}: ${e.message}`));
    });
  });
}

/** Pipes conn's stream (after its header) to the unix socket at path: the
 * reply, then bytes both ways until either side ends, when both are closed
 * and the promise resolves. opened runs once the pipe is open. */
export async function pipeUnix(conn: Conn, path: string, opened?: () => void): Promise<void> {
  const st = conn.stream;
  let c: Socket;
  try {
    c = await dialSocket(path);
  } catch (e) {
    await writeLine(st, { ok: false, error: (e as Error).message } satisfies Reply).catch(() => {});
    conn.reader.release();
    closeStream(st);
    return;
  }
  try {
    await writeLine(st, { ok: true } satisfies Reply);
  } catch {
    c.destroy();
    conn.reader.release();
    closeStream(st);
    return;
  }
  opened?.();
  await pipe(conn, c);
}

/** Copies both ways and closes both ends once either side ends. */
export function pipe(conn: Conn, c: Socket): Promise<void> {
  const st = conn.stream;
  const rest = conn.reader.release();
  return new Promise((resolve) => {
    let done = false;
    const closeBoth = () => {
      if (done) return;
      done = true;
      rest.unpipe(c);
      c.unpipe(st);
      c.destroy();
      closeStream(st);
      resolve();
    };
    c.on('error', closeBoth).on('end', closeBoth).on('close', closeBoth);
    rest.on('error', closeBoth).on('end', closeBoth);
    st.on('close', closeBoth);
    rest.pipe(c, { end: false });
    c.pipe(st, { end: false });
    c.resume();
  });
}
