# 13 · Settings, keybindings and appearance

## Context

Several clients show one core's machines: the web UI (in browsers and in
the desktop app) and the desktop app's shell (its menu and title bar).
Values kept per client (a browser's `localStorage`, keys in a menu) differ
per browser and profile, do not reach the other clients, and cannot be read
by the shell. So settings and keybindings live in the core.

## Goals / non-goals

Goals:

- one settings system and one keybinding system, with the core as the only
  source;
- the settings UI rendered from the core's definitions;
- hand-editable files like VS Code's `settings.json` and `keybindings.json`;
- a change from any client or from the file reaches every client at once;
- the command line stays the authority.

Non-goals: per-user settings on a shared core (the core has no users);
settings per browser; theming terminal applications.

## Design

### Registry

`backend/kernel/config/settings` defines the model (`define.ts`) and the
store of values (`store.ts`); `coreModules`
(`backend/kernel/config/registry.ts`) lists the modules the core registers:
`config/ui` for the user interfaces, the feature switches (`toggles.ts`)
and the features' own (program windows', VS Code's, browser, files, git,
monitor, usage, vault, chat, history; [27](27-plugins.md)). A feature
brings its module in its definition (`settings`); the switches and the
modules follow the order in which the host composes the features
(`coreFeatures` in `backend/hosts/bun/serve.ts`), which is the order the
UIs list them in.

- A module (`defineModule`) brings sections and definitions. A section can be advanced (listed last, under
  **Advanced**) or belong to a plugin.
- A definition (`Setting`, made by helpers such as `bool`, `int`,
  `enumOf`) has a dotted key (`terminal.fontSize`), a
  type (`bool`, `number`, `string`, `enum`, `color`, `list`), a default,
  constraints (enum values, range, step, offered list values), a section,
  group and order, an optional command-line flag and a zod schema that
  validates. Invalid definitions are refused at start.
- Scope: `app` (one value), `machine` (any machine may have its own value),
  `remote-machine` (machines other than the core's host).
- Strings refuse control characters; lists and strings are bounded.
- Descriptions are not in the core: the UI translates `settings.<key>`,
  `settings.<key>.desc`, options, sections and groups.
- `backend/scripts/registry.ts` (`pnpm -C backend registry`), from the
  features `serve` composes and `backend/kernel/config/registry.ts`,
  writes `spec/generated/registry.json` (defaults,
  commands, each platform's default bindings, the translation keys the UI
  needs) and the settings and commands tables of
  [reference](../reference.md#settings). `make tokens` regenerates them;
  `make check` fails when they are stale.
- The terminal colors' defaults are design tokens, which the core reads
  from `spec/tokens.json` when it is built
  (`backend/kernel/config/ui/tokens.ts`, [24](24-design-tokens.md)).

Every setting with its type, default, flag and scope is in
[reference](../reference.md#settings).

### File

`settings[-<instance>].json` lives in the user's configuration directory
on the core host, beside `keybindings[-<instance>].json`
([reference](../reference.md#files-and-directories)). The desktop app's
core is instance `desktop`.

- Global values are top-level `"key": value` pairs; a machine's own values
  are under `"[machine:<id>]": {…}`.
- Read as JSONC (comments and trailing commas allowed); a change edits
  only its value, keeping the file's comments and layout, a new value in
  its sorted place (`backend/kernel/config/jsonc.ts`). Written
  atomically, mode 0600 in a 0700 directory
  (`backend/shared/host/userfile.ts`).
- Unknown keys and invalid values are kept on rewrite (another version may
  know them), count as unset and are reported as problems (`unknown`,
  `invalid`, `scope`).
- A file that is not JSON is reported (`parse`): the values read before
  stay, and changes are refused (`file`) until it is fixed, so an edit in
  progress is never overwritten.
- The core polls the file's modification time and size every 2 s; an API
  change first reads a pending hand edit so it is not lost.

### Layering

Command-line flag → the machine's own value → the global value → the
default. Readers ask for a machine's value (`settings.bool(key, machine)`);
code-server and GUI settings are read when they are used, so changes apply
on the next start or frame.

A flag (a definition's `flag`, which `serve` registers through
`settingFlags`) locks its setting for
every machine: the UI shows it disabled with the flag's name, and changes
are refused (`locked`). The file's value stays and applies again without
the flag.

### API

`backend/kernel/config/routes.ts`; endpoints in
[reference](../reference.md#http-and-websocket-endpoints).

- `GET /api/settings` returns sections, definitions, values (with source,
  per-machine values and lock), problems, read-only state and the file.
- `PUT /api/settings {key, value, machine?}` saves; `DELETE` removes a
  value (falling back to the global value or the default).
- Errors are codes the UI translates: `invalid`, `locked`, `unknown`,
  `scope`, `file`, `save`.
- Every change, through the API or the file, is pushed to every `/ws`
  client (`{t: "settings", …}`); clients replace their values.

### Keybindings

`backend/kernel/config/keybindings`.

- **Commands** are registered in the core (`commands.ts`): an id (`tab.new`,
  `code.open`), a section, a `when` context and default keys per platform.
  Labels are `command.<id>`.
- **Contexts**: `terminal` (the main window, and VS Code panes for keys VS
  Code leaves), `vscode` (only while a VS Code pane has the keyboard),
  `dialog` (a dialog, the palette or a text field) and `always` (the zoom
  commands).
- **Platforms**: `mac`, `windows` and `linux` (the desktop app on each
  system) and `mac-browser`, `windows-browser`, `linux-browser`. The
  desktop app and a browser on the same computer need different defaults
  (`cmd+t` belongs to the browser).
- **Key syntax**: modifiers and a key joined by `+`; a chord is up to 4
  strokes separated by spaces (`ctrl+k c`). Keys are named after the US
  layout's unshifted keys (`?` is `shift+slash`). The first stroke needs
  cmd, ctrl or alt (or is a function key), so a binding never takes a key
  that types text. The core (`keys.ts`) and the web UI (`web/src/keys.ts`)
  both run the vectors in `spec/vectors/keys`.
- **Defaults** are single strokes only: the desktop app's menu keys on
  `mac`, `ctrl+shift` keys on `windows` and `linux`, and in browsers only
  what browsers leave (find, the list of shortcuts, the palette on macOS).
  On every platform `ctrl+b` (`pane.leave`) moves the keyboard from an
  editor to its pane header, and stays the program's in a terminal
  ([04](04-layout-and-keyboard.md)); apart from it no default
  is a chord or `ctrl`/`alt` with a letter alone, so every unbound key
  reaches the terminal's program on the first press.
  Commands without a key run from menus, pane headers and the command
  palette, and users can bind keys or chords to them.
- **User file** `keybindings[-<instance>].json`: an array of
  `{key, command, when?}` applied in order after the defaults;
  `"command": "-<id>"` removes a binding. Rules apply to every platform.
  Unknown commands and malformed entries are kept and
  reported. Watching, atomic writes and refusal over a broken file work as
  for settings.
- **Effective bindings and conflicts** are computed by the core per
  platform, so clients only match keys. A conflict is one key bound to
  commands with overlapping contexts, or a single stroke that also starts
  chords. No platform's defaults conflict (tested); conflicts from user
  rules are marked, and the first binding wins.
- `GET /api/keybindings` returns commands, defaults, user rules, effective
  bindings, conflicts and problems; `PUT /api/keybindings` replaces the
  user's array (at most 1000 rules) and is pushed as
  `{t: "keybindings", …}`.

### Web UI

`web/src/settings.ts`, `prefs.ts`, `keybindings.ts`, `keymap.ts`.

- The page reads `/api/settings` before rendering (the language must be
  known) and after each reconnect; pushes replace the values. Until the
  core answers, `registry.json`'s defaults apply. `prefs.ts` is the typed
  view (`usePrefs`, `getPrefs`); `setPref` saves and shows the value at
  once.
- Per-browser state (sidebar, selected machine, transfer history) stays
  in `localStorage`; settings are only the core's.

**Settings dialog** (`components/SettingsDialog.tsx`, laid out like VS
Code's):

- Scope bar: **User** (global values) and **Machine ▾**, a searchable list
  of machines. A machine's scope lists only the settings it can differ in,
  each "Same as User (value)" until set. Its **Overview** page shows the
  machine, its connection actions and troubleshooting (restart, start or
  stop its terminal service). The sidebar's **Machine Settings…** opens it.
- Sections in a list (advanced ones last, plugins' pages under
  **Plugins**, then **Keyboard Shortcuts**), a dot on sections with
  changes; in a narrow window the list becomes a searchable picker.
- A search across labels, descriptions, keys, sections and options.
- Each setting shows name, description and a control by type (checkbox,
  segmented control or searchable list, stepper with range, list editor
  with chips, text field). A changed setting has a bar and **Modified**
  badge; its `⋯` menu resets it or copies its id or JSON. Ids are not
  shown otherwise.
- The terminal font is a picker (`settings/FontPicker.tsx`) listing the
  bundled JetBrains Mono and the installed monospace fonts, each drawn in
  itself, with a preview. It uses the Local Font Access API where
  available (Chromium, the desktop app) and keeps only families that
  measure as fixed-pitch text fonts (`terminal/localFonts.ts`); elsewhere
  it probes well-known monospace families.
- **Terminal Colors** (`settings/Colors.tsx`): per theme (dark, light) a
  color scheme (`web/src/terminal/schemes.ts`) with a preview, and
  **Customize colors**: named swatches for text, background, cursor,
  selection and the 16 ANSI colors, each overriding the scheme's.
- Extra pages that are not settings: **Permissions → Full Disk Access** in
  the desktop app on macOS ([16](16-desktop-packaging.md)), and what the
  app uses on **Performance** (below).
- The header's file button opens `settings.json` (or `keybindings.json`)
  in a VS Code pane on the core's machine, or copies its path where that
  is not possible.
- Changing a setting re-renders only what changed (focus and scroll
  stay); changing the language reloads the page.

**Keyboard page**: a table of every command with its keys in effect and
their source (Default or User). Rows can be rebound by recording keys,
given another key, unbound or reset; the search matches names, ids and
keys, or recorded keys. Changes become user rules (`rulesFor`) saved with
`PUT`. Only rows in view are drawn, so plugins' commands can make the
table long.

**Key matching** (`keymap.ts`): every keydown of the app, terminals
included, is matched against the page platform's effective bindings.

- A key no binding takes is left to the terminal's key encoder.
- A stroke that starts a user's chord waits 3 s for the next; pressing the
  first stroke again sends it to the terminal (`ctrl+k ctrl+k` types
  `ctrl+k`); a chord matching nothing ends.
- While a dialog or the palette is open, only `dialog` and `always`
  bindings run.
- Keys in a VS Code pane go to VS Code first; on macOS the desktop app's
  menu gets the keys VS Code leaves ([04](04-layout-and-keyboard.md)).
- Key hints (tooltips, menus, palette, status bar) show the command's key,
  or nothing when it has none.

**Desktop app** (`desktop/src/follow.ts`, `desktop/src/menu.ts`): the
shell reads both endpoints when its event channel opens and follows the
pushes (using `registry.json`'s defaults until then). On macOS its menu
items show their command's single-stroke key; on Windows and Linux they
get none ([04](04-layout-and-keyboard.md)). `appearance.theme` drives
Electron's `nativeTheme`, `appearance.language` the menu's language,
`window.zoom` the windows' zoom ([16](16-desktop-packaging.md)).

### What the app uses

`web/src/perf.ts`, `components/settings/Performance.tsx`,
`backend/shared/host/perf.ts`.

The user's **Performance** page shows, below `performance.keptTerminals`
(how many hidden terminals a page keeps attached, [26](26-web-terminals.md)),
what the app uses now, so the cost of that number can be read where it is
set. It refreshes every 2 s while shown. A kept terminal costs mostly its
emulator's memory, which grows with its scrollback (about 11 MB for a full
10,000-line history at 127 columns, measured in Chromium); a hidden
terminal holds no WebGL context and is not drawn.

- **Desktop app**: a row per Electron process (the bridge's `metrics`,
  [16](16-desktop-packaging.md)) with its processor share and memory, the
  core's row, and a total.
- **Browser**: the window's script memory where Chromium tells it, and the
  core's row. A page cannot learn its own processor or GPU use, which a
  note says; no total.
- **The core's row** comes from `GET /api/perf` (`sample`): processor
  time since start, resident memory, the resources the process waits on
  (sockets, timers, requests; the field `goroutines`), uptime and
  processors. The client turns two answers into a processor share; none
  across a core restart. Agents, terminal cores, ssh and the programs in
  terminals are other processes and not counted.
- Below the table: terminals shown and kept, the GPU as WebGL names it,
  and how many terminals draw with WebGL or Canvas 2D (`paneUsage` in
  `vt/pane.ts`).

### Appearance

`web/src/appearance.ts`.

- **Theme** `system`, `dark` or `light`; `system` follows
  `prefers-color-scheme` live. The resolved kind sets `<html data-theme>`
  (the UI's CSS variables come from the design tokens,
  [24](24-design-tokens.md)), the terminals' colors and `theme-color`. It
  is sent to the core, which switches VS Code ([05](05-vscode-panes.md));
  the desktop shell's title bar follows the setting.
- **Color theme** (`appearance.colorTheme`): the chrome's accent, one of
  the design tokens' themes (Blue by default). Neutrals are the same in
  every theme. An unknown id (from a newer core) shows the default.
- **Terminal palettes**: the Default scheme is GitHub Dark Default on the
  UI's background, and GitHub Light Default with brighter yellows. Schemes
  and the user's colors replace them. The palette colors only what
  programs leave to the terminal (default and 16 ANSI colors). Programs
  that query the terminal's colors (OSC 10/11/4, `CSI ?996n`) get the
  current theme's, and keep them until they ask again.
- **Terminal font**: JetBrains Mono (web fonts with their OFL license in
  `web/src/terminal/fonts/`), after `terminal.fontFamily` when that names
  an installed font; system fallbacks cover CJK and symbols. Weight is
  regular or medium (medium imitates native terminals' stroke
  thickening).
- **Font loading**: a terminal measures its cell from the font, so
  `fonts.ts` loads the faces with the `FontFace` API and the page waits up
  to 1.5 s for them; a terminal shown earlier uses the fallbacks and
  re-measures when the faces arrive.
- **Sizes**: `appearance.uiFontSize` sets the root font size (the chrome
  is sized in `rem`); `window.zoom` (desktop app only) scales the whole
  window.
- Every terminal setting applies at once in the browser's terminals
  ([26](26-web-terminals.md)).
- `notifications.*` turn sounds, system notifications and the badge on or
  off and list silent agents ([07](07-agent-native-workflow.md));
  `terminal.mathHover` turns the formula preview on or off
  ([19](19-formulas-in-panes.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Settings kept per browser (`localStorage`) | Values differ per browser and profile; the desktop shell cannot read a page's storage. |
| JSON Schema for the definitions | Clients would need a validator plus sections, scopes and platforms; small typed records suffice. |
| Descriptions in the core's definitions | The UI translates everything else; one place keeps translators' files complete. |
| A file watcher (`fs.watch`, chokidar) | Loses a file replaced by a rename, or a dependency for two small files; polling every 2 s suffices for hand edits. |
| Clients working out the effective bindings | A second implementation of rules and conflicts; the core serves them per platform. |
| One platform per OS | The desktop app and a browser on the same Mac need different defaults. |
| A prefix keymap by default (`ctrl+b` then a key, as herdr and tmux) | Makes every press wait; users can bind chords themselves. |
| Sending a chord's first stroke twice as its control character | Works only for `ctrl`+letter; passing the second press to the key encoder works for any stroke and mode. |
| Settings file overriding flags | Breaks service definitions and scripts that rely on their flags. |
| CSS `zoom` for the font size | Distorts mouse coordinates and canvas sharpness. |
| Relying on installed fonts for terminals | Cell size and glyphs differ per system; the bundled font stays the default. |
| A text field for the font family | The user must know exact family names and CSS syntax; the picker shows what is installed. |
| Ten loose color settings | Picking 20 unnamed colors one by one; schemes give a whole look, swatches name each color. |
| A per-machine table at the bottom of each page | Far from the settings it changes and limited to bools and options; a machine scope reuses the controls. |
| Showing every setting's id beside its name | Ids are for the file; they are copied from the menu and found by search. |
| A comma-separated string for the silent agents | Required knowing ids and syntax; a list of recognized agents says both. |
| The core answering its processor use as a percentage | Needs per-client state or a timer; cumulative time lets each client diff over its own interval. |
| A browser page showing its processor and GPU use | Browsers expose neither; the desktop shell asks Electron instead. |

## Failure modes

- **Settings or keybindings file not JSON** (an edit in progress): the
  values read before stay, the problem is shown, changes are refused until
  it is fixed.
- **An invalid value or unknown key in the file**: that entry is ignored
  and shown; the rest applies; rewrites keep it.
- **Saving fails** (disk, permissions): the old value stays; the dialog
  shows the error.
- **A client was disconnected while settings changed**: it reads both
  endpoints again on reconnect.
- **No VS Code window connected**: the theme is sent when one connects.
- **Two clients choose different themes**: the setting is the core's; the
  last change wins everywhere.
- **A program derived its colors from the old theme**: it gets the new
  ones when it asks again or restarts.
- **The terminal font loads slowly or not at all**: the page renders after
  1.5 s with fallbacks and switches when the font arrives.
- **`GET /api/perf` fails**, or the browser has no script memory or WebGL:
  the row or value shows a dash.
- **A page loaded before the core was replaced** lacks labels for new
  settings; after a reconnect it compares its entry script with the
  core's and offers to reload (`web/src/update.ts`).

## Security

- `PUT`/`DELETE /api/settings` and `PUT /api/keybindings` are mutations:
  Host/Origin and proxy-secret guards, refused in read-only mode, audited
  (`settings.set`, `settings.reset`, `keybindings.set`), bodies bounded
  (64 KiB, 256 KiB).
- Values are typed and validated; strings refuse every control character
  (C0, DEL, C1), so a value carries no line breaks or escape sequences.
  Machine ids are bounded and refuse brackets and line breaks.
- `GET /api/perf` returns only amounts and counts of the core's own
  process: no path, name or process id.
- The desktop bridge's `metrics` answers only the main window's page; the
  preload passes at most 64 processes, short text and numeric amounts.

See [SECURITY.md](../../SECURITY.md).

## Testing

- Settings: `backend/kernel/config/settings/settings.test.ts` (layering,
  validation, kept unknown entries, reload over a broken file, file edits
  keeping the user's text), `backend/kernel/config/jsonc.test.ts`,
  `backend/kernel/config/ui/ui.test.ts`,
  `backend/kernel/config/routes.test.ts` (both APIs, error codes,
  read-only, audit, pushes after API changes and file edits).
- Keybindings: `backend/kernel/config/keybindings/keybindings.test.ts`
  (shared vectors, per-platform defaults without conflicts or terminal
  keys, user rules and chords, conflicts);
  `web/src/__tests__/keys.test.ts` (the same vectors, unbound keys left to
  the terminal, key hints).
- Generated files: `backend/kernel/config/registry.test.ts` (the modules
  and switches in the features' order, the tables, writing and checking),
  `backend/hosts/bun/registry.test.ts` (the composed core's registry and
  tables are the repository's), `backend/scripts/tokens.test.ts`.
- Web UI: `settings.test.ts`, `settingsDialog.test.ts`,
  `pluginSettings.test.ts`, `keysTable.test.tsx`, `localFonts.test.ts`,
  `theme.test.ts`, `termOptions.test.ts`, `tokens.test.ts`,
  `perf.test.tsx`, `keptPanes.test.ts` in `web/src/__tests__`.
- Desktop: `desktop/src/follow.test.ts`, `menu.test.ts`,
  `preload.test.ts` (`metrics`).
- Usage: `backend/shared/host/perf.test.ts`.
- Manually: a dev core changed through the API and by editing its file,
  with pushes observed on `/ws`; the dialog used in headless Chromium and
  the desktop app, in English and Chinese, light and dark.
