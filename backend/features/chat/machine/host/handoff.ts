// Cross-agent session handoff compiler: builds a deterministic, token-budgeted
// representation of a conversation directly from persisted journal events (no
// AI summarization), stripping private agent state (reasoning, permissions,
// subagent internals, binary attachments) and producing either:
//   - structured user/assistant messages for backends that support native
//     history injection (e.g. Codex `thread/inject_items`), or
//   - attributed conversation context for backends that receive handoff text
//     on the first turn (Claude Code, ACP, and fallback Codex/Fork).
//
// Invariants:
//   1. Short conversations that fit within the token & byte budget are kept
//      completely intact (no per-turn artificial chopping).
//   2. Long conversations prioritize: latest user prompt (never truncated),
//      original user request, most recent turns, key command results (both
//      failed and recent completed executions), modified files, and latest
//      plan, with structured omission reference markers for omitted turns.
//   3. Multi-hop transfers (A -> B -> C) preserve provenance per turn so each
//      assistant turn stays attributed to the agent that actually wrote it.
import { posix } from 'node:path';
import { byId as agentById } from '#shared/agents/kinds.ts';
import * as chat from '#shared/proto/chatproto/index.ts';
import type { HandoffMessage } from '../adapter.ts';

/** Default UTF-8 byte ceiling for handoff/export budgets (96 KiB -> ~24k tokens). */
export const DEFAULT_HANDOFF_BYTES = 96 << 10;
/** Minimum allowed byte budget (2 KiB). */
export const MIN_HANDOFF_BYTES = 2 << 10;
/** Maximum allowed byte budget (512 KiB). */
export const MAX_HANDOFF_BYTES = 512 << 10;

const MAX_TOOL_DETAIL_BYTES = 384;
const MAX_FAILED_OUTPUT_BYTES = 1200;
const MAX_COMPLETED_OUTPUT_BYTES = 600;
const MAX_MODIFIED_FILES = 40;
const MAX_KEY_COMMANDS = 12;
const MAX_OMITTED_INDEX_ITEMS = 12;
const MIN_HISTORY_TOKENS = 384;
const MAX_STORED_TURNS = 240;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Clamps a requested byte budget into safe bounds. */
export function clampHandoffBytes(maxBytes: number | undefined): number {
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) return DEFAULT_HANDOFF_BYTES;
  return Math.max(MIN_HANDOFF_BYTES, Math.min(MAX_HANDOFF_BYTES, Math.trunc(maxBytes)));
}

/** Converts a byte budget into a heuristic token budget (~4 bytes/token). */
export function bytesToTokenBudget(maxBytes: number): number {
  return Math.max(512, Math.floor(clampHandoffBytes(maxBytes) / 4));
}

/** Human-readable name for an agent kind id (falls back to kind id). */
export function agentTitle(kind: string | undefined): string {
  if (!kind) return 'Previous Agent';
  return agentById(kind)?.title || kind;
}

/** Fast, zero-dependency heuristic token estimator differentiating ASCII prose,
 * code punctuation, and CJK / Hangul / Kana characters. Monotonic and
 * deterministic for budget allocation across models. */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  let cjk = 0;
  let ascii = 0;
  let punct = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp <= 0x7f) {
      if (
        (cp >= 0x30 && cp <= 0x39) ||
        (cp >= 0x41 && cp <= 0x5a) ||
        (cp >= 0x61 && cp <= 0x7a) ||
        cp === 0x20 ||
        cp === 0x0a ||
        cp === 0x09
      ) {
        ascii++;
      } else {
        punct++;
      }
    } else if (
      (cp >= 0x3000 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.max(1, Math.ceil(cjk * 1.15 + ascii / 4 + punct / 2 + other / 2));
}

/** Estimates tokens occupied by a user's prompt content blocks (images count
 * toward fixed visual token overhead; text & resource links by text). */
export function estimatePromptTokens(content: readonly unknown[] | undefined): number {
  if (!Array.isArray(content) || content.length === 0) return 0;
  let total = 0;
  for (const raw of content) {
    if (!isObj(raw)) continue;
    switch (raw.type) {
      case 'text':
        total += estimateTokens(str(raw.text));
        break;
      case 'resource_link':
        total += estimateTokens(str(raw.uri) || str(raw.name)) + 8;
        break;
      case 'image':
        // Standard multimodal tile estimate; never blocks the prompt itself.
        total += 1024;
        break;
    }
  }
  return total;
}

/** Trims s to at most maxBytes UTF-8 bytes at a valid character boundary. */
export function trimUtf8End(s: string, maxBytes: number): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= maxBytes) return s;
  const ell = '…';
  const ellBytes = Buffer.byteLength(ell, 'utf8');
  if (maxBytes <= ellBytes) {
    let cut = Math.max(0, maxBytes);
    while (cut > 0 && (b[cut]! & 0xc0) === 0x80) cut--;
    return b.subarray(0, cut).toString('utf8');
  }
  let cut = maxBytes - ellBytes;
  while (cut > 0 && (b[cut]! & 0xc0) === 0x80) cut--;
  return b.subarray(0, cut).toString('utf8') + ell;
}

/** Trims s from the middle (preserving head and tail) to at most maxBytes UTF-8. */
export function trimUtf8Middle(s: string, maxBytes: number, marker = '\n… [truncated] …\n'): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= maxBytes) return s;
  const markBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes <= markBytes + 32) return trimUtf8End(s, maxBytes);
  const avail = maxBytes - markBytes;
  // Slightly favor the tail for command outputs / error traces where exit diagnostics live.
  let head = Math.floor(avail * 0.45);
  let tailStart = b.length - (avail - head);
  while (head > 0 && (b[head]! & 0xc0) === 0x80) head--;
  while (tailStart < b.length && (b[tailStart]! & 0xc0) === 0x80) tailStart++;
  return b.subarray(0, head).toString('utf8') + marker + b.subarray(tailStart).toString('utf8');
}

/** Trims s to fit BOTH maxTokens and maxBytes, preserving head+tail when middle is true. */
export function trimToBudget(s: string, maxTokens: number, maxBytes: number, middle = false): string {
  if (maxTokens <= 0 || maxBytes <= 0) return '';
  let out = s;
  if (utf8Bytes(out) > maxBytes) {
    out = middle ? trimUtf8Middle(out, maxBytes) : trimUtf8End(out, maxBytes);
  }
  if (estimateTokens(out) <= maxTokens) return out;
  // Binary search UTF-8 byte ceiling that yields <= maxTokens.
  let lo = 0;
  let hi = utf8Bytes(out);
  let best = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = middle ? trimUtf8Middle(out, mid) : trimUtf8End(out, mid);
    if (estimateTokens(cand) <= maxTokens && utf8Bytes(cand) <= maxBytes) {
      best = cand;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Normalizes a file path or file:// URI relative to cwd when inside cwd. */
export function relPath(raw: string, cwd?: string): string {
  let p = raw.trim();
  if (!p) return '';
  if (p.startsWith('file://')) {
    try {
      const u = new URL(p);
      if (u.protocol === 'file:') p = decodeURIComponent(u.pathname);
    } catch {
      // keep raw
    }
  }
  if (posix.isAbsolute(p)) {
    p = posix.normalize(p);
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (cwd) {
      const base = posix.normalize(cwd).replace(/\/+$/, '') + '/';
      if (p.startsWith(base) && p.length > base.length) return p.slice(base.length);
    }
  }
  return p;
}

/** Formats user prompt content blocks for handoff: strips image binary payloads
 * and renders resource links with workspace-relative paths (without raw `@` so
 * downstream CLIs like Claude Code do not re-expand historical file mentions). */
export function formatHandoffContent(content: unknown[] | undefined, cwd?: string, mentionStyle: 'handoff' | 'export' = 'handoff'): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (!isObj(raw)) continue;
    switch (raw.type) {
      case 'text': {
        const t = str(raw.text).trim();
        if (t) parts.push(t);
        break;
      }
      case 'resource_link': {
        const uri = str(raw.uri);
        const name = str(raw.name);
        const target = (uri ? relPath(uri, cwd) : '') || name;
        if (target) parts.push(mentionStyle === 'handoff' ? `[file: ${target}]` : `@${target}`);
        break;
      }
      case 'image': {
        const mime = str(raw.mimeType);
        parts.push(mentionStyle === 'handoff' ? (mime ? `[image omitted: ${mime}]` : '[image omitted]') : '[image attached]');
        break;
      }
    }
  }
  return parts.join('\n');
}

function extractTextFromUpdate(upd: Record<string, unknown>): string {
  const c = upd.content;
  if (isObj(c) && c.type === 'text') return str(c.text);
  return str(upd.text);
}

function extractLocations(raw: unknown, cwd?: string): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const loc of raw) {
    if (!isObj(loc)) continue;
    const p = relPath(str(loc.path), cwd);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function extractCommand(rawInput: Record<string, unknown>): string {
  const c = rawInput.command ?? rawInput.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((a) => typeof a === 'string')) {
    const argv = c as string[];
    if (argv.length === 3 && /(?:^|\/)(?:ba|z|da|k)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) return argv[2]!;
    return argv.join(' ');
  }
  return '';
}

function extractExitCode(upd: Record<string, unknown>): number | undefined {
  if (isObj(upd._meta)) {
    for (const val of Object.values(upd._meta)) {
      if (isObj(val) && typeof val.exitCode === 'number' && Number.isFinite(val.exitCode)) {
        return Math.trunc(val.exitCode);
      }
    }
  }
  if (isObj(upd.rawOutput) && typeof upd.rawOutput.exitCode === 'number' && Number.isFinite(upd.rawOutput.exitCode)) {
    return Math.trunc(upd.rawOutput.exitCode);
  }
  return undefined;
}

function summarizeToolDetail(upd: Record<string, unknown>, cwd?: string): string {
  if (isObj(upd.rawInput)) {
    const cmd = extractCommand(upd.rawInput);
    if (cmd) return trimUtf8End(cmd.replace(/\s+/g, ' ').trim(), MAX_TOOL_DETAIL_BYTES);
    const p = relPath(str(upd.rawInput.file_path) || str(upd.rawInput.path) || str(upd.rawInput.filePath), cwd);
    if (p) return p;
    const query = str(upd.rawInput.pattern) || str(upd.rawInput.query) || str(upd.rawInput.url) || str(upd.rawInput.uri);
    if (query) return trimUtf8End(query.replace(/\s+/g, ' ').trim(), MAX_TOOL_DETAIL_BYTES);
  }
  if (Array.isArray(upd.content)) {
    for (const c of upd.content) {
      if (!isObj(c) || c.type !== 'diff') continue;
      if (str(c.path)) return `diff ${relPath(str(c.path), cwd)}`;
      if (Array.isArray(c.changes)) {
        const paths = c.changes.map((x) => (isObj(x) ? relPath(str(x.path), cwd) : '')).filter(Boolean);
        if (paths.length) return `diff ${paths.slice(0, 3).join(', ')}`;
      }
    }
  }
  return '';
}

function extractDiffPaths(upd: Record<string, unknown>, cwd?: string): string[] {
  const out: string[] = [];
  if (!Array.isArray(upd.content)) return out;
  for (const c of upd.content) {
    if (!isObj(c) || c.type !== 'diff') continue;
    const single = relPath(str(c.path), cwd);
    if (single && !out.includes(single)) out.push(single);
    if (Array.isArray(c.changes)) {
      for (const ch of c.changes) {
        if (!isObj(ch)) continue;
        const p = relPath(str(ch.path), cwd);
        if (p && !out.includes(p)) out.push(p);
      }
    }
  }
  return out;
}

function cleanCommandOutput(raw: string, maxBytes: number): string {
  // Collapse carriage-return redraw lines and excess blank lines while preserving line breaks.
  const normalized = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return '';
  return trimUtf8Middle(normalized, maxBytes);
}

/** Extracts command/tool output text for failed tools (any kind) and completed
 * execute commands (key command results). Never extracts raw read-file dumps. */
function extractToolOutput(upd: Record<string, unknown>, kind: string, status: string): string {
  const failed = status === 'failed';
  const isExec = kind === 'execute';
  if (!failed && !(isExec && status === 'completed')) return '';
  const cap = failed ? MAX_FAILED_OUTPUT_BYTES : MAX_COMPLETED_OUTPUT_BYTES;
  const pieces: string[] = [];
  if (isObj(upd.rawOutput)) {
    const err = str(upd.rawOutput.error).trim();
    const stderr = str(upd.rawOutput.stderr).trim();
    const stdout = str(upd.rawOutput.stdout).trim();
    const output = str(upd.rawOutput.output).trim();
    const msg = str(upd.rawOutput.message).trim();
    if (err) pieces.push(err);
    if (stderr && stderr !== err) pieces.push(stderr);
    if (stdout) pieces.push(stdout);
    if (output && !pieces.includes(output)) pieces.push(output);
    if (msg && !pieces.includes(msg)) pieces.push(msg);
  } else if (typeof upd.rawOutput === 'string' && upd.rawOutput.trim()) {
    pieces.push(upd.rawOutput.trim());
  }
  if (pieces.length === 0 && Array.isArray(upd.content)) {
    for (const c of upd.content) {
      if (isObj(c) && c.type === 'content' && isObj(c.content) && c.content.type === 'text') {
        const t = str(c.content.text).trim();
        if (t) pieces.push(t);
      }
    }
  }
  if (pieces.length === 0) return '';
  return cleanCommandOutput(pieces.join('\n'), cap);
}

export interface HandoffLineageEntry {
  chatId: string;
  kind: string;
  upToSeq?: number;
}

export interface HandoffToolAction {
  title: string;
  kind: string;
  status: string;
  locations: string[];
  detail: string;
  exitCode?: number;
  output?: string;
}

export interface HandoffClarification {
  question: string;
  answers: string[];
}

export interface HandoffCommandResult {
  turnIndex: number;
  chatId: string;
  agentKind: string;
  command: string;
  status: string;
  exitCode?: number;
  output: string;
}

export interface HandoffTurn {
  /** 1-based chronological turn index across the full lineage. */
  index: number;
  chatId: string;
  agentKind: string;
  seqStart: number;
  seqEnd: number;
  at?: string;
  userText: string;
  clarifications: HandoffClarification[];
  assistantText: string;
  tools: HandoffToolAction[];
  notices: string[];
}

export interface OmittedTurnRef {
  index: number;
  chatId: string;
  agentKind: string;
  seqStart: number;
  seqEnd: number;
  summary: string;
  touched: string[];
}

export interface OmittedSpan {
  fromTurn: number;
  toTurn: number;
  count: number;
  sources: Array<{ chatId: string; agentKind: string; seqStart: number; seqEnd: number }>;
  refs: OmittedTurnRef[];
}

/** Structured handoff payload persisted under `seed:<chatId>` until injected. */
export interface HandoffSeed {
  version: 1;
  title?: string;
  cwd?: string;
  targetKind?: string;
  maxBytes: number;
  maxTokens: number;
  lineage: HandoffLineageEntry[];
  /** Total turns extracted across the entire lineage before any pre-pruning. */
  totalTurns: number;
  /** Original user request (from turn 1) kept explicitly for long conversations. */
  originalRequest?: {
    turnIndex: number;
    chatId: string;
    agentKind: string;
    seq: number;
    text: string;
  };
  /** Pre-omitted middle turn references when a huge lineage exceeded storage window. */
  preOmitted: OmittedTurnRef[];
  /** Retained chronological turns available for final selection. */
  turns: HandoffTurn[];
  /** Key command results from pre-omitted turns (failed + key completed). */
  preCommandResults: HandoffCommandResult[];
  modifiedFiles: string[];
  latestPlan: string[];
  /** Legacy raw Markdown seed (for seamless upgrade compatibility). */
  legacyMarkdown?: string;
}

export interface HandoffSegment {
  chatId: string;
  kind: string;
  cwd?: string;
  upToSeq?: number;
  events: readonly chat.Event[];
}

export interface BuildSeedOptions {
  title?: string;
  cwd?: string;
  targetKind?: string;
  maxBytes?: number;
  /** Optional fallback seed from an ancestor whose journal chat was deleted. */
  fallbackSeed?: HandoffSeed;
}

interface RawTool {
  id: string;
  title: string;
  kind: string;
  status: string;
  locations: string[];
  detail: string;
  exitCode?: number;
  output: string;
}

function summarizeOmittedTurn(t: HandoffTurn): OmittedTurnRef {
  const raw = t.userText || t.assistantText || t.notices[0] || '';
  const firstLine = raw.split('\n').find((l) => l.trim() !== '') ?? '';
  const summary = trimUtf8End(firstLine.replace(/\s+/g, ' ').trim(), 100);
  const touched: string[] = [];
  for (const tool of t.tools) {
    for (const loc of tool.locations) {
      if (loc && !touched.includes(loc) && touched.length < 4) touched.push(loc);
    }
    if (tool.kind === 'execute' && tool.detail && touched.length < 4) {
      const cmd = trimUtf8End(tool.detail, 40);
      if (!touched.includes(cmd)) touched.push(cmd);
    }
  }
  return {
    index: t.index,
    chatId: t.chatId,
    agentKind: t.agentKind,
    seqStart: t.seqStart,
    seqEnd: t.seqEnd,
    summary,
    touched,
  };
}

function commandResultsOfTurn(t: HandoffTurn): HandoffCommandResult[] {
  const out: HandoffCommandResult[] = [];
  for (const tool of t.tools) {
    const failed = tool.status === 'failed';
    const execWithOut = tool.kind === 'execute' && tool.status === 'completed' && !!tool.output;
    if (!failed && !execWithOut) continue;
    const label = tool.detail || tool.title || tool.kind || 'command';
    out.push({
      turnIndex: t.index,
      chatId: t.chatId,
      agentKind: t.agentKind,
      command: label,
      status: tool.status,
      ...(tool.exitCode !== undefined ? { exitCode: tool.exitCode } : {}),
      output: tool.output || (failed ? 'command failed' : ''),
    });
  }
  return out;
}

/** Extracts structured turns and workspace state from one or more chronological
 * lineage segments, stripping private agent reasoning, permissions, subagent
 * internals, live deltas, and binary image payloads. */
export function buildHandoffSeed(segments: readonly HandoffSegment[], opts: BuildSeedOptions = {}): HandoffSeed {
  const maxBytes = clampHandoffBytes(opts.maxBytes);
  const maxTokens = bytesToTokenBudget(maxBytes);
  const cwd = opts.cwd ?? segments.at(-1)?.cwd;

  const lineage: HandoffLineageEntry[] = [];
  const allTurns: HandoffTurn[] = [];
  const preOmitted: OmittedTurnRef[] = [];
  const preCommandResults: HandoffCommandResult[] = [];
  const modifiedFiles: string[] = [];
  let latestPlan: string[] = [];
  let originalRequest: HandoffSeed['originalRequest'];

  const recordModified = (p: string) => {
    const clean = relPath(p, cwd);
    if (!clean || modifiedFiles.includes(clean) || modifiedFiles.length >= MAX_MODIFIED_FILES) return;
    modifiedFiles.push(clean);
  };

  let turnIndex = 0;

  if (opts.fallbackSeed) {
    const fb = opts.fallbackSeed;
    for (const l of fb.lineage) lineage.push({ ...l });
    if (fb.originalRequest) originalRequest = { ...fb.originalRequest };
    for (const ref of fb.preOmitted) preOmitted.push({ ...ref, touched: [...ref.touched] });
    for (const cmd of fb.preCommandResults) preCommandResults.push({ ...cmd });
    for (const f of fb.modifiedFiles) recordModified(f);
    if (fb.latestPlan.length > 0) latestPlan = [...fb.latestPlan];
    for (const t of fb.turns) {
      allTurns.push({
        ...t,
        clarifications: t.clarifications.map((q) => ({ ...q, answers: [...q.answers] })),
        tools: t.tools.map((x) => ({ ...x, locations: [...x.locations] })),
        notices: [...t.notices],
      });
      if (t.index > turnIndex) turnIndex = t.index;
    }
    if (fb.totalTurns > turnIndex) turnIndex = fb.totalTurns;
  }

  for (const seg of segments) {
    if (!lineage.some((l) => l.chatId === seg.chatId)) {
      lineage.push({
        chatId: seg.chatId,
        kind: seg.kind,
        ...(seg.upToSeq !== undefined ? { upToSeq: seg.upToSeq } : {}),
      });
    }
    const segCwd = seg.cwd ?? cwd;
    const openQuestions = new Map<string, chat.Question[]>();
    const queuedWaiting = new Map<string, unknown[]>();

    let cur: {
      seqStart: number;
      seqEnd: number;
      at?: string;
      userText: string;
      clarifications: HandoffClarification[];
      assistantChunks: string[];
      tools: Map<string, RawTool>;
      notices: string[];
    } | null = null;

    const ensureCur = (seq: number, at?: string) => {
      if (!cur) {
        cur = {
          seqStart: seq,
          seqEnd: seq,
          ...(at ? { at } : {}),
          userText: '',
          clarifications: [],
          assistantChunks: [],
          tools: new Map(),
          notices: [],
        };
      } else {
        if (seq > 0) cur.seqEnd = Math.max(cur.seqEnd, seq);
      }
      return cur;
    };

    const flushCur = () => {
      if (!cur) return;
      const prose = cur.assistantChunks.join('').trim();
      const tools: HandoffToolAction[] = [];
      for (const t of cur.tools.values()) {
        tools.push({
          title: t.title,
          kind: t.kind,
          status: t.status,
          locations: t.locations,
          detail: t.detail,
          ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
          ...(t.output ? { output: t.output } : {}),
        });
      }
      const hasAny = cur.userText !== '' || prose !== '' || tools.length > 0 || cur.clarifications.length > 0 || cur.notices.length > 0;
      if (hasAny) {
        turnIndex++;
        const turn: HandoffTurn = {
          index: turnIndex,
          chatId: seg.chatId,
          agentKind: seg.kind,
          seqStart: cur.seqStart,
          seqEnd: cur.seqEnd,
          ...(cur.at ? { at: cur.at } : {}),
          userText: cur.userText,
          clarifications: cur.clarifications,
          assistantText: prose,
          tools,
          notices: cur.notices,
        };
        if (!originalRequest && turn.userText) {
          originalRequest = {
            turnIndex: turn.index,
            chatId: turn.chatId,
            agentKind: turn.agentKind,
            seq: turn.seqStart,
            text: turn.userText,
          };
        }
        allTurns.push(turn);
      }
      cur = null;
    };

    for (const ev of seg.events) {
      if (ev.live) continue;
      const seq = ev.seq ?? 0;
      switch (ev.t) {
        case chat.EventType.User: {
          flushCur();
          const text = formatHandoffContent(ev.content, segCwd, 'handoff');
          if (text) {
            cur = {
              seqStart: seq,
              seqEnd: seq,
              ...(ev.at ? { at: ev.at } : {}),
              userText: text,
              clarifications: [],
              assistantChunks: [],
              tools: new Map(),
              notices: [],
            };
          }
          break;
        }
        case chat.EventType.Queued: {
          if (ev.state === chat.QueuedState.Waiting) {
            if (ev.message && Array.isArray(ev.content)) queuedWaiting.set(ev.message, ev.content);
          } else if (ev.state === chat.QueuedState.Cancelled) {
            if (ev.message) queuedWaiting.delete(ev.message);
          } else if (ev.state === chat.QueuedState.Taken) {
            flushCur();
            const content = Array.isArray(ev.content) ? ev.content : ev.message ? queuedWaiting.get(ev.message) : undefined;
            if (ev.message) queuedWaiting.delete(ev.message);
            const text = formatHandoffContent(content, segCwd, 'handoff');
            if (text) {
              cur = {
                seqStart: seq,
                seqEnd: seq,
                ...(ev.at ? { at: ev.at } : {}),
                userText: text,
                clarifications: [],
                assistantChunks: [],
                tools: new Map(),
                notices: [],
              };
            }
          }
          break;
        }
        case chat.EventType.Update: {
          // Strip subagent internal events (ev.parent) and private reasoning (agent_thought_chunk).
          if (ev.parent) break;
          const upd = ev.update;
          if (!isObj(upd)) break;
          const kind = str(upd.sessionUpdate);
          if (kind === 'agent_message_chunk') {
            const t = extractTextFromUpdate(upd);
            if (t) ensureCur(seq, ev.at).assistantChunks.push(t);
          } else if (kind === 'tool_call' || kind === 'tool_call_update') {
            const id = str(upd.toolCallId) || str(ev.item);
            if (!id) break;
            const c = ensureCur(seq, ev.at);
            const prev: RawTool = c.tools.get(id) ?? {
              id,
              title: '',
              kind: '',
              status: '',
              locations: [],
              detail: '',
              output: '',
            };
            const title = str(upd.title) || prev.title;
            const tk = str(upd.kind) || prev.kind;
            const status = str(upd.status) || prev.status;
            const locs = [...prev.locations];
            for (const p of extractLocations(upd.locations, segCwd)) if (!locs.includes(p)) locs.push(p);
            for (const p of extractDiffPaths(upd, segCwd)) {
              if (!locs.includes(p)) locs.push(p);
              recordModified(p);
            }
            if (tk === 'edit' || tk === 'delete' || tk === 'move') {
              for (const p of locs) recordModified(p);
              if (isObj(upd.rawInput)) {
                const p = str(upd.rawInput.file_path) || str(upd.rawInput.path) || str(upd.rawInput.filePath);
                if (p) recordModified(p);
              }
            }
            const detail = summarizeToolDetail(upd, segCwd) || prev.detail;
            const exitCode = extractExitCode(upd) ?? prev.exitCode;
            const output = extractToolOutput(upd, tk, status) || prev.output;
            c.tools.set(id, {
              id,
              title,
              kind: tk,
              status,
              locations: locs,
              detail,
              ...(exitCode !== undefined ? { exitCode } : {}),
              output,
            });
          } else if (kind === 'plan' && Array.isArray(upd.entries)) {
            const lines: string[] = [];
            for (const entry of upd.entries) {
              if (!isObj(entry)) continue;
              const c = str(entry.content).trim();
              if (!c) continue;
              const st = str(entry.status);
              const mark = st === 'completed' ? '[x]' : st === 'in_progress' ? '[-]' : '[ ]';
              lines.push(`- ${mark} ${c}`);
            }
            if (lines.length > 0) latestPlan = lines;
          }
          break;
        }
        case chat.EventType.Question: {
          if (ev.id && Array.isArray(ev.questions)) openQuestions.set(ev.id, ev.questions);
          break;
        }
        case chat.EventType.QuestionDone: {
          if (ev.id && ev.answers && Object.keys(ev.answers).length > 0) {
            const qs = openQuestions.get(ev.id) ?? [];
            const c = ensureCur(seq, ev.at);
            for (const [qid, vals] of Object.entries(ev.answers)) {
              const q = qs.find((x) => x.id === qid);
              const prompt = q?.question || q?.header || qid;
              c.clarifications.push({ question: prompt, answers: [...vals] });
            }
          }
          if (ev.id) openQuestions.delete(ev.id);
          break;
        }
        case chat.EventType.Notice: {
          const method = str(ev.method);
          const params = isObj(ev.params) ? ev.params : undefined;
          if (method.endsWith('/compacted')) {
            ensureCur(seq, ev.at).notices.push('Context was compacted earlier in this session.');
          } else if (method.endsWith('/error') && params && str(params.message)) {
            ensureCur(seq, ev.at).notices.push(`Error: ${trimUtf8End(str(params.message).replace(/\s+/g, ' ').trim(), 320)}`);
          }
          break;
        }
        case chat.EventType.Turn: {
          if (ev.state === chat.TurnState.End) {
            if (cur && seq > 0) cur.seqEnd = Math.max(cur.seqEnd, seq);
            flushCur();
          } else if (ev.state === chat.TurnState.Error) {
            const msg = ev.error?.message ? trimUtf8End(ev.error.message.replace(/\s+/g, ' ').trim(), 320) : '';
            if (msg) ensureCur(seq, ev.at).notices.push(`Turn failed: ${msg}`);
            if (cur && seq > 0) cur.seqEnd = Math.max(cur.seqEnd, seq);
            flushCur();
          }
          break;
        }
      }
    }
    flushCur();
  }

  // Bound the stored seed cleanly for huge multi-hundred-turn histories while
  // keeping full fidelity for normal sessions and retaining all tail turns up
  // to 2x maxBytes so prompt-time dynamic selection stays accurate.
  const storeBytesLimit = Math.max(maxBytes * 2, 128 << 10);
  let keptTurns = allTurns;
  if (allTurns.length > MAX_STORED_TURNS || estimateStoredTurnsBytes(allTurns) > storeBytesLimit) {
    const tail: HandoffTurn[] = [];
    let bytesUsed = 0;
    let firstKeptIdx = allTurns.length;
    for (let i = allTurns.length - 1; i >= 0 && tail.length < MAX_STORED_TURNS; i--) {
      const t = allTurns[i]!;
      const cost = utf8Bytes(t.userText) + utf8Bytes(t.assistantText) + 512;
      if (tail.length > 0 && bytesUsed + cost > storeBytesLimit) break;
      tail.push(t);
      bytesUsed += cost;
      firstKeptIdx = i;
    }
    tail.reverse();
    for (let i = 0; i < firstKeptIdx; i++) {
      const omitted = allTurns[i]!;
      preOmitted.push(summarizeOmittedTurn(omitted));
      for (const cmd of commandResultsOfTurn(omitted)) preCommandResults.push(cmd);
    }
    keptTurns = tail;
  }

  // Cap stored original request to a generous ceiling (32 KiB) so SQLite row stays bounded.
  if (originalRequest && utf8Bytes(originalRequest.text) > 32 << 10) {
    originalRequest = { ...originalRequest, text: trimUtf8Middle(originalRequest.text, 32 << 10) };
  }
  const trimmedPreCommands = preCommandResults.slice(-MAX_KEY_COMMANDS * 2);

  return {
    version: 1,
    ...(opts.title ? { title: opts.title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(opts.targetKind ? { targetKind: opts.targetKind } : {}),
    maxBytes,
    maxTokens,
    lineage,
    totalTurns: turnIndex,
    ...(originalRequest ? { originalRequest } : {}),
    preOmitted,
    turns: keptTurns,
    preCommandResults: trimmedPreCommands,
    modifiedFiles,
    latestPlan,
  };
}

function estimateStoredTurnsBytes(turns: readonly HandoffTurn[]): number {
  let n = 0;
  for (const t of turns) n += utf8Bytes(t.userText) + utf8Bytes(t.assistantText) + 512;
  return n;
}

/** Parses a stored `seed:<id>` value (either structured HandoffSeed v1 or a
 * legacy plain Markdown string from an earlier build). */
export function parseHandoffSeed(raw: unknown): HandoffSeed | undefined {
  if (typeof raw === 'string') {
    if (!raw.trim()) return undefined;
    return {
      version: 1,
      maxBytes: DEFAULT_HANDOFF_BYTES,
      maxTokens: bytesToTokenBudget(DEFAULT_HANDOFF_BYTES),
      lineage: [],
      totalTurns: 0,
      preOmitted: [],
      turns: [],
      preCommandResults: [],
      modifiedFiles: [],
      latestPlan: [],
      legacyMarkdown: raw,
    };
  }
  if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.turns)) return undefined;
  return raw as unknown as HandoffSeed;
}

export interface SelectHandoffOptions {
  /** Estimated tokens of the user's new prompt being sent right now. Deducted
   * from history budget so the latest user prompt is never truncated. */
  promptTokens?: number;
  /** Target model context window size in tokens, if known. */
  targetContextTokens?: number;
  maxTokens?: number;
  maxBytes?: number;
}

export interface HandoffSelection {
  seed: HandoffSeed;
  truncated: boolean;
  totalTurns: number;
  keptTurns: HandoffTurn[];
  omittedSpan?: OmittedSpan;
  originalRequest?: NonNullable<HandoffSeed['originalRequest']>;
  keyCommands: HandoffCommandResult[];
  modifiedFiles: string[];
  latestPlan: string[];
  lineageKinds: string[];
  effectiveTokenBudget: number;
  effectiveByteBudget: number;
  estimatedTokens: number;
}

function formatToolLines(tools: readonly HandoffToolAction[]): string {
  if (tools.length === 0) return '';
  const lines: string[] = [];
  for (const t of tools) {
    const loc = t.locations.length ? ` (${t.locations.slice(0, 4).join(', ')})` : '';
    const det = t.detail && !loc.includes(t.detail) ? `: \`${t.detail}\`` : '';
    const exit = t.exitCode !== undefined ? ` exit=${t.exitCode}` : '';
    const status = t.status ? ` [${t.status}${exit}]` : exit ? ` [${exit.trim()}]` : '';
    lines.push(`- ${t.title || t.kind || 'tool'}${loc}${det}${status}`);
    if (t.output) {
      const indented = t.output
        .split('\n')
        .map((l) => `  > ${l}`)
        .join('\n');
      lines.push(indented);
    }
  }
  return '**Actions & command results:**\n' + lines.join('\n');
}

function formatAssistantTurnBody(t: HandoffTurn): string {
  const parts: string[] = [];
  if (t.assistantText) parts.push(t.assistantText);
  const tools = formatToolLines(t.tools);
  if (tools) parts.push(tools);
  if (t.notices.length > 0) parts.push(t.notices.map((n) => `_[${n}]_`).join('\n'));
  return parts.join('\n\n');
}

function formatUserTurnBody(t: HandoffTurn): string {
  const parts: string[] = [];
  if (t.userText) parts.push(t.userText);
  if (t.clarifications.length > 0) {
    const qa = t.clarifications.map((q) => `- **Q:** ${q.question}\n  **A:** ${q.answers.join(', ')}`).join('\n');
    parts.push(`**Clarifications:**\n${qa}`);
  }
  return parts.join('\n\n');
}

function formatTurnAsMarkdown(t: HandoffTurn): string {
  const parts: string[] = [];
  const user = formatUserTurnBody(t);
  if (user) parts.push(`### User (Turn ${t.index})\n\n${user}`);
  const assistant = formatAssistantTurnBody(t);
  if (assistant) parts.push(`### Assistant · ${agentTitle(t.agentKind)} (Turn ${t.index})\n\n${assistant}`);
  return parts.join('\n\n');
}

function trimTurnToBudget(t: HandoffTurn, maxTokens: number, maxBytes: number): HandoffTurn {
  const user = formatUserTurnBody(t);
  const assistant = formatAssistantTurnBody(t);
  const userTok = estimateTokens(user);
  const asstTok = estimateTokens(assistant);
  const totalTok = Math.max(1, userTok + asstTok);
  if (totalTok <= maxTokens && utf8Bytes(user) + utf8Bytes(assistant) <= maxBytes) return t;
  const userShare = Math.min(0.45, Math.max(0.2, userTok / totalTok));
  const uMaxTok = Math.max(48, Math.floor(maxTokens * userShare));
  const uMaxBytes = Math.max(192, Math.floor(maxBytes * userShare));
  const aMaxTok = Math.max(64, maxTokens - uMaxTok);
  const aMaxBytes = Math.max(256, maxBytes - uMaxBytes);
  return {
    ...t,
    userText: trimToBudget(t.userText, uMaxTok, uMaxBytes, true),
    assistantText: trimToBudget(t.assistantText, aMaxTok, aMaxBytes, true),
    tools: t.tools.map((tool) => ({
      ...tool,
      ...(tool.output ? { output: trimToBudget(tool.output, Math.min(120, Math.floor(aMaxTok / 3)), 480, true) } : {}),
    })),
  };
}

function buildOmittedSpan(refs: readonly OmittedTurnRef[]): OmittedSpan | undefined {
  if (refs.length === 0) return undefined;
  const sorted = [...refs].sort((a, b) => a.index - b.index);
  const bySource = new Map<string, { chatId: string; agentKind: string; seqStart: number; seqEnd: number }>();
  for (const r of sorted) {
    const key = `${r.chatId}\n${r.agentKind}`;
    const prev = bySource.get(key);
    if (!prev) {
      bySource.set(key, { chatId: r.chatId, agentKind: r.agentKind, seqStart: r.seqStart, seqEnd: r.seqEnd });
    } else {
      prev.seqStart = prev.seqStart === 0 ? r.seqStart : Math.min(prev.seqStart, r.seqStart || prev.seqStart);
      prev.seqEnd = Math.max(prev.seqEnd, r.seqEnd);
    }
  }
  // Keep a representative sample of omitted turn refs (first few + most recent few).
  let sample = sorted;
  if (sorted.length > MAX_OMITTED_INDEX_ITEMS) {
    const head = Math.floor(MAX_OMITTED_INDEX_ITEMS / 2);
    const tail = MAX_OMITTED_INDEX_ITEMS - head;
    sample = [...sorted.slice(0, head), ...sorted.slice(sorted.length - tail)];
  }
  return {
    fromTurn: sorted[0]!.index,
    toTurn: sorted.at(-1)!.index,
    count: sorted.length,
    sources: [...bySource.values()],
    refs: sample,
  };
}

function pickKeyCommands(commands: readonly HandoffCommandResult[]): HandoffCommandResult[] {
  if (commands.length <= MAX_KEY_COMMANDS) return [...commands];
  // Prioritize failed commands first, then most recent completed commands.
  const failed = commands.filter((c) => c.status === 'failed').slice(-Math.ceil(MAX_KEY_COMMANDS * 0.6));
  const completed = commands.filter((c) => c.status !== 'failed').slice(-(MAX_KEY_COMMANDS - failed.length));
  return [...failed, ...completed].sort((a, b) => a.turnIndex - b.turnIndex);
}

function formatOmittedSection(span: OmittedSpan): string {
  const sourceLabels = span.sources.map((s) => {
    const seq = s.seqEnd > 0 ? ` seq ${s.seqStart || 1}–${s.seqEnd}` : '';
    return `${agentTitle(s.agentKind)} chat \`${s.chatId}\`${seq}`;
  });
  const lines = [
    `## Omitted History Reference`,
    '',
    `- **Omitted range:** Turns ${span.fromTurn}–${span.toTurn} (${span.count} ${span.count === 1 ? 'turn' : 'turns'} omitted to fit context budget)`,
    `- **Source record(s):** ${sourceLabels.join('; ')}`,
    `- **Recall guidance:** Earlier details were intentionally omitted; verify current state from workspace files or git history, or ask the user if earlier decisions need clarification.`,
  ];
  if (span.refs.length > 0) {
    lines.push('', '**Omitted turn index:**');
    for (const r of span.refs) {
      const scope = r.touched.length ? ` [${r.touched.join(', ')}]` : '';
      const sum = r.summary || '(no text summary)';
      lines.push(`- Turn ${r.index} (${agentTitle(r.agentKind)}): ${sum}${scope}`);
    }
  }
  return lines.join('\n');
}

function formatKeyCommandsSection(commands: readonly HandoffCommandResult[]): string {
  if (commands.length === 0) return '';
  const lines = ['## Key Command Results (from earlier turns)', ''];
  for (const c of commands) {
    const exit = c.exitCode !== undefined ? ` exit=${c.exitCode}` : '';
    lines.push(`- **Turn ${c.turnIndex}** (${agentTitle(c.agentKind)}) \`${c.command}\` [${c.status}${exit}]`);
    if (c.output) {
      lines.push(
        c.output
          .split('\n')
          .map((l) => `  > ${l}`)
          .join('\n'),
      );
    }
  }
  return lines.join('\n');
}

function formatFilesSection(files: readonly string[]): string {
  if (files.length === 0) return '';
  return `## Files Modified\n\n${files.map((f) => `- \`${f}\``).join('\n')}`;
}

function formatPlanSection(plan: readonly string[]): string {
  if (plan.length === 0) return '';
  return `## Latest Plan\n\n${plan.join('\n')}`;
}

/** Selects turns and supporting context from a HandoffSeed under a token & byte
 * budget, preserving short conversations intact and strictly prioritizing
 * original request, recent turns, key command results, and omission markers. */
export function selectHandoff(seed: HandoffSeed, opts: SelectHandoffOptions = {}): HandoffSelection {
  const maxBytes = clampHandoffBytes(opts.maxBytes ?? seed.maxBytes);
  const baseTokens = opts.maxTokens ?? seed.maxTokens ?? bytesToTokenBudget(maxBytes);
  const promptTokens = Math.max(0, Math.trunc(opts.promptTokens ?? 0));

  let effectiveTokens = baseTokens;
  if (opts.targetContextTokens && opts.targetContextTokens > 0) {
    const windowShare = Math.max(2048, Math.floor(opts.targetContextTokens * 0.35));
    effectiveTokens = Math.min(effectiveTokens, windowShare);
  }
  // Never truncate the latest prompt: shrink history budget instead when the
  // incoming prompt consumes part of the budget.
  if (promptTokens > 0) {
    if (opts.targetContextTokens && opts.targetContextTokens > 0) {
      const remainingWindow = Math.max(MIN_HISTORY_TOKENS, Math.floor(opts.targetContextTokens * 0.75) - promptTokens);
      effectiveTokens = Math.min(effectiveTokens, remainingWindow);
    } else {
      effectiveTokens = Math.max(MIN_HISTORY_TOKENS, effectiveTokens - promptTokens);
    }
  }
  // Keep byte cap proportional when promptTokens shrank effectiveTokens heavily.
  const effectiveBytes = Math.min(maxBytes, Math.max(MIN_HANDOFF_BYTES, effectiveTokens * 6));
  const lineageKinds = [...new Set(seed.lineage.map((l) => l.kind).filter(Boolean))];

  if (seed.legacyMarkdown) {
    const trimmed = trimToBudget(seed.legacyMarkdown, effectiveTokens, effectiveBytes);
    return {
      seed: { ...seed, legacyMarkdown: trimmed },
      truncated: trimmed !== seed.legacyMarkdown,
      totalTurns: 0,
      keptTurns: [],
      keyCommands: [],
      modifiedFiles: [],
      latestPlan: [],
      lineageKinds,
      effectiveTokenBudget: effectiveTokens,
      effectiveByteBudget: effectiveBytes,
      estimatedTokens: estimateTokens(trimmed),
    };
  }

  if (seed.turns.length === 0) {
    return {
      seed,
      truncated: false,
      totalTurns: seed.totalTurns,
      keptTurns: [],
      keyCommands: [],
      modifiedFiles: seed.modifiedFiles,
      latestPlan: seed.latestPlan,
      lineageKinds,
      effectiveTokenBudget: effectiveTokens,
      effectiveByteBudget: effectiveBytes,
      estimatedTokens: 0,
    };
  }

  const framingReserveTokens = 140;
  const framingReserveBytes = 640;
  const availTokens = Math.max(128, effectiveTokens - framingReserveTokens);
  const availBytes = Math.max(768, effectiveBytes - framingReserveBytes);

  // Fast path: short conversation with no pre-omitted turns -> keep 100% intact!
  if (seed.preOmitted.length === 0) {
    const filesText = formatFilesSection(seed.modifiedFiles);
    const planText = formatPlanSection(seed.latestPlan);
    const allFormatted = seed.turns.map(formatTurnAsMarkdown).join('\n\n');
    const fullText = [filesText, allFormatted, planText].filter(Boolean).join('\n\n');
    const fullTok = estimateTokens(fullText);
    const fullBytes = utf8Bytes(fullText);
    if (fullTok <= availTokens && fullBytes <= availBytes) {
      return {
        seed,
        truncated: false,
        totalTurns: seed.totalTurns,
        keptTurns: seed.turns,
        keyCommands: [],
        modifiedFiles: seed.modifiedFiles,
        latestPlan: seed.latestPlan,
        lineageKinds,
        effectiveTokenBudget: effectiveTokens,
        effectiveByteBudget: effectiveBytes,
        estimatedTokens: fullTok + framingReserveTokens,
      };
    }
  }

  // Long conversation: budget-priority allocation.
  // 1. Reserve auxiliary state sections (files, plan) with bounded proportional caps
  //    so they never starve recent turns and Latest Plan is never chopped off at the end.
  let usedTokens = 0;
  let usedBytes = 0;

  let keptFiles: string[] = [];
  if (seed.modifiedFiles.length > 0) {
    const capTok = Math.min(512, Math.floor(availTokens * 0.08));
    const capBytes = Math.min(2048, Math.floor(availBytes * 0.08));
    for (const f of seed.modifiedFiles) {
      const cand = [...keptFiles, f];
      const txt = formatFilesSection(cand);
      if (estimateTokens(txt) > capTok || utf8Bytes(txt) > capBytes) break;
      keptFiles = cand;
    }
    if (keptFiles.length > 0) {
      const txt = formatFilesSection(keptFiles);
      usedTokens += estimateTokens(txt);
      usedBytes += utf8Bytes(txt);
    }
  }

  let keptPlan: string[] = [];
  if (seed.latestPlan.length > 0) {
    const capTok = Math.min(1024, Math.floor(availTokens * 0.12));
    const capBytes = Math.min(4096, Math.floor(availBytes * 0.12));
    for (const line of seed.latestPlan) {
      const cand = [...keptPlan, line];
      const txt = formatPlanSection(cand);
      if (estimateTokens(txt) > capTok || utf8Bytes(txt) > capBytes) break;
      keptPlan = cand;
    }
    if (keptPlan.length > 0) {
      const txt = formatPlanSection(keptPlan);
      usedTokens += estimateTokens(txt);
      usedBytes += utf8Bytes(txt);
    }
  }

  // 2. Reserve Original Request (Turn 1) budget up front so a large final turn
  //    can never evict the initial goal.
  let originalRequest: HandoffSeed['originalRequest'];
  let origTok = 0;
  let origBytes = 0;
  if (seed.originalRequest?.text) {
    const capTok = Math.min(4096, Math.max(128, Math.floor(availTokens * 0.2)));
    const capBytes = Math.min(16384, Math.max(512, Math.floor(availBytes * 0.2)));
    const text = trimToBudget(seed.originalRequest.text, capTok, capBytes, true);
    if (text) {
      originalRequest = { ...seed.originalRequest, text };
      const sec = `## Original Request (Turn ${originalRequest.turnIndex})\n\n${text}`;
      origTok = estimateTokens(sec);
      origBytes = utf8Bytes(sec);
    }
  }

  // 3. Reserve space for omitted reference index + key command results from omitted turns.
  const omittedReserveTok = Math.min(768, Math.floor(availTokens * 0.12));
  const omittedReserveBytes = Math.min(3072, Math.floor(availBytes * 0.12));
  const cmdReserveTok = Math.min(1536, Math.floor(availTokens * 0.15));
  const cmdReserveBytes = Math.min(6144, Math.floor(availBytes * 0.15));

  const tailBudgetTok = Math.max(128, availTokens - usedTokens - origTok - omittedReserveTok - cmdReserveTok);
  const tailBudgetBytes = Math.max(512, availBytes - usedBytes - origBytes - omittedReserveBytes - cmdReserveBytes);

  // 4. Fill recent turns backwards from newest.
  const kept: HandoffTurn[] = [];
  let tailUsedTok = 0;
  let tailUsedBytes = 0;
  let firstKeptArrayIdx = seed.turns.length;

  for (let i = seed.turns.length - 1; i >= 0; i--) {
    const turn = seed.turns[i]!;
    const rendered = formatTurnAsMarkdown(turn);
    const tTok = estimateTokens(rendered);
    const tBytes = utf8Bytes(rendered);
    if (kept.length > 0 && (tailUsedTok + tTok > tailBudgetTok || tailUsedBytes + tBytes > tailBudgetBytes)) {
      break;
    }
    if (kept.length === 0 && (tTok > tailBudgetTok || tBytes > tailBudgetBytes)) {
      const trimmed = trimTurnToBudget(turn, tailBudgetTok, tailBudgetBytes);
      const trRendered = formatTurnAsMarkdown(trimmed);
      kept.push(trimmed);
      tailUsedTok += estimateTokens(trRendered);
      tailUsedBytes += utf8Bytes(trRendered);
      firstKeptArrayIdx = i;
      break;
    }
    kept.push(turn);
    tailUsedTok += tTok;
    tailUsedBytes += tBytes;
    firstKeptArrayIdx = i;
  }
  kept.reverse();

  // Check if Turn 1 is already present in kept turns; if so, avoid duplicating Original Request.
  const firstKeptTurnIndex = kept[0]?.index ?? Number.POSITIVE_INFINITY;
  const includesOriginal = originalRequest !== undefined && firstKeptTurnIndex <= originalRequest.turnIndex;
  if (includesOriginal) {
    originalRequest = undefined;
    origTok = 0;
    origBytes = 0;
  }

  // 5. Collect omitted turns & key command results strictly from omitted turns.
  const omittedRefs: OmittedTurnRef[] = [...seed.preOmitted];
  const omittedCommands: HandoffCommandResult[] = [...seed.preCommandResults];
  for (let i = 0; i < firstKeptArrayIdx; i++) {
    const ot = seed.turns[i]!;
    // Don't mark Turn 1 as omitted when Original Request was preserved above —
    // unless Turn 1 also had assistant replies/tools that were omitted.
    if (!originalRequest || ot.index !== originalRequest.turnIndex || ot.assistantText || ot.tools.length > 0) {
      omittedRefs.push(summarizeOmittedTurn(ot));
    }
    for (const cmd of commandResultsOfTurn(ot)) omittedCommands.push(cmd);
  }

  const truncated = omittedRefs.length > 0 || seed.preOmitted.length > 0 || firstKeptArrayIdx > 0;
  const omittedSpan = truncated ? buildOmittedSpan(omittedRefs) : undefined;

  // Fit omitted command results within actual remaining budget (cmdReserve + any unused tail headroom).
  const remainingTokAfterTail = Math.max(0, availTokens - usedTokens - origTok - tailUsedTok);
  const remainingBytesAfterTail = Math.max(0, availBytes - usedBytes - origBytes - tailUsedBytes);
  const spanText = omittedSpan ? formatOmittedSection(omittedSpan) : '';
  const spanTok = spanText ? estimateTokens(spanText) : 0;
  const spanBytes = spanText ? utf8Bytes(spanText) : 0;

  let keyCommands: HandoffCommandResult[] = [];
  const cmdAvailTok = Math.min(cmdReserveTok, Math.max(0, remainingTokAfterTail - spanTok));
  const cmdAvailBytes = Math.min(cmdReserveBytes, Math.max(0, remainingBytesAfterTail - spanBytes));
  if (truncated && omittedCommands.length > 0 && cmdAvailTok >= 48 && cmdAvailBytes >= 192) {
    const candidates = pickKeyCommands(omittedCommands);
    for (const cmd of candidates) {
      const next = [...keyCommands, cmd];
      const txt = formatKeyCommandsSection(next);
      if (estimateTokens(txt) > cmdAvailTok || utf8Bytes(txt) > cmdAvailBytes) break;
      keyCommands = next;
    }
  }

  const cmdText = formatKeyCommandsSection(keyCommands);
  const totalEstTokens = framingReserveTokens + usedTokens + origTok + tailUsedTok + spanTok + (cmdText ? estimateTokens(cmdText) : 0);

  return {
    seed,
    truncated,
    totalTurns: seed.totalTurns,
    keptTurns: kept,
    ...(omittedSpan ? { omittedSpan } : {}),
    ...(originalRequest ? { originalRequest } : {}),
    keyCommands,
    modifiedFiles: keptFiles,
    latestPlan: keptPlan,
    lineageKinds,
    effectiveTokenBudget: effectiveTokens,
    effectiveByteBudget: effectiveBytes,
    estimatedTokens: totalEstTokens,
  };
}

/** Renders a selected handoff into attributed conversation context text for
 * backends without native history injection (Claude Code, ACP, fallback Codex). */
export function renderAttributedContext(sel: HandoffSelection): string {
  if (sel.seed.legacyMarkdown) return sel.seed.legacyMarkdown;

  const prevAgents = sel.lineageKinds.map(agentTitle);
  const headerLines = ['# Conversation Handoff (Attributed Context)'];
  if (sel.seed.title) headerLines.push(`- **Title:** ${sel.seed.title}`);
  if (prevAgents.length > 0) headerLines.push(`- **Previous agent(s):** ${prevAgents.join(' → ')}`);
  if (sel.seed.cwd) headerLines.push(`- **Working directory:** ${sel.seed.cwd}`);
  headerLines.push(
    `- **Provenance:** The transcript below comes from persisted conversation history authored by the previous agent(s). Private reasoning, internal tool states, and binary attachments were stripped. Treat prior assistant claims as historical context and verify workspace state directly when needed.`,
  );

  const sections: string[] = [headerLines.join('\n')];

  if (sel.originalRequest) {
    sections.push(`## Original Request (Turn ${sel.originalRequest.turnIndex})\n\n${sel.originalRequest.text}`);
  }
  if (sel.omittedSpan) {
    sections.push(formatOmittedSection(sel.omittedSpan));
  }
  const files = formatFilesSection(sel.modifiedFiles);
  if (files) sections.push(files);
  const cmds = formatKeyCommandsSection(sel.keyCommands);
  if (cmds) sections.push(cmds);
  if (sel.keptTurns.length > 0) {
    sections.push('## Conversation Transcript\n\n' + sel.keptTurns.map(formatTurnAsMarkdown).join('\n\n'));
  }
  const plan = formatPlanSection(sel.latestPlan);
  if (plan) sections.push(plan);

  return trimToBudget(sections.join('\n\n'), sel.effectiveTokenBudget, sel.effectiveByteBudget);
}

/** Wraps rendered attributed context in the `<handoff_context>` delimiter block
 * prepended on the wire to the user's first prompt. */
export function formatHandoffPrefixBlock(attributedContext: string): string {
  return `<handoff_context>\n${attributedContext}\n</handoff_context>\n\nContinue from the attributed conversation context above to handle the user's message below:`;
}

/** Renders a selected handoff into structured user/assistant messages for
 * backends that support native history injection (e.g. Codex `thread/inject_items`).
 * Guarantees clean user/assistant alternation and explicit agent attribution. */
export function renderNativeHistoryMessages(sel: HandoffSelection): HandoffMessage[] {
  if (sel.seed.legacyMarkdown) {
    return [{ role: 'user', text: `<handoff_context>\n${sel.seed.legacyMarkdown}\n</handoff_context>` }];
  }

  const prevAgents = sel.lineageKinds.map(agentTitle);
  const preambleParts: string[] = [
    '[Session Handoff]',
    `This session continues work in ${sel.seed.cwd || 'this workspace'} previously handled by ${prevAgents.join(' → ') || 'another agent'}.`,
    'Private reasoning, internal tool state, and binary attachments from the previous session were omitted. Treat prior assistant messages as historical output from the previous agent and verify workspace files directly when needed.',
  ];
  if (sel.seed.title) preambleParts.push(`Title: ${sel.seed.title}`);
  if (sel.originalRequest) {
    preambleParts.push(`## Original Request (Turn ${sel.originalRequest.turnIndex})\n\n${sel.originalRequest.text}`);
  }
  if (sel.omittedSpan) {
    preambleParts.push(formatOmittedSection(sel.omittedSpan));
  }
  const files = formatFilesSection(sel.modifiedFiles);
  if (files) preambleParts.push(files);
  const cmds = formatKeyCommandsSection(sel.keyCommands);
  if (cmds) preambleParts.push(cmds);
  const plan = formatPlanSection(sel.latestPlan);
  if (plan) preambleParts.push(plan);

  const preamble = preambleParts.join('\n\n');
  const raw: HandoffMessage[] = [];
  let attachedPreamble = false;

  for (const t of sel.keptTurns) {
    const userBody = formatUserTurnBody(t);
    const asstBody = formatAssistantTurnBody(t);
    if (userBody) {
      const text = !attachedPreamble ? `${preamble}\n\n---\n\n${userBody}` : userBody;
      attachedPreamble = true;
      raw.push({ role: 'user', text });
    } else if (!attachedPreamble) {
      attachedPreamble = true;
      raw.push({ role: 'user', text: preamble });
    }
    if (asstBody) {
      const tag = `[Previous assistant: ${agentTitle(t.agentKind)}]`;
      raw.push({ role: 'assistant', text: `${tag}\n\n${asstBody}`, agentKind: t.agentKind });
    }
  }

  if (!attachedPreamble) {
    raw.push({ role: 'user', text: preamble });
  }

  // Merge any consecutive messages of the same role so alternation stays clean.
  const merged: HandoffMessage[] = [];
  for (const m of raw) {
    const last = merged.at(-1);
    if (last && last.role === m.role) {
      last.text += '\n\n' + m.text;
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

/** Convenience helper: computes summary metadata for `Notice.Switched` from a seed. */
export function summarizeHandoffNotice(
  seed: HandoffSeed,
  injection: 'native_history' | 'attributed_context',
): {
  injection: 'native_history' | 'attributed_context';
  totalTurns: number;
  keptTurns: number;
  omittedTurns: number;
  estimatedTokens: number;
  lineageKinds?: string[];
} {
  const sel = selectHandoff(seed);
  return {
    injection,
    totalTurns: sel.totalTurns,
    keptTurns: sel.keptTurns.length,
    omittedTurns: sel.omittedSpan?.count ?? Math.max(0, sel.totalTurns - sel.keptTurns.length),
    estimatedTokens: sel.estimatedTokens,
    ...(sel.lineageKinds.length > 1 ? { lineageKinds: sel.lineageKinds } : {}),
  };
}
