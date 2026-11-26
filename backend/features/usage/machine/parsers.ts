// What the CLIs' logs say of each API response, as records: Claude Code's
// projects/**/*.jsonl, Codex's rollouts, Grok's session updates (and its
// legacy unified log), Kimi Code's wire logs. A line is decoded only when
// it carries its log's marker of usage (quoted, so the words are JSON's
// own, not text in a string), and of it only the usage members are kept:
// no prompt, reply or tool output.
//
// A record's and an entry's JSON are the cost cache's (machine database,
// cache.ts), as the Go agent wrote them: a node of either build reads the
// other's cache.
import { posix } from 'node:path';
import { firstNonEmpty, isObj, obj, parseTime, str, timeOf } from './env.ts';

/** One API response's tokens, as a log recorded it (the cache's member
 * names; empty members are left out of its JSON). */
export interface Rec {
  /** The key duplicates share (the same response logged twice). */
  k: string;
  /** When, in Unix seconds. */
  t: number;
  m: string;
  /** The session of a legacy Grok record, whose model the session's
   * events name. */
  s: string;
  /** The project. */
  j: string;
  /** Input not cached, cache reads, cache writes of 5 minutes and of an
   * hour, output, reasoning (part of the output), API calls. */
  i: number;
  c: number;
  w: number;
  h: number;
  o: number;
  r: number;
  n: number;
  /** The prompt length the tier is chosen by (0: i+c+w+h). */
  x: number;
  /** A failed attempt (legacy Grok retries), counted only. */
  e: boolean;
  /** The provider whose model served it, where the CLI is a client of many
   * (OpenCode's providerID): it picks the price table. */
  v: string;
  /** The cost the CLI recorded (OpenCode's), for a model the tables do not
   * price. */
  p: number;
}

/** A record with the members given. */
export const rec = (r: Partial<Rec>): Rec => ({
  k: '',
  t: 0,
  m: '',
  s: '',
  j: '',
  i: 0,
  c: 0,
  w: 0,
  h: 0,
  o: 0,
  r: 0,
  n: 0,
  x: 0,
  e: false,
  v: '',
  p: 0,
  ...r,
});

/** The rollout parser's state at an entry's offset. */
export interface CodexState {
  model?: string;
  turn?: string;
  project?: string;
  /** A token_usage_record was seen: token_count events are replays. */
  new?: boolean;
  /** The last token_count's total input. */
  total?: number;
}

/** What the cache keeps of a log: its size and time (ns) when read, the
 * offset after its last complete line (a log that grew is read on from
 * there; not a compressed one), its records, Grok's session models and
 * the rollout parser's state. */
export interface Entry {
  kind: string;
  size: number;
  mtime: number;
  off: number;
  records: Rec[];
  models?: Record<string, string>;
  codex?: CodexState;
}

/** Kinds of logs. */
export const LOG = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  grokLegacy: 'grok-legacy',
  grokEvents: 'grok-events',
  antigravity: 'antigravity',
  kimi: 'kimi',
  opencode: 'opencode',
} as const;

/** The provider of a kind of log. */
export function providerOf(kind: string): string {
  switch (kind) {
    case LOG.claude:
    case LOG.codex:
    case LOG.antigravity:
    case LOG.kimi:
    case LOG.opencode:
      return kind;
  }
  return 'grok';
}

/** A count of tokens: a whole number, 0 for anything else. */
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);

/** An FNV-1a hash (64 bits) of parts, each ended by a NUL, in base 36:
 * the key a record's duplicates share, as the Go agent makes it. The hash
 * is kept as two 32-bit halves (h × prime = h·2^40 + h·0x1b3). */
export function hashKey(...parts: string[]): string {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  const mix = (b: number) => {
    lo = (lo ^ b) >>> 0;
    const l = lo * 0x1b3;
    hi = (hi * 0x1b3 + Math.floor(l / 0x100000000) + ((lo << 8) >>> 0)) >>> 0;
    lo = l >>> 0;
  };
  for (const p of parts) {
    if (/^[\x00-\x7f]*$/.test(p)) for (let i = 0; i < p.length; i++) mix(p.charCodeAt(i));
    else for (const b of Buffer.from(p, 'utf8')) mix(b);
    mix(0);
  }
  return ((BigInt(hi) << 32n) | BigInt(lo)).toString(36);
}

/** An RFC 3339 time in Unix seconds, else the start of s as a time
 * without a zone (UTC); 0 when it is none. */
export function isoTime(s: unknown): number {
  if (typeof s !== 'string' || s === '') return 0;
  const t = parseTime(s, 'required');
  if (t !== undefined) return t;
  const start = s.slice(0, 19);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(start) ? (parseTime(start, 'optional') ?? 0) : 0;
}

/** The name of a working directory's project: its last name. */
export function projectName(cwd: string): string {
  cwd = cwd.replace(/\/+$/, '');
  return cwd ? posix.basename(cwd) : '';
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

// --- Claude Code ---------------------------------------------------------

/** The cache reads and writes of a Claude usage, as the spend counts them:
 * writes of 5 minutes and of an hour, the total as 5 minutes when it is
 * not broken down. */
export function claudeUsage(u: Record<string, unknown>): { i: number; c: number; w: number; h: number; o: number; r: number } {
  const b = obj(u.cache_creation);
  let w = int(b.ephemeral_5m_input_tokens);
  const h = int(b.ephemeral_1h_input_tokens);
  if (w === 0 && h === 0) w = int(u.cache_creation_input_tokens);
  return {
    i: int(u.input_tokens),
    c: int(u.cache_read_input_tokens),
    w,
    h,
    o: int(u.output_tokens),
    r: int(obj(u.output_tokens_details).thinking_tokens),
  };
}

/** An assistant message's usage: one record per response, keyed by
 * (requestId, message.id) as duplicates of forked and streamed sessions
 * are; "<synthetic>" messages are errors. */
export function claudeLine(file: string, line: string, out: Rec[]): void {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  const d = parse(line);
  const msg = obj(d?.message);
  if (!d || msg.role !== 'assistant' || msg.model === '<synthetic>') return;
  const u = claudeUsage(obj(msg.usage));
  if (u.i === 0 && u.c === 0 && u.w === 0 && u.h === 0 && u.o === 0) return;
  const id = str(msg.id) || str(d.uuid);
  const proj = projectName(str(d.cwd)) || posix.basename(posix.dirname(file));
  out.push(
    rec({ k: hashKey('claude', str(d.requestId), id), t: isoTime(d.timestamp), m: str(msg.model) || 'unknown', j: proj, ...u, n: 1 }),
  );
}

// --- Codex ---------------------------------------------------------------

function codexRecord(u: Record<string, unknown>, model: string, proj: string, t: number): Rec | null {
  const input = int(u.input_tokens);
  const cached = int(u.cached_input_tokens);
  const cw = int(u.cache_write_input_tokens);
  const output = int(u.output_tokens);
  if (input === 0 && output === 0 && cw === 0) return null;
  // input_tokens includes the cached tokens; the tier goes by the whole
  // prompt.
  return rec({
    t,
    m: model,
    j: proj,
    i: Math.max(input - cached, 0),
    c: cached,
    w: cw,
    o: output,
    r: int(u.reasoning_output_tokens),
    n: 1,
    x: input,
  });
}

/** A rollout's parser, on from state: token_usage_record events (one per
 * response, keyed by response_id, the model by turn_id), else the legacy
 * token_count events (last_token_usage; an event whose total did not move
 * is a replay), which after the first token_usage_record are replays too.
 * state() is where it ended. */
export function codexParser(file: string, st: CodexState | undefined, out: Rec[]) {
  const turnModel = new Map<string, string>();
  let lastModel = st?.model ?? '';
  let lastTurn = st?.turn ?? '';
  let proj = st?.project ?? '';
  let seenNew = st?.new ?? false;
  let prevTotal = st?.total ?? -1;
  if (lastTurn) turnModel.set(lastTurn, lastModel);
  return {
    line(line: string): void {
      if (line.includes('"session_meta"')) {
        const cwd = str(obj(parse(line)?.payload).cwd);
        if (cwd) proj = projectName(cwd);
      } else if (line.includes('"turn_context"')) {
        const p = obj(parse(line)?.payload);
        const model = str(p.model);
        if (!model) return;
        lastModel = model;
        lastTurn = str(p.turn_id);
        if (lastTurn) turnModel.set(lastTurn, model);
        if (!proj && str(p.cwd)) proj = projectName(str(p.cwd));
      } else if (line.includes('"token_usage_record"')) {
        const d = parse(line);
        if (!d) return;
        seenNew = true;
        const p = obj(d.payload);
        const model = firstNonEmpty(turnModel.get(str(p.turn_id)) ?? '', lastModel, 'unknown');
        const r = codexRecord(obj(p.usage), model, proj, isoTime(d.timestamp));
        if (!r) return;
        r.k = str(p.response_id) ? hashKey('codex', str(p.response_id)) : hashKey('codex-ord', file, JSON.stringify(d.ordinal ?? null));
        out.push(r);
      } else if (line.includes('"token_count"')) {
        if (seenNew) return;
        const d = parse(line);
        const p = obj(d?.payload);
        if (!d || p.type !== 'token_count') return;
        const info = obj(p.info);
        const total = int(obj(info.total_token_usage).input_tokens);
        if (prevTotal >= 0 && total === prevTotal) return;
        prevTotal = total;
        if (!isObj(info.last_token_usage)) return;
        const r = codexRecord(info.last_token_usage, firstNonEmpty(lastModel, 'unknown'), proj, isoTime(d.timestamp));
        if (!r) return;
        r.k = hashKey('codex-tc', file, str(d.timestamp), JSON.stringify(info.last_token_usage));
        out.push(r);
      }
    },
    state(): CodexState {
      const s: CodexState = {};
      if (lastModel) s.model = lastModel;
      if (lastTurn) s.turn = lastTurn;
      if (proj) s.project = proj;
      if (seenNew) s.new = true;
      if (prevTotal >= 0) s.total = prevTotal;
      return s;
    },
  };
}

// --- Grok ----------------------------------------------------------------

/** A session's project, by its directory (sessions/<project>/<session>/). */
function grokProject(file: string): string {
  let dir = posix.basename(posix.dirname(posix.dirname(file)));
  try {
    dir = decodeURIComponent(dir);
  } catch {
    // as it is
  }
  return projectName(dir);
}

/** A turn_completed update: the turn's usage, by model when modelUsage
 * has them. */
export function grokUpdate(file: string, line: string, out: Rec[]): void {
  if (!line.includes('"turn_completed"') || !line.includes('"usage"')) return;
  const d = parse(line);
  const params = obj(d?.params);
  const update = obj(params.update);
  if (!d || update.sessionUpdate !== 'turn_completed') return;
  const t = timeOf(obj(params._meta).agentTimestampMs) || timeOf(d.timestamp);
  if (t === 0) return;
  const proj = grokProject(file);
  const usage = obj(update.usage);
  const byModel = isObj(usage.modelUsage) && Object.keys(usage.modelUsage).length ? usage.modelUsage : { unknown: usage };
  for (const m of Object.keys(byModel).sort()) {
    const u = obj(byModel[m]);
    const input = int(u.inputTokens);
    const output = int(u.outputTokens);
    if (input === 0 && output === 0) continue;
    const cached = int(u.cachedReadTokens);
    const created = int(u.cacheCreationTokens);
    const calls = Math.max(int(u.modelCalls), 1);
    // inputTokens includes the cached reads; the tier goes by the average
    // prompt of the turn's calls.
    out.push(
      rec({
        t,
        m: m || 'unknown',
        j: proj,
        i: Math.max(input - cached, 0),
        c: cached,
        w: created,
        o: output,
        r: int(u.reasoningTokens),
        n: calls,
        x: Math.max(Math.trunc((input + created) / calls), 1),
      }),
    );
  }
}

/** A turn_started event: the model of its session, the first one named. */
export function grokEvent(line: string, models: Record<string, string>): void {
  if (!line.includes('"turn_started"') || !line.includes('"model_id"')) return;
  const d = obj(parse(line));
  const sid = str(d.session_id);
  const model = str(d.model_id);
  if (sid && model && !Object.hasOwn(models, sid)) models[sid] = model;
}

/** A legacy shell.turn.inference_done event (the model comes from the
 * session's events); retries are counted. */
export function grokUnified(line: string, out: Rec[]): void {
  if (!line.includes('inference_done') && !line.includes('inference_retry')) return;
  const d = parse(line);
  if (!d) return;
  const t = isoTime(d.ts);
  if (t === 0) return;
  const msg = str(d.msg);
  if (msg.includes('inference_retry')) {
    out.push(rec({ t, e: true }));
    return;
  }
  if (!msg.includes('inference_done')) return;
  const c = obj(d.ctx);
  const prompt = int(c.prompt_tokens);
  const cached = int(c.cached_prompt_tokens);
  out.push(
    rec({ t, s: str(d.sid), i: Math.max(prompt - cached, 0), c: cached, o: int(c.completion_tokens), r: int(c.reasoning_tokens), n: 1 }),
  );
}

// --- Kimi Code -----------------------------------------------------------

/** Kimi Code's model identifiers as the price table names them:
 * "kimi-code/k3.1-pro" → "kimi-k3.1-pro", "kimi-code/kimi-for-coding" →
 * "kimi-for-coding". */
export function kimiModelName(m: string): string {
  m = m.trim();
  if (!m) return 'unknown';
  if (m.startsWith('kimi-code/')) m = m.slice('kimi-code/'.length);
  else if (m.startsWith('moonshot/')) m = m.slice('moonshot/'.length);
  if (/^k[0-9]/.test(m)) m = 'kimi-' + m;
  return m;
}

/** A usage.record line of a wire.jsonl of proj. */
export function kimiLine(proj: string, line: string, out: Rec[]): void {
  if (!line.includes('"usage.record"')) return;
  const d = parse(line);
  if (!d || d.type !== 'usage.record') return;
  const t = timeOf(d.time);
  if (t === 0) return;
  const u = obj(d.usage);
  const i = Math.max(int(u.inputOther), 0);
  const c = Math.max(int(u.inputCacheRead), 0);
  const w = Math.max(int(u.inputCacheCreation), 0);
  const o = Math.max(int(u.output), 0);
  if (i + c + w + o === 0) return;
  out.push(rec({ t, m: kimiModelName(str(d.model)), j: proj, i, c, w, o, n: 1 }));
}

/** A wire.jsonl's project from its session's state.json (cwd or
 * workDir), given as its text (null when unread), else the workspace
 * directory's name (wd_<name>_<12 hex>). */
export function kimiProject(file: string, state: string | null): string {
  let dir = posix.dirname(file);
  if (posix.basename(posix.dirname(dir)) === 'agents') dir = posix.dirname(posix.dirname(dir));
  if (state !== null) {
    const st = obj(parse(state));
    const p = projectName(firstNonEmpty(str(st.cwd), str(st.workDir)));
    if (p) return p;
  }
  const ws = posix.basename(posix.dirname(dir));
  if (ws.startsWith('wd_')) {
    const rest = ws.slice(3);
    const i = rest.lastIndexOf('_');
    if (i > 0 && /^[0-9a-fA-F]{12}$/.test(rest.slice(i + 1))) return rest.slice(0, i);
    if (rest) return rest;
  }
  return '';
}

/** The state.json of a wire.jsonl's session. */
export function kimiStateFile(file: string): string {
  let dir = posix.dirname(file);
  if (posix.basename(posix.dirname(dir)) === 'agents') dir = posix.dirname(posix.dirname(dir));
  return posix.join(dir, 'state.json');
}
