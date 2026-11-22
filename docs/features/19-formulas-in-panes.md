# 19 · Formulas in panes

## Context

Agents answer in markdown with LaTeX math: `$…$` and `$$…$$` (Claude),
`\(…\)` and `\[…\]` (GPT models). Claude Code and Codex print it as text,
so nested formulas are hard to read. Terminals are drawn on a canvas
([26](26-web-terminals.md)), so there is no DOM text to typeset in place,
and a typeset formula does not fit the grid's rows. The agents' markdown
renderers also drop backslashes before punctuation: `\,` arrives as `,`,
and `\[ … \]` as `[ … ]`.

## Goals / non-goals

Goals:

- rest the pointer on a formula in any pane to see it typeset, without a
  key or a click;
- find the spellings agents print, including those missing the dropped
  backslashes;
- never show text that is not a formula;
- cost nothing until a formula is shown.

Non-goals: replacing the text in the grid; formulas in a program's own
images; editing; restoring what a renderer dropped (`\{` printed as `{`).

## Design

**Finding formulas** (`web/src/terminal/math.ts`). On a pointer move to a
new cell, only the paragraph around the pointer's row is scanned (rows
between empty lines, bounded above and below), so delimiters never pair
across paragraphs. Rows wrapped by the terminal are joined, as for links
([06](06-quick-look-and-files.md)); cell columns come from the emulator
(`rowCols` in `vt/pane.ts`), so wide characters do not shift a formula.
Recognized, without overlap:

- display: `$$…$$`, `\[…\]`, and lines holding only `[` and `]` around a
  TeX command;
- inline: `\(…\)`;
- inline `$…$` following pandoc's rule (no space inside the delimiters, no
  digit after the closing `$`) and containing one of `\ ^ _ { } =`, so
  `$HOME` and `$5 and $10` are left alone;
- `( … )` around a TeX command, not right after a word (a call), with
  balanced parentheses.

**Showing one** (`web/src/vt/pane.ts`, `updateMath`;
`components/MathPopover.tsx`). After the pointer rests briefly on a
formula, KaTeX must parse it; text that only looks like a formula shows
nothing.

- The formula's cells get a dotted underline, and a popover shows it
  rendered below (or above) it, with a button that copies the LaTeX.
- Moving off hides it after a short delay, so the pointer can reach the
  popover. While the pointer heads toward the popover, formulas it crosses
  on the way do not replace the one shown.
- Typing, clicking, scrolling, rows moving under it, and holding the link
  modifier (⌘/Ctrl) hide it at once.

**KaTeX** (`web/src/terminal/mathRender.ts`) is a separate chunk, loaded
the first time a formula is shown, with a small cache of results. Its
fonts ship as woff2 only (`katexWoff2` in `web/vite.config.ts`), which
keeps the embedded UI about 0.8 MB smaller.

**Setting**: `terminal.mathHover` (on by default,
[13](13-settings-and-appearance.md)); off, no page looks for formulas.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Typeset formulas in the grid | Rows have one height; a fraction would cover text and go stale on every redraw. |
| Render only a selection, from the context menu | Two steps per formula; KaTeX already filters what is not a formula. |
| Find formulas only while ⌘/Ctrl is held | That modifier shows links; a second meaning makes the underline ambiguous. |
| MathJax | Larger, slower, asynchronous; KaTeX renders synchronously to HTML. |
| Scanning the whole visible grid on every change | Work on every frame of streaming output; only the pointer's paragraph matters. |
| A reader view rendering the pane as markdown | A separate place to look; not what resting on one formula needs. |

## Failure modes

- KaTeX cannot be loaded: no formula is shown; the next one tries again.
- A renderer dropped meaningful backslashes (`\{`, `\\`): the formula is
  shown as KaTeX reads what is on screen.
- A formula too long (400 characters in parentheses, 4000 in all), or
  spanning more than 40 rows from the pointer: not found.
- A formula split by an empty line: not found.

## Security

Pane text is controlled by the programs in it. KaTeX parses it with
`trust` off (no `\href`, `\url`, `\includegraphics`, classes or ids),
`throwOnError` (unparsable text is not shown), and `maxExpand` and
`maxSize` bounded (no macro bombs or huge boxes). Its HTML is the only
markup inserted. The stylesheet and fonts come from the UI's own origin,
within the existing Content-Security-Policy.

## Testing

- `design/testdata/math/find.json`: the cases (Claude Code's output,
  delimiters with and without backslashes, multi-line display formulas,
  matrices, shell variables, prices, calls, escaped dollars, empty lines),
  run by `web/src/__tests__/math.test.ts`, which also covers wrapping,
  pairing within a paragraph and wide characters.
- `web/src/__tests__/vt.test.ts` (`drawRow`): the dotted underline.
- Showing and hiding on pointer rest were checked in Chromium.
