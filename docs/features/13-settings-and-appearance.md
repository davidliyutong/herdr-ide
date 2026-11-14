# 13 · Settings, keybindings and appearance

## Context

Several clients show one core's machines: the web UI (in browsers and
inside the desktop app), the desktop app's shell (its menu and title bar)
and the macOS application. Values kept by each client (a browser's
`localStorage`, an application's preferences, keys written into a menu)
differ per browser, profile and application, a change in one client does
not reach the others, and every setting needs UI code in every client.
Earlier versions kept settings that way: browser preferences in
`localStorage`, core settings under other names, the desktop app's
shortcuts as settings of its own. They are migrated once (below).

## Goals / non-goals

Goals: one settings system and one keybinding system with the core as the
only source; every client (web UI, desktop app, macOS application) renders
its settings from the same definitions; a hand-editable file like VS Code's
`settings.json` and `keybindings.json`; changes from any client or from the
file reach every client at once; the command line stays the authority.

Non-goals: per-user settings on a shared core (the core has no users);
settings per browser; theming terminal applications.

## Design

**Registry** (`internal/settings`, `internal/registry`)

- A package defines the settings it uses as a `settings.Module`: sections
  (`{id, order}`), definitions and migrations of its old keys
  (`internal/uisettings` for the user interfaces, `codeserver.Settings`,
  `gui.Settings`); `internal/registry` lists the modules the core
  registers.
- A definition (`settings.Def`) has a dotted key (`terminal.fontSize`), a
  type (`bool`, `number`, `string`, `enum`, `color` `#rrggbb`, `list` of
  strings or colors with an optional exact length), a default, the enum's
  values, a range and whether numbers are whole, a scope (`app`; `machine`:
  any machine may have its own value; `remote-machine`: machines other than
  the core's host), its section and order, the platforms that use it
  (`web`, `macos`; none, which every registered setting has, means all),
  an optional command-line flag and a validation function. Lists
  hold at most 256 items; strings at most 4096 bytes, without NUL, CR or
  LF. Invalid definitions panic at start.
- The modules registered: the user interfaces' sections `appearance`,
  `layout`, `terminal`, `colors` and `notifications`; code-server's
  `codeServer` (`codeServer.install`, `codeServer.path`); the program
  windows' `gui` (`gui.enabled`, `gui.gpu`, `gui.video`, scope
  `remote-machine`). Every setting with its type, default, flag and scope
  is listed in [reference](../reference.md#settings).
- Descriptions are not in Go: the UIs translate `settings.<key>`,
  `settings.<key>.desc`, `settings.<key>.<option>` and
  `settings.section.<id>`. `scripts/registry` writes
  `design/generated/registry.json` from the registry: each setting's
  default, the commands and each platform's default bindings, and the
  translation keys each UI needs (`i18n.web`, `i18n.macos`); a test of the
  web UI and one of the macOS application fail when a listed key is
  missing. It also writes the tables of settings and of commands with
  their default keys in [reference](../reference.md), between markers
  there. `make check` fails when either is stale
  (`make tokens` writes them).
- The terminal colors' defaults (`terminal.colors.{dark,light}.*`) are the
  design tokens' (`design/tokens.json`); `scripts/tokens` writes them into
  `internal/uisettings/tokens.go` beside the Swift and CSS tokens
  ([24](24-design-tokens.md)).

**File** (`settings[-<instance>].json`, core host)

- The file is in the user's configuration directory on the core host
  (`~/Library/Application Support/<slug>/` on macOS, `~/.config/<slug>/`
  on Linux), beside `keybindings[-<instance>].json` and the machines file
  ([reference](../reference.md#files-and-directories)). A missing file has
  no values. The desktop app and the macOS application start their cores
  as instance `desktop`, so both use `settings-desktop.json` and
  `keybindings-desktop.json`.
- Global values are top-level `"key": value` pairs, typed JSON; a
  machine's own values are under `"[machine:<id>]": {"key": value}`. The
  file is written with global values first, keys sorted, two-space
  indentation, atomically, mode 0600.
- Keys the core does not know and values that do not validate are kept
  when the file is rewritten (another version may know them); they count
  as unset and are reported as problems (`unknown`, `invalid`, `scope` for
  a machine's value of an `app` setting).
- A file that is not JSON is reported (`parse`); the values read before
  stay in effect and nothing is written over the file until it is fixed
  (changes are refused with `file`).
- The core polls the file every 2 s (modification time and size) and reads
  it again when someone else changed it; a change through the API first
  reads such an edit, so it is not lost.
- Migration: on load, a file of the earlier format (string values under
  the old names, machines' values under `"machines": {…}`) is converted
  once and rewritten: `code-server-install` → `codeServer.install`,
  `code-server-path` → `codeServer.path`, `gui` → `gui.enabled` (`on`/`off`
  → `true`/`false`), `gui-gpu` → `gui.gpu`, `gui-video` → `gui.video`;
  values of the current format win over migrated ones. The desktop app's
  shortcut settings (`desktop-*-key`) become keybinding rules before the
  settings are read (below), and the settings' migration then drops them
  from the file (`internal/registry`, `TestLegacyShortcutsLeaveTheSettings`).

**Layering**

- Command-line flag (locks the setting, for every machine too) → the
  machine's own value (scope other than `app`) → the global value → the
  default. Readers ask for the value of a machine (`Store.Bool(key,
  machine)`); code-server's install mode is read at each start, GUI
  settings when a display is prepared or a frame is sent.
- The flags that lock settings are `--code-server-install`,
  `--code-server-path`, `--gui`, `--gui-gpu` and `--gui-video`
  (`Def.Flag`, registered with the other flags by `RegisterFlags`). A
  locked setting reports `source: flag` and `locked`, the UIs show it
  disabled with the flag's name, and changes to it, global or per
  machine, are refused (`locked`). The file's value for it stays and
  applies again when the core runs without the flag.

**API** (`internal/server/settings.go`)

- `GET /api/settings` → `{sections, definitions, values, problems,
  read_only, file}`; `values` has per key `{value, source:
  default|global|flag, machines: {id: value}, locked}`.
- `PUT /api/settings {key, value, machine?}` validates and saves; `DELETE
  /api/settings?key=&machine=` removes a value (the global one falls back
  to the default, a machine's to the global value). Errors are codes the
  UIs translate: `invalid` (400), `locked` (409), `unknown` (404: no such
  setting, or a machine the core does not have), `scope` (400: an `app`
  setting given a machine, or a `remote-machine` setting given the core's
  own machine), `file` (409), `save` (500, with the system's error).
- Every change, through the API or the file, is pushed to every `/ws`
  client as `{t: "settings", values, problems}`:
  clients replace their values without asking again.
- Writes are refused in read-only mode, audited (`settings.set`,
  `settings.reset`) and behind the Host/Origin and proxy-secret guards.

**Keybindings** (`internal/keybindings`)

- Commands are registered in Go (`internal/keybindings/commands.go`): an
  id (`tab.new`, `pane.splitRight`, `view.toggleCode`,
  `find.open`…), a section of the keyboard page (`app`, `workspace`,
  `tab`, `pane`, `view`, `find`, `code`), where it applies and default
  keys per platform. Labels are `command.<id>` and
  `command.section.<id>`.
- `when` contexts: `terminal` (the main window outside VS Code's panel and
  dialogs; every command but one), `vscode` (VS Code's panel has the
  keyboard), `dialog` (a dialog, the palette or a text field of the
  application has it) and `always` (`view.toggleCode`, so the key that
  hides VS Code works from inside it). A binding runs only in its context;
  `always` runs in every one.
- Platforms: `mac` and `pc` (the desktop applications on macOS and on
  other systems) and `mac-browser`, `pc-browser` (a browser on either).
  The macOS application and the desktop app on macOS use `mac`; a page
  picks its platform from the system and whether the desktop shell's
  bridge is present.
- Key syntax: a stroke is modifiers (`cmd`, `ctrl`, `alt`, `shift`, with
  aliases such as `meta`, `option`) and a key joined by `+`; a chord is
  strokes separated by spaces (`ctrl+b c`), at most 4. The canonical form
  orders modifiers cmd, ctrl, alt, shift and names keys after the US
  layout's unshifted keys: `?` is `shift+slash`, `}` is
  `shift+bracketright`. The first stroke needs cmd, ctrl or alt (or is a
  function key), so a binding never takes a key that types text. Go
  (`keys.go`), TypeScript (`web/src/keys.ts`) and Swift
  (`macos/Sources/TermKit/Keys.swift`) each parse and normalize; all three
  run the vectors of `design/testdata/keys` (`parse.json`; the clients also
  `events.json`, how a key press is named, and `sequences.json`, how strokes
  run bindings).
- Defaults are a prefix keymap on every platform (`ctrl+b`, then a
  key; the tab numbers are the commands `tab.select1`…`9`) and add each
  application's direct shortcuts: the macOS application's menu keys on
  `mac` (`cmd+t`, `cmd+d`, `cmd+w` closes the pane…), the desktop app's
  `ctrl+shift` keys on `pc`. Browsers get the chords and the find key only:
  they keep `cmd+t` and the like for themselves.
- The user's file `keybindings[-<instance>].json` is an array of `{key,
  command, when?}`; `"command": "-<id>"` removes the command's binding of
  that key (every binding without a key; only those of the rule's `when`
  when it has one), rules apply in order, after the defaults. A rule
  without `when` takes its command's. Rules are not per platform: a rule
  applies to the bindings of every platform. Keys are stored as written
  and normalized when read. Entries for
  commands this version does not have are kept and reported (`unknown`), as
  are entries that are not rules (`invalid`). Same watching, migration of
  the desktop app's `desktop-*-key` settings (a changed key replaces the
  command's direct keys, `none` removes them; once, while the file does not
  exist), atomic writes and refusal over a broken file as the settings.
- `GET /api/keybindings` → `{sections, commands, defaults, user, effective,
  conflicts, problems, read_only, file}`, with `defaults`, `effective` and
  `conflicts` per platform: the core works out the bindings in effect, so
  clients only match keys. A conflict is a key bound to several commands
  whose contexts overlap (the same `when`, or one of them `always`), or a
  stroke bound alone that also starts chords where both apply (the chords
  would never run). No platform's defaults conflict (a test checks it);
  conflicts made by user rules are kept, marked in every keyboard page,
  and the clients' key matchers run the first binding of the key in
  effect. `PUT /api/keybindings` replaces the user's array (each entry
  validated, at most 1000, 256 KiB); pushed as `{t: "keybindings", user,
  effective, conflicts, problems}`; refused in read-only mode, audited
  (`keybindings.set`).

**Web UI** (`web/src/settings.ts`, `prefs.ts`, `keybindings.ts`,
`keymap.ts`)

- The page reads `/api/settings` before it renders (the language must be
  known) and again after each reconnect; pushes replace the values.
  `prefs.ts` is the typed view the UI reads (`usePrefs`, `getPrefs`);
  `setPref` saves through the API and shows the value at once. Until the
  core answers, the defaults of `registry.json` apply.
- Browser settings of earlier versions (11 `localStorage` keys: language,
  theme, font sizes and weight, panel position, Option as Meta, program
  clipboard, formulas, sounds, silent agents) are moved once: each value
  the core still has at its default is saved there, then the key is
  removed. Read-only mode leaves them for a writable session. State of one
  browser (whether the sidebar is open, the panel's sizes and what each
  workspace's panel shows, the selected machine, the transfer history)
  stays in `localStorage`.
- The settings dialog renders sections from the definitions shown on the
  web (`platforms`): a page per section and **Keyboard shortcuts**, a search
  across labels, descriptions, keys and options, a control per type
  (switch, segmented or select, number with its range, text, color well,
  the 16-color palette), a dot on changed settings, reset, a per-machine
  table for settings with machine scope (inherit first; `remote-machine`
  leaves the core's host out; the program windows section adds each
  machine's display and Enable), the lock of a flag, the file's problems
  and where the file is. Changing the language reloads the page that
  changed it.
- The keyboard page lists every command with its keys in effect, grouped
  by section: × removes a key, + records one (press the strokes, Enter
  keeps them, Escape cancels; the recorder cancels every key, so in the
  desktop app its menu, ⌘Q included, does not act on one), reset returns to
  the defaults; conflicts are marked.
  Changes become user rules (`rulesFor`) saved with `PUT`.
- `keymap.ts` matches every keydown of the app (terminals route theirs
  through it) against the bindings in effect on the page's platform, chords
  included: a stroke that starts chords waits 3 s for the next; the
  chord's first stroke twice sends it to the pane (`ctrl+b ctrl+b`); a
  chord matching nothing ends and its key is dropped. While a dialog or
  the palette is open only `dialog` and `always` bindings run. Keys typed
  in VS Code's panel do not reach the page; in the desktop app its menu
  runs the `vscode` and `always` commands there. Key hints show the
  direct shortcut in the desktop app, else the first chord.
- Desktop app (`desktop/src/follow.ts`, `desktop/src/menu.ts`): the page
  matches its keys as above with the `mac` or `pc` bindings. The shell
  reads both endpoints when its own event channel opens and follows the
  `settings` and `keybindings` messages, as the macOS application does
  (its platform's defaults from `registry.json` and the system's languages
  until then). Its menu is the macOS application's; items show their
  command's first single-stroke key and get only the keys the page leaves
  ([04](04-layout-and-keyboard.md)). `appearance.theme` becomes Electron's
  `nativeTheme.themeSource` (title bar, native controls, window
  background), `appearance.language` the language of the menu and the
  error dialogs.

**macOS application** (`macos/Sources/TermKit/Settings.swift`, `Keys.swift`,
`App/Settings.swift`, `App/main.swift`)

- The application reads both endpoints when it connects and follows the
  `settings` and `keybindings` messages of the event channel.
- The settings window is built from the definitions shown on macOS: a
  sidebar of sections and **Keyboard Shortcuts**, a search field, a switch,
  menu, number field, text field, color well or a grid of 16 color wells
  per type, a dot on changed settings, reset, a per-machine table (each
  machine follows the global value or has its own; the local machine is
  left out of settings only remote machines can differ in), the lock of a
  flag, the file's problems and **Open settings.json** (on the keyboard
  page **Open keybindings.json**), which opens the file in the application
  for JSON, else shows it in the Finder. A change from elsewhere rebuilds
  the page unless a field of it is being edited. Its keyboard page records
  keys in a sheet (strokes as pressed, Cmd keys before the menu, Return
  keeps them) that names the commands the key would clash with before it
  is saved (`KeybindingsModel.clashes`: the same key, or a chord it starts
  or that starts it, where both apply), removes and resets them, marks
  conflicts and commands the application does not run.
- The main menu's key equivalents are the first single-stroke binding of
  each command and are rebuilt on every change; Ghostty unbinds them (and
  ⌘Q, ⌘H, ⌘M and ⌘V, `TerminalControllerBox.systemKeys`) so the menu gets
  them. A key matcher in front of the window
  runs chords and keys no menu item shows, in the contexts `terminal`,
  `vscode` (the web panel) and `dialog` (a text field); the chord's first
  stroke twice reaches the terminal.
- Settings apply live: `appearance.language` switches the menus, the
  sidebar and the settings to English or Chinese (or the system's
  language), `appearance.theme` sets the application's
  appearance (the terminals' colors follow it), `appearance.uiFontSize`
  scales the chrome's fonts and rows, `layout.panelPosition` puts the VS
  Code panel beside the terminals or below them, and the terminal settings become
  Ghostty configuration — font family, size and weight (`font-thicken`
  for medium), line height (`adjust-cell-height`), cursor style and blink,
  scrollback (Ghostty bounds it in bytes: 2 KiB a line; new attaches ask
  the core for that many lines of history, at most 100 000), copy on
  select, bold as bright, Option as Alt, the colors of both themes and the
  program clipboard (`clipboard-write` is `deny` for `off`; otherwise
  Ghostty asks the application about each write, which `auto` copies
  within 10 s of the user's input and otherwise offers in a note,
  [23](23-macos-application.md)). The bell beeps, flashes the pane or
  does nothing; `terminal.mathHover` turns the formula preview on or off;
  `notifications.sound` and `notifications.mutedAgents` decide the sounds.

**Appearance** (`web/src/appearance.ts`)

- Theme `system`, `dark` or `light`; `system` follows
  `prefers-color-scheme` as it changes (`useSystemDark`, a store that
  components drawing with the theme subscribe to besides the settings: in
  the desktop app the query reads the shell's `nativeTheme.themeSource`,
  which turns from dark to system only after the setting did, so switching
  from `dark` to `system` changes the resolved kind without changing the
  settings). The resolved kind sets `<html data-theme>`, whose CSS variables
  restyle the UI (`styles.css` has no other colors; they are defined from
  the design tokens the macOS application shares,
  [24](24-design-tokens.md)), the terminals' colors (the theme's
  `terminal.colors.*`, [26](26-web-terminals.md)) and `theme-color`. The kind is sent to the core,
  which switches VS Code ([05](05-vscode-panel.md)); in the desktop app the
  shell reads the setting from the core, and its title bar follows it
  ([16](16-desktop-packaging.md)).
- Terminal palettes: dark is GitHub Dark Default (Ghostty's theme of that
  name: colors made for a near-black background) on the UI's `--bg` with
  its `--fg`; light is GitHub Light Default except for brighter yellows.
  The palette only colors what programs leave to the terminal (default
  colors and the 16 ANSI colors); programs that use 24-bit colors look the
  same everywhere. Programs that ask the terminal for its colors (OSC
  10/11/4, `CSI ?996n`) get the UI theme's from the client's emulator;
  programs keep the colors they derived until they ask again or restart.
- Terminal font: JetBrains Mono 2.304, the official web fonts (regular,
  medium, bold, each upright and italic) in `web/src/terminal/fonts/` with
  their license (SIL OFL 1.1, appended to the generated `licenses.md`) and
  checksums, after `terminal.fontFamily` when it names a font installed on
  the computer. Characters it lacks (CJK, some symbols) come from the
  fallbacks: SF Mono, Menlo, …, PingFang SC. Rows are
  `terminal.lineHeight` times the font's own line height (1.05 by default).
- Fonts and cell size: a terminal measures its cell from the font, so it
  must not use the font before it is loaded. `fonts.ts` registers the faces
  with the `FontFace` API and loads them on demand; the page waits up to
  1.5 s for the faces of the chosen weight before rendering, a terminal
  shown earlier uses only the fallbacks and measures again (resizing the
  terminal) once the faces arrive, and a new weight is applied when its
  faces are loaded.
- Terminal font weight: regular (400) or medium (500); bold text is 700.
  Medium gives the heavier strokes native terminals produce with stroke
  thickening (Ghostty's `font-thicken`), which the browser's glyphs do not
  get.
- Interface font size sets the root font size; the chrome is sized in `rem`,
  so it scales with it. Every terminal setting applies at once in the
  browser's terminals ([26](26-web-terminals.md)): font family, size,
  weight and line height (a new cell size resizes the terminals), colors,
  cursor style and blink (the cursor a program's reset returns to),
  scrollback (lines kept by the emulator and asked for when attaching),
  copy on select, bold as bright, Option as Meta and the program clipboard;
  the bell flashes the pane, beeps or does nothing.
- Panel position (`right` or `bottom`) changes the grid: below the panes the
  panel spans the workspace column and is resized by its top edge.
- `notifications.sound` and `notifications.mutedAgents` decide which
  agents' changes play a sound ([07](07-agent-native-workflow.md));
  `terminal.mathHover` turns the formula preview on or off
  ([19](19-formulas-in-panes.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Settings kept per browser (`localStorage`) | Every browser, profile and application would have its own values; the desktop app's shell cannot read a page's storage, and not before the page loads. |
| JSON Schema for the definitions | Clients would need a schema validator and still a list of sections, scopes and platforms; the definitions are small typed records. |
| Descriptions in Go | Two UIs translate everything else; one place for text per UI keeps translators' files complete. |
| A file watcher library (fsnotify) | A new dependency for two small files; polling the modification time every 2 s is enough for edits by hand. |
| Clients working out the effective bindings | Three implementations of the rules and of the conflicts; the core serves them per platform and clients only match keys. |
| One platform per OS | The desktop app and a browser on the same Mac need different defaults (`cmd+t` is the browser's). |
| Settings file overriding flags | Breaks service definitions and scripts that rely on their flags. |
| CSS `zoom` for the font size | Distorts mouse coordinates and canvas sharpness. |
| Relying on installed fonts for terminals | Cell size and glyphs differ per system; the bundled font stays the default, an installed one is a choice. |

## Failure modes

- **Settings or keybindings file not JSON** (an edit in progress) → the
  values read before stay, the problem is shown in every settings UI,
  changes are refused (`file`) until the file is fixed.
- **A value in the file does not validate, or a key is unknown** → that
  entry is ignored and shown; the rest applies. Rewrites keep it.
- **Saving fails** (disk, permissions) → the old value stays, the dialog
  shows the error.
- **A client was disconnected while settings changed** → it reads both
  endpoints again when it reconnects.
- **A Ghostty configuration value is refused** → the terminals keep the
  previous configuration (Ghostty rejects the whole configuration).
- **No VS Code window connected** → the theme is sent when one connects.
- **Two browsers choose different themes** → the setting is the core's;
  the last change wins for every client.
- **A program derives its colors from the wrong theme** → it asked before
  the theme changed (or in another client with another theme); it gets the
  new colors when it asks again or restarts.
- **The terminal font loads slowly or not at all** → the page renders after
  1.5 s with the fallback fonts; terminals switch when the font arrives.
- **A page loaded before the core was replaced** has no labels for new
  settings and lacks new features. After every reconnect the page compares
  its entry script with the one the core serves and offers to reload
  (`web/src/update.ts`).

## Security

`PUT` and `DELETE /api/settings` and `PUT /api/keybindings` are mutations:
same Host/Origin and proxy-secret guards, refused in read-only mode,
audited, bodies bounded (64 KiB, 256 KiB). Values are typed and validated;
strings refuse NUL, CR and LF, so a value cannot add lines to the
Ghostty configuration the macOS application writes. Machine ids in the
file and in requests are bounded and refuse brackets and line breaks. See
[SECURITY.md](../../SECURITY.md).

## Testing

`internal/settings/settings_test.go` (`TestDefinitionsOrder`,
`TestMergeOrder`: flag, machine, global and default; `TestValidation`;
`TestMigration` of the old format; `TestUnknownAndInvalidKept`;
`TestReload` after edits by hand and over a broken file;
`TestMemoryStore`), `internal/keybindings/keybindings_test.go`
(`TestParseVectors`, the shared vectors; `TestDefaults` per platform
without conflicts; `TestUserRules`, additions, removals and kept unknown
entries; `TestConflicts` with prefix shadowing; `TestReload`;
`TestMigrateDesktopShortcuts`), `internal/server/settings_test.go`
(`TestSettingsAPI`, `TestSettingsReadOnly`, `TestKeybindingsAPI`,
`TestSettingsPush`: both APIs, error codes, read-only refusal, the
Host/Origin guard, audit, pushes after API changes and file edits),
`scripts/registry/main_test.go` and `scripts/tokens/main_test.go`
(generated files current), `web/src/__tests__/keys.test.ts` (the shared
vectors: parsing, key names, chords; key hints, user rules),
`settings.test.ts` (labels for every registry key, store, optimistic
changes and error codes, migration of the browser settings, search),
`theme.test.ts` (`system` after `dark`), `termOptions.test.ts`,
`tokens.test.ts`, `desktop/src/follow.test.ts` (keybindings and settings
from the replies and pushes, reconnecting), `desktop/src/menu.test.ts`
(accelerators, rebinding and unbinding, titles per language),
`macos/Tests/TermKitTests/TermKitTests.swift` (`KeysTests`: the shared
vectors, labels, menu equivalents, Ghostty triggers, the closing
commands; `SettingsModelTests`: loading and pushes, the keybindings
model's rules and clashes; `LocalizationTests.testRegistryKeys`). A dev core was changed through the
API and by editing its file, with the pushes observed on `/ws`; the dialog's
pages were checked in headless Chromium, and so were the browser's
terminals following a font size and a palette color changed through the
API; the macOS debug build was driven
through its debug actions (font size and a palette color changed live,
the settings window's pages).
