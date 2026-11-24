// The core's side of features' protocols (#shared/proto/protocol.ts):
// calling an action of a feature on a machine's agent.
import { MAX_BODY, MAX_INLINE, Op, readBody, type Header } from '#shared/proto/agentproto/index.ts';
import type { Action, Protocol, ResultOf } from '#shared/proto/protocol.ts';
import type { z } from 'zod';
import { Fail } from './fail.ts';
import type { Machine } from './machines/machine.ts';
import { AgentError, closeStream, type AgentStream } from './machines/transport/session.ts';

/** The status a failure of an agent action answers with. */
function statusOf(code: string): number {
  switch (code) {
    case 'offline':
      return 409;
    case 'transport':
      return 502;
    case 'not_found':
      return 404;
  }
  return 400;
}

/** A failure the agent answered keeps its code; anything else is the
 * transport's. */
function failOf(e: unknown): Fail {
  if (e instanceof Fail) return e;
  if (e instanceof AgentError && e.reply && !e.reply.ok) {
    const code = e.reply.code || 'failed';
    return new Fail(code, statusOf(code), e.reply.error ?? code);
  }
  if (e instanceof Error && e.name === 'AbortError') throw e;
  return new Fail('transport', 502, e instanceof Error ? e.message : String(e));
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Runs action of proto on m's agent and returns its result and the stream
 * after the reply (a streaming action's bytes follow there). The stream is
 * closed when signal ends, also after the reply; whoever goes on with it
 * closes it (closeStream). Fails with the agent's code, offline without a
 * session, transport when the stream breaks, too_large for params over
 * MAX_BODY, invalid_result for a result that does not match the action. */
export async function open<P extends Protocol, K extends keyof P['actions'] & string>(
  m: Machine,
  proto: P,
  action: K,
  params: z.input<P['actions'][K]['params']>,
  opts: CallOptions = {},
): Promise<{ result: ResultOf<P['actions'][K]>; conn: AgentStream }> {
  const def: Action = proto.actions[action];
  const h: Header = { op: Op.Plugin, plugin: proto.id, action };
  let body: Uint8Array | undefined;
  const encoded = Buffer.from(JSON.stringify(def.params.parse(params)));
  if (encoded.length > MAX_BODY) throw new Fail('too_large', 400, `params of ${encoded.length} bytes`);
  if (encoded.length > MAX_INLINE) {
    h.params_length = encoded.length;
    body = encoded;
  } else h.params = JSON.parse(encoded.toString('utf8'));

  let conn: AgentStream;
  let raw: unknown;
  try {
    const r = await m.open(h, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? def.timeoutMs, body });
    conn = r.conn;
    raw = r.reply.plugin;
    if (r.reply.plugin_length && r.reply.plugin_length > 0) {
      try {
        raw = await readBody(conn.reader, r.reply.plugin_length);
      } catch (e) {
        conn.reader.release();
        closeStream(conn.stream);
        throw e;
      }
    }
  } catch (e) {
    throw failOf(e);
  }
  const onAbort = () => conn.stream.destroy();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  conn.stream.once('close', () => opts.signal?.removeEventListener('abort', onAbort));
  const parsed = def.result.safeParse(raw ?? {});
  if (!parsed.success) {
    conn.reader.release();
    closeStream(conn.stream);
    throw new Fail('invalid_result', 502, `${proto.id}.${action}: ${parsed.error.message}`);
  }
  return { result: parsed.data as ResultOf<P['actions'][K]>, conn };
}

/** Runs a non-streaming action and returns its result. */
export async function call<P extends Protocol, K extends keyof P['actions'] & string>(
  m: Machine,
  proto: P,
  action: K,
  params: z.input<P['actions'][K]['params']>,
  opts: CallOptions = {},
): Promise<ResultOf<P['actions'][K]>> {
  const { result, conn } = await open(m, proto, action, params, opts);
  conn.reader.release();
  closeStream(conn.stream);
  return result;
}
