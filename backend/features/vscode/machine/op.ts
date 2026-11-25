// Op code-server, as the hub's provision.ts drives it (and the Go machine
// build answers it): every request names the release (version) and, for a
// code-server installed on the machine, its executable (bin); a reply
// carries the status (cs) of that code-server, a refusal its error.
//
//   status                 the status.
//   download {url, digest} the machine fetches the release and installs it;
//                          the reply carries the tarball's digest, which
//                          the hub records when it knew none. The download
//                          ends when the hub closes the stream.
//   install {digest}       a first reply, then the tarball in chunks
//                          (ChunkWriter), checked against digest when the
//                          hub sends one, then the second reply.
//   start, stop            code-server started (once it answers), ended.
//   release                ended unless another hub's session has a
//                          connection to it (a hub's idle end).
//   install-ext {path, args}
//                          a first reply, then (with path) a VSIX in
//                          chunks; installs it and the extension ids args.
//   marker {path, args}    whether the marker path exists in the
//                          extensions directory; args ["set"] creates it.
import { rm } from 'node:fs/promises';
import { ChunkReader, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import type { Logger } from '#shared/lib/log.ts';
import { shownURL } from '#shared/lib/urls.ts';
import { untilClosed } from '#machine/dispatch.ts';
import type { ActionContext } from '#machine/feature.ts';
import type { Conn } from '#machine/stream.ts';
import { installExtensions, marker } from './extensions.ts';
import { validVersion } from './layout.ts';
import { download, install, receive, RELEASE_LIMITS, type ReleaseLimits, type Staged } from './release.ts';
import type { CodeServer } from './server.ts';

export interface OpOptions {
  logger: Logger;
  limits?: Partial<ReleaseLimits>;
  /** Bounds code-server's extension installer. */
  installExtMs?: number;
}

const failed = (e: unknown): Reply => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

/** An upload that failed before its end is read on and dropped, so that the
 * hub, which reads the reply only after its last chunk, gets it. */
const dropRest = (conn: Conn) => conn.reader.release().resume();

/** Serves one code-server op on conn; the agent closes the stream after. */
export async function serveCodeServer(cs: CodeServer, conn: Conn, h: Header, ctx: ActionContext, o: OpOptions): Promise<void> {
  const st = conn.stream;
  const reply = (r: Reply) => writeLine(st, r);
  const ok = async () => reply({ ok: true, cs: await cs.status(h) });
  if (!validVersion(h.version)) return reply(failed('code-server: bad version'));
  const l = cs.layout;
  const limits = { ...RELEASE_LIMITS, ...o.limits };
  try {
    switch (h.action) {
      case 'status':
        return await ok();
      case 'download': {
        // The download ends when the hub gives up (VS Code turned off, the
        // request timed out): it sends nothing after the header.
        const ac = untilClosed(conn, ctx.signal);
        let tarball: Staged | null = null;
        try {
          tarball = await download(l, h.url ?? '', { env: ctx.environ(), signal: ac.signal, limits });
          await install(l, h.version, tarball, {
            expected: h.digest,
            what: shownURL(h.url ?? ''),
            env: ctx.environ(),
            logger: o.logger,
            limits,
          });
        } finally {
          ac.abort();
          if (tarball) await rm(tarball.file, { force: true });
        }
        return await reply({ ok: true, cs: { ...(await cs.status(h)), digest: tarball.digest } });
      }
      case 'install': {
        await reply({ ok: true });
        let tarball: Staged | null = null;
        try {
          tarball = await receive(l, new ChunkReader(conn.reader), limits.maxTarball);
        } catch (e) {
          dropRest(conn);
          throw e;
        }
        try {
          await install(l, h.version, tarball, { expected: h.digest, env: ctx.environ(), logger: o.logger, limits });
        } finally {
          await rm(tarball.file, { force: true });
        }
        return await ok();
      }
      case 'start':
        await cs.start(h, ctx.signal);
        return await ok();
      case 'stop':
        await cs.stop();
        return await ok();
      case 'release':
        // A hub's idle end: another hub's VS Code windows keep it.
        if (!ctx.sessions().some((s) => s !== ctx.session && s.dialed(l.socket).open > 0)) await cs.stop();
        return await ok();
      case 'install-ext': {
        await reply({ ok: true });
        let out: string;
        try {
          const bin = await cs.binFor(h);
          out = await installExtensions(l, bin, {
            vsix: h.path ? new ChunkReader(conn.reader) : undefined,
            ids: h.args ?? [],
            env: ctx.environ(),
            signal: ctx.signal,
            timeoutMs: o.installExtMs,
          });
        } catch (e) {
          dropRest(conn);
          throw e;
        }
        return await reply({ ok: true, exec: { exit_code: 0, stdout: out, stderr: '' } });
      }
      case 'marker':
        return await reply({ ok: await marker(l, h.path ?? '', h.args?.[0] === 'set') });
    }
    return await reply(failed(`code-server: unknown action ${JSON.stringify(h.action ?? '')}`));
  } catch (e) {
    await reply(failed(e)).catch(() => {});
  }
}
