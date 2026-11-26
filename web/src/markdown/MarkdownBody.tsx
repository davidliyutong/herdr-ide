// The renderer behind Markdown.tsx, which hands it the renderer's packages
// once they are loaded. The text is untrusted:
//  - raw HTML is not enabled (no rehype-raw), so it shows as text;
//  - a link keeps its href only for http(s) and mailto (links.ts); a relative
//    one opens a file through the caller, and any other is its text; a web
//    link names its address in its tooltip, and of a document of a machine
//    opens as one of its terminals' does (terminal/openLink.ts: localhost
//    in a browser pane, the rest outside), except that the pane asks before
//    it makes a port forward: the link's text may hide where it leads;
//  - an image loads only from a data URL, a blob or a file next to the
//    document; a remote one becomes a link;
//  - formulas go through KaTeX with trust off (terminal/mathRender.ts).

import { cloneElement, isValidElement, useEffect, useMemo, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import type ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import { AlertTriangle, Check, Copy, Info, Lightbulb, MessageSquareWarning, OctagonAlert } from 'lucide-react';
import { Code } from '../highlight/Code';
import { languageByAlias } from '../highlight/languages';
import { renderMath } from '../terminal/mathRender';
import { openWebLink } from '../terminal/openLink';
import { t, type MessageKey } from '../i18n';
import { imageSource, relativePath, safeLink, type MarkdownBase } from './links';

/** Every URL as written: the components decide, where react-markdown's own
 * filter would drop some silently. */
const urlTransform = (url: string) => url;
/** Prefix of the ids of headings (and of footnotes, react-markdown's own), so
 * that a text cannot take an id the page uses. */
const ID_PREFIX = 'user-content-';

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');

/** Extracts leading YAML frontmatter (`---\nkey: value\n---`) when every
 * non-empty line in the block looks like YAML metadata. Returns undefined for
 * plain horizontal rules or non-YAML blocks so regular Markdown stays intact. */
export function parseFrontmatter(text: string): { entries: Array<[string, string]>; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return undefined;
  const raw = m[1];
  const lines = raw.split(/\r?\n/);
  const entries: Array<[string, string]> = [];
  let current: [string, string] | undefined;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      const val = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      current = [kv[1], val];
      entries.push(current);
      continue;
    }
    if (/^\s+-\s+/.test(line) && current) {
      const item = line
        .replace(/^\s+-\s+/, '')
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
      current[1] = current[1] ? `${current[1]}, ${item}` : item;
      continue;
    }
    if (/^\s+\S/.test(line) && current) {
      const more = line.trim();
      current[1] = current[1] ? `${current[1]} ${more}` : more;
      continue;
    }
    return undefined;
  }
  if (!entries.length) return undefined;
  return { entries, body: text.slice(m[0].length) };
}

type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]*(?:\r?\n|$))?/i;
const ALERT_META: Record<AlertKind, { icon: typeof Info; label: MessageKey }> = {
  note: { icon: Info, label: 'markdown.alert.note' },
  tip: { icon: Lightbulb, label: 'markdown.alert.tip' },
  important: { icon: MessageSquareWarning, label: 'markdown.alert.important' },
  warning: { icon: AlertTriangle, label: 'markdown.alert.warning' },
  caution: { icon: OctagonAlert, label: 'markdown.alert.caution' },
};

/** Detects a GitHub-style alert blockquote (`> [!NOTE]\n> ...`) and strips the
 * marker from the first paragraph without using raw HTML. */
function extractAlert(children: ReactNode): { kind: AlertKind; body: ReactNode } | undefined {
  const list = Array.isArray(children) ? children : [children];
  const idx = list.findIndex((c) => isValidElement(c));
  if (idx < 0) return undefined;
  const first = list[idx] as ReactElement<{ children?: ReactNode }>;
  const inner = first.props.children;
  const parts = Array.isArray(inner) ? inner : [inner];
  const head = parts[0];
  if (typeof head !== 'string') return undefined;
  const m = ALERT_RE.exec(head);
  if (!m) return undefined;
  const kind = m[1].toLowerCase() as AlertKind;
  const restHead = head.slice(m[0].length);
  const nextParts = restHead ? [restHead, ...parts.slice(1)] : parts.slice(1);
  // Drop a leading <br /> if hard breaks were used right after `[!NOTE]`.
  const cleaned = nextParts.length > 0 && isValidElement(nextParts[0]) && nextParts[0].type === 'br' ? nextParts.slice(1) : nextParts;
  const nextList = [...list];
  if (cleaned.length > 0) nextList[idx] = cloneElement(first, undefined, ...cleaned);
  else nextList.splice(idx, 1);
  return { kind, body: nextList };
}

function MathView({ tex, display }: { tex: string; display: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setHtml(null);
    renderMath(tex, display).then(
      (h) => live && setHtml(h),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [tex, display]);
  const Tag = display ? 'div' : 'span';
  const cls = display ? 'md-math md-math-display' : 'md-math';
  // KaTeX's own markup, made with trust off (terminal/mathRender.ts).
  if (html !== null) return <Tag className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <Tag className={`${cls} md-math-source`}>
      <code>{tex}</code>
    </Tag>
  );
}

function CodeBlock({ text, info }: { text: string; info: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setCopied(true))
      .catch(() => {});
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{info}</span>
        <button
          type="button"
          className="icon md-code-copy"
          title={copied ? t('markdown.copied') : t('markdown.copy')}
          aria-label={t('markdown.copy')}
          onClick={copy}
        >
          {copied ? <Check /> : <Copy />}
        </button>
      </div>
      <Code text={text} lang={languageByAlias(info)} />
    </div>
  );
}

type NodeWithPos = { position?: { start?: { offset?: number } } };

/** Scrolls to the element a `#fragment` link names inside the document. */
function jumpTo(from: HTMLElement, fragment: string) {
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    /* used as written */
  }
  const root = from.closest('.markdown') ?? document;
  const ids = [id, ID_PREFIX + id, ID_PREFIX + slug(id)];
  const el = Array.from(root.querySelectorAll('[id]')).find((e) => ids.includes(e.id));
  el?.scrollIntoView({ block: 'start' });
}

function components(base: MarkdownBase | undefined, onOpenPath: ((path: string) => void) | undefined): Components {
  // Deterministic, StrictMode-safe heading slug deduplication keyed by source offset.
  const seenOffsets = new Map<number, string>();
  const slugCounts = new Map<string, number>();
  const headingId = (node: unknown, children: ReactNode): string | undefined => {
    const baseSlug = slug(textOf(children));
    if (!baseSlug) return undefined;
    const off = (node as NodeWithPos | undefined)?.position?.start?.offset;
    if (off !== undefined) {
      const existing = seenOffsets.get(off);
      if (existing !== undefined) return existing;
    }
    const n = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, n + 1);
    const id = ID_PREFIX + (n === 0 ? baseSlug : `${baseSlug}-${n}`);
    if (off !== undefined) seenOffsets.set(off, id);
    return id;
  };
  const heading =
    (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
    ({ node, children, ...rest }: ComponentProps<'h1'> & { node?: unknown }) => (
      <Tag {...rest} id={headingId(node, children)}>
        {children}
      </Tag>
    );

  // A click on a web link of a machine's document: it opens as a link in
  // one of that machine's terminals does, but a port forward waits for the
  // user's word in the pane.
  const openWeb = (url: string) => {
    const m = base && !url.startsWith('mailto:') ? base.m : undefined;
    return m === undefined
      ? undefined
      : (e: { preventDefault(): void }) => {
          e.preventDefault();
          openWebLink(url, m, { ask: true });
        };
  };
  return {
    h1: heading('h1'),
    h2: heading('h2'),
    h3: heading('h3'),
    h4: heading('h4'),
    h5: heading('h5'),
    h6: heading('h6'),
    blockquote({ node: _node, children, ...rest }) {
      const alert = extractAlert(children);
      if (alert) {
        const meta = ALERT_META[alert.kind];
        const Icon = meta.icon;
        return (
          <div className={`md-alert md-alert-${alert.kind}`} role="note">
            <div className="md-alert-title">
              <Icon className="md-alert-icon" aria-hidden="true" />
              <span>{t(meta.label)}</span>
            </div>
            <div className="md-alert-body">{alert.body}</div>
          </div>
        );
      }
      return <blockquote {...rest}>{children}</blockquote>;
    },
    a({ node: _node, href, children }) {
      if (href === undefined) return <span>{children}</span>;
      if (href.startsWith('#')) {
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              jumpTo(e.currentTarget, href.slice(1));
            }}
          >
            {children}
          </a>
        );
      }
      const safe = safeLink(href);
      if (safe !== undefined) {
        return (
          <a href={safe} title={safe} target="_blank" rel="noopener noreferrer" onClick={openWeb(safe)}>
            {children}
          </a>
        );
      }
      const path = base && onOpenPath ? relativePath(href, base.dir) : undefined;
      if (path !== undefined && onOpenPath) {
        return (
          <a
            href="#"
            title={path}
            onClick={(e) => {
              e.preventDefault();
              onOpenPath(path);
            }}
          >
            {children}
          </a>
        );
      }
      return <span>{children}</span>;
    },
    img({ node: _node, src, alt }) {
      const source = typeof src === 'string' ? imageSource(src, base) : undefined;
      if (source !== undefined) return <img src={source} alt={alt ?? ''} loading="lazy" />;
      const remote = typeof src === 'string' && /^https?:/i.test(src.trim()) ? safeLink(src) : undefined;
      if (remote !== undefined) {
        return (
          <a href={remote} title={remote} target="_blank" rel="noopener noreferrer" onClick={openWeb(remote)}>
            {alt || remote}
          </a>
        );
      }
      return <span>{alt}</span>;
    },
    pre({ node: _node, children }) {
      const child = (Array.isArray(children) ? children[0] : children) as
        ReactElement<{ className?: string; children?: ReactNode }> | undefined;
      const cls = isValidElement(child) ? (child.props.className ?? '') : '';
      const text = textOf(isValidElement(child) ? child.props.children : children).replace(/\n$/, '');
      if (/\blanguage-math\b/.test(cls)) return <MathView tex={text} display />;
      return <CodeBlock text={text} info={/\blanguage-(\S+)/.exec(cls)?.[1] ?? ''} />;
    },
    code({ node: _node, className, children }) {
      if (/\blanguage-math\b/.test(className ?? '')) {
        return <MathView tex={textOf(children)} display={/\bmath-display\b/.test(className ?? '')} />;
      }
      return <code className={className}>{children}</code>;
    },
    input({ node: _node, type, checked }) {
      return type === 'checkbox' ? <input type="checkbox" checked={!!checked} disabled readOnly /> : null;
    },
    table({ node: _node, children }) {
      return (
        <div className="md-table">
          <table>{children}</table>
        </div>
      );
    },
  };
}

export interface MarkdownBodyProps {
  text: string;
  base?: MarkdownBase;
  onOpenPath?: (path: string) => void;
}

/** The renderer made of react-markdown and its plugins (GFM, maths). */
export function markdownBody(Renderer: typeof ReactMarkdown, remarkPlugins: NonNullable<Options['remarkPlugins']>) {
  return function MarkdownBody({ text, base, onOpenPath }: MarkdownBodyProps) {
    const fm = useMemo(() => parseFrontmatter(text), [text]);
    const body = fm ? fm.body : text;
    // Recreate components when text changes so deduplicated heading slugs reset cleanly.
    const comps = useMemo(() => components(base, onOpenPath), [text, base?.m, base?.dir, onOpenPath]);
    return (
      <>
        {fm && (
          <dl className="md-frontmatter">
            {fm.entries.map(([k, v], i) => (
              <div key={`${k}:${i}`} className="md-frontmatter-row">
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <Renderer remarkPlugins={remarkPlugins} components={comps} urlTransform={urlTransform}>
          {body}
        </Renderer>
      </>
    );
  };
}
