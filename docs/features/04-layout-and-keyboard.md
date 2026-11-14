# 04 · Layout and keyboard

## Context

herdr users already know its layout model (workspaces → tabs → binary split
trees of panes) and its prefix keymap (`ctrl+b` by default). In a browser,
`Cmd+W`, `Cmd+T` and similar shortcuts belong to the browser and cannot be
captured reliably; the desktop app and the macOS application own their
keys.

## Goals / non-goals

Goals: the same topology as herdr (changes in either UI show up in the
other); herdr's default keys work unchanged in every client; one set of
keybindings, changeable, for every client; nothing important depends on
browser-reserved shortcuts.

Non-goals: a separate herdr-ide layout model; arbitrary docking of panes.

## Design

**Layout** (`web/src/components/SurfaceView.tsx`)

- herdr lays out the shown tab itself, at the browser's size in cells: the
  surface carries each pane's rectangle, the split lines and their handles
  ([18](18-endpoint-surfaces.md)); `zoomed` tabs show one pane. The split
  tree from `layout.export` still names panes for actions, directional focus
  and the tab list.
- Dragging a split handle calls `layout.set_split_ratio` with herdr's path
  from the root (`false` = first child, `true` = second; `[]` is the root
  split); a line follows the pointer until herdr's next surface.
- Split, close, zoom, new tab and new workspace call the corresponding herdr
  methods with the focused pane's cwd.
- The owning browser's tab and focused pane become herdr's focus (herdr
  renders the focused tab of its client), so herdr's TUI, if one is
  attached, follows the browser; opening an agent from the inbox calls
  `pane.focus` so herdr marks it as seen.
- Tabs and workspaces are shown in the order of the snapshot's arrays, which
  is herdr's order. `Tab.number` is not a position: it stays with a tab when
  the tab moves (workspace numbers are positions). `prefix 1..9` picks tabs
  by position.
- Tabs that do not fit on one row continue on more rows and the tab bar
  grows, as with VS Code's wrapped tabs: every tab stays visible and the bar
  never scrolls. The sidebar toggle and the breadcrumb stay on the first
  row, `+` follows the last tab, and a label longer than 16em is cut with
  an ellipsis (the tooltip has it in full). The sidebar lists every
  workspace of a machine one below the other.

**Rearranging and renaming** (`web/src/drag.ts`, `paneDrag.ts`,
`reorderDrag.ts`, `InlineEdit.tsx`)

- All drags share `drag.ts`: a drag starts after the pointer moved 6
  pixels on the screen (so a click stays a click), a ghost follows the
  pointer, a marker shows where the drop lands, and Escape cancels. The
  distance is measured in screen coordinates: in macOS full screen the menu
  bar slides down when the pointer nears the top edge and moves the page
  under a pointer that stands still, which page coordinates would count as
  a drag of the tab under it.
- A tab is shown when it is pressed, as in browsers, not on release: a press
  that turns into a drag, or whose release lands elsewhere because the page
  moved, still switches to it.

- Dragging a pane header or the toolbar above a lone pane (after a few
  pixels, so a click stays a click)
  shows a highlight of where the pane will go. The middle of another pane
  swaps the two (`pane.swap`); an edge places the pane beside it
  (`pane.move` with `split` right/down and `target_pane_id`; left/top add a
  swap, since herdr splits only to the right or down). Dropping on a tab
  moves the pane into it, on `+` into a new tab. Escape cancels.
- herdr 0.9.5 refuses `pane.move` within one tab (`same_tab`), so a move
  beside a pane of the same tab first moves the pane to a new tab, which herdr
  closes again when the pane leaves it.
- Dragging a tab along the tab bar, or a workspace along its machine's list
  in the sidebar, shows an insertion bar and reorders it (`tab.move`,
  `workspace.move`). Their `insert_index` is a slot in the current order (0
  before the first item, n after the last); the two slots beside the dragged
  item change nothing and show no bar. On a tab bar with several rows the
  row under the pointer (or the nearest) is picked first, then the slot
  within it; the end of one row and the start of the next are the same
  slot, drawn on the row the pointer is on. A tab stays in its workspace and a
  workspace on its machine: a tab can be dropped anywhere along its tab bar,
  a workspace only on or next to its machine's list, so dropping it on
  another machine's list does nothing. The reply (the moved group in its new order) is
  applied to the shown snapshot at once; the snapshot that follows herdr's
  `tab.moved` / `workspace.reordered` event replaces it. Tabs are still drop
  targets for dragged panes; the two drags start from different elements.
- Clicking a pane's title edits it in place (`pane.rename`; empty clears the
  label so the terminal title shows again). Double-clicking a tab or
  workspace, or its rename binding, edits it in place (`tab.rename`,
  `workspace.rename`). Enter or leaving the field saves, Escape cancels.
- Read-only mode and zoomed panes have no drag, rename or mutating buttons.

**Context menus** (`web/src/contextMenu.ts`, `menus.tsx`,
`components/ContextMenu.tsx`)

- Right-clicking a pane header (or the toolbar above a lone pane), a tab or
  a workspace in the sidebar opens an in-app menu at the pointer instead of
  the browser's:
  - pane header and toolbar: rename, split right / down, zoom or restore, VS Code /
    changes / Git Graph of the pane's folder, close;
  - tab: rename, new tab, move left / right, close;
  - workspace: rename, new tab in it, move up / down, close.
- Items call the same commands as the buttons and bindings, and show the
  binding of the same command. Bindings act on the current tab or workspace,
  so a menu of another tab or workspace shows none for those items. Moving
  past either end is disabled. A move item uses the position the tab or
  workspace has when it runs, which another browser or herdr itself may
  have changed since the menu opened.
- The menu takes the keyboard: ↑↓ (skipping disabled items), Home/End,
  Enter or Space runs, Escape or Tab closes; prefix bindings do not run
  while it is open. Running an item or closing from the keyboard gives focus
  back to what had it, before the item runs, so items that move focus
  (rename, split) keep it. A click elsewhere, scrolling, leaving the window
  or resizing closes it. The menu keeps its own width next to the window's
  right edge.
- Read-only mode offers no items, so the browser's menu shows. A pane's
  text has its own menu (copy, paste, open a path or URL;
  [03](03-pane-rendering-and-input.md)), which keeps copying and opening in
  read-only mode.

**Dialogs** (`web/src/dialog.ts`, `Dialogs.tsx`)

- Creating a workspace asks for its directory, with completion of folders on
  the machine (Tab, ↑↓; the folder must exist) and an optional name
  (`workspace.create` `label`). In the desktop app, folders dragged from
  Finder onto the sidebar create a workspace each on the local machine,
  without the dialog (herdr names them after the folder; the last one is
  selected); the sidebar shows where they go while they are over it, and
  dropped files that are not folders are skipped with a note. Folders
  dropped on the app's Dock icon do the same; when the drop launched the app,
  they wait up to 30 s for the local machine to connect, else a note says
  they were not opened. Browsers do
  not tell the page where a dropped folder is, so they do not offer this, nor
  does read-only mode (`web/src/drop.ts`,
  [16](16-desktop-packaging.md)). Closing a pane with a working agent, a
  tab where a program runs (below) and a workspace ask for confirmation;
  Enter cancels these unless
  the user moves to the confirm button. The browser's `prompt()` and
  `confirm()` are not used.

**Keyboard** (`internal/keybindings`, `web/src/keymap.ts`; the system is
described in [13](13-settings-and-appearance.md))

- Commands (`tab.new`, `pane.splitRight`, `view.toggleCode`…) have default
  keys per platform; the user's rules in `keybindings[-<instance>].json` on
  the core host add and remove keys, and the settings' **Keyboard
  shortcuts** page edits them. Every client matches keys against the
  bindings the core works out for its platform.
- The defaults keep herdr's prefix keymap: `ctrl+b`, then a key (split
  `v` / `-`, focus `h` `j` `k` `l`, tabs `c` `n` `p` `1`…`9`, workspaces
  `shift+n` `shift+w` `shift+d`…). A chord lasts 3 s or until its next key;
  the prefix twice (`ctrl+b ctrl+b`) sends it to the pane; a key that ends
  no chord is dropped.
- herdr-ide adds bindings for its own features (VS Code `ctrl+b e`, diff
  `ctrl+b d`, Git Graph `ctrl+b shift+g`, palette `ctrl+b space`, settings
  `ctrl+b ,`).
- herdr's own custom commands (`[[keys.command]]` in `~/.config/herdr/
  config.toml`, read through `/api/keymap`) keep working in the web UI as
  chords of herdr's prefix and come before the other bindings:
  `plugin_action` commands call `plugin.action.invoke` on the pane's
  machine; `pane`/`popup`/`shell` commands run in a new pane.
- The command palette lists commands with their keys, workspaces and agents
  on every machine, agent kinds to start, UI languages and themes.
- The PWA manifest allows installing the app in its own window, where fewer
  shortcuts are taken by browser chrome.

**Direct shortcuts** (`desktop/src/shortcuts.ts`, `web/src/desktop.ts`,
`macos/Sources/App/main.swift`)

- The desktop applications own their keys, so their platforms add direct
  shortcuts without the prefix. On macOS (both applications) they are the
  macOS application's menu keys: `cmd+t` new tab, `cmd+d` / `cmd+shift+d`
  split right / down, `cmd+w` close pane, `cmd+n` new workspace (asking for
  its folder), `cmd+,` settings, `cmd+b` sidebar, `cmd+j` show or hide the
  VS Code panel ([05](05-vscode-panel.md)), `cmd+}` / `cmd+{` next / previous
  tab, `cmd+f` / `cmd+g` / `cmd+shift+g` find. On other systems the desktop
  app has `ctrl+shift+t` new tab, `ctrl+shift+w` close tab (as in terminal
  emulators, since `ctrl+w` deletes a word in shells), `ctrl+,` settings,
  `ctrl+shift+n` new workspace and `ctrl+shift+j` VS Code. Browsers get
  none of these (they keep them), except find (`cmd+f` on macOS,
  `ctrl+shift+f` elsewhere: `ctrl+f` belongs to the programs in panes).
- A key is named after the character the keyboard layout gives it, as macOS
  names its shortcuts (`web/src/keys.ts`, shared by the shell and the page;
  `Keys.stroke` in the macOS application): on AZERTY, `cmd+z` stays undo
  although its physical key is QWERTY's W. Keys without an ASCII character
  (non-Latin layouts, Option characters, dead keys) and keys that type
  nothing fall back to the physical key, so `cmd+w` on a Russian layout is
  still `cmd+w`; Shift does not change the name (`cmd+shift+1`, not
  `cmd+!`).
- The desktop app's shell starts with its platform's defaults
  (`design/generated/registry.json`) and reads `/api/keybindings` once the
  core is up (retrying a failed read) and when the page reports a change.
  It takes single-stroke bindings with cmd, ctrl or alt in
  `before-input-event` of the main window: before the page, every frame in
  it and the menu. A match is not passed on; the shell asks the page to run
  the command. Held keys do not repeat it. Chords and plain keys stay with
  the page.
- While VS Code has focus (the focused frame, or the frame containing it,
  is a `/m/<machine>/code/` frame of the core), its keys belong to it: only
  bindings for `vscode` or `always` run there, so `cmd+w` closes the
  editor, `cmd+t` opens VS Code's symbol search, `cmd+,` VS Code's settings
  and `cmd+n` a new file. Showing or hiding the VS Code panel is `always`:
  hiding it from inside VS Code is what the key is for, so VS Code loses its
  own `cmd+j` (its bottom panel). If VS Code does not take such a key, the
  menu's Close Window does not act on it either, since closing the main
  window quits the app.
- The page runs only `dialog` and `always` bindings while a dialog or the
  palette is open. Closing a tab (the shortcut, the tab bar, the prefix
  binding, menus) first asks herdr what runs in each of its panes
  (`pane.process_info`, read-only, one request per pane at once). A pane
  counts as idle only when the terminal's foreground process group is the
  pane's shell and that shell is a known one (zsh, bash, fish, sh…), that
  is, the shell waits at its prompt; a pane whose terminal is gone counts as
  idle too. When every pane is idle the tab closes at once. Otherwise a
  confirmation names the programs that end (an agent by its name, also
  while it waits for input; Cancel has focus). When herdr cannot tell within
  1.5 s (an older herdr, a slow link) it asks anyway, naming the number of
  panes. Jobs sent to the background with `&` are not seen; they end with
  the tab.
- The desktop app's **File** menu lists new workspace, new tab, close pane
  and close tab with their keys, **View** shows or hides VS Code, the app
  menu has **Settings…**; the menu does not register them itself, so in
  program windows `cmd+w` (Window → Close Window) still closes the window.
- The macOS application's menu items show the first single-stroke key of
  their command and are rebuilt when the keybindings change; Ghostty
  unbinds those keys, so the menu gets them before a terminal. A key
  matcher in front of the window runs chords and keys without a menu item.
- Key hints (tooltips, context menus) show the direct shortcut in the
  desktop app, else the first chord.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Reordering tabs and workspaces in the browser only | The order would differ from herdr's TUI and from other browsers. |
| A tab bar that scrolls sideways (with auto-scroll while dragging) | Tabs out of view are hidden with no sign that they exist. |
| Tabs that shrink to fit, as in Chrome | Labels become unreadable with many tabs. |
| A "more tabs" menu for the tabs that do not fit | Hides tabs again and costs a click. |
| Bindings to move tabs and workspaces | herdr has no such bindings to mirror; the context menu's move items work from the keyboard. |
| A "⋯" button on every header, tab and workspace row | Takes room on every tab and row; right-click covers desktop browsers. |
| Desktop shell (Electron/Tauri) to own all shortcuts | Electron was replaced by browser access so the IDE works remotely; Tauri's WKWebView on macOS lacks service workers, which VS Code webviews need. |
| Browser-specific bindings (`Cmd+…`) | Conflict with the browser and with muscle memory from herdr; browsers do not deliver `Cmd+T`/`Cmd+W` to pages. The desktop app has them (above). |
| Keys in herdr's `config.toml` | herdr's TUI cannot see Cmd and would read the entries as its own bindings; the shell and the macOS application need keys before and outside herdr. |
| Desktop shortcuts as registered menu accelerators | Would also take the keys in program windows; the page's key handlers and frames (VS Code) would need their own exceptions. |
| Desktop shortcuts per browser profile (localStorage) | The shell needs them before and outside the page; the core's keybindings keep one set for all windows. |
| `cmd+w` closing the tab on macOS, as the desktop app did | The macOS application's menu closes the focused terminal with it, like Ghostty and iTerm close a split; one set of macOS defaults for both applications. `ctrl+b shift+x` closes a tab. |
| Keyboard Lock API | Fullscreen-only and Chromium-only. |

## Failure modes

- **Config unreadable** → defaults are used.
- **Pane closed while focused** → focus falls back to the first pane of the
  tab on the next navigation.
- **Move refused** (for example the tab was closed meanwhile) → a toast with
  herdr's error; the order stays as herdr has it.

## Testing

`internal/keybindings/keybindings_test.go` (key syntax vectors, defaults,
rules, conflicts), `internal/server/server_test.go` (`TestLoadKeyConfig`),
`web/src/__tests__/core.test.ts` (pane geometry for directional focus),
`web/src/__tests__/settings.test.ts` (drop zones),
`web/src/__tests__/keys.test.ts` (key names, chords, key hints),
`web/src/__tests__/desktop.test.ts` (key names on other layouts, closing
idle tabs at once and asking for running programs, unknown answers and
timeouts, no shortcuts under dialogs), `desktop/src/shortcuts.test.ts`
(matching inputs on AZERTY, Dvorak and non-Latin layouts, recorded keys,
VS Code frames, defaults, menu accelerators, reading the keybindings),
`macos/Tests/TermKitTests` (`KeysTests`: chords, menu equivalents),
`web/src/__tests__/menus.test.ts` (insertion slots, also on wrapped rows,
the area a drop counts in, applying a move reply, menu items and their commands, moves from the
current position, read-only, keyboard, focus and closing of the menu);
`internal/server/server_test.go` (`TestAPIAllowlist`: moves are refused in
read-only mode). The `set_split_ratio` path semantics, the `pane.swap` /
`pane.move` behavior (including `same_tab` and the temporary tab closing
itself) and the `insert_index` slots of `tab.move` / `workspace.move` were
verified against a real herdr 0.9.5 session, and dragging, reordering and
the menus in Chrome.
