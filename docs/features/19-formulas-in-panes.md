# 19 · Formulas in panes

## Context

Agents answer in markdown with LaTeX math, which Claude Code and Codex print as text. Terminals are drawn on a canvas ([26](26-web-terminals.md)), so there is no DOM text to typeset, and a typeset formula does not fit the grid's rows. The agents' renderers also drop backslashes before punctuation (`\[ … \]` arrives as `[ … ]`).

## Goals / non-goals

Goals: rest the pointer on a formula in any pane to see it typeset; find the spellings agents print; never show text that is not a formula; cost nothing until one is shown. Non-goal: replacing the text in the grid.

## Design

- `web/src/terminal/math.ts` scans only the paragraph around the pointer, so delimiters never pair across paragraphs. It finds `$$…$$`, `\[…\]`, `\(…\)`, their forms without backslashes around a TeX command, and `$…$` only by pandoc's rule with a TeX character inside, so `$HOME` and `$5 and $10` are left alone.
- Once the pointer rests and KaTeX parses the text, the formula is underlined and a popover shows it typeset, with a button that copies the LaTeX (`updateMath` in `vt/pane.ts`, `components/MathPopover.tsx`).
- KaTeX (`web/src/terminal/mathRender.ts`) is a chunk of its own, loaded with the first formula. `terminal.mathHover` turns the feature off.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Typeset formulas in the grid | Rows have one height; a fraction would cover text. |
| MathJax | Larger, slower, asynchronous; KaTeX renders synchronously. |
| Scanning the whole visible grid on every change | Work on every frame of streaming output. |

## Failure modes

- KaTeX cannot be loaded → no formula is shown; the next one tries again.
- A formula too long or split by an empty line → not found.

## Security

Pane text is controlled by the programs in it. KaTeX parses it with `trust` off (no `\href`, `\url`, `\includegraphics`, classes or ids), `throwOnError` and bounded expansion; its HTML is the only markup inserted.

## Testing

`spec/vectors/math/find.json`, run by `web/src/__tests__/math.test.ts`; `vt.test.ts` (`drawRow`) for the underline.
