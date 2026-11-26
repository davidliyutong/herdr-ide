# 24 · Design tokens and design language

## Context

The web UI (also inside the desktop shell) follows one design language: neutral greys, one accent color for focus, selection and what asks for the user, color otherwise only for state, dense rows and toolbars of fixed heights, in a light and a dark theme with a color theme of the user's choice. The same values are needed in the chrome's CSS, in the terminals' default colors (settings of the hub) and in the desktop window's background before the page paints. Copied into each place, they drift.

## Goals / non-goals

Goals: one file defining colors, color themes, sizes, the type scale and terminal palettes; the web UI and the hub read it in their own form without a build step; a stale generated file fails `make check`; every chrome element of one kind has one size, and all sizes scale with the UI font size.

Non-goals: themes that change backgrounds or text (the neutral black and white stay); user-defined themes; the colors programs draw with in panes (terminal settings, [13](13-settings-and-appearance.md)).

## Design

**Source: `spec/tokens.json`.** Each color has a light and a dark value, `"#rrggbb"` or `{"hex", "alpha"}`. Groups:

- `color.*`: neutral interface colors named by purpose (`background`, `foreground`, `sidebar`, `hover`, `accent` fill, `muted`, `border`, …).
- `status.*`: agent and machine states. A `blocked` agent takes the theme's accent, since it asks for attention.
- `git.*`: VS Code's Git decoration colors.
- `chart.*`: eight data hues (Git graph lanes, usage charts).
- `fileIcon.*`: file-type icon hues, each 3:1 against every row background (`fileIcons.test.ts`).
- `syntax.*`: code colors by token role, opaque, 4.5:1 against the background (`highlight.test.ts`).
- `themes`: color themes `{id, accent, onAccent}`, the first the default; accent 3:1 against the background, `onAccent` 4.5:1 on the accent.
- `terminal.light` / `terminal.dark`: default background, foreground, cursor, selection and the 16 ANSI colors.
- `metric.*` (pixel lengths: radii, sidebar width), `size.*` (chrome heights at root font size `font.root` = 13) and `font.size.*` (type scale).

**Generator: `backend/scripts/tokens.ts`** (Bun, no dependencies). `make tokens` writes one checked-in file, so no build needs to run it:

- `web/src/tokens.css`: `--ds-*` custom properties on `:root` (dark) and `:root[data-theme='light']`; each non-default color theme under `:root[data-accent='<id>']`, so light/dark and color theme combine. Sizes and font sizes are in `rem`, so the UI font size setting (the root font size) scales them.

The hub reads `tokens.json` itself (`backend/kernel/config/ui/tokens.ts`, bundled into its executable): the terminal palettes as defaults of the `terminal.colors.*` settings, and the theme ids as the values of `appearance.colorTheme`.

Output is deterministic. The generator rejects malformed tokens (wrong color form, missing theme value, wrong palette length, unknown fields) and writes nothing. `bun backend/scripts/tokens.ts --check`, run by `scripts/check.sh`, fails naming stale files.

**Chrome variables.** `web/src/styles/base.css` defines the chrome's own short variables from the tokens (`--bg`, `--bg-1..3`, `--fg*`, `--line*`, `--accent`, `--on-accent`, `--working`…, `--radius*`, `--h-header`, `--h-toolbar`, `--h-row`, `--ctl`, `--ic`, `--fs-*`); rules use those. Git, chart and file icon colors are used directly as `--ds-*`. Virtual lists that need sizes in pixels take them from `web/src/lib/sizes.ts`.

**Design language** (`web/src/styles/*.css`):

- The accent marks only focus, selection, the one primary button of a place, badges and an agent waiting for the user. Other notices stay plain; failures and warnings add an icon and a bar of their color.
- Header rows (sidebar heads, the tab bar) line up across the window, as do toolbars below them; list rows have one height everywhere.
- The active tab has an outline and an accent bar, not only a fill, so it stands out by more than color (WCAG 1.4.11).
- Shared components: buttons (secondary, `.primary`, `.ghost`, icon buttons), fields, `.badge`, `.tag`, `.callout`, `.empty-note`, `.switch`, dropdowns (`components/Picker.tsx`) and trees (`components/tree`).

**Terminals and first paint.** Terminal colors come from the hub's settings (from `spec/generated/registry.json` until the hub answers). The page's `theme-color` and manifest background are `color.background`; the desktop shell reads it from `tokens.json`, which its build bundles.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Style Dictionary or another token toolchain | A Node dependency for one small output; the hub reads the JSON itself. |
| Generating at build time | Vite would need a step first; a checked-in file plus a staleness check keeps builds unchanged. |
| Reading `tokens.json` at run time | Colors would arrive after the first paint and CSS could not use them. |
| Using `--ds-*` in every rule | Thousands of lines changed for no visible difference. |
| A second theme switch (class or media query) | Two mechanisms can disagree; `data-theme` already follows the setting. |
| Themes that change backgrounds and text, as VS Code's do | A theme of the accent alone keeps every text contrast checked once. |
| The accent for every notice | A color that is everywhere marks nothing. |
| Sizes in pixels | Would not scale with the UI font size. |
| Palettes written out in web code | A second copy; every client reads the settings' generated defaults. |
| `#rrggbbaa` colors | An alpha like 0.07 has no exact two-digit form. |

## Failure modes

- **`tokens.json` edited without `make tokens`, or a generated file edited by hand** → `make check` fails naming the stale files.
- **Malformed token** → the generator stops with the reason.
- **Terminal defaults differ from the tokens** → `make check` and `web/src/__tests__/tokens.test.ts` fail.
- **A token removed while CSS uses it** → the property falls back, visibly.

## Testing

- `backend/scripts/tokens.test.ts`: parsing, generated CSS, determinism, rejected tokens, `--check`, and that the repository's file is current.
- `backend/kernel/config/ui/ui.test.ts`: the color theme setting offers the tokens' themes (`color themes`), the hub's terminal defaults are `tokens.css`'s (`tokens as tokens.css has them`).
- `web/src/__tests__/tokens.test.ts`: terminal defaults equal the tokens, theme contrast, `data-accent`, size scaling; `termOptions.test.ts` and `fileIcons.test.ts` contrast.
