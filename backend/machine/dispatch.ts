// The plugin op: an action of a feature's machine side (feature.ts), its
// params validated by the feature's protocol, its result written as the
// core reads it (inline, or after the reply line when larger than
// MAX_INLINE). A handler that throws fails its action with the Fail's code,
// or failed, instead of ending the agent.
import { Fail } from '#shared/lib/fail.ts';
import type { Logger } from '#shared/lib/log.ts';
import { write } from '#shared/lib/streamio.ts';
import { MAX_BODY, MAX_INLINE, readBody, writeLine, type Header, type Reply } from '#shared/proto/agentproto/index.ts';
import type { Action, Protocol } from '#shared/proto/protocol.ts';
import { closeStream } from '#shared/proto/yamux.ts';
import type { ActionContext, ActionStream, Served } from './feature.ts';
import type { Conn } from './stream.ts';

/** The refusal of err: a Fail's code ("code: message" as the error, as the
 * Go agent wrote its errors), anything else failed. */
export function refusal(err: unknown): Reply {
  if (err instanceof Fail) return { ok: false, code: err.code, error: err.message === err.code ? err.code : `${err.code}: ${err.message}` };
  return { ok: false, code: 'failed', error: err instanceof Error ? err.message : String(err) };
}

/** The reply line of a result: undefined is none. */
export function resultLine(v: unknown): { line: string; body?: Buffer } {
  if (v === undefined) return { line: '{"ok":true}\n' };
  const b = Buffer.from(JSON.stringify(v));
  if (b.length > MAX_BODY) return { line: JSON.stringify(refusal(new Fail('too_large', 400, `result of ${b.length} bytes`))) + '\n' };
  // A large result follows the reply line, which the core reads and bounds.
  if (b.length > MAX_INLINE) return { line: `{"ok":true,"plugin_length":${b.length}}\n`, body: b };
  return { line: `{"ok":true,"plugin":${b.toString('utf8')}}\n` };
}

/** Writes a result's reply (and body). */
export async function writeResult(conn: Conn, v: unknown): Promise<void> {
  const { line, body } = resultLine(v);
  await write(conn.stream, line);
  if (body) await write(conn.stream, body);
}

/** An abort controller that also ends when the core closes conn's stream
 * (reading nothing more of it) or signal ends. */
export function untilClosed(conn: Conn, signal: AbortSignal): AbortController {
  const ac = new AbortController();
  const stop = () => ac.abort(new Error('the core closed the stream'));
  if (signal.aborted) stop();
  signal.addEventListener('abort', stop, { once: true });
  const rest = conn.reader.release();
  rest.on('end', stop).on('close', stop).on('error', stop);
  rest.resume();
  conn.stream.once('close', stop);
  ac.signal.addEventListener('abort', () => signal.removeEventListener('abort', stop), { once: true });
  return ac;
}

/** A feature's machine side as an agent runs it. */
export interface Running {
  readonly protocol: Protocol;
  readonly served: Served;
}

/** Serves one plugin op on conn and closes its stream. */
export async function servePlugin(
  conn: Conn,
  h: Header,
  features: ReadonlyMap<string, Running>,
  ctx: (signal: AbortSignal) => ActionContext,
  signal: AbortSignal,
  logger: Logger,
): Promise<void> {
  const id = h.plugin ?? '';
  let answered = false;
  const answer = async (rep: Reply) => {
    answered = true;
    await writeLine(conn.stream, rep);
  };
  try {
    let raw: unknown = h.params;
    if (h.params_length && h.params_length > 0) {
      try {
        raw = await readBody(conn.reader, h.params_length);
      } catch (e) {
        throw new Fail('bad_params', 400, `${id}: ${(e as Error).message}`);
      }
    }
    const f = features.get(id);
    if (!f) throw new Fail('unknown_plugin', 400, `unknown plugin ${JSON.stringify(id)}`);
    if (!h.action) throw new Fail('bad_params', 400, `${id}: no action`);
    const handler = Object.hasOwn(f.served.actions, h.action) ? (f.served.actions as Record<string, unknown>)[h.action] : undefined;
    const def: Action | undefined = Object.hasOwn(f.protocol.actions, h.action) ? f.protocol.actions[h.action] : undefined;
    if (typeof handler !== 'function' || !def) throw new Fail('bad_params', 400, `unknown action ${JSON.stringify(h.action)}`);
    const parsed = def.params.safeParse(raw ?? {});
    if (!parsed.success) throw new Fail('bad_params', 400, `${id}.${h.action}: ${parsed.error.message}`);
    if (def.stream) {
      const s: ActionStream = {
        stream: conn.stream,
        reader: conn.reader,
        reply: async (result) => {
          answered = true;
          await writeResult(conn, result);
        },
      };
      await (handler as (p: unknown, c: ActionContext, s: ActionStream) => Promise<void>)(parsed.data, ctx(signal), s);
      return;
    }
    const ac = untilClosed(conn, signal);
    try {
      const result = await (handler as (p: unknown, c: ActionContext) => unknown)(parsed.data, ctx(ac.signal));
      answered = true;
      await writeResult(conn, result);
    } finally {
      ac.abort();
    }
  } catch (e) {
    if (!(e instanceof Fail)) logger(`plugin ${id}.${h.action ?? ''}: ${(e as Error)?.stack ?? e}`);
    if (!answered) await answer(refusal(e)).catch(() => {});
  } finally {
    closeStream(conn.stream);
  }
}
