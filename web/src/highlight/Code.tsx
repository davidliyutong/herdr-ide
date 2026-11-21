// Code colored by its language (highlighter.ts): the text shows at once,
// its colors when the grammar has loaded.

import { Fragment, memo, useEffect, useState } from 'react';
import { highlight, type Piece } from './highlighter';
import './highlight.css';

/** The colored lines of text in language lang, or undefined until they are
 * known (and for good when the language is none of ours). */
export function useHighlight(text: string, lang: string | undefined): Piece[][] | undefined {
  const [done, setDone] = useState<{ text: string; lang: string | undefined; lines?: Piece[][] }>();
  useEffect(() => {
    let live = true;
    if (!lang) return;
    highlight(text, lang).then(
      (lines) => live && setDone({ text, lang, lines }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [text, lang]);
  return done && done.text === text && done.lang === lang ? done.lines : undefined;
}

/** Lines of pieces as text with a span per role. */
export function Pieces({ lines }: { lines: Piece[][] }) {
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {line.map((p, j) =>
            p.role ? (
              <span key={j} className={`syn-${p.role}`}>
                {p.text}
              </span>
            ) : (
              p.text
            ),
          )}
          {i < lines.length - 1 ? '\n' : ''}
        </Fragment>
      ))}
    </>
  );
}

/** A block of code in language lang (an id of languages.ts). */
export const Code = memo(function Code({ text, lang, className }: { text: string; lang?: string; className?: string }) {
  const lines = useHighlight(text, lang);
  return (
    <pre className={className}>
      <code>{lines ? <Pieces lines={lines} /> : text}</code>
    </pre>
  );
});
