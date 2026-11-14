# 24 · Design tokens

## Context

The application is drawn twice: the web UI (`web/`, also inside the
Electron desktop shell) with CSS, and the macOS application (`macos/`,
[23](23-macos-application.md)) with AppKit. Both follow one design
language: neutral greys, color only for state, dense rows, a 6 px radius,
in a light and a dark theme. Kept in two places, the values drift: the web
UI's chrome was blue-grey with a blue accent while the macOS application
was neutral, and the macOS application's terminal palette was a copy of
the web UI's.

The two sides take values in different forms. AppKit wants `NSColor`s that
follow the window's appearance and lengths in points; the web UI wants CSS
custom properties that change with `<html data-theme>`
([13](13-settings-and-appearance.md)).

## Goals / non-goals

Goals: one file that defines the colors (light and dark), status colors,
terminal palettes, metrics and font sizes; both applications read them in
their own form without a build step of their own; a stale generated file
fails `make check`; the web UI's chrome uses the tokens through its
existing CSS variables.

Non-goals: components or layouts shared between the two applications;
themes chosen by the user beyond light and dark; scaling the web UI by the
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
  `make tokens` runs it; it writes two files, both checked in so that
  neither build needs Go to run first:
  - `macos/Sources/App/Tokens.swift`: `enum Tokens` with the raw values
    (`Tokens.colorBackground`, `Tokens.statusWorking`,
    `Tokens.terminalDark`, `Tokens.metricRowHeight`,
    `Tokens.fontSizeBase`). `Theme` (`macos/Sources/App/Theme.swift`)
    turns them into AppKit's types: colors that follow the appearance,
    fonts, `TerminalColors` for Ghostty's configuration. The views use
    `Theme`, not `Tokens`.
  - `web/src/tokens.css`: custom properties on `:root` for the dark theme
    and on `:root[data-theme='light']` for the light one, the same
    selectors as `web/src/styles.css`, so the theme setting switches both
    (`--ds-color-background`, `--ds-status-working`,
    `--ds-terminal-ansi-0` to `-15`, `--ds-metric-radius`,
    `--ds-font-size-base`). Lengths are written once, with `px`.
    `web/src/main.tsx` imports it before `styles.css`.
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
  directly. The light theme's block in `styles.css` sets only what is not
  a token: the transparency of overlays, the dialog backdrop, shadows and
  the checkerboard behind images, all neutral. Sizes (`--fs-sm`,
  `--fs-md`, the tab row) stay in `rem`.
- **Terminals.** The web UI's default terminal colors stay in
  `web/src/terminal/options.ts`, where the pane surface and xterm.js read
  them; a test keeps them equal to `terminal.light` and `terminal.dark`.
  The page's background before the UI paints (`theme-color` in
  `web/index.html`, the web app manifest in `web/vite.config.ts`, the
  desktop shell's window in `desktop/src/main.ts`) is `color.background`
  written out.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Style Dictionary or another token toolchain | A Node dependency and its configuration for two small outputs; the macOS build would need the web toolchain. |
| Generating at build time instead of checking the files in | `swift build`, Xcode and Vite would each need Go and a step before them; checked-in files with a staleness check keep every build as it was. |
| The web UI reading `tokens.json` at run time | Colors would arrive after the first paint, and CSS could not use them without scripting. |
| Replacing the web UI's variables by the tokens in every rule | About two thousand lines of rules change for no visible difference from defining the variables once. |
| A second theme switch for the tokens (class or media query) | Two mechanisms can disagree; `data-theme` already follows the setting and the system. |
| Generating `options.ts`'s palettes | The terminal settings' code would import generated TypeScript for 40 values; a test that compares them is enough. |
| Colors as `#rrggbbaa` | An alpha of 0.07 has no exact two-digit form; hex and alpha apart stay readable. |

## Failure modes

- **`tokens.json` edited without `make tokens`** → `make check` fails with
  the stale files' names; `go test ./scripts/tokens` fails as well.
- **A generated file edited by hand** → the same check fails; the header
  of both files says where they come from.
- **A malformed token** (wrong color form, unknown field, missing theme)
  → the generator stops with the reason and writes nothing.
- **The web UI's default terminal colors changed in `options.ts` only** →
  `web/src/__tests__/tokens.test.ts` fails.
- **A token removed while `Theme.swift` or `styles.css` still uses it** →
  the Swift build fails on the missing member; in CSS the variable is
  undefined and the property falls back to its inherited or initial
  value, which is visible in the chrome.

## Testing

`scripts/tokens/main_test.go`: parsing (plain and alpha colors), the
generated Swift and CSS and that repeated runs give the same bytes,
rejected tokens (malformed colors, alpha, missing theme, unknown field,
short palette, names), `-check` on missing, edited and outdated files
without writing, and that the repository's generated files are current.
`web/src/__tests__/tokens.test.ts`: the web UI's default terminal colors
equal the tokens' and a theme's terminal background is the page's.
`web/src/__tests__/termOptions.test.ts` keeps the terminal colors'
contrast. The macOS application's build (`scripts/macos-app.sh build`)
compiles `Theme` against the generated `Tokens`.
