// Rendered Markdown, safe for text that is not trusted (links.ts and
// MarkdownBody.tsx say how). The renderer's packages (react-markdown and its
// plugins) load when the first text is shown, so the main bundle does not
// carry them; the text shows as it is meanwhile. They are imported here,
// apart from the app's code that uses them, so that their chunks hold no
// module of the app and ship without source maps (vite.config.ts).

import { lazy, Suspense } from 'react';
import type { MarkdownBase } from './links';
import { markdownBody } from './MarkdownBody';
import './markdown.css';

const MarkdownBody = lazy(async () => {
  const [{ default: Renderer }, { default: gfm }, { default: math }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
    import('remark-math'),
  ]);
  return { default: markdownBody(Renderer, [gfm, math]) };
});

export interface MarkdownProps {
  text: string;
  /** The machine and directory relative links and images resolve against. */
  base?: MarkdownBase;
  /** Opens the file a relative link names; without it such links are plain text. */
  onOpenPath?: (path: string) => void;
  className?: string;
}

export function Markdown({ text, base, onOpenPath, className }: MarkdownProps) {
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      <Suspense fallback={<pre className="markdown-plain">{text}</pre>}>
        <MarkdownBody text={text} base={base} onOpenPath={onOpenPath} />
      </Suspense>
    </div>
  );
}
