# 13 · Settings and appearance

## Context

Some choices belong to each browser (language, theme, font sizes, where the
VS Code panel sits), others to the core (how machines get code-server). They
used to be hidden: a palette command for the language, a `localStorage` key
for Option as Meta, command-line flags for everything on the core. New flags
keep arriving, so adding a setting must not mean writing new UI.

## Goals / non-goals

Goals: one dialog for every setting; each setting defined once, with the
dialog generated from the definitions; core settings changeable at runtime
without losing the command line as the authority; a light theme that VS Code
follows; terminals that look the same in every browser.

Non-goals: per-user settings on a shared core (the core has no users);
syncing browser settings between browsers; theming terminal applications.

## Design

**Definitions**

- Browser settings: `web/src/prefs.ts` (`prefDefs`: section, kind `enum` /
  `number` / `bool`, default, options or range, whether a change reloads the
  page). Values are stored as strings in `localStorage` under the setting's
  key, which keeps the keys used before (`locale`, `optionIsMeta`).
- Core settings: `internal/settings` (`Def`: key, kind `enum` / `string` /
  `bool`, default, options, validation, flag usage). The package that uses a
  setting defines it (`codeserver.SettingDefs`); the core registers each one
  as a flag with the same name, so flag and setting cannot drift apart.
- Labels are i18n keys derived from the key: `settings.<key>`,
  `settings.<key>.desc`, `settings.<key>.<option>`, `settings.<key>.placeholder`.

**Core settings** (`/api/settings`)

- Precedence: command line, then the machine's own value (settings defined
  with `PerMachine`), then the settings file
  (`<config dir>/herdr-ide/settings[-<instance>].json`), then the default. A
  flag locks the setting, for every machine too; the dialog shows which flag.
- Per-machine values live in the same file under
  `"machines": {"<machine id>": {"<key>": "<value>"}}`; a definition's scope
  is `all` or `remote` (machines other than the core's host). Values of
  machines that are not configured at the moment are kept.
- `GET /api/settings` lists definitions with value and source (`default`,
  `saved`, `flag`), plus `per_machine` and the machines' own values;
  `PUT /api/settings {key, value, machine?}` validates, saves atomically,
  notifies subscribers (with the machine whose value changed) and returns the
  new list. An empty machine value makes the machine follow the global one. Errors are codes
  (`invalid`, `locked`, `unknown`, `save`). An empty value restores the
  default. Saved values that no longer validate are ignored; unknown keys in
  the file are kept for other versions.
- Users of a setting read it when they need it (code-server's install mode is
  read at each `Ensure`), so no restart is needed.

**Dialog** (`web/src/components/SettingsDialog.tsx`)

- Opened from the sidebar's gear, `prefix ,` or the palette. Sections:
  appearance, layout, terminal, VS Code (core settings whose key starts with
  `code-server-`), program windows (`gui`, `gui-*`), server (other core
  settings).
- Settings that can differ per machine get a table below the section's rows:
  one row per machine (remote machines only for `remote` scope), a select
  per setting offering "Default (current global value)" and each option.
  The program windows section adds each machine's display state and a button
  that enables program windows in its open panes
  ([14](14-gui-windows.md)).
- Controls by kind: segmented buttons (up to three options) or a select,
  steppers with reset for numbers, switches for booleans, text fields that
  save on Enter or blur. Core settings are disabled when locked or in
  read-only mode.

**Appearance** (`web/src/appearance.ts`)

- Theme `system`, `dark` or `light`; `system` follows
  `prefers-color-scheme` as it changes. The resolved kind sets
  `<html data-theme>`, whose CSS variables restyle the UI (`styles.css` has
  no other colors), the terminal palette of the pane surface and the dialogs'
  terminals (`themes` in `web/src/terminal/options.ts`, backgrounds equal to
  `--bg`) and
  `theme-color`. The kind is sent to the core, which switches VS Code
  ([05](05-vscode-panel.md)).
- Terminal palettes: dark is GitHub Dark Default (Ghostty's theme of that
  name: foreground `#e6edf3`, colors made for a near-black background) on
  the UI's `--bg`; light is GitHub Light Default except for brighter
  yellows. The palette only colors what programs leave to the terminal
  (default colors and the 16 ANSI colors); programs that use 24-bit colors
  look the same everywhere. The owning browser reports the palette's
  foreground, background, 16 colors and dark or light to herdr
  ([18](18-endpoint-surfaces.md)), so programs that ask the terminal for its
  colors (OSC 10/11/4, `CSI ?996n`) get the UI theme's; programs keep the
  colors they derived until they ask again or restart.
- Terminal font: JetBrains Mono 2.304, the official web fonts (regular,
  medium, bold, each upright and italic) in `web/src/terminal/fonts/` with
  their license (SIL OFL 1.1, appended to the generated `licenses.md`) and
  checksums. Shipping it means every browser draws panes with the same
  glyphs and cell size; before, the stack named a font few systems have and
  most fell back to SF Mono or Menlo. Characters it lacks (CJK, some
  symbols) come from the fallbacks: SF Mono, Menlo, …, PingFang SC.
  Rows are 1.05 times the font's own line height (1.32 em).
- Fonts and cell size: the pane surface measures the cell from the font, so
  it must not use the font before it is loaded. `fonts.ts` registers the
  faces with the `FontFace` API and loads them on demand; the page waits up
  to 1.5 s for the faces of the chosen weight before rendering, a surface
  shown earlier uses only the fallbacks and measures again (resizing herdr's
  panes) once the faces arrive, and a new weight is applied when its faces
  are loaded.
- Terminal font weight: regular (400) or medium (500); bold text is 700.
  Medium gives the heavier strokes native terminals produce with stroke
  thickening (Ghostty's `font-thicken`), which canvas text does not get.
- Interface font size sets the root font size; the chrome is sized in `rem`,
  so it scales with it. Terminal font size and weight and Option as Meta are
  applied at once; a new cell size resizes herdr's panes.
- Panel position (`right` or `bottom`) changes the grid: below the panes the
  panel spans the workspace column and is resized by its top edge.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A JSON-Schema form library (react-jsonschema-form) | Hundreds of KB and heavy restyling for a handful of controls; definitions in Go would need a second schema anyway. |
| Settings only as flags | Needs a restart and shell access to change how VS Code is installed. |
| Settings file overriding flags | Breaks service definitions and scripts that rely on their flags. |
| Core-side storage for browser settings | Every browser would get the same font size and theme; the core has no notion of users. |
| CSS `zoom` for the font size | Distorts mouse coordinates and canvas sharpness. |
| `window.autoDetectColorScheme` in VS Code | Follows the OS inside the iframe, not the theme chosen in the UI. |
| Relying on installed fonts for terminals | Cell size and glyphs differ per system; most browsers ended up with SF Mono or Menlo. |
| `@fontsource/jetbrains-mono` | Split into language subsets without the symbol ranges terminal programs draw (❯, ⏺, ✻, arrows), which would fall back glyph by glyph. |
| The variable font (one file per style) | Only published as TTF (300 KB each); three static weights as WOFF2 are about as large and load per weight. |
| Tokyo Night colors on the GitHub background (before) | Made for a navy background: pale on near-black, black at 1.1:1 and dim text at 3.1:1 contrast. |

## Failure modes

- **Settings file unreadable or invalid JSON** → logged at start; defaults
  and flags apply; the next change rewrites the file.
- **Saving fails** (disk, permissions) → the old value stays, the dialog
  shows the error.
- **No VS Code window connected** → the theme is sent when one connects.
- **Two browsers choose different themes** → VS Code follows the last one.
- **A program derives its colors from the wrong theme** (Codex's input box
  is dark on the light theme after a herdr TUI ran in a dark terminal, or
  unfilled when no TUI client has reported colors) → herdr answered its
  background query; the browser cannot. Restarting the program after a herdr
  TUI in a terminal of the same kind reported its colors gives matching
  ones.
- **The terminal font loads slowly or not at all** (a slow link to the core,
  a browser without `FontFace`) → the page renders after 1.5 s with the
  fallback fonts; terminals switch when the font arrives, or keep the
  fallbacks.
- **A page loaded before the core was replaced** has no labels for new
  settings and lacks new features. After every reconnect the page compares
  its entry script with the one the core serves and offers to reload
  (`web/src/update.ts`).

## Security

`PUT /api/settings` is a mutation like any herdr call: same Host/Origin and
proxy-secret guards, refused in read-only mode, audited. See
[SECURITY.md](../../SECURITY.md).

## Testing

`internal/settings/settings_test.go` (precedence, persistence, validation,
locked flags, per-machine values), `cmd/herdr-ide/main_test.go` (every core
setting has a label, description and option labels), `internal/server/server_test.go` (`TestSettingsAPI`,
`TestBridgeTheme`), `web/src/__tests__/settings.test.ts` (parsing and
clamping, labels for every setting, theme resolution),
`web/src/__tests__/termOptions.test.ts` (palette contrast, font fallback,
weight mapping). The dialog, live theme and font changes and both panel
positions were checked in Chrome in both themes and languages; the bundled
font (all weights loaded, live weight changes, `font/woff2` with immutable
caching) in Chrome against the core.
