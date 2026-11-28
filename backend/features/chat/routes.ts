// The chat feature's HTTP routes:
//
//   - GET    /api/m/{id}/p/chat/agents: which agent kinds with a chat the
//     machine can start ({agents}), from a chat host that serves
//     (not_running otherwise); refused on a read-only hub (read_only), as
//     the host asks the agents' programs;
//   - POST   /api/m/{id}/p/chat/agents: the same, starting the host when
//     none serves, audited as chat.agents;
//   - GET    /api/m/{id}/p/chat/chats: its chats, closed ones included
//     ({chats}), from a chat host that serves (not_running otherwise);
//   - POST   /api/m/{id}/p/chat/sessions?kind=&cwd=&cursor=: the sessions
//     an agent kept for a directory ({sessions, nextCursor}); a change, as
//     listing them may run the agent; audited as chat.sessions;
//   - POST   /api/m/{id}/p/chat/new: a new chat from the body {kind, cwd,
//     resume?, import?, options?{model, effort, mode, models}} ({chat}), audited as
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
//     hub last read them (StatesSnapshot);
//   - GET    /api/p/chat/ws: the page's WebSocket (wire.ts).
//
// Errors are {error: code, message} (errors.ts). A read-only hub refuses
// every change, and leaves out of a chat what only a reader who may change
// it sees (its agent's standard error), here and on the WebSocket.
import { z } from 'zod';
import * as agentkinds from '#shared/agents/kinds.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { Fail } from '#kernel/fail.ts';
import type { FeatureContext } from '#kernel/feature.ts';
import { readBody } from '#kernel/http/app.ts';
import type { Client, Ctx } from '#kernel/http/env.ts';
import { auditText } from './audit.ts';
import { badRequest, failOf, protocolError } from './errors.ts';
import type { ChatSwitchboard } from './switchboard.ts';
import { invalidateOverviews, overviews } from './overview.ts';
import type { Timing } from './timing.ts';
import { HubCode } from './wire.ts';

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
/** Whether a body's options are in their bounds: valid model and effort,
 * a mode of chatproto's, models non-empty valid values. */
const validStartOptions = (o: { model: string; effort: string; mode: string; models?: string[] | null }): boolean =>
  validOption(o.model) &&
  validOption(o.effort) &&
  (!o.mode || (chat.MODES as readonly string[]).includes(o.mode)) &&
  (o.models ?? []).every((m) => m !== '' && validOption(m));

const opt = z
  .string()
  .nullish()
  .transform((v) => v ?? '');

/** What a new chat starts with (chatproto Options). */
const startOptionsBody = z
  .object({ model: opt, effort: opt, mode: opt, models: z.array(z.string()).max(chat.MAX_START_MODELS).nullish() })
  .nullish();

/** The body of POST new. */
const newBody = z.object({
  kind: opt,
  cwd: opt,
  resume: opt,
  import: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
  workspace: opt,
  options: startOptionsBody,
});

const optSeq = z.number().int().positive().nullish();
const optMaxBytes = z
  .number()
  .int()
  .min(2048)
  .max(512 * 1024)
  .nullish();

const modelsBody = z.object({
  kind: opt,
  cwd: opt,
  refresh: z.boolean().nullish(),
});

const forkBody = z.object({
  chat: opt,
  upToSeq: optSeq,
  title: opt,
  maxBytes: optMaxBytes,
  workspace: opt,
});

const switchBody = z.object({
  chat: opt,
  targetKind: opt,
  upToSeq: optSeq,
  maxBytes: optMaxBytes,
  workspace: opt,
  options: startOptionsBody,
});

export interface WorkspaceEnvLookup {
  (
    machine: string,
    workspace: string,
    client: Client,
  ): Promise<{
    presets: string[];
    env: Record<string, string>;
    names: string[];
    missing: string[];
    locked: boolean;
    logFailed?: boolean;
    corrupt?: boolean;
  }>;
}

const OK = {};

/** The request's own signal, bounded by ms. */
const bounded = (c: Ctx, ms: number) => AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(ms)]);

export function routes(ctx: FeatureContext, board: ChatSwitchboard, timing: Timing, workspaceEnv?: WorkspaceEnvLookup): void {
  const api = ctx.machineApi;
  const query = (c: Ctx, name: string) => c.req.query(name) ?? '';
  /** One request of the machine's chat host within ms: start starts the
   * host when none serves, agent configures it first. */
  const ask = async (c: Ctx, req: chat.Request, o: { ms?: number; start: boolean; agent?: boolean }) => {
    try {
      return await board.request(c.var.machine.id, req, {
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
  /** Resolves fresh workspace vault environment variables for a new, forked,
   * or switched chat. Fails closed (no env) when no workspace is provided or
   * the vault is locked/unlinked; logs injected names and preset ids to audit. */
  const resolveWorkspaceEnv = async (
    c: Ctx,
    workspace: string,
  ): Promise<{
    env: Record<string, string> | undefined;
    vault: { injected: number; locked?: boolean; missing?: string[]; logFailed?: boolean; corrupt?: boolean } | undefined;
  }> => {
    if (workspace && (Buffer.byteLength(workspace) > 128 || /[\x00-\x1f\x7f]/.test(workspace)))
      throw badRequest('workspace: a workspace id');
    if (!workspace || !workspaceEnv) return { env: undefined, vault: undefined };
    const resolved = await workspaceEnv(c.var.machine.id, workspace, c.var.client);
    if (resolved.presets.length === 0 && !resolved.corrupt) return { env: undefined, vault: undefined };
    let env: Record<string, string> | undefined;
    if (resolved.names.length) {
      env = resolved.env;
      c.var.audit.vault_env = resolved.names;
      c.var.audit.vault_presets = resolved.presets;
    }
    const vault = {
      injected: resolved.names.length,
      ...(resolved.locked ? { locked: true } : {}),
      ...(resolved.missing.length ? { missing: resolved.missing } : {}),
      ...(resolved.logFailed ? { logFailed: true } : {}),
      ...(resolved.corrupt ? { corrupt: true } : {}),
    };
    return { env, vault };
  };

  /** Which kinds the machine can start; start starts its host. */
  const agents = async (c: Ctx, start: boolean) => {
    const kinds = chatKinds();
    const refresh = query(c, 'refresh') === '1' || query(c, 'refresh') === 'true';
    try {
      const out = await board.agents(c.var.machine.id, {
        kinds,
        start,
        refresh,
        signal: bounded(c, timing.shortMs),
      });
      return c.json({ agents: out });
    } catch (e) {
      throw failOf(e);
    }
  };
  api.get('/agents', async (c) => {
    // The host asks the agents' programs: nothing a reader starts.
    if (ctx.readOnly) throw new Fail(HubCode.ReadOnly, 403, 'read-only mode');
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
    const refresh = query(c, 'refresh') === '1' || query(c, 'refresh') === 'true';
    if (!chatKinds().includes(kind)) throw badRequest('kind: an agent kind with a chat');
    c.var.audit.kind = kind;
    cwdParam(c, cwd);
    if (Buffer.byteLength(cursor) > MAX_CURSOR) throw badRequest('cursor: too long');
    // Listing them may run the agent (Codex, ACP agents); served through the
    // hub's bounded TTL + coalescing cache unless ?refresh=1 is requested.
    try {
      const res = await board.sessions(c.var.machine.id, {
        kind,
        cwd,
        cursor,
        refresh,
        signal: bounded(c, timing.sessionsMs),
      });
      return c.json({ sessions: res.sessions, nextCursor: res.nextCursor });
    } catch (e) {
      throw failOf(e);
    }
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
    if (o && !validStartOptions(o)) throw badRequest('options: model, effort, a mode and models');
    const { env, vault } = await resolveWorkspaceEnv(c, b.workspace);
    c.var.audit.cwd = auditText(b.cwd);
    if (b.resume) Object.assign(c.var.audit, { resume: b.resume, import: b.import });
    if (o?.mode) c.var.audit.mode = o.mode;
    const options = o && {
      ...(o.model ? { model: o.model } : {}),
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.mode ? { mode: o.mode } : {}),
      ...(o.models?.length ? { models: o.models } : {}),
    };
    // A Claude Code chat runs on Anthropic's Agent SDK, which the machine
    // gets first: asked again although it failed lately, the user asking.
    try {
      await board.ensureSdk(c.var.machine.id, b.kind, bounded(c, timing.sdkMs), {
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
        ...(env ? { env } : {}),
      },
      { start: true, agent: true },
    );
    const id = res.chat?.id;
    if (typeof id !== 'string' || !chat.validChatID(id)) throw failOf(protocolError("the chat host's answer has no chat"));
    c.var.audit.chat = id;
    return c.json({ chat: res.chat, ...(vault ? { vault } : {}) });
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
      await board.handoff(c.var.machine.id, id, bounded(c, timing.handoffMs));
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
    board.invalidateMachine(c.var.machine.id);
    invalidateOverviews(board);
    return c.json(OK);
  });

  /** Cached models for a provider kind (never starts host or probes agent). */
  api.get('/models', async (c) => {
    const kind = query(c, 'kind');
    if (!chatKinds().includes(kind)) throw badRequest('kind: an agent kind with a chat');
    const res = await ask(c, { op: chat.Op.Models, kind, refresh: false }, { start: false });
    return c.json({ models: res.models ?? [], ...(res.fetchedAt ? { fetchedAt: res.fetchedAt } : {}) });
  });

  /** Refreshes (or fetches) models for a provider kind, starting the host and
   * ensuring the Claude SDK if needed. Accepts JSON body or query params. */
  api.post('/models', ctx.mutating('models'), async (c) => {
    let b: z.output<typeof modelsBody> = { kind: '', cwd: '', refresh: undefined };
    const raw = Buffer.from(await readBody(c.req.raw, MAX_BODY))
      .toString('utf8')
      .trim();
    if (raw) {
      try {
        const r = modelsBody.safeParse(JSON.parse(raw));
        if (!r.success) throw r.error;
        b = r.data;
      } catch {
        throw badRequest('the body: {kind, cwd?, refresh?}');
      }
    }
    const kind = b.kind || query(c, 'kind');
    const cwd = b.cwd || query(c, 'cwd');
    const refresh = b.refresh ?? query(c, 'refresh') !== '0';
    if (!chatKinds().includes(kind)) throw badRequest('kind: an agent kind with a chat');
    if (cwd && !validCwd(cwd)) throw badRequest('cwd: a clean absolute path');
    c.var.audit.kind = kind;
    if (cwd) c.var.audit.cwd = auditText(cwd);
    c.var.audit.refresh = refresh;
    try {
      await board.ensureSdk(c.var.machine.id, kind, bounded(c, timing.sdkMs), {
        retry: true,
        audit: (event, fields) => ctx.audit.log(c.var.who, event, fields),
      });
    } catch (e) {
      throw failOf(e);
    }
    const res = await ask(
      c,
      { op: chat.Op.Models, kind, ...(cwd ? { cwd } : {}), refresh },
      { ms: timing.sessionsMs, start: true, agent: true },
    );
    return c.json({ models: res.models ?? [], ...(res.fetchedAt ? { fetchedAt: res.fetchedAt } : {}) });
  });

  /** Forks a chat (optionally up to upToSeq) into a new chat. */
  api.post('/fork', ctx.mutating('fork'), async (c) => {
    let b: z.output<typeof forkBody> = { chat: '', upToSeq: undefined, title: '', maxBytes: undefined, workspace: '' };
    const raw = Buffer.from(await readBody(c.req.raw, MAX_BODY))
      .toString('utf8')
      .trim();
    if (raw) {
      try {
        const r = forkBody.safeParse(JSON.parse(raw));
        if (!r.success) throw r.error;
        b = r.data;
      } catch {
        throw badRequest('the body: {chat, upToSeq?, title?, workspace?}');
      }
    }
    const id = b.chat || query(c, 'chat');
    if (!chat.validChatID(id)) throw badRequest("chat: a chat's id");
    const upToSeq = b.upToSeq ?? undefined;
    const maxBytes = b.maxBytes ?? undefined;
    const title = b.title ? b.title.trim() : '';
    if (title && Buffer.byteLength(title) > 512) throw badRequest('title: too long');
    const { env, vault } = await resolveWorkspaceEnv(c, b.workspace);
    c.var.audit.chat = id;
    if (upToSeq) c.var.audit.upToSeq = upToSeq;
    let kind = board.watch.snapshot().machines[c.var.machine.id]?.states.find((s) => s.id === id)?.kind;
    if (!kind) {
      try {
        const listed = await ask(c, { op: chat.Op.Chats }, { start: false });
        const chats = (listed.chats ?? []) as unknown as chat.Chat[];
        kind = chats.find((ch) => ch.id === id)?.kind;
      } catch {
        // Host not running or unreachable; Op.Fork below will start/report it.
      }
    }
    if (kind) {
      try {
        await board.ensureSdk(c.var.machine.id, kind, bounded(c, timing.sdkMs), {
          retry: true,
          audit: (event, fields) => ctx.audit.log(c.var.who, event, fields),
        });
      } catch (e) {
        throw failOf(e);
      }
    }
    const res = await ask(
      c,
      {
        op: chat.Op.Fork,
        chat: id,
        ...(upToSeq ? { upToSeq } : {}),
        ...(title ? { title } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(env ? { env } : {}),
      },
      { ms: timing.sessionsMs, start: true, agent: true },
    );
    const newId = res.chat?.id;
    if (typeof newId !== 'string' || !chat.validChatID(newId)) throw failOf(protocolError("the chat host's answer has no chat"));
    c.var.audit.forked_chat = newId;
    return c.json({ chat: res.chat, ...(vault ? { vault } : {}) });
  });

  /** Exports conversation context from a chat and creates a new chat of targetKind. */
  api.post('/switch', ctx.mutating('switch'), async (c) => {
    let b: z.output<typeof switchBody>;
    try {
      const r = switchBody.safeParse(JSON.parse(Buffer.from(await readBody(c.req.raw, MAX_BODY)).toString('utf8')));
      if (!r.success) throw r.error;
      b = r.data;
    } catch {
      throw badRequest('the body: {chat, targetKind, options?, upToSeq?, workspace?}');
    }
    if (!chat.validChatID(b.chat)) throw badRequest("chat: a chat's id");
    if (!chatKinds().includes(b.targetKind)) throw badRequest('targetKind: an agent kind with a chat');
    const o = b.options;
    if (o && !validStartOptions(o)) throw badRequest('options: model, effort, a mode and models');
    const { env, vault } = await resolveWorkspaceEnv(c, b.workspace);
    c.var.audit.chat = b.chat;
    c.var.audit.targetKind = b.targetKind;
    if (b.upToSeq) c.var.audit.upToSeq = b.upToSeq;
    if (o?.mode) c.var.audit.mode = o.mode;
    const options = o && {
      ...(o.model ? { model: o.model } : {}),
      ...(o.effort ? { effort: o.effort } : {}),
      ...(o.mode ? { mode: o.mode } : {}),
      ...(o.models?.length ? { models: o.models } : {}),
    };
    try {
      await board.ensureSdk(c.var.machine.id, b.targetKind, bounded(c, timing.sdkMs), {
        retry: true,
        audit: (event, fields) => ctx.audit.log(c.var.who, event, fields),
      });
    } catch (e) {
      throw failOf(e);
    }
    const res = await ask(
      c,
      {
        op: chat.Op.Switch,
        chat: b.chat,
        targetKind: b.targetKind,
        ...(b.upToSeq ? { upToSeq: b.upToSeq } : {}),
        ...(b.maxBytes != null ? { maxBytes: b.maxBytes } : {}),
        ...(options ? { options } : {}),
        ...(env ? { env } : {}),
      },
      { ms: timing.sessionsMs, start: true, agent: true },
    );
    const newId = res.chat?.id;
    if (typeof newId !== 'string' || !chat.validChatID(newId)) throw failOf(protocolError("the chat host's answer has no chat"));
    c.var.audit.switched_chat = newId;
    return c.json({ chat: res.chat, ...(vault ? { vault } : {}) });
  });

  /** Exports a chat's conversation as a bounded Markdown digest (default) or
   * lossless raw JSON (?format=json). Optional ?maxBytes= sets the Markdown
   * byte budget (2 KiB – 512 KiB). */
  api.get('/export', async (c) => {
    const id = chatParam(c);
    const rawSeq = query(c, 'upToSeq');
    let upToSeq: number | undefined;
    if (rawSeq !== '') {
      const n = Number(rawSeq);
      if (!/^[1-9][0-9]*$/.test(rawSeq) || !Number.isSafeInteger(n)) throw badRequest('upToSeq: a positive sequence number');
      upToSeq = n;
    }
    const rawFormat = query(c, 'format');
    if (rawFormat !== '' && rawFormat !== 'markdown' && rawFormat !== 'json') {
      throw badRequest('format: markdown or json');
    }
    const format = rawFormat === 'json' ? 'json' : undefined;
    const rawMax = query(c, 'maxBytes');
    let maxBytes: number | undefined;
    if (rawMax !== '') {
      const n = Number(rawMax);
      if (!/^[1-9][0-9]*$/.test(rawMax) || !Number.isSafeInteger(n) || n < 2048 || n > 512 * 1024) {
        throw badRequest('maxBytes: an integer between 2048 and 524288');
      }
      maxBytes = n;
    }
    const res = await ask(
      c,
      {
        op: chat.Op.Export,
        chat: id,
        ...(upToSeq ? { upToSeq } : {}),
        ...(format ? { format } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      },
      { start: false },
    );
    if (format === 'json') {
      let data = res.data as chat.ChatExport | undefined;
      if (data && ctx.readOnly && Array.isArray(data.events)) {
        data = { ...data, events: data.events.map(chat.redactedEvent) };
      }
      return c.json({ format: 'json', data: data ?? null });
    }
    return c.json({ markdown: res.markdown ?? '' });
  });

  ctx.api.get('/hosts', async (c) =>
    c.json({ hosts: await overviews(board, c.req.raw.signal, timing.overviewMs, { refresh: query(c, 'refresh') === '1' }) }),
  );
  ctx.api.get('/states', (c) => c.json(board.watch.snapshot()));
  ctx.api.get('/ws', (c) => {
    if (!c.env.upgrade) throw new Fail('upgrade_required', 426);
    const who = c.var.who;
    return c.env.upgrade((ch) => board.connectPage(ch, who), { compress: true });
  });
}
