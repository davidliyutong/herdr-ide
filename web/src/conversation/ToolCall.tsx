// A tool call in the conversation view: one quiet row (what the tool did,
// to what, how it went), which opens on what it gave: a command's output as
// a terminal shows text, an edit's diff, what was read, searched or fetched,
// a task's result, or the call's input. What only the opened call shows (a
// text diff's comparison, the input as JSON) is made when it is opened, so
// that a long conversation of closed calls costs little to draw.

import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowRightLeft,
  Ban,
  ChevronRight,
  CircleX,
  FilePenLine,
  FileSymlink,
  FileText,
  Globe,
  LoaderCircle,
  Search,
  SquareTerminal,
  Trash2,
  Workflow,
  Wrench,
} from 'lucide-react';
import { Markdown } from '../markdown/Markdown';
import { t } from '../i18n';
import { diffStat, hunks, lineDiff, patchLines, type DiffRow, type LineDiff, type Patch } from './diff';
import { commandOf, displayMath, exitCodeOf, inputText, interrupted, jsonText, plainOutput, splitPath, subjectOf } from './format';
import { asText, isDiffV2, type ToolCallContent, type ToolDiff, type ToolItem, type ToolKind } from './model';
import { Blocks, isShortened, type ItemContext } from './parts';

const KIND_ICONS: Record<ToolKind, typeof Wrench> = {
  read: FileText,
  edit: FilePenLine,
  delete: Trash2,
  move: FileSymlink,
  search: Search,
  execute: SquareTerminal,
  think: Workflow,
  fetch: Globe,
  switch_mode: ArrowRightLeft,
  other: Wrench,
};

/** The most lines of a diff drawn; the rest are counted. */
const MAX_DIFF_ROWS = 800;

/** The most pairs of lines a closed call's row compares to count the lines
 * a text diff adds and removes; beyond it the row shows no count until the
 * call is opened. */
const STAT_CELLS = 100_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A text diff: a file's text before (null: a new file) and after. */
type TextDiff = { type: 'text'; path?: string; oldText: string | null; newText: string };

/** A diff of the call, read once: a text diff (v1), a patch, or a v2
 * diff's list of changes without one. */
export type Change =
  TextDiff | { type: 'patch'; path?: string; patch: Patch } | { type: 'list'; changes: { operation: string; path: string }[] };

export function readDiff(d: ToolDiff): Change {
  const raw = d as unknown as Record<string, unknown>;
  const path = asText(raw.path);
  const patch = isObject(raw.patch) ? asText(raw.patch.text) : undefined;
  if (patch !== undefined) return { type: 'patch', path, patch: patchLines(patch) };
  if (isDiffV2(d)) {
    const changes = (d.changes as unknown[]).flatMap((c) => {
      const p = isObject(c) ? asText(c.path) : undefined;
      return p === undefined ? [] : [{ operation: asText((c as Record<string, unknown>).operation) ?? '', path: p }];
    });
    return { type: 'list', changes };
  }
  return { type: 'text', path, oldText: asText(raw.oldText) ?? null, newText: asText(raw.newText) ?? '' };
}

/** The lines of text diffs compared, once each. */
const compared = new WeakMap<TextDiff, LineDiff>();

function textDiff(c: TextDiff): LineDiff {
  let d = compared.get(c);
  if (!d) compared.set(c, (d = lineDiff(c.oldText, c.newText)));
  return d;
}

export const isDiff = (c: ToolCallContent): c is ToolDiff => c.type === 'diff';

/** The files diffs change, for a call that names no locations. */
export function changedPaths(changes: readonly Change[]): { path: string }[] {
  const out: string[] = [];
  for (const c of changes) {
    const paths = c.type === 'list' ? c.changes.map((x) => x.path) : c.type === 'patch' && !c.path ? c.patch.paths : c.path ? [c.path] : [];
    for (const p of paths) if (!out.includes(p)) out.push(p);
  }
  return out.map((path) => ({ path }));
}

/** The lines the diffs add and remove: a text diff's compared when the call
 * is open or was, else within STAT_CELLS; undefined when one is not. */
function counts(changes: readonly Change[], open: boolean): { added: number; removed: number } | undefined {
  let added = 0;
  let removed = 0;
  let any = false;
  for (const c of changes) {
    if (c.type === 'text') {
      const s = open ? textDiff(c) : (compared.get(c) ?? diffStat(c.oldText, c.newText, STAT_CELLS));
      if (!s) return undefined;
      added += s.added;
      removed += s.removed;
      any = true;
    } else if (c.type === 'patch') {
      added += c.patch.added;
      removed += c.patch.removed;
      any = true;
    }
  }
  return any ? { added, removed } : undefined;
}

export function StatusIcon({ kind, status }: { kind: ToolKind; status: string }) {
  if (status === 'in_progress') return <LoaderCircle className="conv-kind-icon conv-spin" aria-hidden />;
  if (status === 'failed') return <CircleX className="conv-kind-icon" aria-hidden />;
  if (status === 'cancelled') return <Ban className="conv-kind-icon" aria-hidden />;
  const Icon = KIND_ICONS[kind];
  return <Icon className="conv-kind-icon" aria-hidden />;
}

/** A path the call acts on: its name, and the directories above it apart,
 * a button that opens it when the view can. */
export function PathButton({ path, line, ctx }: { path: string; line?: number | null; ctx: ItemContext }) {
  const { name, dir } = splitPath(path);
  const body = (
    <>
      <span className="conv-path-name">
        {name}
        {line ? `:${line}` : ''}
      </span>
      {dir && <span className="conv-path-dir">{dir}</span>}
    </>
  );
  if (!ctx.openFile) {
    return (
      <span className="conv-path" title={path}>
        {body}
      </span>
    );
  }
  const open = ctx.openFile;
  return (
    <button type="button" className="conv-path" title={t('conversation.tool.open', { path })} onClick={() => open(path, line ?? undefined)}>
      {body}
    </button>
  );
}

function DiffRows({ rows }: { rows: readonly DiffRow[] }) {
  const shown = rows.length > MAX_DIFF_ROWS ? rows.slice(0, MAX_DIFF_ROWS) : rows;
  return (
    <div className="conv-diff">
      <div className="conv-diff-lines">
        {shown.map((r, i) =>
          r.op === 'skip' ? (
            <div key={i} className="conv-dl skip">
              {t('conversation.diff.unchanged', { n: r.count })}
            </div>
          ) : (
            <div key={i} className={`conv-dl ${r.op === '+' ? 'add' : r.op === '-' ? 'del' : 'ctx'}`} data-op={r.op}>
              {r.text || ' '}
            </div>
          ),
        )}
        {rows.length > shown.length && <div className="conv-dl skip">{t('conversation.diff.more', { n: rows.length - shown.length })}</div>}
      </div>
    </div>
  );
}

const PATCH_OPS = { add: '+', del: '-', ctx: ' ', hunk: '', meta: '' } as const;

function PatchRows({ patch }: { patch: Patch }) {
  const shown = patch.lines.length > MAX_DIFF_ROWS ? patch.lines.slice(0, MAX_DIFF_ROWS) : patch.lines;
  return (
    <div className="conv-diff">
      <div className="conv-diff-lines">
        {shown.map((l, i) => (
          <div key={i} className={`conv-dl ${l.kind}`} data-op={PATCH_OPS[l.kind]}>
            {(l.marked ? l.text.slice(1) : l.text) || ' '}
          </div>
        ))}
        {patch.lines.length > shown.length && (
          <div className="conv-dl skip">{t('conversation.diff.more', { n: patch.lines.length - shown.length })}</div>
        )}
      </div>
    </div>
  );
}

export function ChangeView({ change, header, ctx }: { change: Change; header: boolean; ctx: ItemContext }) {
  const head = header && change.type !== 'list' && change.path ? <PathButton path={change.path} ctx={ctx} /> : null;
  if (change.type === 'list') {
    return (
      <ul className="conv-changes">
        {change.changes.map((c, i) => (
          <li key={i}>
            <span className="conv-change-op">{c.operation}</span> <PathButton path={c.path} ctx={ctx} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="conv-change">
      {head}
      {change.type === 'patch' ? <PatchRows patch={change.patch} /> : <TextChange change={change} />}
    </div>
  );
}

/** A text diff: a new file whole, else its changes with the lines around
 * them. */
function TextChange({ change }: { change: TextDiff }) {
  const created = change.oldText === null;
  const diff = useMemo(() => textDiff(change), [change]);
  const rows = useMemo(() => (created ? diff.lines : hunks(diff.lines)), [diff, created]);
  return (
    <>
      {created && <div className="conv-note">{t('conversation.diff.newFile')}</div>}
      {!diff.exact && <div className="conv-note">{t('conversation.diff.notCompared')}</div>}
      {rows.length ? <DiffRows rows={rows} /> : <div className="conv-note">{t('conversation.diff.noChanges')}</div>}
    </>
  );
}

/** The kinds whose text results are Markdown (a page, a task's answer, a
 * plan), not a program's output. */
const PROSE: ReadonlySet<ToolKind> = new Set(['fetch', 'think', 'switch_mode']);

/** The text, images and links a call gave, as its kind shows them. */
export function Results({ content, kind, ctx }: { content: readonly ToolCallContent[]; kind: ToolKind; ctx: ItemContext }) {
  const blocks = content.flatMap((c) => (c.type === 'content' ? [c.content] : []));
  const text = blocks.flatMap((b) => (b.type === 'text' ? (asText(b.text) ?? []) : [])).join('\n');
  const terminal = content.some((c) => c.type === 'terminal');
  const cut = blocks.some(isShortened);
  const out: ReactNode[] = [];
  if (text.trim()) {
    if (PROSE.has(kind)) out.push(<Markdown key="md" text={displayMath(text)} className="conv-md conv-tool-md" />);
    else
      out.push(
        <pre key="pre" className={kind === 'execute' ? 'conv-pre conv-term' : 'conv-pre'}>
          {kind === 'execute' ? plainOutput(text) : text}
        </pre>,
      );
  }
  out.push(<Blocks key="blocks" blocks={blocks} ctx={ctx} />);
  if (cut)
    out.push(
      <div key="cut" className="conv-note">
        {t('conversation.tool.outputShortened')}
      </div>,
    );
  if (terminal)
    out.push(
      <div key="term" className="conv-note">
        {t('conversation.tool.inTerminal')}
      </div>,
    );
  return <>{out}</>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="conv-section">
      <div className="conv-section-title">{title}</div>
      {children}
    </div>
  );
}

export function ToolCallView({ item, ctx }: { item: ToolItem; ctx: ItemContext }) {
  const [open, setOpen] = useState(false);
  const kind: ToolKind = item.toolKind ?? 'other';
  const status = item.status ?? 'pending';
  const changes = useMemo(() => item.content.filter(isDiff).map(readDiff), [item.content]);
  const stat = useMemo(() => counts(changes, open), [changes, open]);
  const results = item.content.filter((c) => c.type !== 'diff');
  const command = kind === 'execute' ? commandOf(item.rawInput) : undefined;
  const code = kind === 'execute' ? exitCodeOf(item) : undefined;
  const stopped = kind === 'execute' && interrupted(item);
  const kindLabel = t(`conversation.toolKind.${kind}`);
  const title = item.title.trim();

  // The row: the kind of call (or the agent's own words for it, where the
  // kind says little), and what it acts on.
  let label = kindLabel;
  let subject = subjectOf(item);
  if (kind === 'execute') {
    if (title && command && title !== command && !command.startsWith(title)) label = title;
  } else if (kind === 'think' || kind === 'other' || kind === 'switch_mode') {
    if (title) label = title;
    if (subject === title) subject = undefined;
  } else if (!subject && !item.locations.length && title && title !== kindLabel) subject = title;
  const paths: { path: string; line?: number | null }[] = item.locations.length ? item.locations : changedPaths(changes);
  const shownPaths = paths.slice(0, 3);

  // What opens below it.
  const prompt = kind === 'think' ? inputText(item.rawInput, 'prompt') : undefined;
  const plan = kind === 'switch_mode' ? inputText(item.rawInput, 'plan') : undefined;
  const longCommand = !!command && (command.includes('\n') || command.length > 80);
  const hasInput = kind === 'other' && item.rawInput !== undefined;
  const rawInput = open && hasInput ? jsonText(item.rawInput) : undefined;
  const hasBody =
    results.length > 0 || changes.length > 0 || !!prompt || !!plan || longCommand || hasInput || (kind === 'execute' && code !== undefined);

  const statusLabel = t(`conversation.toolStatus.${status}`);
  const meta: ReactNode[] = [];
  if (stat && (stat.added || stat.removed)) {
    meta.push(
      <span key="stat" className="conv-stat" title={t('conversation.diff.stat', stat)}>
        <span className="add">+{stat.added}</span> <span className="del">−{stat.removed}</span>
      </span>,
    );
  }
  if (stopped) meta.push(<span key="int">{t('conversation.tool.interrupted')}</span>);
  else if (code !== undefined && code !== 0)
    meta.push(
      <span key="exit" className="conv-bad">
        {t('conversation.tool.exit', { code })}
      </span>,
    );
  if (status === 'failed' && code === undefined)
    meta.push(
      <span key="failed" className="conv-bad">
        {statusLabel}
      </span>,
    );
  if (status === 'cancelled') meta.push(<span key="cancelled">{statusLabel}</span>);

  const head = (
    <>
      <ChevronRight className="conv-chevron" aria-hidden />
      <StatusIcon kind={kind} status={status} />
      <span className="conv-tool-label">{label}</span>
      {subject && <span className="conv-tool-subject">{subject.split('\n')[0]}</span>}
      <span className="conv-sr">, {statusLabel}</span>
    </>
  );

  return (
    <div className="conv-item conv-quiet conv-tool" data-kind={kind} data-status={status}>
      <div className="conv-row">
        {hasBody ? (
          <button type="button" className="conv-toggle" aria-expanded={open} title={subject ?? title} onClick={() => setOpen((o) => !o)}>
            {head}
          </button>
        ) : (
          <div className="conv-toggle static" title={subject ?? title}>
            {head}
          </div>
        )}
        {shownPaths.map((l, i) => (
          <PathButton key={i} path={l.path} line={l.line} ctx={ctx} />
        ))}
        {paths.length > shownPaths.length && <span className="conv-more">+{paths.length - shownPaths.length}</span>}
        {meta.length > 0 && <span className="conv-meta">{meta}</span>}
      </div>
      {open && hasBody && (
        <div className="conv-tool-body">
          {longCommand && <pre className="conv-pre conv-command">{command}</pre>}
          {prompt && (
            <Section title={t('conversation.tool.task')}>
              <div className="conv-prompt">{prompt}</div>
            </Section>
          )}
          {plan && <Markdown text={displayMath(plan)} className="conv-md conv-tool-md" />}
          {rawInput && (
            <Section title={t('conversation.tool.input')}>
              <pre className="conv-pre">{rawInput}</pre>
            </Section>
          )}
          {changes.map((c, i) => (
            <ChangeView key={i} change={c} header={changes.length > 1} ctx={ctx} />
          ))}
          {results.length > 0 &&
            (prompt || rawInput ? (
              <Section title={t('conversation.tool.result')}>
                <Results content={results} kind={kind} ctx={ctx} />
              </Section>
            ) : (
              <Results content={results} kind={kind} ctx={ctx} />
            ))}
          {kind === 'execute' && !results.length && status === 'completed' && (
            <div className="conv-note">{t('conversation.tool.noOutput')}</div>
          )}
          {kind === 'execute' && code !== undefined && <div className="conv-note">{t('conversation.tool.exitCode', { code })}</div>}
        </div>
      )}
    </div>
  );
}
