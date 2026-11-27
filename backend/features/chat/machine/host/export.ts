// Serializes a chat's stored events into a bounded Markdown handoff digest
// for Op.Export, Op.Switch, and fallback Op.Fork / CommandOp.Rewind.
import * as chat from '#shared/proto/chatproto/index.ts';

/** Default cap on an exported conversation handoff, in UTF-8 bytes. */
export const MAX_EXPORT_BYTES = 96 << 10;
const MAX_TOOL_SUMMARY = 384;
const MAX_TURN_TEXT = 16 << 10;

interface ToolSummary {
  id: string;
  title: string;
  kind: string;
  status: string;
  locations: string[];
  detail: string;
}

interface TurnEntry {
  kind: 'user' | 'assistant' | 'qa';
  text: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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

function summarizeToolDetail(upd: Record<string, unknown>): string {
  if (isObj(upd.rawInput)) {
    const cmd = str(upd.rawInput.command) || str(upd.rawInput.cmd);
    if (cmd) return trimBytes(cmd.replace(/\s+/g, ' ').trim(), MAX_TOOL_SUMMARY);
    const p = str(upd.rawInput.file_path) || str(upd.rawInput.path);
    if (p) return p;
  }
  if (Array.isArray(upd.content)) {
    for (const c of upd.content) {
      if (!isObj(c)) continue;
      if (c.type === 'diff' && str(c.path)) return `diff ${str(c.path)}`;
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

/** Formats stored chat events into a structured, size-bounded Markdown handoff. */
export function exportMarkdown(events: readonly chat.Event[], opts: ExportOptions = {}): string {
  const maxBytes = Math.max(2048, opts.maxBytes ?? MAX_EXPORT_BYTES);
  const turns: TurnEntry[] = [];
  let assistantChunks: string[] = [];
  let assistantTools = new Map<string, ToolSummary>();
  let latestPlan: string[] = [];
  const openQuestions = new Map<string, chat.Question[]>();
  const queuedWaiting = new Map<string, unknown[]>();

  const flushAssistant = () => {
    const bodyParts: string[] = [];
    const prose = assistantChunks.join('').trim();
    if (prose) bodyParts.push(trimBytes(prose, MAX_TURN_TEXT));
    if (assistantTools.size > 0) {
      const lines: string[] = [];
      for (const t of assistantTools.values()) {
        const loc = t.locations.length ? ` (${t.locations.slice(0, 4).join(', ')})` : '';
        const det = t.detail && !loc.includes(t.detail) ? `: \`${t.detail}\`` : '';
        const status = t.status ? ` [${t.status}]` : '';
        lines.push(`- ${t.title || t.kind || 'tool'}${loc}${det}${status}`);
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
        if (text) turns.push({ kind: 'user', text: trimBytes(text, MAX_TURN_TEXT) });
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
          if (text) turns.push({ kind: 'user', text: trimBytes(text, MAX_TURN_TEXT) });
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
          };
          const title = str(upd.title) || prev.title;
          const tk = str(upd.kind) || prev.kind;
          const status = str(upd.status) || prev.status;
          const locs = [...prev.locations];
          for (const p of extractLocations(upd.locations)) if (!locs.includes(p)) locs.push(p);
          const detail = summarizeToolDetail(upd) || prev.detail;
          assistantTools.set(id, { id, title, kind: tk, status, locations: locs, detail });
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
      case chat.EventType.Turn: {
        if (ev.state === chat.TurnState.End || ev.state === chat.TurnState.Error) flushAssistant();
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

  const planCap = Math.min(8192, Math.floor(maxBytes / 4));
  const planSection = latestPlan.length > 0 ? trimBytes(`\n\n## Latest Plan\n\n${latestPlan.join('\n')}`, planCap) : '';
  const omittedNote = '\n\n_[Earlier turns omitted to fit context budget]_\n';

  if (turns.length === 0) {
    return trimBytes(header + planSection, maxBytes);
  }

  const formatted = turns.map((t) => {
    const label = t.kind === 'user' ? '### User' : t.kind === 'qa' ? '### Clarifications' : '### Assistant';
    return `${label}\n\n${t.text}`;
  });

  const fixedBytes = Buffer.byteLength(header + planSection + '\n\n## Transcript\n\n', 'utf8');
  const budget = Math.max(512, maxBytes - fixedBytes - Buffer.byteLength(omittedNote, 'utf8'));

  // Keep the most recent turns that fit the byte budget.
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (let i = formatted.length - 1; i >= 0; i--) {
    const chunk = formatted[i]!;
    const cost = Buffer.byteLength(chunk, 'utf8') + (kept.length > 0 ? 2 : 0);
    if (kept.length > 0 && used + cost > budget) {
      truncated = true;
      break;
    }
    if (cost > budget) {
      kept.push(trimBytes(chunk, budget));
      truncated = i > 0;
      break;
    }
    kept.push(chunk);
    used += cost;
  }
  kept.reverse();

  const body = (truncated ? omittedNote + '\n' : '\n\n') + kept.join('\n\n');
  return trimBytes(`${header}\n\n## Transcript${body}${planSection}`, maxBytes);
}

/** Prepends a conversation handoff digest to a user's first prompt blocks. */
export function wrapSeedPrompt(seedContext: string, content: readonly unknown[]): unknown[] {
  const prefix = {
    type: 'text',
    text: `<handoff_context>\n${seedContext}\n</handoff_context>\n\nContinue from the handoff context above to answer the user's message below:`,
  };
  return [prefix, ...content];
}
