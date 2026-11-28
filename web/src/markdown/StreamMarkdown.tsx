// Streaming-friendly wrapper around the unified Markdown component: while
// `live` is true, splits text into independent blocks (streaming.ts) so each
// arriving increment re-renders only the trailing block; once complete,
// renders the whole document as one Markdown tree.

import { memo, useMemo } from 'react';
import { Markdown, type MarkdownProps } from './Markdown';
import { streamBlocks } from './streaming';

export interface StreamMarkdownProps extends MarkdownProps {
  /** When true, splits Markdown into memoized blocks so only the last
   * arriving block re-renders on each increment. */
  live?: boolean;
  /** Optional class name added alongside `.md-stream` on the live wrapper. */
  streamClassName?: string;
}

const StreamBlock = memo(function StreamBlock(props: MarkdownProps) {
  return <Markdown {...props} />;
});

export function StreamMarkdown({ text, live, streamClassName, ...rest }: StreamMarkdownProps) {
  const blocks = useMemo(() => (live ? streamBlocks(text) : undefined), [text, live]);
  if (!blocks) return <Markdown text={text} {...rest} />;
  const cls = streamClassName ? `md-stream ${streamClassName}` : 'md-stream';
  return (
    <div className={cls} data-live>
      {blocks.map((b, i) => (
        <StreamBlock key={i} text={b} {...rest} />
      ))}
    </div>
  );
}
