# 04 · Layout and keyboard

## Context

herdr users already know its layout model (workspaces → tabs → binary split
trees of panes) and its prefix keymap (`ctrl+b` by default). The terminal
core keeps terminals, not layouts; every client of a machine arranges its
terminals in the machine's layout document ([22](22-terminal-protocol.md)),
so the browser, the desktop app and the macOS application show the same
arrangement. In a browser, `Cmd+W`, `Cmd+T` and similar shortcuts belong to
the browser and cannot be captured reliably; the desktop app and the macOS
application own their keys.

## Goals / non-goals

Goals: herdr's topology, shared by every client of a machine; herdr's
default keys work unchanged in every client; one set of keybindings,
changeable, for every client; nothing important depends on
browser-reserved shortcuts.

Non-goals: arbitrary docking of panes; floating panes.

## Design

**Layout** (`web/src/state/terms.ts`, `components/Workspace.tsx`,
`web/src/term/layout.ts`)

- The page follows the machines the user turned to (the machine shown at
  load: the one shown last, else the local machine; others when selected in
  the sidebar or the palette): it subscribes to their terminals, which
  installs and starts their terminal cores ([22](22-terminal-protocol.md)),
  then reads their layout documents. A machine whose document has no
  workspace gets one, named in the user's language. Terminals that no
  longer run are dropped from it.
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
  click) shows a highlight of where the pane will go. The middle of another
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
  Enter or Space runs, Escape or Tab closes; prefix bindings do not run
  while it is open. Running an item or closing from the keyboard gives focus
  back to what had it, before the item runs, so items that move focus
  (rename, split) keep it. A click elsewhere, scrolling, leaving the window
  or resizing closes it. The menu keeps its own width next to the window's
  right edge.
- Read-only mode offers no items, so the browser's menu shows. A pane's
  text has its own menu (copy, paste, open a path or URL;
  [26](26-web-terminals.md)), which keeps copying and opening in
  read-only mode.

**Dialogs** (`web/src/dialog.ts`, `Dialogs.tsx`)

- Creating a workspace asks for its directory, with completion of folders on
  the machine (Tab, ↑↓; the folder must exist) and an optional name
  (`workspace.create` `label`). In the desktop app, folders dragged from
  Finder onto the sidebar create a workspace each on the local machine,
  without the dialog (named after the folder; the last one is selected); the sidebar shows where they go while they are over it, and
  dropped files that are not folders are skipped with a note. Folders
  dropped on the app's Dock icon do the same; when the drop launched the app,
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
- The command palette lists commands with their keys, workspaces and agents
  on the machines followed, agent kinds to start, UI languages and themes.
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
  palette is open. Closing a pane or a tab (the shortcut, the tab bar, the
  prefix binding, menus) first looks at what runs in its terminals, from
  the terminal core's records: a terminal counts as idle when its
  foreground process is its shell and that shell is a known one (zsh,
  bash, fish, sh…), that is, the shell waits at its prompt, or when its
  program has ended. When every terminal is idle the pane or tab closes at
  once. Otherwise a confirmation names the programs that end (an agent by
  its name, also while it waits for input; Cancel has focus). Jobs sent to
  the background with `&` are not seen; they end with the tab.
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
| Each client keeping its own arrangement | The browser, the desktop app and the macOS application would show the same terminals differently; the document is one arrangement for every client of the machine. |
| The selection kept per browser | Two windows on one machine would disagree about what is shown and focused; herdr shares them too. Zoom stays per browser, since it is a way of looking. |
| Pane headers over herdr's border rows, a toolbar above a lone pane (the previous design) | The grid was herdr's; with the page's own layout every pane has room for a header of its own. |
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
- **A pane closed while focused** → the focus moves to its sibling.
- **Two clients edit the layout at once** → the second write is refused
  (version conflict); its client reads the newer layout, which wins.
- **The terminal core is not ready** (installing, starting, failed) → the
  workspace area and the sidebar say so; a machine's menu starts it again.

## Testing

`internal/keybindings/keybindings_test.go` (key syntax vectors, defaults,
rules, conflicts), `web/src/__tests__/core.test.ts` (pane geometry for
directional focus), `web/src/__tests__/term.test.ts` (the layout vectors of
`design/testdata/layout`, shared with the macOS application),
`web/src/__tests__/terms.test.ts` (reading and writing the document, other
clients' versions, ended programs, terminals asked for early),
`web/src/__tests__/settings.test.ts` (drop zones),
`web/src/__tests__/keys.test.ts` (key names, chords, key hints),
`web/src/__tests__/desktop.test.ts` (key names on other layouts, closing
idle tabs and panes at once and asking for running programs, no shortcuts
under dialogs), `desktop/src/shortcuts.test.ts` (matching inputs on AZERTY,
Dvorak and non-Latin layouts, recorded keys, VS Code frames, defaults, menu
accelerators, reading the keybindings), `macos/Tests/TermKitTests`
(`KeysTests`: chords, menu equivalents), `web/src/__tests__/menus.test.ts`
(insertion slots, also on wrapped rows, the area a drop counts in, menu
items and their commands, moves from the current position, read-only,
keyboard, focus and closing of the menu, the machine's terminal core),
`web/src/__tests__/paneHeader.test.ts` (a header's buttons act on its own
pane and keep the terminal's focus, rename, menu, read-only). Splits, new
tabs and workspaces, closing and dragging the split handle were checked in
headless Chromium against a dev core.
