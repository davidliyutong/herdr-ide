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
follows.

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

- Precedence: command line, then the settings file
  (`<config dir>/herdr-ide/settings[-<instance>].json`), then the default. A
  flag locks the setting; the dialog shows which flag.
- `GET /api/settings` lists definitions with value and source (`default`,
  `saved`, `flag`); `PUT /api/settings {key, value}` validates, saves
  atomically, notifies subscribers and returns the new list. Errors are codes
  (`invalid`, `locked`, `unknown`, `save`). An empty value restores the
  default. Saved values that no longer validate are ignored; unknown keys in
  the file are kept for other versions.
- Users of a setting read it when they need it (code-server's install mode is
  read at each `Ensure`), so no restart is needed.

**Dialog** (`web/src/components/SettingsDialog.tsx`)

- Opened from the sidebar's gear, `prefix ,` or the palette. Sections:
  appearance, layout, terminal, VS Code (core settings whose key starts with
  `code-server-`), server (other core settings).
- Controls by kind: segmented buttons (up to three options) or a select,
  steppers with reset for numbers, switches for booleans, text fields that
  save on Enter or blur. Core settings are disabled when locked or in
  read-only mode.

**Appearance** (`web/src/appearance.ts`)

- Theme `system`, `dark` or `light`; `system` follows
  `prefers-color-scheme` as it changes. The resolved kind sets
  `<html data-theme>`, whose CSS variables restyle the UI (`styles.css` has
  no other colors), the terminal palette of every xterm (`themes` in
  `TermController.ts`, backgrounds equal to `--bg`) and `theme-color`. The
  kind is sent to the core, which switches VS Code ([05](05-vscode-panel.md)).
- Interface font size sets the root font size; the chrome is sized in `rem`,
  so it scales with it. Terminal font size and Option as Meta are applied to
  running terminals, which refit and resize their panes.
- Panel position (`right` or `bottom`) changes the grid: below the panes the
  panel spans the workspace column and is resized by its top edge.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A JSON-Schema form library (react-jsonschema-form) | Hundreds of KB and heavy restyling for a handful of controls; definitions in Go would need a second schema anyway. |
| Settings only as flags | Needs a restart and shell access to change how VS Code is installed. |
| Settings file overriding flags | Breaks service definitions and scripts that rely on their flags. |
| Core-side storage for browser settings | Every browser would get the same font size and theme; the core has no notion of users. |
| CSS `zoom` for the font size | Distorts xterm.js mouse coordinates and canvas sharpness. |
| `window.autoDetectColorScheme` in VS Code | Follows the OS inside the iframe, not the theme chosen in the UI. |

## Failure modes

- **Settings file unreadable or invalid JSON** → logged at start; defaults
  and flags apply; the next change rewrites the file.
- **Saving fails** (disk, permissions) → the old value stays, the dialog
  shows the error.
- **No VS Code window connected** → the theme is sent when one connects.
- **Two browsers choose different themes** → VS Code follows the last one.

## Security

`PUT /api/settings` is a mutation like any herdr call: same Host/Origin and
proxy-secret guards, refused in read-only mode, audited. See
[SECURITY.md](../../SECURITY.md).

## Testing

`internal/settings/settings_test.go` (precedence, persistence, validation,
locked flags), `internal/server/server_test.go` (`TestSettingsAPI`,
`TestBridgeTheme`), `web/src/__tests__/settings.test.ts` (parsing and
clamping, labels for every setting, theme resolution). The dialog, live theme
and font changes and both panel positions were checked in Chrome in both
themes and languages.
