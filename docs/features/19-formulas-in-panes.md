# 19 · Formulas in panes

## Context

Agents answer with markdown, and their math is LaTeX: `$…$` and `$$…$$`
(Claude), `\(…\)` and `\[…\]` (GPT models). Claude Code and Codex render
markdown in the terminal as text, so formulas stay source code, often hard
to read once fractions, sums or matrices nest. Panes are herdr's cell grid
painted on a canvas ([03](03-pane-rendering-and-input.md)): there is no
DOM text to typeset in place, and a formula's rendering does not fit the
grid's rows. Those renderers also treat a backslash before punctuation as
a markdown escape and drop it: Claude Code printed `e^{-x^2}\,dx` as
`e^{-x^2},dx`, and `\[ … \]` and `\( … \)` arrive as `[ … ]` and `( … )`.

## Goals / non-goals

Goals: rest the pointer on a formula in any pane to see it typeset, without
a key or a click; find the spellings agents print, also without the
backslashes their renderers drop; never show text that is not a formula;
cost nothing until a formula is shown.

Non-goals: replacing the text in the grid; formulas in a program's own
images (kitty graphics); editing; restoring what a markdown renderer
dropped (`\{` printed as `{`, `\\` as `\`).

## Design

- **Finding formulas** (`web/src/terminal/math.ts`). On every pointer move
  over a new cell, the paragraph around the row under the pointer is read
  (the rows between empty ones, at most 40 above and below), so a `$$` is
  never paired with one of another paragraph. Rows whose text reaches the
  last column continue in the next row after its indentation, as for links
  ([06](06-quick-look-and-files.md)); other rows are separate lines, which
  is how a program's own word wrapping and multi-line display formulas
  arrive. Cell columns come from `Grid.rowText`, so wide characters next to
  a formula (Chinese text) do not shift it. Found, in this order, without
  overlapping and never across an empty line:
  - display: `$$…$$`, `\[…\]`, and a line holding only `[` … a line holding
    only `]` around a TeX command (`\frac`);
  - inline: `\(…\)`; `$…$` whose opening `$` is followed by a non-space,
    whose closing `$` follows a non-space and is not followed by a digit
    (pandoc's rule) and which contains one of `\ ^ _ { } =`, which leaves
    `$HOME`, `$5 and $10` and `$x$` alone; `( … )` not right after a word
    (a call) around a TeX command, up to 400 characters, with balanced
    parentheses.
- **Showing one** (`web/src/surface/controller.ts`, `updateMath`). After the
  pointer rests 300 ms on a formula, KaTeX renders it; moving to another
  formula shows that one at once. KaTeX must parse the text first: text
  that only looks like a formula (`$\frac{a$`, a Windows path in
  parentheses) shows nothing. The formula's cells get a dotted underline
  (unless the program underlined them), and `MathPopover.tsx` shows the
  rendered formula below it, or above it without room below, within the
  panes, scrolling when it is larger than 60 % of their height. It has a
  button that copies the LaTeX source. Moving off the formula hides it
  after 250 ms, so the pointer can reach the popover, which keeps it shown;
  typing, clicking, scrolling, a modifier showing links (⌘/Ctrl) and rows
  herdr moves under it hide it at once. When the text under a shown
  formula changes, the formula under the pointer is looked for again.
- **KaTeX** (`web/src/terminal/mathRender.ts`) is a separate chunk with its
  stylesheet, imported the first time a formula is shown; the last 200
  results (HTML, or that KaTeX could not read the text) are kept. A failed
  load is tried again on the next formula. Its fonts ship as woff2 only:
  a Vite plugin (`katexWoff2` in `web/vite.config.ts`) removes the woff and
  ttf alternatives from the stylesheet before Vite resolves its URLs, so
  the embedded UI grows by about 290 KB of fonts instead of 1.1 MB.
- **Setting.** *Show formulas under the pointer* (Terminal, on by default)
  turns it off for this browser.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Typeset formulas in the grid | Rows have one height: a fraction or a display formula does not fit, would cover the text around it, and goes stale with every redraw, scroll and selection. |
| Render only a selection, from the context menu | Two steps for every formula; resting the pointer is enough once KaTeX filters what is not a formula. |
| Find formulas only while ⌘/Ctrl is held | That modifier shows links; a second meaning would make the underline ambiguous. |
| MathJax | Larger, slower to start, and asynchronous typesetting; KaTeX renders synchronously to HTML, which suits a popover. |
| Scanning the whole visible grid on every change | Work on every frame of streaming output; only the paragraph under the pointer matters. |
| A reader view rendering the pane's output as markdown | A separate place to look; useful for long derivations but not what resting on one formula needs. |

## Failure modes

- KaTeX cannot be loaded (the chunk is missing or the connection dropped):
  no formula is shown, and the next one tries again.
- A markdown renderer dropped backslashes that change the meaning (`\{`,
  `\\` in matrices): the formula is shown as KaTeX reads what is on screen.
- A formula larger than 400 characters in parentheses or 4000 characters
  in all, or spanning more than 40 rows from the pointer: not found.
- A formula split over two paragraphs, or with an empty line inside: not
  found; the paragraph rule prevents pairing delimiters across paragraphs.

## Security

Pane text is controlled by the programs in it. KaTeX parses it with
`trust` off (no `\href`, `\url`, `\includegraphics`, classes or ids),
`throwOnError` (unparsable text is not shown), `maxExpand` 500 and
`maxSize` 20 (no macro bombs or huge boxes); its HTML is the only markup
inserted. The stylesheet and fonts come from the UI's own origin, within the
existing Content-Security-Policy (inline styles were already allowed).

## Testing

`web/src/__tests__/math.test.ts` covers what Claude Code printed, `\(…\)`
and `\[…\]` with and without backslashes, matrices, shell variables,
prices, calls and empty lines, display formulas over several rows,
formulas wrapped by the terminal and by the program, pairing within a
paragraph and wide characters. `web/src/__tests__/surfaceSelect.test.ts`
(`formulas`) covers showing a formula after the pointer rests, the dotted
underline, hiding after leaving, text KaTeX cannot read, ⌘ held, the
setting and typing.
