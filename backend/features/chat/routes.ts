// The chat feature's HTTP routes:
//
//   - GET    /api/m/{id}/p/chat/agents: which agent kinds with a chat the
//     machine can start ({agents}), from a chat host that serves
//     (not_running otherwise); refused on a read-only core (read_only), as
//     the host asks the agents' programs;
//   - POST   /api/m/{id}/p/chat/agents: the same, starting the host when
//     none serves, audited as chat.agents;
//   - GET    /api/m/{id}/p/chat/chats: its chats, closed ones included
//     ({chats}), from a chat host that serves (not_running otherwise);
//   - POST   /api/m/{id}/p/chat/sessions?kind=&cwd=&cursor=: the sessions
//     an agent kept for a directory ({sessions, nextCursor}); a change, as
//     listing them may run the agent; audited as chat.sessions;
//   - POST   /api/m/{id}/p/chat/new: a new chat from the body {kind, cwd,
//     resume?, import?, options?{model, effort, mode}} ({chat}), audited as
//     chat.new;
//   - POST   /api/m/{id}/p/chat/close?chat=: ends a chat's agent and keeps
//     the chat ({}), audited as chat.close;
//   - DELETE /api/m/{id}/p/chat/chat?chat=: forgets a chat and its log
//     ({}), audited as chat.delete;
//   - POST   /api/m/{id}/p/chat/archive?chat= and unarchive?chat=: puts a
//     chat away and takes it back ({}), audited as chat.archive and
//     chat.unarchive;
//   - POST   /api/m/{id}/p/chat/seen?chat=&seq=: the user saw the chat up to
//     seq, which ends its done status for every page ({}), audited as
//     chat.seen;
//   - POST   /api/m/{id}/p/chat/handoff?chat=: ends the chat's agent so that
//     its session goes on in a terminal ({}), refused while a turn runs
//     (busy), audited as chat.handoff;
//   - POST   /api/m/{id}/p/chat/trust?cwd= and untrust?cwd=: trusts a
//     directory and those below it on the machine, or takes back the trust
//     that covers it ({}), audited as chat.trust and chat.untrust;
//   - GET    /api/m/{id}/p/chat/trusted: the trusted folders ({trusted})
//     from a serving host (not_running otherwise); POST: the same,
//     starting the host, audited as chat.trusted;
//   - POST   /api/m/{id}/p/chat/host/stop: ends the machine's chat host
//     ({}), refused with busy while a chat works or waits, audited as
//     chat.host_stop;
//   - GET    /api/p/chat/hosts: every machine with its chat host
//     (overview.ts);
//   - GET    /api/p/chat/states: the chats' states of every machine as the
//     core last read them (StatesSnapshot);
//   - GET    /api/p/chat/ws: the page's WebSocket (wire.ts).
//
// Errors are {error: code, message} (errors.ts). A read-only core refuses
// every change, and leaves out of a chat what only a reader who may change
// it sees (its agent's standard error), here and on the WebSocket.
import { z } from 'zod';
import * as agentkinds from '#shared/agents/kinds.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { Fail } from '#kernel/fail.ts';
import type { FeatureContext } from '#kernel/feature.ts';
import { readBody } from '#kernel/http/app.ts';
import type { Ctx } from '#kernel/http/env.ts';
import { auditText } from './audit.ts';
import { badRequest, failOf, protocolError } from './errors.ts';
import type { ChatHub } from './hub.ts';
import { overviews } from './overview.ts';
import type { Timing } from './timing.ts';
import { CoreCode } from './wire.ts';

/** The longest body of POST new. */
const MAX_BODY = 64 << 10;
/** The longest directory a route takes. */
const MAX_PATH = 4096;
/** The longest cursor of a session listing. */
const MAX_CURSOR = 4096;

/** The form of an agent's session id a route takes (the chat host's own
 * check). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** The ids of the agent kinds with a chat. */
const chatKinds = (): string[] => agentkinds.chatKinds().map((k) => k.id);

/** Whether s is a clean absolute path of a machine (POSIX): what Go's
 * path.Clean leaves as it is. */
export function validCwd(s: string): boolean {
  if (!s.startsWith('/') || Buffer.byteLength(s) > MAX_PATH || s.includes('\0')) return false;
  if (s === '/') return true;
  return s
    .slice(1)
    .split('/')
    .every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Whether s may be the value of an option of a new chat. */
const validOption = (s: string): boolean => Buffer.byteLength(s) <= 256 && !/[\x00-\x1f\x7f]/.test(s);

const opt = z
  .string()
  .nullish()
  .transform((v) => v ?? '');

/** The body of POST new. */
const newBody = z.object({
  kind: opt,
  cwd: opt,
  resume: opt,
  import: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
  options: z.object({ model: opt, effort: opt, mode: opt }).nullish(),
});

const OK = {};

/** The request's own signal, bounded by ms. */
const bounded = (c: Ctx, ms: number) => AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(ms)]);

export function routes(ctx: FeatureContext, hub: ChatHub, timing: Timing): void {
  const api = ctx.machineApi;
  const query = (c: Ctx, name: string) => c.req.query(name) ?? '';
  /** One request of the machine's chat host within ms: start starts the
   * host when none serves, agent configures it first. */
  const ask = async (c: Ctx, req: chat.Request, o: { ms?: number; start: boolean; agent?: boolean }) => {
    try {
      return await hub.request(c.var.machine.id, req, {
        start: o.start,
        agent: o.agent ?? false,
        signal: bounded(c, o.ms ?? timing.shortMs),
      });
    } catch (e) {
      throw failOf(e);
    }
  };
  /** The route's ?chat=, audited. */
  const chatParam = (c: Ctx): string => {
    const id = query(c, 'chat');
    if (!chat.validChatID(id)) throw badRequest("chat: a chat's id");
    c.var.audit.chat = id;
    return id;
  };
  const cwdParam = (c: Ctx, cwd: string): string => {
    if (!validCwd(cwd)) throw badRequest('cwd: a clean absolute path');
    c.var.audit.cwd = auditText(cwd);
    return cwd;
  };

  /** Which kinds the machine can start; start starts its host. */
  const agents = async (c: Ctx, start: boolean) => {
    const kinds = chatKinds();
    const res = await ask(c, { op: chat.Op.Agents, kinds }, { start });
    const out = (res.agents ?? [])
      .filter((a) => kinds.includes(a.kind))
      .map((a) => ({
        kind: a.kind,
        available: a.available ?? false,
        ...(a.version ? { version: a.version } : {}),
        ...(a.reason ? { reason: a.reason } : {}),
      }));
    return c.json({ agents: out });
  };
  api.get('/agents', async (c) => {
    // The host asks the agents' programs: nothing a reader starts.
    if (ctx.readOnly) throw new Fail(CoreCode.ReadOnly, 403, 'read-only mode');
    return agents(c, false);
  });
  api.post('/agents', ctx.mutating('agents'), (c) => agents(c, true));

  api.get('/chats', async (c) => {
    const res = await ask(c, { op: chat.Op.Chats }, { start: false });
    let chats = (res.chats ?? []) as unknown as chat.Chat[];
    if (ctx.readOnly) chats = chats.map(chat.redactedChat);
    return c.json({ chats });
  });

  api.post('/sessions', ctx.mutating('sessions'), async (c) => {
    const kind = query(c, 'kind');
    const cwd = query(c, 'cwd');
    const cursor = query(c, 'cursor');
    if (!chatKinds().includes(kind)) throw badRequest('kind: an agent kind with a chat');
    c.var.audit.kind = kind;
    cwdParam(c, cwd);
    if (Buffer.byteLength(cursor) > MAX_CURSOR) throw badRequest('cursor: too long');
    // Listing them may run the agent (Codex, ACP agents).
    const res = await ask(
      c,
      { op: chat.Op.Sessions, kind, cwd, ...(cursor ? { cursor } : {}) },
      { ms: timing.sessionsMs, start: true, agent: true },
    );
    return c.json({ sessions: res.sessions ?? [], nextCursor: res.nextCursor ?? '' });
  });

  api.post('/new', ctx.mutating('new'), async (c) => {
    const shape = 'the body: {kind, cwd, resume?, import?, options?}';
    let b: z.output<typeof newBody>;
    try {
      const r = newBody.safeParse(JSON.parse(Buffer.from(await readBody(c.req.raw, MAX_BODY)).toString('utf8')));
      if (!r.success) throw r.error;
      b = r.data;
    } catch {
      throw badRequest(shape);
    }
    if (!chatKinds().includes(b.kind)) throw badRequest('kind: an agent kind with a chat');
    c.var.audit.kind = b.kind;
    if (!validCwd(b.cwd)) throw badRequest('cwd: a clean absolute path');
    if (b.resume && !SESSION_ID.test(b.resume)) throw badRequest('resume: a session id');
    if (b.import && !b.resume) throw badRequest('import needs a session to resume');
    const o = b.options;
    if (o && (!validOption(o.model) || !validOption(o.effort) || (o.mode && !(chat.MODES as readonly string[]).includes(o.mode))))
      throw badRequest('options: model, effort and a mode');
    c.var.audit.cwd = auditText(b.cwd);
    if (b.resume) Object.assign(c.var.audit, { resume: b.resume, import: b.import });
    if (o?.mode) c.var.audit.mode = o.mode;
    const options = o && {
      ...(o.model ? { model: o.model } : {}),
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.mode ? { mode: o.mode } : {}),
    };
    // A Claude Code chat runs on Anthropic's Agent SDK, which the machine
    // gets first: asked again although it failed lately, the user asking.
    try {
      await hub.ensureSdk(c.var.machine.id, b.kind, bounded(c, timing.sdkMs), {
        retry: true,
        audit: (event, fields) => ctx.audit.log(c.var.who, event, fields),
      });
    } catch (e) {
      throw failOf(e);
    }
    const res = await ask(
      c,
      {
        op: chat.Op.New,
        kind: b.kind,
        cwd: b.cwd,
        ...(b.resume ? { resume: b.resume } : {}),
        ...(b.import ? { import: true } : {}),
        ...(options ? { options } : {}),
      },
      { start: true, agent: true },
    );
    const id = res.chat?.id;
    if (typeof id !== 'string' || !chat.validChatID(id)) throw failOf(protocolError("the chat host's answer has no chat"));
    c.var.audit.chat = id;
    return c.json({ chat: res.chat });
  });

  /** A request on a chat that answers nothing but OK. */
  const simple = (op: chat.Op) => async (c: Ctx) => {
    await ask(c, { op, chat: chatParam(c) }, { start: true });
    return c.json(OK);
  };
  api.post('/close', ctx.mutating('close'), simple(chat.Op.Close));
  api.delete('/chat', ctx.mutating('delete'), simple(chat.Op.Delete));
  api.post('/archive', ctx.mutating('archive'), simple(chat.Op.Archive));
  api.post('/unarchive', ctx.mutating('unarchive'), simple(chat.Op.Unarchive));

  api.post('/seen', ctx.mutating('seen'), async (c) => {
    const id = chatParam(c);
    const text = query(c, 'seq');
    const seq = Number(text);
    if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(seq)) throw badRequest('seq: a sequence number');
    c.var.audit.seq = seq;
    await ask(c, { op: chat.Op.Seen, chat: id, ...(seq ? { seq } : {}) }, { start: true });
    return c.json(OK);
  });

  api.post('/handoff', ctx.mutating('handoff'), async (c) => {
    const id = chatParam(c);
    try {
      await hub.handoff(c.var.machine.id, id, bounded(c, timing.handoffMs));
    } catch (e) {
      throw failOf(e);
    }
    return c.json(OK);
  });

  /** Asks the machine's chat host to trust the directory ?cwd=, or to take
   * its trust back (op), audited with the directory. */
  const folderTrust = (op: chat.Op) => async (c: Ctx) => {
    const cwd = cwdParam(c, query(c, 'cwd'));
    await ask(c, { op, cwd }, { start: true });
    return c.json(OK);
  };
  api.post('/trust', ctx.mutating('trust'), folderTrust(chat.Op.Trust));
  api.post('/untrust', ctx.mutating('untrust'), folderTrust(chat.Op.Untrust));

  const trusted = async (c: Ctx, start: boolean) => {
    const res = await ask(c, { op: chat.Op.Trusted }, { start });
    return c.json({ trusted: res.trusted ?? [] });
  };
  api.get('/trusted', (c) => trusted(c, false));
  api.post('/trusted', ctx.mutating('trusted'), (c) => trusted(c, true));

  api.post('/host/stop', ctx.mutating('host_stop'), async (c) => {
    await ask(c, { op: chat.Op.Shutdown }, { start: false });
    return c.json(OK);
  });

  ctx.api.get('/hosts', async (c) => c.json({ hosts: await overviews(hub, c.req.raw.signal, timing.overviewMs) }));
  ctx.api.get('/states', (c) => c.json(hub.watch.snapshot()));
  ctx.api.get('/ws', (c) => {
    if (!c.env.upgrade) throw new Fail('upgrade_required', 426);
    const who = c.var.who;
    return c.env.upgrade((ch) => hub.connectPage(ch, who), { compress: true });
  });
}
