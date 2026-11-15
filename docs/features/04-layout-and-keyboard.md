# 04 · Layout and keyboard

## Context

Terminal multiplexer users know a layout model (workspaces → tabs → binary
split trees of panes). Their prefix keymaps (`ctrl+b` in tmux) belong to
the multiplexer running in a pane: this application is used with the
mouse, so its default keys leave that key to the terminal. The
terminal core keeps terminals, not layouts; every client of a machine arranges its
terminals in the machine's layout document ([22](22-terminal-protocol.md)),
so the browser, the desktop app and the macOS application show the same
arrangement. In a browser, `Cmd+W`, `Cmd+T` and similar shortcuts belong to
the browser and cannot be captured reliably; the desktop app and the macOS
application own their keys.

## Goals / non-goals

Goals: that topology, shared by every client of a machine; every command
within reach of the mouse (menus, context menus, buttons, the palette);
default keys that take nothing from the programs in the terminals; one
set of keybindings, changeable, for every client; nothing important
depends on browser-reserved shortcuts.

Non-goals: arbitrary docking of panes; floating panes.

## Design

**Layout** (`web/src/state/terms.ts`, `components/Workspace.tsx`,
`web/src/term/layout.ts`)

- Each machine has one layout document, `layout` in its terminal core,
  version 2 ([22](22-terminal-protocol.md) has the format and the
  operations): a list of workspaces and the selected one; a workspace has
  an id, a name, the directory its new terminals start in, its tabs and
  the selected tab; a tab has a binary split tree whose leaves are
  terminal addresses, its focused terminal and a name when the user gave
  one. `layout.ts` (TypeScript) and `macos/Sources/TermKit/Layout.swift`
  implement the same operations and run the same vectors
  (`design/testdata/layout`). Fields and node kinds a client does not know
  are kept, and a version 1 document (tabs without workspaces) reads as one
  workspace.
- The page follows the machines the user turned to (the machine shown at
  load: the one shown last in this browser, else the local machine; others
  when selected in the sidebar or the palette): it subscribes to their
  terminals, which installs and starts their terminal cores
  ([02](02-multi-machine-transport.md)), then reads their layout documents.
  A machine whose document has no workspace gets one, named in the user's
  language. Terminals that no longer run are dropped from it.
- The shown machine's selected workspace, its selected tab and the focused
  terminal are the document's: selecting a workspace or tab, or focusing a
  pane, writes it, and every client follows. Edits are written one at a time
  with the version last read; a newer version from another client is read
  again, and wins over an edit written against an older one.
- The selected tab's panes are laid out by their shares of the split tree
  (`horizontal`: side by side). Dragging a split's handle sets its ratio.
- A new tab starts in its workspace's directory, else in the focused
  terminal's; a split in the focused terminal's directory, else the
  workspace's (`terminal.run` on the machine's terminal core). A terminal
  asked for while the machine's terminals are still starting opens once
  they are ready.
- Closing a pane ends its terminal's program; its pane leaves the layout
  when the core reports the terminal gone. Closing a tab or a workspace
  removes it from the layout and ends its terminals. A program that ends by
  itself closes its pane the same way, and the finished terminal is removed
  from the terminal core.
- Zoom shows the focused pane alone in its tab; it is this browser's own
  view, not written to the document.
- Tabs and workspaces are shown in the document's order. Tabs that do not
  fit on one row continue on more rows and the tab bar grows, as with VS
  Code's wrapped tabs: every tab stays visible and the bar never scrolls.
  The sidebar toggle and the breadcrumb stay on the first row, `+` follows
  the last tab, and a label longer than 16em is cut with an ellipsis (the
  tooltip has it in full). A tab is called by its name, else by its focused
  terminal's pane name or title. The sidebar lists every workspace of a followed machine
  one below the other; a machine not followed yet offers to show its
  terminals.

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
- Dragging a pane by its header (after a few pixels, so a click stays a
  click) shows a highlight of where the pane goes. The middle of another
  pane swaps the two; an edge places the pane beside it, on that side.
  Dropping on a tab places it beside that tab's focused pane, on `+` into a
  new tab. Escape cancels. All of these are edits of the layout document.
- Dragging a tab along the tab bar, or a workspace along its machine's list
  in the sidebar, shows an insertion bar and reorders it. A drop lands in a
  slot of the current order (0 before the first item, n after the last);
  the two slots beside the dragged item change nothing and show no bar. On
  a tab bar with several rows the row under the pointer (or the nearest) is
  picked first, then the slot within it; the end of one row and the start of
  the next are the same slot, drawn on the row the pointer is on. A tab
  stays in its workspace and a workspace on its machine.
- Clicking a pane's title edits its name (the terminal's `name` label in the
  terminal core, which also names it in tabs, the sidebar and the palette;
  empty shows the terminal's title again). Double-clicking a
  tab or workspace, or its rename binding, edits its name in the layout
  document (an empty tab name shows its terminal's title again). Enter or
  leaving the field saves, Escape cancels.
- Read-only mode and zoomed panes have no drag, rename or mutating buttons.

**Pane headers** (`components/PaneHeader.tsx`, `PaneActions.tsx`)

- Every pane has a header above its terminal: the agent's state, the
  pane's name (else the terminal's title), the agent and the folder, then
  its buttons: program windows ([14](14-gui-windows.md)), VS Code, changes
  and Git Graph of the folder, split right / down, zoom or restore, and
  close. They act on that pane, whichever pane has the focus, and a press on
  one leaves the keyboard in the terminal. Pressing the header focuses the
  pane; the focused pane's header is marked when the tab has several.
  Read-only pages see titles, folders and program windows without the other
  buttons.
- Narrow headers keep one row: they drop the folder, the agent, the VS Code
  buttons, the split buttons, the title and zoom, in this order (the dropped
  commands stay in the pane's menu and key bindings); the close button
  stays. Headers do not clip, so the program windows' menu can hang below
  them.

**Context menus** (`web/src/contextMenu.ts`, `menus.tsx`,
`components/ContextMenu.tsx`)

- Right-clicking a pane header, a tab, a workspace or a machine in the
  sidebar opens an in-app menu at the pointer instead of the browser's:
  - pane header: rename, split right / down, zoom or restore, VS Code /
    changes / Git Graph of the pane's folder, close;
  - tab: rename, new tab, move left / right, close;
  - workspace: rename, new tab in it, move up / down, close;
  - machine: start, restart or stop its terminal core
    ([02](02-multi-machine-transport.md)), disable or enable it, rename or
    remove an SSH machine, add one.
- Items call the same commands as the buttons and bindings, and show the
  binding of the same command. Bindings act on the current tab or workspace,
  so a menu of another tab or workspace shows none for those items. Moving
  past either end is disabled. A move item uses the position the tab or
  workspace has when it runs, which another client may have changed since
  the menu opened.
- The menu takes the keyboard: ↑↓ (skipping disabled items), Home/End,
  Enter or Space runs, Escape or Tab closes; key bindings do not run
  while it is open. Running an item or closing from the keyboard gives focus
  back to what had it, before the item runs, so items that move focus
  (rename, split) keep it. A click elsewhere, scrolling, leaving the window
  or resizing closes it. The menu keeps its own width next to the window's
  right edge.
- Read-only mode offers no items, so the browser's menu shows. A pane's
  text has its own menu (copy, paste, find, open or copy a path or URL,
  download it or files of the pane's directory;
  [26](26-web-terminals.md), [06](06-quick-look-and-files.md)), which keeps
  copying and opening in read-only mode.

**Dialogs** (`web/src/dialog.ts`, `Dialogs.tsx`)

- Creating a workspace asks for its directory (the focused terminal's to
  begin with, else the machine's home), with completion of folders on the
  machine (Tab, ↑↓; the folder must exist) and an optional name (else the
  folder's). The workspace is added at the end of the layout document,
  selected, and opens a tab with a terminal in that directory. In the
  desktop app, folders dragged from
  Finder onto the sidebar create a workspace each on the local machine,
  without the dialog (named after the folder; the last one is selected); the sidebar shows where they go while they are over it, and
  dropped files that are not folders are skipped with a note. Folders
  dropped on the app's Dock icon or opened with it do the same, also
  skipping other items with that note, as in the macOS application; when the drop launched the app,
  they wait up to 30 s for the local machine to connect, else a note says
  they were not opened. Browsers do
  not tell the page where a dropped folder is, so they do not offer this, nor
  does read-only mode (`web/src/drop.ts`,
  [16](16-desktop-packaging.md)). Closing a pane or a tab where a program
  runs (below) and a workspace ask for confirmation;
  Enter cancels these unless
  the user moves to the confirm button. The browser's `prompt()` and
  `confirm()` are not used.

**Keyboard** (`internal/keybindings`, `web/src/keymap.ts`; the system is
described in [13](13-settings-and-appearance.md))

- Commands (`tab.new`, `pane.splitRight`, `view.toggleCode`…) have default
  keys per platform (`mac`: the macOS application and the desktop app on
  macOS; `mac-browser`; `pc`: the desktop app elsewhere; `pc-browser`) and
  a context (`when`: `terminal`, `vscode`, `dialog` or `always`); the
  user's rules in `keybindings[-<instance>].json` on the core host add and
  remove keys, and the settings' **Keyboard shortcuts** page edits them.
  Every client matches keys against the bindings the core works out for its
  platform, and follows the core's `keybindings` messages after every
  change. The full table is in
  [reference](../reference.md#keyboard-shortcuts).
- No default is a chord, and no default is `ctrl` or `alt` with a letter
  alone or a function key: `ctrl+b` and every key that is not a default
  reach the program in the terminal on their first press. The defaults
  are the direct shortcuts below and, on every platform, the list of
  shortcuts (`cmd+/` on macOS, `ctrl+shift+/` elsewhere) and the command
  palette (`cmd+shift+p` and `ctrl+shift+p` in the applications, `cmd+k`
  in browsers on macOS; browsers elsewhere leave no key for it, and the
  status bar's **Command palette** button opens it everywhere). Commands
  without a key (tab numbers, focus moves, renames, zoom, workspace
  switching, the most urgent agent, VS Code's folder, diff and Git
  Graph…) are in the menus, the context menus, the pane headers and the
  palette, and keys or chords can be bound to any of them.
- A user's chord lasts 3 s or until its next key; its first stroke
  pressed again is not taken (the terminal's key encoder sends it, so
  `ctrl+k ctrl+k` types `ctrl+k` with `ctrl+k` chords bound); a key that
  ends no chord is dropped.
- The command palette (`components/Palette.tsx`) lists the commands with
  their keys, the workspaces and agents of the machines followed, the agent
  kinds to start, the UI languages and themes, and enabling program windows
  ([14](14-gui-windows.md)). `workspace.switch` opens it with workspaces
  and agents only, `app.keyboardShortcuts` with the commands only.
- The PWA manifest allows installing the app in its own window, where fewer
  shortcuts are taken by browser chrome.

**Direct shortcuts** (`desktop/src/menu.ts`, `web/src/desktop.ts`,
`macos/Sources/App/main.swift`)

- The desktop applications own their keys, so their platforms have direct
  shortcuts. On macOS (both applications) they are the
  macOS application's menu keys: `cmd+t` new tab, `cmd+d` / `cmd+shift+d`
  split right / down, `cmd+w` close the focused pane (its terminal, not
  the tab), `cmd+n` new workspace (asking for
  its folder), `cmd+,` settings, `cmd+b` sidebar, `cmd+j` show or hide the
  VS Code panel ([05](05-vscode-panel.md)), `cmd+}` / `cmd+{` next / previous
  tab, `cmd+f` / `cmd+g` / `cmd+shift+g` find, `cmd+shift+p` the command
  palette (as in VS Code and Ghostty), `cmd+/` the list of shortcuts. On
  other systems the desktop
  app has `ctrl+shift+t` new tab, `ctrl+shift+w` close tab (as in terminal
  emulators, since `ctrl+w` deletes a word in shells), `ctrl+,` settings,
  `ctrl+shift+n` new workspace, `ctrl+shift+j` VS Code, `ctrl+shift+p` the
  palette and `ctrl+shift+/` the shortcuts. Browsers get
  none of these (they keep them), except find (`cmd+f` on macOS,
  `ctrl+shift+f` elsewhere: `ctrl+f` belongs to the programs in panes),
  the list of shortcuts and, on macOS, the palette as `cmd+k` (Firefox
  opens a private window on `cmd+shift+p` and `ctrl+shift+p` and gives
  pages neither).
- A key is named after the character the keyboard layout gives it, as macOS
  names its shortcuts (`web/src/keys.ts`, shared by the shell and the page;
  `Keys.stroke` in the macOS application): on AZERTY, `cmd+z` stays undo
  although its physical key is QWERTY's W. Keys without an ASCII character
  (non-Latin layouts, Option characters, dead keys) and keys that type
  nothing fall back to the physical key, so `cmd+w` on a Russian layout is
  still `cmd+w`; Shift does not change the name (`cmd+shift+1`, not
  `cmd+!`).
- In the desktop app the page matches every key it sees itself
  (`web/src/keymap.ts`), direct shortcuts and users' chords alike, with the
  desktop platform's bindings, and cancels the keys it runs. Held keys do
  not repeat a command. The application menu shows on each command item the
  first single-stroke key the keybindings give that command. Keys with Cmd
  are the menu's accelerators, but Chromium on macOS gives a Cmd key to the
  page first, so the menu acts only on keys the page left: a text field
  has the keyboard (the page's window handler skips them), VS Code does, a
  dialog is open, or another window has it. A key thus runs its command
  once. Keys without Cmd are shown but not registered (macOS would offer
  them to a menu before the page), and the page runs them.
- A menu command the page receives (`runMenuCommand`) runs as in the macOS
  application's menu: while VS Code has the keyboard (its frame is the
  page's focused element) only commands for `vscode` or `always`, while a
  dialog or the palette is open only those for `dialog` or `always`.
  VS Code takes its own keys before the menu in both applications, so
  `cmd+w` closes its editor, `cmd+t` opens its symbol search, `cmd+,` its
  settings, `cmd+n` a new file and `cmd+j` its bottom panel; a key it
  leaves runs the menu's command where that applies.
- With a program window or one of VS Code's own windows in front, the
  menu's commands that close a pane or a tab (`pane.close`, `tab.close`)
  close that window; the others bring the main window forward and run
  there.
- The desktop app's shell starts its menu with its platform's defaults
  (`design/generated/registry.json`) and follows the core's keybindings over
  its own event channel ([16](16-desktop-packaging.md)); the page follows
  them on its own.
- The page runs only `dialog` and `always` bindings while a dialog or the
  palette is open. Closing a pane or a tab (the shortcut, the tab bar, a
  binding, menus) first looks at what runs in its terminals, from
  the terminal core's records: a terminal counts as idle when its
  foreground process is its shell and that shell is a known one (zsh,
  bash, fish, sh…), that is, the shell waits at its prompt, or when its
  program has ended. When every terminal is idle the pane or tab closes at
  once. Otherwise a confirmation names the programs that end (an agent by
  its name, also while it waits for input; Cancel has focus). Jobs sent to
  the background with `&` are not seen; they end with the tab.
- Both applications have the same menu, with the same commands in the same
  places under the same titles (the macOS application's `makeMenu`; the
  desktop app's titles are the web UI's `desktop.menu.*` strings): Shell
  (new terminal, splits, workspaces, rename tab, close terminal or tab),
  Edit (copy, paste, find; the desktop app adds undo, redo and cut, which
  Chromium's text fields need), View (palette, switch workspace, sidebar,
  VS Code, zoom, next and previous tab, workspace and pane, focus on a
  side) and Window ([16](16-desktop-packaging.md),
  [23](23-macos-application.md)). Items show the first single-stroke key
  of their command, none when it has none, and are rebuilt when the
  keybindings change.
- In the macOS application Ghostty unbinds the menu's keys, so the menu gets
  them before a terminal; a key matcher in front of the window runs chords
  and keys without a menu item, and passes every other key on.
- Key hints (tooltips, context menus, the palette, the status bar) show
  the direct shortcut in the desktop app, else the first key, and nothing
  for a command without one.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Each client keeping its own arrangement | The browser, the desktop app and the macOS application would show the same terminals differently; the document is one arrangement for every client of the machine. |
| The selection kept per browser | Two windows on one machine would disagree about what is shown and focused. Zoom stays per browser, since it is a way of looking. |
| A toolbar above a lone pane instead of pane headers | With the page's own layout every pane has room for a header of its own. |
| A tab bar that scrolls sideways (with auto-scroll while dragging) | Tabs out of view are hidden with no sign that they exist. |
| Tabs that shrink to fit, as in Chrome | Labels become unreadable with many tabs. |
| A "more tabs" menu for the tabs that do not fit | Hides tabs again and costs a click. |
| Bindings to move tabs and workspaces | Rarely needed; the context menu's move items work from the keyboard. |
| A "⋯" button on every header, tab and workspace row | Takes room on every tab and row; right-click covers desktop browsers. |
| A desktop shell as the only client, owning all shortcuts | Browser access lets the IDE work from other devices, with the mouse and the keys browsers leave to pages, and the applications add direct shortcuts on top; Tauri's WKWebView on macOS lacks service workers, which VS Code webviews need. |
| The prefix chords as defaults (`ctrl+b`, then a key), as earlier versions had | They took `ctrl+b` from tmux and other programs in the terminals, and every press of it waited for a second key; the application is used with the mouse, and chords stay available to users who bind them. |
| Browser-specific bindings (`Cmd+…`) | Conflict with the browser; browsers do not deliver `Cmd+T`/`Cmd+W` to pages. The desktop app has them (above). |
| The desktop shell taking direct shortcuts before the page (`before-input-event`), as it did | Two key matchers (the shell's and the page's) with their own rules for VS Code, dialogs and recording keys; with the page matching every key and the menu getting the rest, the desktop app behaves as the macOS application, where VS Code also keeps its own keys. |
| Desktop shortcuts per browser profile (localStorage) | The shell needs them before and outside the page; the core's keybindings keep one set for all windows. |
| `cmd+w` closing the tab on macOS, as the desktop app did | The macOS application's menu closes the focused terminal with it, like Ghostty and iTerm close a split; one set of macOS defaults for both applications. **Close Tab** in the Shell menu and the tab's × close a tab. |
| Keyboard Lock API | Fullscreen-only and Chromium-only. |

## Failure modes

- **The keybindings file has errors** → a file that is not a JSON array
  keeps the rules read before it (none at start: the defaults) and is
  reported as `parse`; entries that do not parse or name an unknown command
  are skipped and reported (`invalid`, `unknown`). The **Keyboard
  shortcuts** page shows the problems and conflicts
  ([13](13-settings-and-appearance.md)).
- **A pane closed while focused** → the focus moves to its sibling.
- **Two clients edit the layout at once** → the second write is refused
  (version conflict); its client reads the newer layout, which wins.
- **The terminal core is not ready** (installing, starting, failed) → the
  workspace area and the sidebar say so; a machine's menu starts it again.

## Testing

- `internal/keybindings/keybindings_test.go`: key syntax vectors
  (`TestParseVectors`), defaults per platform (`TestDefaults`), the user's
  rules and problems (`TestUserRules`), conflicts (`TestConflicts`), edits
  of the file (`TestReload`), the desktop app's old shortcut settings
  (`TestMigrateDesktopShortcuts`).
- `web/src/__tests__/term.test.ts`: the layout vectors of
  `design/testdata/layout` (workspaces, tabs, splits, closing, swaps and
  moves, directional focus and pane drops, version 1 documents, unknown
  fields, malformed documents), also run by the macOS application's
  `LayoutTests`.
- `web/src/__tests__/terms.test.ts`: reading the document after the
  terminals, with a workspace named in the language and without ended
  terminals; one write at a time and another client's newer version; ended
  programs closing their panes; terminals asked for early.
- `web/src/__tests__/core.test.ts` (pane geometry of split trees),
  `web/src/__tests__/settings.test.ts` (drop zones).
- `web/src/__tests__/keys.test.ts`: key names, chords from the page's keys,
  every platform's defaults (`design/testdata/keys/defaults.json`: `ctrl+b`
  and other keys without a binding left to the terminal), the second press
  of a chord's first stroke left to the terminal, key changes as the
  user's rules, key hints (none for unbound commands);
  `web/src/__tests__/vt.test.ts`: the bytes `ctrl+b` sends.
- `web/src/__tests__/desktop.test.ts`: key names on other layouts, the
  menu's commands: closing idle tabs and panes at once and asking for
  running programs, none under dialogs, only those for VS Code or
  everywhere while VS Code has the keyboard, showing and hiding VS Code.
- `desktop/src/menu.test.ts` (the menu's structure and titles against the
  macOS application's, accelerators, a rebinding, an unbinding, chords
  and unbound commands without accelerators, keys without Cmd shown only),
  `desktop/src/follow.test.ts` (reading the keybindings and settings, their
  pushes, reconnecting), `macos/Tests/TermKitTests` (`KeysTests`: chords,
  every platform's defaults, menu equivalents, closing commands).
- `web/src/__tests__/menus.test.ts`: insertion slots, also on wrapped rows,
  the area a drop counts in, drags measured on the screen, menu items and
  their commands, moves from the current position, read-only, keyboard,
  focus and closing of the menu, the machine's terminal core.
- `web/src/__tests__/paneHeader.test.ts`: a header's buttons act on its own
  pane and keep the terminal's focus, rename, menu, read-only.

Splits, new tabs and workspaces, closing and dragging the split handle were
checked in headless Chromium against a dev core.
