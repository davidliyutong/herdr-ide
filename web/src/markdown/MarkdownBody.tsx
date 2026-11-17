// The renderer behind Markdown.tsx, which hands it the renderer's packages
// once they are loaded. The text is untrusted:
//  - raw HTML is not enabled (no rehype-raw), so it shows as text;
//  - a link keeps its href only for http(s) and mailto (links.ts); a relative
//    one opens a file through the caller, and any other is its text;
//  - an image loads only from a data URL, a blob or a file next to the
//    document; a remote one becomes a link;
//  - formulas go through KaTeX with trust off (terminal/mathRender.ts).

import { isValidElement, useEffect, useMemo, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import type ReactMarkdown from 'react-markdown';
import type { Components, Options } from 'react-markdown';
import { Check, Copy } from 'lucide-react';
import { Code } from '../highlight/Code';
import { languageByAlias } from '../highlight/languages';
import { renderMath } from '../terminal/mathRender';
import { t } from '../i18n';
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

const heading =
  (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
  ({ node: _node, children, ...rest }: ComponentProps<'h1'> & { node?: unknown }) => {
    const s = slug(textOf(children));
    return (
      <Tag {...rest} id={s ? ID_PREFIX + s : undefined}>
        {children}
      </Tag>
    );
  };

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
  return {
    h1: heading('h1'),
    h2: heading('h2'),
    h3: heading('h3'),
    h4: heading('h4'),
    h5: heading('h5'),
    h6: heading('h6'),
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
          <a href={safe} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }
      const path = base && onOpenPath ? relativePath(href, base.dir) : undefined;
      if (path !== undefined && onOpenPath) {
        return (
          <a
            href="#"
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
      if (source !== undefined) return <img src={source} alt={alt ?? ''} />;
      if (typeof src === 'string' && /^https?:/i.test(src.trim()) && safeLink(src) !== undefined) {
        return (
          <a href={src} target="_blank" rel="noopener noreferrer">
            {alt || src}
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
    const comps = useMemo(() => components(base, onOpenPath), [base?.m, base?.dir, onOpenPath]);
    return (
      <Renderer remarkPlugins={remarkPlugins} components={comps} urlTransform={urlTransform}>
        {text}
      </Renderer>
    );
  };
}
