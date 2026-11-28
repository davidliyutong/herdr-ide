// Rendered Markdown, safe for text that is not trusted (links.ts, sanitize.ts
// and MarkdownBody.tsx say how). The renderer's packages (react-markdown and
// its remark/rehype plugins) load when the first text is shown, so the main
// bundle does not carry them; the text shows as it is meanwhile. They are
// imported here, apart from the app's code that uses them, so that their
// chunks hold no module of the app and ship without source maps
// (vite.config.ts).

import { lazy, Suspense } from 'react';
import type { MarkdownBase } from './links';
import { markdownBody, type MarkdownVariant } from './MarkdownBody';
import { safeHtmlPlugins } from './sanitize';
import './markdown.css';

export type { MarkdownVariant };

const MarkdownBody = lazy(async () => {
  const [{ default: Renderer }, { default: gfm }, { default: math }, { default: rehypeRaw }, { default: rehypeSanitize }] =
    await Promise.all([
      import('react-markdown'),
      import('remark-gfm'),
      import('remark-math'),
      import('rehype-raw'),
      import('rehype-sanitize'),
    ]);
  return { default: markdownBody(Renderer, [gfm, math], safeHtmlPlugins(rehypeRaw, rehypeSanitize)) };
});

export interface MarkdownProps {
  text: string;
  /** Layout and typographic density: 'document' (default, file/Quick Look
   * preview) or 'compact' (Agent Native View / chat messages and cards). */
  variant?: MarkdownVariant;
  /** The machine and directory relative links and images resolve against. */
  base?: MarkdownBase;
  /** Opens the file a relative link names; without it such links are plain text. */
  onOpenPath?: (path: string) => void;
  /** Custom image resolver hook; defaults to `imageSource(src, base)`. */
  resolveImage?: (src: string, base?: MarkdownBase) => string | undefined;
  /** Custom relative file link resolver hook; defaults to `relativePath(href, base.dir)`. */
  resolveLink?: (href: string, base?: MarkdownBase) => string | undefined;
  /** Whether leading YAML frontmatter renders as a metadata card. Defaults to
   * `true` for 'document' and `false` for 'compact'. */
  frontmatter?: boolean;
  /** Whether headings receive deduplicated `user-content-*` anchor IDs.
   * Defaults to `true`. */
  headingAnchors?: boolean;
  /** Whether LaTeX `\[...\]` / `\(...\)` and single-line `$$...$$` paragraphs
   * are converted into remark-math delimiters. Defaults to `false` for
   * 'document' and `true` for 'compact'. */
  mathDelimiters?: boolean;
  /** Whether single newlines render as hard line breaks (`<br>`) instead of
   * CommonMark soft-break continuation. Defaults to `false` for 'document'
   * and `true` for 'compact' (Agent Native View). */
  hardBreaks?: boolean;
  /** Whether fenced code blocks offer the copy button. Defaults to `true`. */
  codeCopy?: boolean;
  className?: string;
}

export function Markdown({
  text,
  variant = 'document',
  base,
  onOpenPath,
  resolveImage,
  resolveLink,
  frontmatter,
  headingAnchors,
  mathDelimiters,
  hardBreaks,
  codeCopy,
  className,
}: MarkdownProps) {
  const variantClass = variant === 'compact' ? 'markdown-compact' : 'markdown-document';
  const rootClass = className ? `markdown ${variantClass} ${className}` : `markdown ${variantClass}`;
  return (
    <div className={rootClass}>
      <Suspense fallback={<pre className="markdown-plain">{text}</pre>}>
        <MarkdownBody
          text={text}
          variant={variant}
          base={base}
          onOpenPath={onOpenPath}
          resolveImage={resolveImage}
          resolveLink={resolveLink}
          frontmatter={frontmatter}
          headingAnchors={headingAnchors}
          mathDelimiters={mathDelimiters}
          hardBreaks={hardBreaks}
          codeCopy={codeCopy}
        />
      </Suspense>
    </div>
  );
}
