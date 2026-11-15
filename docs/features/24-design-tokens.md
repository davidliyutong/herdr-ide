# 24 · Design tokens

## Context

The web UI (`web/`, also inside the Electron desktop shell) is drawn with
CSS in one design language: neutral greys, color only for state, dense
rows, a 6 px radius, in a light and a dark theme. Its values are needed in
more than one place: the chrome's CSS, the terminals' default colors, which
are settings of the core, and the background the desktop shell gives its
window before the page paints. Kept in each of them, the values drift.

These places take values in different forms. The web UI wants CSS custom
properties that change with `<html data-theme>`
([13](13-settings-and-appearance.md)); the core's settings want Go values
for their defaults.

## Goals / non-goals

Goals: one file that defines the colors (light and dark), status colors,
terminal palettes, metrics and font sizes; the web UI and the core read
them in their own form without a build step of their own; a stale generated file
fails `make check`; the web UI's chrome uses the tokens through its
existing CSS variables.

Non-goals: themes chosen by the user beyond light and dark; scaling the web UI by the
tokens' metrics and font sizes (the web UI's sizes are in `rem` so that its
font size setting scales the chrome); the colors programs draw with in
panes, which stay the terminal settings'
([13](13-settings-and-appearance.md)).

## Design

- **The source** is `design/tokens.json`:
  - `color.<name>`: a color of the interface, `{"light": …, "dark": …}`.
    A value is `"#rrggbb"` or `{"hex": "#rrggbb", "alpha": 0.07}`.
    The names say what a color is for: `background`, `foreground`,
    `sidebar`, `tabBar`, `tabActive`, `hover` (hovered rows and floating
    panels), `accent` (selected rows and controls), `muted` and `faint`
    (secondary and tertiary text), `primary` and `onPrimary` (the one
    emphasized control and the text on it), `border`, `borderStrong`,
    `focusRing`.
  - `status.<state>`: the colors of the agent states `working`, `blocked`,
    `done`, `error` and `idle`, in the same form.
  - `terminal.light` and `terminal.dark`: a terminal's default
    `background`, `foreground`, `cursor` and `selection` and its `palette`
    of the 16 ANSI colors (black to white, then the bright variants), all
    opaque.
  - `metric.<name>`: lengths in points, which are CSS pixels
    (`rowHeight`, `tabHeight`, `sidebarWidth`, `radius`, `divider`).
  - `font.size.<name>`: font sizes in points (`base`, `small`, `terminal`).
- **The generator** is `scripts/tokens` (Go, standard library only).
  `make tokens` runs it; it writes two files, both checked in so that no
  build needs Go to run first:
  - `web/src/tokens.css`: custom properties on `:root` for the dark theme
    and on `:root[data-theme='light']` for the light one, the same
    selectors as `web/src/styles.css`, so the theme setting switches both
    (`--ds-color-background`, `--ds-status-working`,
    `--ds-terminal-ansi-0` to `-15`, `--ds-metric-radius`,
    `--ds-font-size-base`). Lengths are written once, with `px`.
    `web/src/main.tsx` imports it before `styles.css`.
  - `internal/uisettings/tokens.go`: the terminal palettes as the
    defaults of the `terminal.colors.*` settings
    ([13](13-settings-and-appearance.md)), from which the web UI's terminal
    colors come; a user's colors replace them.
  Names are written in sorted order and the output depends on nothing but
  the tokens, so generating twice gives the same bytes. The generator
  refuses unknown fields, colors that are not lower-case `#rrggbb`, an
  alpha outside 0 to 1, a color without both themes, palettes that do not
  have 16 colors, and names that are not camelCase.
- **The check.** `go run ./scripts/tokens -check` writes nothing and fails
  naming the files that differ from what it would generate;
  `scripts/check.sh` (`make check`, CI) runs it.
- **The web UI's chrome** keeps its own variables, which the rules in
  `styles.css` use, and defines them from the tokens:

  | Variable | Token |
  | --- | --- |
  | `--bg` | `color.background` |
  | `--bg-1` (sidebar, toolbars, dock, status bar) | `color.sidebar` |
  | `--bg-2` (hovered rows, menus, dialogs) | `color.hover` |
  | `--bg-3` (buttons, selected rows) | `color.accent` |
  | `--line`, `--line-2` | `color.border`, `color.borderStrong` |
  | `--fg`, `--fg-dim`, `--fg-mute` | `color.foreground`, `color.muted`, `color.faint` |
  | `--accent`, `--on-accent` | `color.primary`, `color.onPrimary` |
  | `--accent-soft` | `color.primary`, mostly transparent |
  | `--focus-ring` | `color.focusRing` |
  | `--working`, `--blocked`, `--done`, `--error`, `--idle` | `status.*` |
  | `--blocked-glow` | `status.blocked`, mostly transparent |
  | `--overlay`, `--float` | `color.background` and `color.accent` (light: `color.sidebar`), slightly transparent |
  | `--radius` | `metric.radius` |

  The tab bar and the active tab use `color.tabBar` and `color.tabActive`
  directly; the active tab also has an outline (`--line-2`) and an accent
  bar under it, so it stands out by more than its fill (WCAG 1.4.11), as
  the selected workspace and settings section do with a 3-pixel accent bar.
  `color.focusRing` keeps at least 3:1 against both themes' backgrounds. The light theme's block in `styles.css` sets only what is not
  a token: the transparency of overlays, the dialog backdrop, shadows and
  the checkerboard behind images, all neutral. Sizes (`--fs-sm`,
  `--fs-md`, the tab row) stay in `rem`.
- **Terminals.** The terminal colors are settings whose defaults are
  `terminal.light` and `terminal.dark` (`internal/uisettings/tokens.go`);
  the web UI reads them from the core (and from
  `design/generated/registry.json` until the core answers).
  The page's background before the UI paints (`theme-color` in
  `web/index.html`, the web app manifest in `web/vite.config.ts`) is
  `color.background` written out; the desktop shell's window
  (`desktop/src/main.ts`) reads it from `tokens.json`, which its build
  bundles.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Style Dictionary or another token toolchain | A Node dependency and its configuration for two small outputs, one of them Go; the Go build would need the web toolchain. |
| Generating at build time instead of checking the files in | Vite and `go build` would each need a step before them; checked-in files with a staleness check keep every build as it was. |
| The web UI reading `tokens.json` at run time | Colors would arrive after the first paint, and CSS could not use them without scripting. |
| Replacing the web UI's variables by the tokens in every rule | About two thousand lines of rules change for no visible difference from defining the variables once. |
| A second theme switch for the tokens (class or media query) | Two mechanisms can disagree; `data-theme` already follows the setting and the system. |
| Palettes written out in the web UI's code | A second copy to keep equal; the settings' defaults are generated from the tokens and every client reads those. |
| Colors as `#rrggbbaa` | An alpha of 0.07 has no exact two-digit form; hex and alpha apart stay readable. |

## Failure modes

- **`tokens.json` edited without `make tokens`** → `make check` fails with
  the stale files' names; `go test ./scripts/tokens` fails as well.
- **A generated file edited by hand** → the same check fails; the header
  of both files says where they come from.
- **A malformed token** (wrong color form, unknown field, missing theme)
  → the generator stops with the reason and writes nothing.
- **The terminal colors' defaults differ from the tokens** (a stale
  `tokens.go` or `registry.json`) → `make check` fails;
  `web/src/__tests__/tokens.test.ts` compares the registry's defaults with
  the tokens.
- **A token removed while `styles.css` still uses it** → the variable is
  undefined and the property falls back to its inherited or initial
  value, which is visible in the chrome.

## Testing

`scripts/tokens/main_test.go`: parsing (plain and alpha colors), the
generated CSS and Go and that repeated runs give the same bytes,
rejected tokens (malformed colors, alpha, missing theme, unknown field,
short palette, names), `-check` on missing, edited and outdated files
without writing, and that the repository's generated files are current.
`web/src/__tests__/tokens.test.ts`: the web UI's default terminal colors
equal the tokens' and a theme's terminal background is the page's.
`web/src/__tests__/termOptions.test.ts` keeps the terminal colors'
contrast.
