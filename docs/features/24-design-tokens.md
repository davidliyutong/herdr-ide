# 24 · Design tokens and design language

## Context

The web UI follows one design language: neutral greys, one accent for focus, selection and what asks for the user, color otherwise only for state, rows of fixed heights, in a light and a dark theme with a color theme of the user's choice. The same values are needed in the chrome's CSS, the terminals' default colors (settings of the hub) and the desktop window before the page paints; copied into each place, they drift.

## Goals / non-goals

Goals: one file of colors, themes, sizes and terminal palettes, read by the web UI and the hub without a build step; sizes that scale with the UI font size. Non-goals: themes that change backgrounds or text; user-defined themes.

## Design

- `spec/tokens.json` holds each color's light and dark value, grouped by purpose, the color themes (the first the default), the terminals' default palettes and the sizes.
- `backend/scripts/tokens.ts` (`make tokens`) writes the checked-in `web/src/tokens.css`: `--ds-*` properties per theme (`data-theme`) and color theme (`data-accent`), sizes in `rem`. `--check`, run by `scripts/check.sh`, fails on a stale file.
- The hub reads `tokens.json` itself (`backend/kernel/config/ui/tokens.ts`): palettes as defaults of `terminal.colors.*`, theme ids as the values of `appearance.colorTheme`.
- `web/src/styles/base.css` defines the chrome's short variables from the tokens. The accent marks only focus, selection, a place's one primary button, badges and an agent waiting for the user; the active tab adds an outline, so it stands out by more than color (WCAG 1.4.11).

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Style Dictionary or another token toolchain | A Node dependency for one small output. |
| Generating at build time, or reading the JSON at run time | Vite would need a step first; colors would arrive after the first paint. |
| Themes that change backgrounds and text, as VS Code's do | A theme of the accent alone keeps every text contrast checked once. |

## Failure modes

- **`tokens.json` edited without `make tokens`** → `make check` fails naming the stale file.
- **A token removed while CSS uses it** → the property falls back, visibly.

## Testing

`backend/scripts/tokens.test.ts` (parsing, output, `--check`), `backend/kernel/config/ui/ui.test.ts` (themes and terminal defaults), `web/src/__tests__/tokens.test.ts`, `fileIcons.test.ts` and `highlight.test.ts` (contrast).
