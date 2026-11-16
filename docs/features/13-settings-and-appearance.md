# 13 · Settings, keybindings and appearance

## Context

Several clients show one core's machines: the web UI (in browsers and
inside the desktop app) and the desktop app's shell (its menu and title
bar). Values kept by each client (a browser's `localStorage`, keys written
into a menu) differ per browser and profile, a change in one client does
not reach the others, and the shell cannot read what a page keeps.
Earlier versions kept settings that way: browser preferences in
`localStorage`, core settings under other names, the desktop app's
shortcuts as settings of its own. They are migrated once (below).

## Goals / non-goals

Goals: one settings system and one keybinding system with the core as the
only source; the settings UI rendered from the core's definitions; a
hand-editable file like VS Code's `settings.json` and `keybindings.json`;
changes from any client or from the file reach every client at once; the
command line stays the authority.

Non-goals: per-user settings on a shared core (the core has no users);
settings per browser; theming terminal applications.

## Design

**Registry** (`internal/settings`, `internal/registry`)

- A package defines the settings it uses as a `settings.Module`: sections
  (`{id, order}`; `advanced`; `plugin`, the plugin a plugin's section
  belongs to, [27](27-plugins.md)), definitions and migrations of its old keys
  (`internal/uisettings` for the user interfaces, `codeserver.Settings`,
  `gui.Settings`); `internal/registry` lists the modules the core
  registers.
- A definition (`settings.Def`) has a dotted key (`terminal.fontSize`), a
  type (`bool`, `number`, `string`, `enum`, `color` `#rrggbb`, `list` of
  strings or colors with an optional exact length), a default, the enum's
  values, a range, whether numbers are whole and the step of the UIs'
  stepper, the values offered for a list of strings (others can be added),
  a scope (`app`; `machine`: any machine may have its own value;
  `remote-machine`: machines other than the core's host), its section,
  group (a heading within the section) and order, an optional command-line
  flag and a validation function. A section can be advanced: the UIs list
  it after the others, under **Advanced**. Lists
  hold at most 256 items; strings at most 4096 bytes, without control
  characters (C0 among them NUL, tab, CR, LF and ESC; DEL; C1). Invalid
  definitions panic at start.
- The modules registered: the user interfaces' sections `appearance`,
  `terminal` (groups `text`, `cursor`, `behavior`, `clipboard`), `colors`
  and `notifications`; code-server's advanced `codeServer`
  (`codeServer.install`, `codeServer.path`, scope `machine`: one machine is
  offline, another has its own code-server); the program windows' advanced
  `gui` (`gui.enabled`, `gui.gpu`, `gui.video`, scope `remote-machine`).
  Every setting with its type, default, flag and scope is listed in
  [reference](../reference.md#settings).
- Descriptions are not in Go: the UI translates `settings.<key>`,
  `settings.<key>.desc`, `settings.<key>.<option>`, `settings.section.<id>`,
  `settings.group.<id>` and, where they exist, `settings.<key>.unit` and
  `settings.<key>.placeholder`. `scripts/registry` writes
  `design/generated/registry.json` from the registry: each setting's
  default, the commands and each platform's default bindings, and the
  translation keys the web UI needs for the settings and commands it shows
  (`i18n`); a test of the web UI fails when a listed key is missing. It also writes the tables of settings and of commands with
  their default keys in [reference](../reference.md), between markers
  there. `make check` fails when either is stale
  (`make tokens` writes them).
- The terminal colors' defaults (`terminal.colors.{dark,light}.*`) are the
  design tokens' (`design/tokens.json`); `scripts/tokens` writes them into
  `internal/uisettings/tokens.go` beside the CSS tokens
  ([24](24-design-tokens.md)).

**File** (`settings[-<instance>].json`, core host)

- The file is in the user's configuration directory on the core host
  (`~/Library/Application Support/<slug>/` on macOS, `~/.config/<slug>/`
  on Linux, `%AppData%\<slug>\` on Windows), beside
  `keybindings[-<instance>].json` and the machines file
  ([reference](../reference.md#files-and-directories)). A missing file has
  no values. The desktop app starts its core as instance `desktop`, so it
  uses `settings-desktop.json` and `keybindings-desktop.json`.
- Global values are top-level `"key": value` pairs, typed JSON; a
  machine's own values are under `"[machine:<id>]": {"key": value}`. The
  file is written with global values first, keys sorted, two-space
  indentation, atomically, mode 0600; the directory is created 0700, and
  an existing one of the user's that others may access is made 0700 when
  a file is written (a link to a directory is left as it is;
  `internal/userfile`). On Windows, which has no such modes, the
  directory is left to its access control list, which keeps `%AppData%`
  the user's.
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
  values of the current format win over migrated ones. Values of an older
  type change in place, once: `notifications.mutedAgents`, a
  comma-separated string before, becomes a list of agent names, a
  `terminal.scrollback` above 100,000 (earlier versions took a million,
  which the terminals' memory cannot hold) comes down to 100,000, and
  `layout.panelPosition` (where earlier versions placed the VS Code panel,
  which VS Code panes replaced) is dropped from the file
  (`uisettings.TestMigrateValues`). A value already of the current type is
  left as it is and the file is not rewritten. The desktop app's
  shortcut settings (`desktop-*-key`) become keybinding rules before the
  settings are read (below), and the settings' migration then drops them
  from the file (`internal/registry`, `TestLegacyShortcutsLeaveTheSettings`).

**Layering**

- Command-line flag (locks the setting, for every machine too) → the
  machine's own value (scope other than `app`) → the global value → the
  default. Readers ask for the value of a machine (`Store.Bool(key,
  machine)`); code-server's install mode and path are read for the machine
  at each start, GUI settings when a display is prepared or a frame is
  sent.
- The flags that lock settings are `--code-server-install`,
  `--code-server-path`, `--gui`, `--gui-gpu` and `--gui-video`
  (`Def.Flag`, registered with the other flags by `RegisterFlags`). A
  locked setting reports `source: flag` and `locked`, the UI shows it
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
  UI translates: `invalid` (400), `locked` (409), `unknown` (404: no such
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
  id (`tab.new`, `pane.splitRight`, `code.open`,
  `find.open`…), a section of the keyboard page (`app`, `workspace`,
  `tab`, `pane`, `view`, `find`, `code`), where it applies and default
  keys per platform. Labels are `command.<id>` and
  `command.section.<id>`.
- `when` contexts: `terminal` (the main window outside dialogs: terminal
  panes, and VS Code panes for the keys VS Code leaves; every command but
  the zoom commands), `vscode` (only while a VS Code pane has the
  keyboard), `dialog` (a dialog, the palette or a text field of the
  application has it) and `always` (`view.zoomIn`, `view.zoomOut` and
  `view.zoomReset`, so the window's zoom works in dialogs too). A binding
  runs only in its context, `terminal` ones in VS Code panes too; `always`
  runs in every one.
- Platforms: `mac` and `pc` (the desktop app on macOS and on other
  systems) and `mac-browser`, `pc-browser` (a browser on either). A page
  picks its platform from the system and whether the desktop shell's
  bridge is present.
- Key syntax: a stroke is modifiers (`cmd`, `ctrl`, `alt`, `shift`, with
  aliases such as `meta`, `option`) and a key joined by `+`; a chord is
  strokes separated by spaces (`ctrl+k c`), at most 4. The canonical form
  orders modifiers cmd, ctrl, alt, shift and names keys after the US
  layout's unshifted keys: `?` is `shift+slash`, `}` is
  `shift+bracketright`. The first stroke needs cmd, ctrl or alt (or is a
  function key), so a binding never takes a key that types text. Go
  (`keys.go`) and TypeScript (`web/src/keys.ts`) each parse and normalize;
  both run the vectors of `design/testdata/keys` (`parse.json`; the web UI
  also `events.json`, how a key press is named, `sequences.json`, how
  strokes run bindings, and `defaults.json`, how strokes run each
  platform's defaults).
- Defaults are the desktop app's direct shortcuts, single strokes only:
  its menu keys on `mac` (`cmd+t`, `cmd+d`, `cmd+w` closes the pane,
  `cmd+shift+p` the command palette, `cmd+/` the list of shortcuts…), its
  `ctrl+shift` keys on `pc`
  (`ctrl+shift+p`, `ctrl+shift+/`…). Browsers keep `cmd+t` and the like
  for themselves and get find, the list of shortcuts (`cmd+/`,
  `ctrl+shift+/`) and on macOS the palette (`cmd+k`); a browser elsewhere
  has no key left for the palette (Firefox opens a private window on
  `ctrl+shift+p`, and `ctrl` with a letter belongs to the programs in the
  terminals), and the status bar's **Command palette** opens it. The
  application is used with the mouse: no default is a chord and none is
  `ctrl` or `alt` with a letter alone, so `ctrl+b` (tmux's prefix) and
  every other key that is not a default reach the program in the terminal
  on their first press. Commands without a key (the tab numbers
  `tab.select1`…`9`, focus moves, renames, zoom, VS Code's diff and Git
  Graph…) run from the menus, the context menus, the pane headers' buttons
  and the command palette, and the user can bind keys or chords to them.
- The user's file `keybindings[-<instance>].json` is an array of `{key,
  command, when?}`; `"command": "-<id>"` removes the command's binding of
  that key (every binding without a key; only those of the rule's `when`
  when it has one), rules apply in order, after the defaults. A rule
  without `when` takes its command's. Rules are not per platform: a rule
  applies to the bindings of every platform. Keys are stored as written
  and normalized when read. A rule naming a command that earlier versions
  had under another id applies to the command that took its place
  (`view.toggleCode`, the VS Code panel's toggle, is `code.open`). Entries for
  commands this version does not have are kept and reported (`unknown`), as
  are entries that are not rules (`invalid`). Same watching, migration of
  the desktop app's `desktop-*-key` settings (a changed key replaces the
  command's direct keys, `none` removes them; `desktop-toggle-code-key`
  becomes `code.open`'s; once, while the file does not exist), atomic
  writes and refusal over a broken file as the settings.
- `GET /api/keybindings` → `{sections, commands, defaults, user, effective,
  conflicts, problems, read_only, file}`, with `defaults`, `effective` and
  `conflicts` per platform: the core works out the bindings in effect, so
  clients only match keys. A conflict is a key bound to several commands
  whose contexts overlap (the same `when`, `terminal` and `vscode`, which
  both apply in a VS Code pane, or one of them `always`), or a
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
  theme, font sizes and weight, Option as Meta, program clipboard,
  formulas, sounds, silent agents as a list, and the VS Code panel's
  position) are moved once: each value the core still has at its default
  is saved there, then the key is removed; the panel's position, gone with
  the panel, is only removed. Read-only mode leaves them for a writable
  session. State of one browser (whether the sidebar is open, the
  sidebar's width, the selected machine, the transfer history) stays in
  `localStorage`; what earlier versions kept there for the VS Code panel
  (`docks`, `dockWidth`, `dockHeight`) is removed once when the page
  loads.
- The settings dialog (`components/SettingsDialog.tsx`, laid out as VS
  Code's) floats in the middle of the window, shrinking with it down to a
  16 px gutter on every side, and renders the definitions:
  - a scope bar: **User** (the global values) and, beside it as VS Code
    has its folder settings, **Machine ▾**, a searchable list of the
    machines that can have their own values (each with its state and
    address; the button names the machine chosen), so any number of
    machines fits on one row, a phone's too. A machine's scope lists only the settings it
    can differ in (`remote-machine` leaves the core's host out), each
    showing "Same as User (value)" until it is set and a reset that removes
    the machine's own value; its **Overview** page has the machine's name
    (renamed in place), address and platform, its
    connection with Enable, Disable, Sign In… or Retry, and
    **Troubleshooting**: restart, start or stop its terminal service. A
    machine's menu in the sidebar opens it there (**Machine Settings…**), and
    a program window error opens its **Program Windows** page;
  - in the desktop app on macOS, the user's **Terminal** page ends with
    **Permissions → Full Disk Access**, which is no setting: whether
    terminals and the app have it, System Settings, and what to restart
    ([16](16-desktop-packaging.md)); the search finds it too;
  - a list of sections, the advanced ones last under **Advanced**, each
    with a dot when one of its settings is changed in the scope shown,
    **Plugins** (User only) with the plugins' own pages indented below it
    (in a machine's scope under a heading; a plugin's page starts with its
    switch, says when it is off and is dimmed in the list then,
    [27](27-plugins.md)), and **Keyboard Shortcuts** (User only);
  - a search across labels, descriptions, keys, sections and options of the
    scope shown (and the keyboard shortcuts in User);
  - per setting: its name, its description, then its control; a bar on its
    left and a **Modified** badge (in a machine's scope: **Set for this
    machine**) when it is not at its default; a `⋯` button (shown while the
    row is pointed at or focused) and a right-click open **Reset Setting**,
    **Copy Setting ID** and **Copy Setting as JSON**: ids are not shown
    otherwise. Settings of the user scope set for some machines say so,
    with links to those machines' scopes;
  - controls by type: a checkbox with the description for a bool; a
    segmented control for up to four options, else a searchable list
    (`components/Picker.tsx`, [27](27-plugins.md)); in a machine's scope
    a native select of "Same as User (value)", On and Off or up to four
    options, a searchable list starting with "Same as User" for more; a
    stepper (−, the value, +) with the definition's step, unit and range
    written out ("0–100,000 lines"; typed values are brought into the
    range) for a number; for a list with offered values, a searchable list
    of them with check boxes that adds any other value typed (**Add
    "…"**; `notifications.mutedAgents`: every agent the terminals
    recognize, `usage.thresholds`), and for one without, a field that
    adds a value; every value of a list is a removable chip; a text field
    otherwise. The terminal font is a
    picker (`settings/FontPicker.tsx`): the bundled JetBrains Mono first,
    then the monospace fonts installed on the computer, each drawn in
    itself, searchable, and any other typed name; a preview line in the
    chosen font and size below. The fonts are listed with the Local Font
    Access API where the browser has it (Chromium, and the desktop app,
    which grants its pages the permission), asked on the first opening, and
    filtered to the families that are really fixed-pitch
    (`terminal/localFonts.ts`): each is loaded by its name and measured at
    40 px on a canvas; it must draw the text itself (the same width with a
    serif or a monospace fallback behind it), draw `i`, `m`, `W`, the
    space, `0`, `.`, `_` and `@` equally wide (Ayuthaya's narrower space
    leaves it out), and draw letters as letters (`x` on the baseline, `p`
    below it, `H` a fifth taller than `x`; symbol fonts such as Wingdings
    put pictures there). Names that do not print (not starting with a
    letter or digit, or holding `?`, U+FFFD, control, format or private-use
    characters, as a name that did not decode, `???®™??-`) are left out,
    each family is listed once (without regard to case), sorted after the
    bundled font; without the API (Firefox, Safari, a refusal) the
    well-known monospace families found installed by measuring them are
    listed the same way;
  - **Terminal Colors** (`settings/Colors.tsx`): for the dark and the light
    theme a scheme (`terminal.colorScheme.dark`, `.light`: Default, which is
    the app's own colors, Dracula, Gruvbox Dark and Light, Nord, One Dark
    and Light, Solarized Dark and Light, Tomorrow and Tomorrow Night;
    `web/src/terminal/schemes.ts`), chosen in a searchable list that shows
    each scheme's background and four of its colors, with a preview of its
    background, text and 16 colors, and **Customize colors**: named swatches for text,
    background, cursor, selection and the 16 ANSI colors (Black … Bright
    white), each set one replacing the scheme's (`terminal.colors.<theme>.*`;
    a color left at its default follows the scheme) and with a reset of its
    own. Choosing another scheme drops the theme's own colors after asking.
    `terminal.boldIsBright` is on this page; Option as Meta is shown on
    macOS only;
  - read-only mode, a flag's lock and the file's problems as before; the
    header's file button opens `settings.json` (or `keybindings.json` on the
    shortcuts page) in a VS Code pane on the core's own machine, where the
    file is (as a path from a terminal opens,
    [06](06-quick-look-and-files.md)), and copies its path where there is
    none (a core on Windows, read-only mode).
  Changing one setting re-renders only what changed: the field or button
  used keeps the keyboard and the page its scroll position. Changing the
  language reloads the page that changed it.
- The keyboard page is a table of every command with its keys in effect,
  grouped by section, and where they come from (Default or User, with a bar
  on rows the user changed): double-clicking a row (or **Change
  Keybinding…** in its menu) records keys that replace the command's, `+`
  (**Add Keybinding…**) records one more, a key's × removes it, **Reset
  Keybinding** returns to the defaults, **Copy Command ID** copies the id;
  recording takes the strokes, Enter keeps them, Escape cancels (the
  recorder cancels every key, so in the desktop app its menu, ⌘Q included,
  does not act on one). The search matches names, ids and keys; its
  keyboard button searches by the keys pressed instead. Conflicts are
  marked. Changes become user rules (`rulesFor`) saved with `PUT`.
- `keymap.ts` matches every keydown of the app (terminals route theirs
  through it) against the bindings in effect on the page's platform, chords
  included: a key no binding takes is left to the terminal, whose key
  encoder sends it; a stroke that starts a user's chords waits 3 s for the
  next; the chord's first stroke pressed again is left to the terminal in
  the same way (`ctrl+k ctrl+k` types `ctrl+k`, whatever the stroke is); a
  chord matching nothing ends and its key is dropped. While a dialog or
  the palette is open only `dialog` and `always` bindings run. Keys typed
  in a VS Code pane go to VS Code first, `cmd+w` (closing an editor) too;
  in the desktop app on macOS the keys VS Code leaves reach the
  application menu, which runs the `terminal`, `vscode` and `always`
  commands on that pane, and VS Code's key for closing in a window
  without editors closes the pane ([04](04-layout-and-keyboard.md)). Key hints (tooltips,
  context menus, the palette, the status bar) show the command's direct
  shortcut in the desktop app, else its first key, and nothing when it has
  none. The status bar offers **Keyboard shortcuts** and **Command
  palette** as buttons, with their keys when they have one.
- Desktop app (`desktop/src/follow.ts`, `desktop/src/menu.ts`): the page
  matches its keys as above with the `mac` or `pc` bindings. The shell
  reads both endpoints when its own event channel opens and follows the
  `settings` and `keybindings` messages (its platform's defaults from
  `registry.json` and the system's languages until then). Its menu's items
  show their command's first single-stroke key and get only the keys the
  page leaves, on macOS; on Windows and Linux they get none
  ([04](04-layout-and-keyboard.md)). `appearance.theme` becomes Electron's
  `nativeTheme.themeSource` (title bar, native controls, window
  background), `appearance.language` the language of the menu and the
  error dialogs, `window.zoom` the windows' zoom
  ([16](16-desktop-packaging.md)).

**Appearance** (`web/src/appearance.ts`)

- Theme `system`, `dark` or `light`; `system` follows
  `prefers-color-scheme` as it changes (`useSystemDark`, a store that
  components drawing with the theme subscribe to besides the settings: in
  the desktop app the query reads the shell's `nativeTheme.themeSource`,
  which turns from dark to system only after the setting did, so switching
  from `dark` to `system` changes the resolved kind without changing the
  settings). The resolved kind sets `<html data-theme>`, whose CSS variables
  restyle the UI (`styles.css` has no other colors; they are defined from
  the design tokens, [24](24-design-tokens.md)), the terminals' colors (the theme's
  `terminal.colors.*`, [26](26-web-terminals.md)) and `theme-color`. The kind is sent to the core,
  which switches VS Code ([05](05-vscode-panes.md)); in the desktop app the
  shell reads the setting from the core, and its title bar follows it
  ([16](16-desktop-packaging.md)).
- Color theme (`appearance.colorTheme`): the accent of the chrome, one of
  the design tokens' themes (Blue, the default, from the app's icon;
  VS Code Blue; Teal; Violet; Rose; Amber; Graphite, the neutral accent of
  earlier versions). The neutrals (backgrounds, text, borders) are the same
  in every theme, so only focus, the selection, the emphasized control and
  what asks for the user change. A theme other than the first sets
  `<html data-accent>` ([24](24-design-tokens.md)); an id this client does
  not know (a newer core's) shows the first. The settings show the themes
  as cards with the accent on both backgrounds.
- Terminal palettes: the Default scheme's dark colors are GitHub Dark
  Default (Ghostty's theme of that name: colors made for a near-black
  background) on the UI's `--bg` with its `--fg`; its light ones GitHub
  Light Default except for brighter yellows. The other schemes and the
  user's own colors replace them (above).
  The palette only colors what programs leave to the terminal (default
  colors and the 16 ANSI colors); programs that use 24-bit colors look the
  same everywhere. Programs that ask the terminal for its colors (OSC
  10/11/4, `CSI ?996n`) get the UI theme's from the client's emulator;
  programs keep the colors they derived until they ask again or restart.
- Terminal font: JetBrains Mono 2.304, the official web fonts (regular,
  medium, bold, each upright and italic) in `web/src/terminal/fonts/` with
  their license (SIL OFL 1.1, appended to the generated `licenses.md`) and
  checksums, after `terminal.fontFamily` when it names a font installed on
  the computer (the picker writes one family; a hand-written list of
  families is used as written). Characters it lacks (CJK, some symbols) come from the
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
- Interface text size (`appearance.uiFontSize`, 11–20 px) sets the root
  font size; the chrome is sized in `rem`, so it scales with it. Zoom
  (`window.zoom`, 50–300 %, the desktop app only, where its shell applies
  it; hidden in browsers, which zoom pages themselves) scales the whole
  window, terminals included, on top of both sizes
  ([16](16-desktop-packaging.md)). Every terminal setting applies at once in the
  browser's terminals ([26](26-web-terminals.md)): font family, size,
  weight and line height (a new cell size resizes the terminals), colors,
  cursor style, thickness and blink (the cursor a program's reset
  returns to; a thin bar by default, `terminal.cursorWidth` 0.5–4 CSS
  pixels for the bar and the underline; a blinking cursor stays lit
  while it moves, so a cursor held by an arrow key or followed while
  typing is never dark),
  scrollback (lines kept by the emulator and asked for when attaching),
  copy on select, bold as bright, Option as Meta and the program clipboard;
  the bell flashes the pane, beeps or does nothing.
- `notifications.sound`, `notifications.system` and `notifications.badge`
  turn the sounds, the system's notifications and the count of blocked
  agents on the app's icon and in the title on or off, each on its own;
  `notifications.mutedAgents` lists the agents that play no sound
  ([07](07-agent-native-workflow.md));
  `terminal.mathHover` turns the formula preview on or off
  ([19](19-formulas-in-panes.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Settings kept per browser (`localStorage`) | Every browser and profile would have its own values; the desktop app's shell cannot read a page's storage, and not before the page loads. |
| JSON Schema for the definitions | Clients would need a schema validator and still a list of sections, scopes and platforms; the definitions are small typed records. |
| Descriptions in Go | The UI translates everything else; one place for its text keeps translators' files complete. |
| A file watcher library (fsnotify) | A new dependency for two small files; polling the modification time every 2 s is enough for edits by hand. |
| Clients working out the effective bindings | A second implementation of the rules and of the conflicts beside the core's; the core serves them per platform and clients only match keys. |
| One platform per OS | The desktop app and a browser on the same Mac need different defaults (`cmd+t` is the browser's). |
| A prefix keymap by default (`ctrl+b`, then a key, as herdr and tmux), as earlier versions had | The application is used with the mouse; a default prefix takes its key from the programs in the terminals (tmux inside a pane needs `ctrl+b` on the first press) and makes every press of it wait for a second key. Users who want chords bind them in the keybindings file. |
| Sending a chord's first stroke twice as its control character | Worked only for `ctrl` with a letter; letting the second press through to the terminal's key encoder sends whatever stroke it is, in the terminal's current keyboard mode. |
| Settings file overriding flags | Breaks service definitions and scripts that rely on their flags. |
| CSS `zoom` for the font size | Distorts mouse coordinates and canvas sharpness. |
| Relying on installed fonts for terminals | Cell size and glyphs differ per system; the bundled font stays the default, an installed one is a choice. |
| A text field for the font family, as VS Code has | The user must know a font's exact family name and the CSS list syntax; the picker lists what is installed and shows it. |
| Ten loose color settings | Choosing a look meant picking 20 colors one by one, and the 16 colors had no names; schemes give a whole look at once, the swatches name each color. |
| A per-machine table at the bottom of each page | Machine values were far from the settings they change and the table only took bools and options; a machine's scope shows its settings with the same controls, reachable from the machine's menu. |
| Showing every setting's id beside its name | Ids are for the JSON file; they are copied from the setting's menu and still found by the search. |
| A comma-separated string for the silent agents | The user had to know the agents' ids and the syntax; a list of the agents the terminals recognize, with others addable, says both. |

## Failure modes

- **Settings or keybindings file not JSON** (an edit in progress) → the
  values read before stay, the problem is shown in the settings dialog,
  changes are refused (`file`) until the file is fixed.
- **A value in the file does not validate, or a key is unknown** → that
  entry is ignored and shown; the rest applies. Rewrites keep it.
- **Saving fails** (disk, permissions) → the old value stays, the dialog
  shows the error.
- **A client was disconnected while settings changed** → it reads both
  endpoints again when it reconnects.
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
strings refuse every control character (C0, DEL, C1), so a value carries
no line breaks or escape sequences. Machine ids in the
file and in requests are bounded and refuse brackets and line breaks. See
[SECURITY.md](../../SECURITY.md).

## Testing

`internal/settings/settings_test.go` (`TestDefinitionsOrder`,
`TestMergeOrder`: flag, machine, global and default; `TestValidation`;
`TestMigration` of the old format; `TestUnknownAndInvalidKept`;
`TestReload` after edits by hand and over a broken file;
`TestMemoryStore`), `internal/keybindings/keybindings_test.go`
(`TestParseVectors`, the shared vectors; `TestDefaults` per platform:
single strokes only, none a key of terminal programs, no conflicts, keys
for the palette and the shortcuts; `TestUserChords`, chords of the user's
file, the earlier `ctrl+b` ones included; `TestUserRules`, additions,
removals and kept unknown entries; `TestRenamedCommands`, rules naming
`view.toggleCode` applied to `code.open`; `TestConflicts` with prefix
shadowing and `terminal` meeting `vscode`; `TestReload`;
`TestMigrateDesktopShortcuts`), `internal/server/settings_test.go`
(`TestSettingsAPI`, `TestSettingsReadOnly`, `TestKeybindingsAPI`,
`TestSettingsPush`: both APIs, error codes, read-only refusal, the
Host/Origin guard, audit, pushes after API changes and file edits),
`scripts/registry/main_test.go` and `scripts/tokens/main_test.go`
(generated files current), `web/src/__tests__/keys.test.ts` (the shared
vectors: parsing, key names, chords, each platform's defaults; `ctrl+b`
and other unbound keys left to the terminal on every platform, the second
press of a chord's first stroke left to it; key hints, empty when
unbound; user rules), `vt.test.ts` (the bytes the terminal sends for
`ctrl+b`),
`settings.test.ts` (labels for every registry key, store, optimistic
changes and error codes, migration of the browser settings, search),
`settingsDialog.test.ts` (sections and scopes, the machines' scope list,
the stepper keeping the focus and the range, the list editor's offered
values, an added one and chips, a machine's own value set and removed,
small lists as native selects, a color scheme searched and chosen, a
machine's value among many options, colors from schemes and the user's,
every scheme defined),
`pluginSettings.test.ts` (plugins' pages in the list and their switch),
`localFonts.test.ts` (the font picker's list with Chromium's metrics of
fixed-pitch, proportional, symbol and undecoded fonts and one drawn by a
fallback: names that print, each once, sorted),
`internal/uisettings/uisettings_test.go` (`TestMigrateValues`: the silent
agents and the scrollback changed once, `layout.panelPosition` dropped,
current values not rewritten), `codePanes.test.ts` (the VS Code panel's
browser keys removed),
`internal/agent/detect` (`TestSettingsListEveryAgent`),
`internal/codeserver` (`TestInstallMode`: a machine's own mode and path),
`theme.test.ts` (`system` after `dark`), `termOptions.test.ts`,
`tokens.test.ts`, `desktop/src/follow.test.ts` (keybindings and settings
from the replies and pushes, reconnecting), `desktop/src/menu.test.ts`
(accelerators, rebinding and unbinding, items without a key, titles per
language). A dev core was changed through the API and by editing its
file, with the pushes observed on `/ws`; the dialog's pages were checked in
headless Chromium, and so were the browser's terminals following a font
size and a palette color changed through the API; the dialog's pages, both
scopes, the font picker, the list editor, schemes and swatches, search and
the shortcuts page were used with pointer events in English and Chinese,
light and dark, and the font picker in the desktop app.
