// Serializes a chat's stored events into:
// - a structured, size-bounded Markdown handoff digest (exportMarkdown) for
//   Op.Export (format 'markdown'), Op.Switch, and fallback Op.Fork / Rewind;
// - a lossless raw JSON export (exportJson) for Op.Export (format 'json').
import * as chat from '#shared/proto/chatproto/index.ts';

/** Default cap on an exported Markdown handoff, in UTF-8 bytes (96 KiB). */
export const MAX_EXPORT_BYTES = 96 << 10;
/** Minimum allowed Markdown export/handoff byte budget (2 KiB). */
export const MIN_EXPORT_BYTES = 2 << 10;
/** Maximum allowed Markdown export/handoff byte budget (512 KiB). */
export const MAX_EXPORT_BUDGET = 512 << 10;
/** Maximum serialized byte size for raw JSON exports (12 MiB, safely under MAX_LINE). */
export const MAX_EXPORT_JSON_BYTES = 12 << 20;

const MAX_TOOL_SUMMARY = 384;
const MAX_ERROR_SUMMARY = 640;
const MAX_ISSUES = 12;
const MAX_CHANGED_FILES = 40;

interface ToolSummary {
  id: string;
  title: string;
  kind: string;
  status: string;
  locations: string[];
  detail: string;
  error: string;
}

interface TurnEntry {
  kind: 'user' | 'assistant' | 'qa' | 'notice';
  text: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Clamps a requested Markdown export/handoff budget to safe bounds. */
export function clampExportBytes(maxBytes: number | undefined): number {
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) return MAX_EXPORT_BYTES;
  return Math.max(MIN_EXPORT_BYTES, Math.min(MAX_EXPORT_BUDGET, Math.trunc(maxBytes)));
}

function trimBytes(s: string, max: number): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= max) return s;
  const ell = '…';
  const ellBytes = Buffer.byteLength(ell, 'utf8');
  if (max <= ellBytes) return b.subarray(0, Math.max(0, max)).toString('utf8');
  let cut = max - ellBytes;
  while (cut > 0 && (b[cut]! & 0xc0) === 0x80) cut--;
  return b.subarray(0, cut).toString('utf8') + ell;
}

function formatContent(content: unknown[] | undefined): string {
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
        const name = str(raw.name) || str(raw.uri);
        if (name) parts.push(`@${name}`);
        break;
      }
      case 'image':
        parts.push('[image attached]');
        break;
    }
  }
  return parts.join('\n');
}

function extractTextFromUpdate(upd: Record<string, unknown>): string {
  const c = upd.content;
  if (isObj(c) && c.type === 'text') return str(c.text);
  return str(upd.text);
}

function extractLocations(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const loc of raw) {
    if (!isObj(loc)) continue;
    const p = str(loc.path);
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

function summarizeToolDetail(upd: Record<string, unknown>): string {
  if (isObj(upd.rawInput)) {
    const cmd = extractCommand(upd.rawInput);
    if (cmd) return trimBytes(cmd.replace(/\s+/g, ' ').trim(), MAX_TOOL_SUMMARY);
    const p = str(upd.rawInput.file_path) || str(upd.rawInput.path) || str(upd.rawInput.filePath);
    if (p) return p;
    const query = str(upd.rawInput.pattern) || str(upd.rawInput.query) || str(upd.rawInput.url) || str(upd.rawInput.uri);
    if (query) return trimBytes(query.replace(/\s+/g, ' ').trim(), MAX_TOOL_SUMMARY);
  }
  if (Array.isArray(upd.content)) {
    for (const c of upd.content) {
      if (!isObj(c)) continue;
      if (c.type === 'diff') {
        if (str(c.path)) return `diff ${str(c.path)}`;
        if (Array.isArray(c.changes)) {
          const paths = c.changes.map((x) => (isObj(x) ? str(x.path) : '')).filter(Boolean);
          if (paths.length) return `diff ${paths.slice(0, 3).join(', ')}`;
        }
      }
    }
  }
  return '';
}

function extractDiffPaths(upd: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (!Array.isArray(upd.content)) return out;
  for (const c of upd.content) {
    if (!isObj(c) || c.type !== 'diff') continue;
    if (str(c.path) && !out.includes(str(c.path))) out.push(str(c.path));
    if (Array.isArray(c.changes)) {
      for (const ch of c.changes) {
        if (!isObj(ch)) continue;
        const p = str(ch.path);
        if (p && !out.includes(p)) out.push(p);
      }
    }
  }
  return out;
}

function extractToolError(upd: Record<string, unknown>): string {
  const status = str(upd.status);
  if (status !== 'failed') return '';
  if (isObj(upd.rawOutput)) {
    const msg = str(upd.rawOutput.error) || str(upd.rawOutput.stderr) || str(upd.rawOutput.message) || str(upd.rawOutput.output);
    if (msg) return trimBytes(msg.replace(/\s+/g, ' ').trim(), MAX_ERROR_SUMMARY);
  } else if (typeof upd.rawOutput === 'string' && upd.rawOutput.trim()) {
    return trimBytes(upd.rawOutput.replace(/\s+/g, ' ').trim(), MAX_ERROR_SUMMARY);
  }
  if (Array.isArray(upd.content)) {
    for (const c of upd.content) {
      if (isObj(c) && c.type === 'content' && isObj(c.content) && c.content.type === 'text') {
        const t = str(c.content.text).trim();
        if (t) return trimBytes(t.replace(/\s+/g, ' '), MAX_ERROR_SUMMARY);
      }
    }
  }
  return '';
}

export interface ExportOptions {
  title?: string;
  kind?: string;
  cwd?: string;
  maxBytes?: number;
}

/** Formats stored chat events into a structured, size-bounded Markdown export.
 * Preserves short conversations intact (no per-turn chopping when total fits),
 * and on long conversations preserves workspace file changes, recent issues,
 * the original user request, recent turns, and the latest plan. */
export function exportMarkdown(events: readonly chat.Event[], opts: ExportOptions = {}): string {
  const maxBytes = clampExportBytes(opts.maxBytes);
  const turns: TurnEntry[] = [];
  let assistantChunks: string[] = [];
  let assistantTools = new Map<string, ToolSummary>();
  let latestPlan: string[] = [];
  const modifiedFiles: string[] = [];
  const issues: string[] = [];
  const openQuestions = new Map<string, chat.Question[]>();
  const queuedWaiting = new Map<string, unknown[]>();

  const recordModified = (path: string) => {
    if (!path || modifiedFiles.includes(path) || modifiedFiles.length >= MAX_CHANGED_FILES) return;
    modifiedFiles.push(path);
  };
  const recordIssue = (msg: string) => {
    const clean = trimBytes(msg.replace(/\s+/g, ' ').trim(), MAX_ERROR_SUMMARY);
    if (!clean) return;
    if (issues.at(-1) === clean) return;
    issues.push(clean);
    if (issues.length > MAX_ISSUES) issues.shift();
  };

  const flushAssistant = () => {
    const bodyParts: string[] = [];
    const prose = assistantChunks.join('').trim();
    if (prose) bodyParts.push(prose);
    if (assistantTools.size > 0) {
      const lines: string[] = [];
      for (const t of assistantTools.values()) {
        const loc = t.locations.length ? ` (${t.locations.slice(0, 4).join(', ')})` : '';
        const det = t.detail && !loc.includes(t.detail) ? `: \`${t.detail}\`` : '';
        const status = t.status ? ` [${t.status}]` : '';
        const err = t.error ? ` — ${t.error}` : '';
        lines.push(`- ${t.title || t.kind || 'tool'}${loc}${det}${status}${err}`);
        if (t.status === 'failed') {
          const label = t.title || t.kind || 'tool';
          recordIssue(`${label}${loc}${t.error ? `: ${t.error}` : ' failed'}`);
        }
      }
      bodyParts.push('**Tools & files:**\n' + lines.join('\n'));
    }
    if (bodyParts.length > 0) {
      turns.push({ kind: 'assistant', text: bodyParts.join('\n\n') });
    }
    assistantChunks = [];
    assistantTools = new Map();
  };

  for (const ev of events) {
    if (ev.live) continue;
    switch (ev.t) {
      case chat.EventType.User: {
        flushAssistant();
        const text = formatContent(ev.content);
        if (text) turns.push({ kind: 'user', text });
        break;
      }
      case chat.EventType.Queued: {
        if (ev.state === chat.QueuedState.Waiting) {
          if (ev.message && Array.isArray(ev.content)) queuedWaiting.set(ev.message, ev.content);
        } else if (ev.state === chat.QueuedState.Cancelled) {
          if (ev.message) queuedWaiting.delete(ev.message);
        } else if (ev.state === chat.QueuedState.Taken) {
          flushAssistant();
          const content = Array.isArray(ev.content) ? ev.content : ev.message ? queuedWaiting.get(ev.message) : undefined;
          if (ev.message) queuedWaiting.delete(ev.message);
          const text = formatContent(content);
          if (text) turns.push({ kind: 'user', text });
        }
        break;
      }
      case chat.EventType.Update: {
        if (ev.parent) break;
        const upd = ev.update;
        if (!isObj(upd)) break;
        const kind = str(upd.sessionUpdate);
        if (kind === 'agent_message_chunk') {
          const t = extractTextFromUpdate(upd);
          if (t) assistantChunks.push(t);
        } else if (kind === 'tool_call' || kind === 'tool_call_update') {
          const id = str(upd.toolCallId) || str(ev.item);
          if (!id) break;
          const prev = assistantTools.get(id) ?? {
            id,
            title: '',
            kind: '',
            status: '',
            locations: [],
            detail: '',
            error: '',
          };
          const title = str(upd.title) || prev.title;
          const tk = str(upd.kind) || prev.kind;
          const status = str(upd.status) || prev.status;
          const locs = [...prev.locations];
          for (const p of extractLocations(upd.locations)) if (!locs.includes(p)) locs.push(p);
          const diffPaths = extractDiffPaths(upd);
          for (const p of diffPaths) {
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
          const detail = summarizeToolDetail(upd) || prev.detail;
          const error = extractToolError(upd) || prev.error;
          assistantTools.set(id, { id, title, kind: tk, status, locations: locs, detail, error });
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
          flushAssistant();
          const qs = openQuestions.get(ev.id) ?? [];
          const lines: string[] = [];
          for (const [qid, vals] of Object.entries(ev.answers)) {
            const q = qs.find((x) => x.id === qid);
            const prompt = q?.question || q?.header || qid;
            lines.push(`- **Q:** ${prompt}\n  **A:** ${vals.join(', ')}`);
          }
          if (lines.length > 0) turns.push({ kind: 'qa', text: lines.join('\n') });
        }
        if (ev.id) openQuestions.delete(ev.id);
        break;
      }
      case chat.EventType.Notice: {
        const method = str(ev.method);
        const params = isObj(ev.params) ? ev.params : undefined;
        if (method.endsWith('/compacted')) {
          flushAssistant();
          turns.push({ kind: 'notice', text: '_[Context compacted earlier in session]_' });
        } else if (method.endsWith('/error') && params && str(params.message)) {
          recordIssue(str(params.message));
        }
        break;
      }
      case chat.EventType.Turn: {
        if (ev.state === chat.TurnState.End) {
          flushAssistant();
        } else if (ev.state === chat.TurnState.Error) {
          flushAssistant();
          const msg = ev.error?.message ? trimBytes(ev.error.message, MAX_ERROR_SUMMARY) : '';
          if (msg) {
            recordIssue(`Turn error: ${msg}`);
            turns.push({ kind: 'notice', text: `_[Turn failed: ${msg}]_` });
          }
        }
        break;
      }
    }
  }
  flushAssistant();

  const headerLines = ['# Conversation Handoff'];
  if (opts.title) headerLines.push(`- **Title:** ${opts.title}`);
  if (opts.kind) headerLines.push(`- **Previous agent:** ${opts.kind}`);
  if (opts.cwd) headerLines.push(`- **Working directory:** ${opts.cwd}`);
  const header = headerLines.join('\n');

  const filesCap = Math.min(4096, Math.floor(maxBytes / 8));
  const filesSection =
    modifiedFiles.length > 0 ? trimBytes(`\n\n## Files Modified\n\n${modifiedFiles.map((f) => `- \`${f}\``).join('\n')}`, filesCap) : '';

  const issuesCap = Math.min(2048, Math.floor(maxBytes / 10));
  const issuesSection = issues.length > 0 ? trimBytes(`\n\n## Recent Issues\n\n${issues.map((i) => `- ${i}`).join('\n')}`, issuesCap) : '';

  const planCap = Math.min(8192, Math.floor(maxBytes / 4));
  const planSection = latestPlan.length > 0 ? trimBytes(`\n\n## Latest Plan\n\n${latestPlan.join('\n')}`, planCap) : '';
  const omittedNote = '\n\n_[Earlier turns omitted to fit context budget]_\n';

  if (turns.length === 0) {
    return trimBytes(header + filesSection + issuesSection + planSection, maxBytes);
  }

  const formatted = turns.map((t) => {
    if (t.kind === 'notice') return t.text;
    const label = t.kind === 'user' ? '### User' : t.kind === 'qa' ? '### Clarifications' : '### Assistant';
    return `${label}\n\n${t.text}`;
  });

  const auxSections = filesSection + issuesSection;
  const fullDoc = `${header}${auxSections}\n\n## Transcript\n\n${formatted.join('\n\n')}${planSection}`;
  if (Buffer.byteLength(fullDoc, 'utf8') <= maxBytes) {
    return fullDoc;
  }

  const fixedBytes = Buffer.byteLength(header + auxSections + planSection + '\n\n## Transcript\n\n', 'utf8');
  const budget = Math.max(256, maxBytes - fixedBytes - Buffer.byteLength(omittedNote, 'utf8'));

  // Reserve space for Original Request when budget >= 4 KiB so a large final turn
  // never crowds it out.
  let goalSection = '';
  let goalBytes = 0;
  const firstUserIdx = turns.findIndex((t) => t.kind === 'user');
  if (maxBytes >= 4096 && firstUserIdx >= 0) {
    const goalCap = Math.min(8192, Math.max(512, Math.floor(maxBytes / 6)));
    const cand = trimBytes(`\n\n## Original Request\n\n${turns[firstUserIdx]!.text}`, goalCap);
    const cb = Buffer.byteLength(cand, 'utf8');
    if (cb < budget - 256) {
      goalSection = cand;
      goalBytes = cb;
    }
  }
  const tailBudget = Math.max(256, budget - goalBytes);

  // Keep the most recent turns that fit the byte budget.
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  let firstKeptIndex = formatted.length;
  for (let i = formatted.length - 1; i >= 0; i--) {
    const chunk = formatted[i]!;
    const cost = Buffer.byteLength(chunk, 'utf8') + (kept.length > 0 ? 2 : 0);
    if (kept.length > 0 && used + cost > tailBudget) {
      truncated = true;
      break;
    }
    if (cost > tailBudget) {
      kept.push(trimBytes(chunk, tailBudget));
      firstKeptIndex = i;
      truncated = i > 0;
      break;
    }
    kept.push(chunk);
    used += cost;
    firstKeptIndex = i;
  }
  kept.reverse();

  if (!truncated || firstUserIdx >= firstKeptIndex) {
    goalSection = '';
  }

  const body = (truncated ? omittedNote + '\n' : '\n\n') + kept.join('\n\n');
  return trimBytes(`${header}${goalSection}${auxSections}\n\n## Transcript${body}${planSection}`, maxBytes);
}

export interface ExportJsonOptions {
  chat: chat.Chat;
  upToSeq?: number;
  exportedAt: string;
  maxBytes?: number;
}

/** Produces a lossless structured JSON export of a chat and its stored events,
 * keeping the serialized payload safely under MAX_EXPORT_JSON_BYTES so it
 * always fits a single chatproto Response line. */
export function exportJson(events: readonly chat.Event[], opts: ExportJsonOptions): chat.ChatExport {
  const c = opts.chat;
  const maxBytes = Math.max(64 << 10, Math.min(MAX_EXPORT_JSON_BYTES, opts.maxBytes ?? MAX_EXPORT_JSON_BYTES));
  const meta: chat.ChatExport['chat'] = {
    id: c.id,
    kind: c.kind,
    title: c.title,
    cwd: c.cwd,
    sessionId: c.sessionId,
    state: c.state,
    created: c.created,
    updated: c.updated,
    seq: c.seq,
    ...(c.agentVersion ? { agentVersion: c.agentVersion } : {}),
    ...(c.closed ? { closed: c.closed } : {}),
    ...(c.archived ? { archived: c.archived } : {}),
    ...(c.usage ? { usage: c.usage } : {}),
  };
  const base: chat.ChatExport = {
    version: 1,
    exportedAt: opts.exportedAt,
    chat: meta,
    ...(opts.upToSeq !== undefined ? { upToSeq: opts.upToSeq } : {}),
    events: [],
  };
  const stored = events.filter((ev) => !ev.live);
  const overhead = Buffer.byteLength(JSON.stringify({ ...base, truncated: true, omittedEvents: stored.length }), 'utf8');
  const budget = Math.max(0, maxBytes - overhead);

  const kept: chat.Event[] = [];
  let used = 0;
  for (let i = stored.length - 1; i >= 0; i--) {
    const ev = stored[i]!;
    const cost = Buffer.byteLength(JSON.stringify(ev), 'utf8') + (kept.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    kept.push(ev);
    used += cost;
  }
  kept.reverse();
  const omitted = stored.length - kept.length;
  return {
    ...base,
    ...(omitted > 0 ? { truncated: true, omittedEvents: omitted } : {}),
    events: kept,
  };
}

/** Prepends a conversation handoff digest to a user's first prompt blocks. */
export function wrapSeedPrompt(seedContext: string, content: readonly unknown[]): unknown[] {
  const prefix = {
    type: 'text',
    text: `<handoff_context>\n${seedContext}\n</handoff_context>\n\nContinue from the handoff context above to answer the user's message below:`,
  };
  return [prefix, ...content];
}
