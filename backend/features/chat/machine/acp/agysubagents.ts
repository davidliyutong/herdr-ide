// Antigravity (`agy acp --stdio`) subagent visibility: `agy acp` emits only a
// generic `tool_call` ("Run invoke_subagent", kind "other", PascalCase input)
// and marks it completed as soon as the child conversation is spawned, sending
// no `session/update` notifications for the subagent's own turns. Antigravity
// writes the parent's spawn response (with the child's `conversationId`) and
// the child's step-by-step JSONL transcript under `<agy dir>/brain/<id>/
// .system_generated/logs/transcript.jsonl`.
//
// This module normalizes `invoke_subagent` calls into `think` subagent tool
// calls (matching Claude Code / Codex), tails the parent and child JSONL
// transcripts read-only (refusing symlinks and bounding every read), emits the
// child's thoughts, tool calls and messages with `Event.parent` set to the
// spawning `toolCallId`, and publishes active subagents in `Chat.tasks`.
import { openSync, closeSync, readSync, lstatSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { validSessionId } from '#shared/agents/kinds.ts';
import { SLUG } from '#shared/lib/brand.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import { UPDATE_MESSAGE, UPDATE_THOUGHT, UPDATE_TOOL_CALL } from './items.ts';
import { clip, isObj, MAX_NAME, str, type Obj } from './state.ts';

/** How often active subagents' transcripts are polled while running. */
export const DEFAULT_POLL_MS = 250;
/** Most subagents tracked per session; oldest settled/tracked entry evicted. */
export const MAX_SUBAGENTS = 64;
/** Most bytes read from a single transcript in one poll tick. */
const MAX_READ_BYTES = 1 << 20;
/** Most bytes kept in an incomplete line buffer before discarding the line. */
const MAX_LINE_BYTES = 1 << 20;
/** Most characters kept from a subagent tool call's text output. */
const MAX_OUTPUT_CHARS = 32_768;
/** Most events emitted for a single subagent transcript. */
const MAX_CHILD_EVENTS = 1024;
/** Most characters kept in a subagent summary. */
const MAX_SUMMARY_CHARS = 4096;

const CHILD_CREATED_RE = /Created the following subagent:\s*(\{[\s\S]*?\})/;
const SENDER_MSG_RE = /\[Message\][^\n]*\bsender=([0-9a-f-]{36})\b[^\n]*\bcontent=([\s\S]*?)(?:\n<\/SYSTEM_MESSAGE>|$)/;
const EXIT_CODE_RE = /^Command exited with code (-?\d+)\./m;
const HEADER_STAMP_RE = /^(?:(?:Created At|Completed At): [^\n]*\n)+/;

/** Whether an ACP tool call update represents Antigravity's `invoke_subagent`. */
export function isAgySubagentCall(raw: Obj): boolean {
  if (raw.name === 'invoke_subagent' || raw.title === 'Run invoke_subagent') return true;
  const input = isObj(raw.rawInput) ? raw.rawInput : isObj(raw.args) ? raw.args : undefined;
  return !!input && typeof input.TypeName === 'string' && typeof input.Prompt === 'string';
}

/** Extracts normalized fields from an `invoke_subagent` rawInput/args object. */
export function agySubagentInput(raw: Obj): {
  typeName: string;
  role: string;
  prompt: string;
  model: string;
  rawInput: Obj;
} {
  const src = isObj(raw.rawInput) ? raw.rawInput : isObj(raw.args) ? raw.args : {};
  const typeName = (str(src.TypeName) ?? '').trim();
  const role = (str(src.Role) ?? '').trim();
  const prompt = (str(src.Prompt) ?? '').trim();
  const model = (str(src.Model) ?? '').trim();
  const rawInput: Obj = { ...src };
  if (typeName && !str(rawInput.agent_type)) rawInput.agent_type = typeName;
  if (role && !str(rawInput.description)) rawInput.description = role;
  if (prompt && !str(rawInput.prompt)) rawInput.prompt = prompt;
  if (model && model !== 'inherit' && !str(rawInput.model)) rawInput.model = model;
  return { typeName, role, prompt, model: model === 'inherit' ? '' : model, rawInput };
}

export interface SubagentMetaState {
  status: string;
  childId?: string;
  role: string;
  typeName: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastTool?: string;
  summary?: string;
  error?: string;
}

/** Builds a normalized ACP `tool_call` update for an Antigravity subagent. */
export function normalizeAgySubagentCall(raw: Obj, meta: SubagentMetaState): Obj {
  const { typeName, role, rawInput } = agySubagentInput(raw);
  const title = clip(role || typeName || 'Subagent', MAX_NAME);
  const prevMeta = isObj(raw._meta) ? { ...raw._meta } : {};
  const prevOwn = isObj(prevMeta[SLUG]) ? { ...(prevMeta[SLUG] as Obj) } : {};
  const sub: Obj = {
    tool: 'invoke_subagent',
    status: meta.status,
    agentPath: role || typeName || 'subagent',
    ...(meta.childId ? { threadId: meta.childId } : {}),
  };
  const task: Obj = {
    type: 'subagent',
    ...(meta.childId ? { taskId: meta.childId } : {}),
    ...(role ? { description: role } : {}),
    ...(typeName ? { subagentType: typeName } : {}),
    backgrounded: true,
    stoppable: false,
    ...(meta.tokens ? { tokens: meta.tokens } : {}),
    ...(meta.toolUses ? { toolUses: meta.toolUses } : {}),
    ...(meta.durationMs ? { durationMs: meta.durationMs } : {}),
    ...(meta.lastTool && meta.status === 'in_progress' ? { lastTool: meta.lastTool } : {}),
    ...(meta.summary ? { summary: meta.summary } : {}),
    ...(meta.error ? { error: meta.error } : {}),
  };
  prevOwn.subagent = sub;
  prevOwn.task = task;
  prevMeta[SLUG] = prevOwn;
  const out: Obj = {
    ...raw,
    sessionUpdate: UPDATE_TOOL_CALL,
    kind: 'think',
    title,
    status: meta.status,
    rawInput,
    _meta: prevMeta,
  };
  if (meta.summary && !raw.content) {
    out.content = [{ type: 'content', content: { type: 'text', text: meta.summary } }];
  }
  return out;
}

/** Resolves Antigravity's data directories from argv and env (matching
 * `backend/machine/agents/agy.ts` conventions). */
export function agyDataDirs(argv: readonly string[], env: Readonly<Record<string, string>>, cwd: string): string[] {
  const home = (env.HOME ?? '').trim();
  let appData = '';
  let geminiDir = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break;
    const next = argv[i + 1] ?? '';
    if ((a === '--app-data-dir' || a === '--app_data_dir') && next) appData = next.trim();
    else if (a.startsWith('--app-data-dir=')) appData = a.slice('--app-data-dir='.length).trim();
    else if (a.startsWith('--app_data_dir=')) appData = a.slice('--app_data_dir='.length).trim();
    else if ((a === '--gemini-dir' || a === '--gemini_dir') && next) geminiDir = next.trim();
    else if (a.startsWith('--gemini-dir=')) geminiDir = a.slice('--gemini-dir='.length).trim();
    else if (a.startsWith('--gemini_dir=')) geminiDir = a.slice('--gemini_dir='.length).trim();
  }
  const expand = (p: string): string => {
    if (!p) return '';
    if (p.startsWith('~/') && home) return posix.normalize(posix.join(home, p.slice(2)));
    if (posix.isAbsolute(p)) return posix.normalize(p);
    return '';
  };
  const baseGemini = expand(geminiDir) || (home ? posix.join(home, geminiDir || '.gemini') : '');
  const out: string[] = [];
  const push = (p: string) => {
    const n = p ? posix.normalize(p) : '';
    if (n && !out.includes(n)) out.push(n);
  };
  if (appData) {
    const abs = expand(appData);
    if (abs) push(abs);
    else if (baseGemini) push(posix.join(baseGemini, appData));
  }
  if (baseGemini) {
    push(posix.join(baseGemini, 'antigravity-cli'));
    push(posix.join(baseGemini, 'antigravity'));
    push(posix.join(baseGemini, 'antigravity-ide'));
  }
  // Ignore unused cwd parameter when relative appData wasn't supplied.
  void cwd;
  return out;
}

/** Path of a conversation's transcript inside an Antigravity data dir. */
export function transcriptPath(agyDir: string, sessionId: string): string {
  return posix.join(agyDir, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

/** Safely opens a user-owned regular file (rejecting symlinks and special files)
 * and reads up to MAX_READ_BYTES starting from `offset`. */
function safeReadChunk(path: string, offset: number, uid: number): { bytes: Buffer; nextOffset: number; size: number } | null {
  let lst;
  try {
    lst = lstatSync(path);
  } catch {
    return null;
  }
  if (!lst.isFile() || lst.isSymbolicLink()) return null;
  if (uid >= 0 && lst.uid !== uid) return null;
  if (lst.size <= offset) return { bytes: Buffer.alloc(0), nextOffset: offset, size: lst.size };
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  let rst;
  try {
    rst = lstatSync(real);
  } catch {
    return null;
  }
  if (!rst.isFile() || rst.dev !== lst.dev || rst.ino !== lst.ino) return null;
  const toRead = Math.min(lst.size - offset, MAX_READ_BYTES);
  const buf = Buffer.allocUnsafe(toRead);
  let fd = -1;
  try {
    fd = openSync(real, 'r');
    const n = readSync(fd, buf, 0, toRead, offset);
    return { bytes: buf.subarray(0, n), nextOffset: offset + n, size: lst.size };
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // closed
      }
    }
  }
}

/** Incremental JSONL tailer for a single regular file. */
class JsonlTailer {
  path: string;
  private offset = 0;
  private rem = '';
  private readonly uid: number;

  constructor(path: string, uid: number, startOffset = 0) {
    this.path = path;
    this.uid = uid;
    this.offset = startOffset;
  }

  /** Fast-forwards to the current end of the file (if it exists). */
  seekEnd(): void {
    try {
      const st = lstatSync(this.path);
      if (st.isFile() && !st.isSymbolicLink() && (this.uid < 0 || st.uid === this.uid)) {
        this.offset = st.size;
      }
    } catch {
      // File may not exist yet; start at 0 when created.
    }
  }

  /** Reads and parses newly appended complete JSONL objects. */
  poll(): Obj[] {
    const chunk = safeReadChunk(this.path, this.offset, this.uid);
    if (!chunk || chunk.bytes.length === 0) return [];
    this.offset = chunk.nextOffset;
    const text = this.rem + chunk.bytes.toString('utf8');
    const lines = text.split('\n');
    const tail = lines.pop() ?? '';
    this.rem = Buffer.byteLength(tail) <= MAX_LINE_BYTES ? tail : '';
    const out: Obj[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || Buffer.byteLength(trimmed) > MAX_LINE_BYTES) continue;
      try {
        const v: unknown = JSON.parse(trimmed);
        if (isObj(v)) out.push(v);
      } catch {
        // Ignore partial or malformed lines.
      }
    }
    return out;
  }
}

/** Decodes Antigravity transcript tool_call args (values are often JSON-encoded
 * strings such as `"\"ls\""` or `"5000"`). */
export function decodeTranscriptArgs(rawArgs: unknown): Obj {
  if (!isObj(rawArgs)) return {};
  const out: Obj = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
        trimmed === 'true' ||
        trimmed === 'false' ||
        /^-?\d+(?:\.\d+)?$/.test(trimmed)
      ) {
        try {
          out[k] = JSON.parse(trimmed);
          continue;
        } catch {
          // keep as string
        }
      }
    }
    out[k] = v;
  }
  return out;
}

/** Maps an Antigravity transcript tool call to an ACP tool_call update. */
export function mapTranscriptToolCall(toolCallId: string, name: string, rawArgs: unknown): Obj {
  const args = decodeTranscriptArgs(rawArgs);
  let kind = 'other';
  let title = name;
  const rawInput: Obj = { ...args };
  const locations: Array<{ path: string; line?: number }> = [];

  const addLoc = (p: unknown, line?: unknown) => {
    if (typeof p === 'string' && p.trim() !== '') {
      const n = typeof line === 'number' && Number.isFinite(line) && line > 0 ? Math.trunc(line) : undefined;
      locations.push(n !== undefined ? { path: p, line: n } : { path: p });
    }
  };

  switch (name) {
    case 'run_command': {
      kind = 'execute';
      const cmd = str(args.CommandLine) ?? str(args.command) ?? '';
      const summary = str(args.toolSummary) ?? '';
      title = clip(summary || cmd || name, MAX_NAME);
      if (cmd && !rawInput.command) rawInput.command = cmd;
      break;
    }
    case 'read_file':
    case 'view_file':
    case 'view_file_outline':
    case 'view_code_item': {
      kind = 'read';
      const path = str(args.Path) ?? str(args.AbsolutePath) ?? str(args.path) ?? '';
      addLoc(path, args.StartLine);
      title = clip(path || name, MAX_NAME);
      if (path && !rawInput.path) rawInput.path = path;
      break;
    }
    case 'edit_file':
    case 'write_file':
    case 'write_to_file':
    case 'replace_file_content':
    case 'multi_replace_file_content': {
      kind = 'edit';
      const path = str(args.Path) ?? str(args.TargetFile) ?? str(args.path) ?? '';
      addLoc(path);
      title = clip(path || name, MAX_NAME);
      if (path && !rawInput.path) rawInput.path = path;
      break;
    }
    case 'grep_search':
    case 'find_by_name':
    case 'list_dir': {
      kind = 'search';
      const q = str(args.Query) ?? str(args.Pattern) ?? str(args.SearchPath) ?? str(args.DirectoryPath) ?? '';
      title = clip(q || name, MAX_NAME);
      if (q && !rawInput.query) rawInput.query = q;
      break;
    }
    case 'search_web':
    case 'read_url_content': {
      kind = 'fetch';
      const q = str(args.query) ?? str(args.Url) ?? str(args.url) ?? '';
      title = clip(q || name, MAX_NAME);
      if (q && !rawInput.query) rawInput.query = q;
      break;
    }
    case 'invoke_subagent': {
      kind = 'think';
      const role = str(args.Role) ?? str(args.TypeName) ?? 'Subagent';
      title = clip(role, MAX_NAME);
      if (str(args.TypeName)) rawInput.agent_type = str(args.TypeName);
      if (str(args.Role)) rawInput.description = str(args.Role);
      if (str(args.Prompt)) rawInput.prompt = str(args.Prompt);
      break;
    }
    case 'send_message': {
      kind = 'other';
      title = 'send_message';
      break;
    }
    default: {
      kind = 'other';
      title = clip(name, MAX_NAME);
      break;
    }
  }

  return {
    sessionUpdate: UPDATE_TOOL_CALL,
    toolCallId,
    kind,
    title,
    status: 'in_progress',
    rawInput,
    ...(locations.length > 0 ? { locations } : {}),
  };
}

/** Strips repeated Created At / Completed At timestamps from Antigravity
 * transcript GENERIC tool output blocks and bounds output length. */
function cleanGenericOutput(text: string): string {
  let out = text.replace(HEADER_STAMP_RE, '').trim();
  if (out.length > MAX_OUTPUT_CHARS) {
    out = out.slice(0, MAX_OUTPUT_CHARS) + '\n…';
  }
  return out;
}

/** Extracts `conversationId` from an `invoke_subagent` GENERIC output block. */
export function parseSubagentCreated(content: string): { conversationId: string; logPath: string } | null {
  const m = CHILD_CREATED_RE.exec(content);
  if (!m) return null;
  try {
    const parsed: unknown = JSON.parse(m[1]!);
    if (!isObj(parsed)) return null;
    const id = str(parsed.conversationId)?.trim() ?? '';
    if (!validSessionId(id)) return null;
    let logPath = '';
    const uri = str(parsed.logAbsoluteUri)?.trim() ?? '';
    if (uri.startsWith('file://')) {
      try {
        logPath = decodeURIComponent(new URL(uri).pathname);
      } catch {
        // fallback to derived path
      }
    }
    return { conversationId: id, logPath };
  } catch {
    return null;
  }
}

/** Extracts `{ sender, content }` from a parent SYSTEM_MESSAGE sent by a child. */
export function parseChildMessage(content: string): { sender: string; content: string } | null {
  const m = SENDER_MSG_RE.exec(content);
  if (!m) return null;
  const sender = m[1]!;
  if (!validSessionId(sender)) return null;
  return { sender, content: m[2]!.trim() };
}

interface PendingChildTool {
  id: string;
  name: string;
  update: Obj;
  sentMessageToParent?: string;
}

interface TrackedSubagent {
  toolCallId: string;
  raw: Obj;
  role: string;
  typeName: string;
  /** Whether ACP already reported `completed` for the spawn tool call itself. */
  acpCompleted: boolean;
  /** Child conversation UUID once discovered from parent transcript. */
  childId: string;
  tailer: JsonlTailer | null;
  pendingTools: PendingChildTool[];
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  startedMs: number;
  startedAt: string;
  tokens: number;
  toolUses: number;
  lastTool: string;
  summary: string;
  emitted: number;
  sentReplyToParent: boolean;
  hadFinalResponse: boolean;
}

export interface AgySubagentHost {
  emit(ev: chat.Event): void;
  updateTasks(tasks: chat.BackgroundTask[]): void;
  logf(line: string): void;
}

export interface AgySubagentOptions {
  /** Antigravity data directories to search for `brain/<id>/...`. */
  dirs: readonly string[];
  /** Poll interval in milliseconds (defaults to DEFAULT_POLL_MS). */
  pollMs?: number;
  /** Expected file owner UID (-1 disables UID check in tests). */
  uid?: number;
}

/** Tracks Antigravity subagents spawned by an ACP session, streaming their
 * nested transcript items under `Event.parent = <invoke_subagent toolCallId>`
 * and publishing live entries to `Chat.tasks`. */
export class AgySubagentTracker {
  private readonly host: AgySubagentHost;
  private readonly dirs: readonly string[];
  private readonly pollMs: number;
  private readonly uid: number;

  private parentSid = '';
  private parentDir = '';
  private parentTailer: JsonlTailer | null = null;
  private readonly subs = new Map<string, TrackedSubagent>();
  private readonly byChildId = new Map<string, TrackedSubagent>();
  private readonly earlyCreated: Array<{ conversationId: string; logPath: string }> = [];
  private readonly earlyReports = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTasksJson = '';
  private stopped = false;

  constructor(host: AgySubagentHost, opts: AgySubagentOptions) {
    this.host = host;
    this.dirs = opts.dirs;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  }

  /** Associates the tracker with the opened parent ACP session id. */
  setSession(sessionId: string): void {
    if (!validSessionId(sessionId)) return;
    this.parentSid = sessionId;
    this.resolveParentTailer(true);
  }

  /** Locates the parent session's `transcript.jsonl` if present on disk. */
  private resolveParentTailer(seekToEnd: boolean): JsonlTailer | null {
    if (this.parentTailer) return this.parentTailer;
    if (!this.parentSid) return null;
    for (const d of this.dirs) {
      const p = transcriptPath(d, this.parentSid);
      try {
        const st = lstatSync(p);
        if (st.isFile() && !st.isSymbolicLink() && (this.uid < 0 || st.uid === this.uid)) {
          this.parentDir = d;
          const tailer = new JsonlTailer(p, this.uid);
          if (seekToEnd) tailer.seekEnd();
          this.parentTailer = tailer;
          return tailer;
        }
      } catch {
        // not created yet in this dir
      }
    }
    return null;
  }

  /** Resolves a validated child transcript path under one of the trusted dirs. */
  private childTranscriptPath(childId: string, hintedPath: string): string {
    const expectedSuffix = posix.join('brain', childId, '.system_generated', 'logs', 'transcript.jsonl');
    const dirs = this.parentDir ? [this.parentDir, ...this.dirs.filter((d) => d !== this.parentDir)] : [...this.dirs];
    if (hintedPath) {
      const cleanHint = posix.normalize(hintedPath);
      for (const d of dirs) {
        if (cleanHint === posix.join(d, expectedSuffix)) return cleanHint;
      }
    }
    for (const d of dirs) {
      const p = posix.join(d, expectedSuffix);
      try {
        const st = lstatSync(p);
        if (st.isFile() && !st.isSymbolicLink() && (this.uid < 0 || st.uid === this.uid)) return p;
      } catch {
        // try next
      }
    }
    return dirs.length > 0 ? posix.join(dirs[0]!, expectedSuffix) : '';
  }

  /** Intercepts an ACP `tool_call` / `tool_call_update` for `invoke_subagent`.
   * Returns the normalized update to pass on to `Items`, or null if unchanged. */
  onToolUpdate(raw: Obj): Obj | null {
    if (this.stopped) return null;
    const id = str(raw.toolCallId);
    if (!id) return null;
    let sub = this.subs.get(id);
    if (!sub) {
      if (!isAgySubagentCall(raw)) return null;
      if (this.subs.size >= MAX_SUBAGENTS) {
        const oldestKey = this.subs.keys().next().value;
        if (oldestKey) {
          const old = this.subs.get(oldestKey);
          this.subs.delete(oldestKey);
          if (old?.childId) this.byChildId.delete(old.childId);
        }
      }
      const { typeName, role } = agySubagentInput(raw);
      const now = Date.now();
      sub = {
        toolCallId: id,
        raw: { ...raw },
        role,
        typeName,
        acpCompleted: false,
        childId: '',
        tailer: null,
        pendingTools: [],
        status: 'in_progress',
        startedMs: now,
        startedAt: new Date(now).toISOString(),
        tokens: 0,
        toolUses: 0,
        lastTool: '',
        summary: '',
        emitted: 0,
        sentReplyToParent: false,
        hadFinalResponse: false,
      };
      this.subs.set(id, sub);
    } else {
      sub.raw = { ...sub.raw, ...raw };
    }

    const acpStatus = str(raw.status) ?? '';
    if (acpStatus === 'failed' || acpStatus === 'cancelled') {
      sub.status = acpStatus;
      this.publishTasks();
      this.maybeStopTimer();
      return this.buildParentUpdate(sub);
    }
    if (acpStatus === 'completed') {
      sub.acpCompleted = true;
    }

    // If a child creation was already read before this tool call arrived, link it now.
    if (!sub.childId && this.earlyCreated.length > 0) {
      const next = this.earlyCreated.shift()!;
      this.linkChild(sub, next.conversationId, next.logPath);
    }

    this.ensureTimer();
    this.publishTasks();
    return this.buildParentUpdate(sub);
  }

  /** Called when the parent turn completes: flushes transcripts once and
   * settles any unlinked calls whose ACP spawn already completed (e.g. when
   * transcripts do not exist on disk). */
  onTurnEnd(aborted = false): void {
    if (this.stopped) return;
    this.poll();
    let changed = false;
    for (const sub of this.subs.values()) {
      if (sub.status !== 'in_progress') continue;
      // If we never found a child transcript on disk, or the child already sent
      // its reply / finished its final response and the parent turn is now done, settle it.
      if (aborted && !sub.childId && !sub.acpCompleted) {
        sub.status = 'cancelled';
        this.emitParentUpdate(sub);
        changed = true;
      } else if ((!sub.childId && sub.acpCompleted) || sub.sentReplyToParent || (sub.hadFinalResponse && sub.pendingTools.length === 0)) {
        this.completeSubagent(sub);
        changed = true;
      }
    }
    if (changed) {
      this.publishTasks();
      this.maybeStopTimer();
    }
  }

  /** Tracked spawns are settled here, independently of the ACP parent turn. */
  tracks(toolCallId: string): boolean {
    return this.subs.has(toolCallId);
  }

  /** Performs one synchronous poll of the parent and active child transcripts. */
  poll(): void {
    if (this.stopped) return;
    const parent = this.resolveParentTailer(false);
    if (parent) {
      for (const step of parent.poll()) {
        this.handleParentStep(step);
      }
    }
    for (const sub of this.subs.values()) {
      if (sub.status !== 'in_progress' || !sub.childId) continue;
      if (!sub.tailer) {
        const p = this.childTranscriptPath(sub.childId, '');
        if (p) sub.tailer = new JsonlTailer(p, this.uid);
      }
      if (!sub.tailer) continue;
      const lines = sub.tailer.poll();
      if (lines.length === 0) continue;
      for (const step of lines) {
        this.handleChildStep(sub, step);
      }
      if (sub.status === 'in_progress') {
        this.emitParentUpdate(sub);
        this.publishTasks();
      }
    }
    this.maybeStopTimer();
  }

  /** Stops polling and settles open transcript items when the session ends. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const sub of this.subs.values()) {
      if (sub.status !== 'in_progress') continue;
      for (const pending of sub.pendingTools) {
        this.emitChild(sub, pending.id, { ...pending.update, status: 'cancelled' });
      }
      sub.pendingTools = [];
      sub.status = 'cancelled';
      this.emitParentUpdate(sub);
    }
    if (this.lastTasksJson !== '') {
      this.lastTasksJson = '';
      this.host.updateTasks([]);
    }
  }

  private ensureTimer(): void {
    if (this.stopped || this.timer || this.pollMs <= 0) return;
    this.timer = setInterval(() => {
      try {
        this.poll();
      } catch (e) {
        this.host.logf(`agy subagent poll: ${(e as Error).message}`);
      }
    }, this.pollMs);
    this.timer.unref?.();
  }

  private maybeStopTimer(): void {
    if (!this.timer) return;
    for (const sub of this.subs.values()) {
      if (sub.status === 'in_progress') return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private handleParentStep(step: Obj): void {
    const type = str(step.type) ?? '';
    const content = str(step.content) ?? '';
    if (!content) return;
    if (type === 'GENERIC') {
      const created = parseSubagentCreated(content);
      if (created && !this.byChildId.has(created.conversationId)) {
        const target = this.findUnlinkedSubagent();
        if (target) {
          this.linkChild(target, created.conversationId, created.logPath);
        } else if (this.earlyCreated.length < MAX_SUBAGENTS) {
          this.earlyCreated.push(created);
        }
      }
      return;
    }
    if (type === 'SYSTEM_MESSAGE') {
      const msg = parseChildMessage(content);
      if (!msg) return;
      const sub = this.byChildId.get(msg.sender);
      if (sub) {
        if (msg.content && !sub.summary) sub.summary = clip(msg.content, MAX_SUMMARY_CHARS);
        sub.sentReplyToParent = true;
        this.completeSubagent(sub);
      } else if (this.earlyReports.size < MAX_SUBAGENTS) {
        this.earlyReports.set(msg.sender, clip(msg.content, MAX_SUMMARY_CHARS));
      }
    }
  }

  private findUnlinkedSubagent(): TrackedSubagent | undefined {
    for (const sub of this.subs.values()) {
      if (sub.status === 'in_progress' && !sub.childId) return sub;
    }
    return undefined;
  }

  private linkChild(sub: TrackedSubagent, childId: string, hintedPath: string): void {
    sub.childId = childId;
    this.byChildId.set(childId, sub);
    const p = this.childTranscriptPath(childId, hintedPath);
    if (p) sub.tailer = new JsonlTailer(p, this.uid);
    const earlySummary = this.earlyReports.get(childId);
    if (earlySummary !== undefined) {
      this.earlyReports.delete(childId);
      sub.summary = earlySummary;
      sub.sentReplyToParent = true;
      this.completeSubagent(sub);
      return;
    }
    this.emitParentUpdate(sub);
    this.publishTasks();
  }

  private handleChildStep(sub: TrackedSubagent, step: Obj): void {
    if (sub.emitted >= MAX_CHILD_EVENTS) return;
    const type = str(step.type) ?? '';
    const idx = typeof step.step_index === 'number' ? step.step_index : sub.emitted;
    const prefix = `agy-sub-${sub.childId.slice(0, 8)}`;

    if (type === 'PLANNER_RESPONSE') {
      const inTok = typeof step.input_tokens === 'number' ? step.input_tokens : 0;
      const outTok = typeof step.output_tokens === 'number' ? step.output_tokens : 0;
      const cacheTok = typeof step.cache_read_tokens === 'number' ? step.cache_read_tokens : 0;
      if (inTok + outTok + cacheTok > 0) {
        sub.tokens += inTok + outTok;
      }

      const thinking = (str(step.thinking) ?? '').trim();
      if (thinking) {
        this.emitChild(sub, `${prefix}-s${idx}-t`, {
          sessionUpdate: UPDATE_THOUGHT,
          content: { type: 'text', text: thinking },
        });
      }

      const tcs = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      for (let i = 0; i < tcs.length; i++) {
        const tc = tcs[i];
        if (!isObj(tc)) continue;
        const name = str(tc.name) ?? 'tool';
        const callId = `${prefix}-s${idx}-c${i}`;
        const update = mapTranscriptToolCall(callId, name, tc.args);
        sub.toolUses++;
        sub.lastTool = name;
        let sentToParent: string | undefined;
        if (name === 'send_message' && isObj(update.rawInput)) {
          const recipient = str(update.rawInput.Recipient) ?? '';
          const msg = str(update.rawInput.Message) ?? '';
          if (recipient === this.parentSid && msg) sentToParent = msg;
        }
        sub.pendingTools.push({ id: callId, name, update, ...(sentToParent ? { sentMessageToParent: sentToParent } : {}) });
        this.emitChild(sub, callId, update);
      }

      const content = (str(step.content) ?? '').trim();
      if (content) {
        this.emitChild(sub, `${prefix}-s${idx}-m`, {
          sessionUpdate: UPDATE_MESSAGE,
          content: { type: 'text', text: content },
        });
        if (tcs.length === 0 && !sub.summary) {
          sub.summary = clip(content, MAX_SUMMARY_CHARS);
        }
      }

      // If the subagent emitted a final response (no tool calls) after sending
      // its reply to the parent, we can mark it completed right away.
      if (tcs.length === 0 && sub.pendingTools.length === 0) {
        sub.hadFinalResponse = true;
        if (sub.sentReplyToParent) {
          this.completeSubagent(sub);
        }
      }
      return;
    }

    if (type === 'GENERIC') {
      const pending = sub.pendingTools.shift();
      if (!pending) return;
      const rawContent = str(step.content) ?? '';
      const cleaned = cleanGenericOutput(rawContent);
      const stepStatus = str(step.status) ?? 'DONE';
      let status = stepStatus === 'ERROR' || stepStatus === 'FAILED' ? 'failed' : 'completed';
      const exitMatch = EXIT_CODE_RE.exec(cleaned);
      const next: Obj = { ...pending.update, status };
      if (exitMatch) {
        const code = Number.parseInt(exitMatch[1]!, 10);
        if (Number.isFinite(code)) {
          const meta = isObj(next._meta) ? { ...next._meta } : {};
          const own = isObj(meta[SLUG]) ? { ...(meta[SLUG] as Obj) } : {};
          own.exitCode = code;
          meta[SLUG] = own;
          next._meta = meta;
          if (code !== 0) next.status = 'failed';
        }
      } else if (cleaned.startsWith('Encountered error')) {
        next.status = 'failed';
      }
      if (cleaned) {
        next.content = [{ type: 'content', content: { type: 'text', text: cleaned } }];
      }
      this.emitChild(sub, pending.id, next);
      if (pending.sentMessageToParent && next.status === 'completed') {
        sub.sentReplyToParent = true;
        if (!sub.summary) sub.summary = clip(pending.sentMessageToParent, MAX_SUMMARY_CHARS);
      }
    }
  }

  private completeSubagent(sub: TrackedSubagent): void {
    if (sub.status !== 'in_progress') return;
    // Drain any final lines from the child transcript before closing it out.
    if (sub.tailer) {
      for (const step of sub.tailer.poll()) {
        this.handleChildStep(sub, step);
      }
    }
    // Settle any tool call that never received a GENERIC step.
    for (const pending of sub.pendingTools) {
      this.emitChild(sub, pending.id, { ...pending.update, status: 'completed' });
    }
    sub.pendingTools = [];
    sub.status = 'completed';
    this.emitParentUpdate(sub);
    this.publishTasks();
    this.maybeStopTimer();
  }

  private emitChild(sub: TrackedSubagent, item: string, update: Obj): void {
    if (sub.emitted >= MAX_CHILD_EVENTS) return;
    sub.emitted++;
    this.host.emit({
      t: chat.EventType.Update,
      item,
      parent: sub.toolCallId,
      update,
    });
  }

  private buildParentUpdate(sub: TrackedSubagent): Obj {
    const durationMs = Math.max(0, Date.now() - sub.startedMs);
    return normalizeAgySubagentCall(sub.raw, {
      status: sub.status,
      ...(sub.childId ? { childId: sub.childId } : {}),
      role: sub.role,
      typeName: sub.typeName,
      ...(sub.tokens > 0 ? { tokens: sub.tokens } : {}),
      ...(sub.toolUses > 0 ? { toolUses: sub.toolUses } : {}),
      ...(durationMs > 0 ? { durationMs } : {}),
      ...(sub.lastTool ? { lastTool: sub.lastTool } : {}),
      ...(sub.summary ? { summary: sub.summary } : {}),
    });
  }

  private emitParentUpdate(sub: TrackedSubagent): void {
    this.host.emit({
      t: chat.EventType.Update,
      item: sub.toolCallId,
      update: this.buildParentUpdate(sub),
    });
  }

  private publishTasks(): void {
    if (this.stopped) return;
    const tasks: chat.BackgroundTask[] = [];
    for (const sub of this.subs.values()) {
      if (sub.status !== 'in_progress') continue;
      const desc = clip(sub.role || sub.typeName || 'subagent', MAX_NAME);
      tasks.push({
        id: sub.childId || sub.toolCallId,
        kind: chat.TaskKind.Subagent,
        status: chat.TaskStatus.Running,
        description: desc,
        ...(sub.typeName ? { agentType: sub.typeName } : {}),
        toolCallId: sub.toolCallId,
        backgrounded: true,
        stoppable: false,
        startedAt: sub.startedAt,
        ...(sub.tokens > 0 ? { tokens: sub.tokens } : {}),
        ...(sub.toolUses > 0 ? { toolUses: sub.toolUses } : {}),
      });
    }
    const json = tasks.length > 0 ? JSON.stringify(tasks) : '';
    if (json === this.lastTasksJson) return;
    this.lastTasksJson = json;
    this.host.updateTasks(tasks);
  }
}

/** Reads a finished Antigravity parent + child transcripts on disk to hydrate
 * nested subagent events during `adapter.history()` replay (best-effort). */
export function loadAgySubagentHistory(
  parentSessionId: string,
  subagentToolCalls: readonly { toolCallId: string; raw: Obj }[],
  dirs: readonly string[],
  emit: (ev: chat.Event) => void,
  uid = typeof process.getuid === 'function' ? process.getuid() : -1,
): void {
  if (!validSessionId(parentSessionId) || subagentToolCalls.length === 0) return;
  // Find parent transcript and read from offset 0 (entire history).
  let parentDir = '';
  let parentTailer: JsonlTailer | null = null;
  for (const d of dirs) {
    const p = transcriptPath(d, parentSessionId);
    try {
      const st = lstatSync(p);
      if (st.isFile() && !st.isSymbolicLink() && (uid < 0 || st.uid === uid)) {
        parentDir = d;
        parentTailer = new JsonlTailer(p, uid, 0);
        break;
      }
    } catch {
      // try next
    }
  }
  if (!parentTailer || !parentDir) return;
  // Discover children in order from parent transcript.
  const created: Array<{ conversationId: string; logPath: string }> = [];
  const reports = new Map<string, string>();
  for (const step of parentTailer.poll()) {
    const type = str(step.type) ?? '';
    const content = str(step.content) ?? '';
    if (type === 'GENERIC') {
      const c = parseSubagentCreated(content);
      if (c) created.push(c);
    } else if (type === 'SYSTEM_MESSAGE') {
      const m = parseChildMessage(content);
      if (m) reports.set(m.sender, clip(m.content, MAX_SUMMARY_CHARS));
    }
  }
  // Replay each matched child's transcript under its parent toolCallId.
  const n = Math.min(subagentToolCalls.length, created.length);
  for (let i = 0; i < n; i++) {
    const tc = subagentToolCalls[i]!;
    const child = created[i]!;
    const childPath = transcriptPath(parentDir, child.conversationId);
    const tailer = new JsonlTailer(childPath, uid, 0);
    const steps = tailer.poll();
    if (steps.length === 0) continue;
    const { typeName, role } = agySubagentInput(tc.raw);
    const pending: PendingChildTool[] = [];
    const prefix = `agy-sub-${child.conversationId.slice(0, 8)}`;
    let emitted = 0;
    let tokens = 0;
    let toolUses = 0;
    let summary = reports.get(child.conversationId) ?? '';
    for (const step of steps) {
      if (emitted >= MAX_CHILD_EVENTS) break;
      const type = str(step.type) ?? '';
      const idx = typeof step.step_index === 'number' ? step.step_index : emitted;
      if (type === 'PLANNER_RESPONSE') {
        const inTok = typeof step.input_tokens === 'number' ? step.input_tokens : 0;
        const outTok = typeof step.output_tokens === 'number' ? step.output_tokens : 0;
        if (inTok + outTok > 0) tokens += inTok + outTok;
        const thinking = (str(step.thinking) ?? '').trim();
        if (thinking && emitted < MAX_CHILD_EVENTS) {
          emitted++;
          emit({
            t: chat.EventType.Update,
            item: `${prefix}-s${idx}-t`,
            parent: tc.toolCallId,
            update: { sessionUpdate: UPDATE_THOUGHT, content: { type: 'text', text: thinking } },
          });
        }
        const tcs = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        for (let j = 0; j < tcs.length && emitted < MAX_CHILD_EVENTS; j++) {
          const c = tcs[j];
          if (!isObj(c)) continue;
          const name = str(c.name) ?? 'tool';
          const callId = `${prefix}-s${idx}-c${j}`;
          const update = mapTranscriptToolCall(callId, name, c.args);
          toolUses++;
          pending.push({ id: callId, name, update });
          emitted++;
          emit({ t: chat.EventType.Update, item: callId, parent: tc.toolCallId, update });
        }
        const text = (str(step.content) ?? '').trim();
        if (text && emitted < MAX_CHILD_EVENTS) {
          emitted++;
          emit({
            t: chat.EventType.Update,
            item: `${prefix}-s${idx}-m`,
            parent: tc.toolCallId,
            update: { sessionUpdate: UPDATE_MESSAGE, content: { type: 'text', text } },
          });
          if (tcs.length === 0 && !summary) summary = clip(text, MAX_SUMMARY_CHARS);
        }
      } else if (type === 'GENERIC') {
        const p = pending.shift();
        if (!p || emitted >= MAX_CHILD_EVENTS) continue;
        const cleaned = cleanGenericOutput(str(step.content) ?? '');
        const exitMatch = EXIT_CODE_RE.exec(cleaned);
        const next: Obj = { ...p.update, status: 'completed' };
        if (exitMatch) {
          const code = Number.parseInt(exitMatch[1]!, 10);
          if (Number.isFinite(code)) {
            next._meta = { [SLUG]: { exitCode: code } };
            if (code !== 0) next.status = 'failed';
          }
        }
        if (cleaned) next.content = [{ type: 'content', content: { type: 'text', text: cleaned } }];
        emitted++;
        emit({ t: chat.EventType.Update, item: p.id, parent: tc.toolCallId, update: next });
      }
    }
    for (const p of pending) {
      if (emitted >= MAX_CHILD_EVENTS) break;
      emitted++;
      emit({ t: chat.EventType.Update, item: p.id, parent: tc.toolCallId, update: { ...p.update, status: 'completed' } });
    }
    emit({
      t: chat.EventType.Update,
      item: tc.toolCallId,
      update: normalizeAgySubagentCall(tc.raw, {
        status: 'completed',
        childId: child.conversationId,
        role,
        typeName,
        ...(tokens > 0 ? { tokens } : {}),
        ...(toolUses > 0 ? { toolUses } : {}),
        ...(summary ? { summary } : {}),
      }),
    });
  }
}
