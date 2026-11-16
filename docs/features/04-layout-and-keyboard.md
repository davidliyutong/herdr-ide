# 04 · Layout and keyboard

## Context

Terminal multiplexer users know a layout model (workspaces → tabs → binary
split trees of panes). Their prefix keymaps (`ctrl+b` in tmux) belong to
the multiplexer running in a pane: this application is used with the
mouse, so its default keys leave that key to the terminal. The
terminal core keeps terminals, not layouts; every client of a machine arranges its
terminals, VS Code views and previews in the machine's layout document
([22](22-terminal-protocol.md)),
so browsers and the desktop app show the same arrangement. In a browser,
`Cmd+W`, `Cmd+T` and similar shortcuts belong to the browser and cannot be
captured reliably; the desktop app owns its keys.

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
  the selected tab; a tab has a binary split tree whose leaves are panes
  (terminals by their addresses, VS Code views of a folder
  ([05](05-vscode-panes.md)) and previews of a file or directory
  ([06](06-quick-look-and-files.md))), its focused pane and a name when
  the user gave one. `layout.ts` implements the operations and runs the vectors of
  `design/testdata/layout`. Fields and node kinds a client does not know
  are kept, and a version 1 document (tabs without workspaces) reads as one
  workspace.
- The page follows the machines the user turned to (the machine shown at
  load: the one shown last in this browser, else the local machine; others
  when selected in the sidebar or the palette): it subscribes to their
  terminals, which installs and starts their terminal cores
  ([02](02-multi-machine-transport.md)), then reads their layout documents.
  A machine whose document has no workspace gets one without a name or a
  directory (shown as `~` until its first pane gives it one). Terminals that no longer run are dropped from
  it.
- The shown machine's selected workspace, its selected tab and the focused
  pane are the document's: selecting a workspace or tab, or focusing a
  pane, writes it, and every client follows. Edits are written one at a time
  with the version last read; a newer version from another client is read
  again, and wins over an edit written against an older one.
- The selected tab's panes are laid out by their shares of the split tree
  (`horizontal`: side by side). Dragging a split's handle sets its ratio;
  double-clicking it shares the split equally again. The handle is 9 pixels
  wide around a 1-pixel line and shows a 3-pixel accent line while it is
  pointed at or dragged.
- The sidebar is as wide as its right edge is dragged (180 to 520 pixels,
  kept per browser); dragging the edge far left hides it, double-clicking
  the edge gives it its default width (260 pixels) back, and
  `view.toggleSidebar` (the tab bar's first button) shows and hides it. In
  a window 760 pixels wide or less the open sidebar lies over the panes
  with a dimmed backdrop; a press on the backdrop closes it. The uploads
  and downloads panels of the status bar have a ×.
- A new tab starts in its workspace's directory, else (none, or the home
  directory, which a machine's first workspace takes from its first
  terminal) in the focused terminal's, so it follows `cd` there; a split
  in the directory of the pane split (a terminal's, a
  VS Code pane's folder, a preview's file's directory), else the
  workspace's (`terminal.run` on the machine's terminal core). A terminal
  asked for while the machine's terminals are still starting opens once
  they are ready.
- Closing a terminal's pane ends its program; the pane leaves the layout
  when the core reports the terminal gone. Closing a VS Code or preview
  pane ends nothing: it leaves the layout at once. Closing a tab or a
  workspace removes it from the layout and ends its terminals only. Every tab has a ×
  (shown on the active tab and on the tab under the pointer), the only one
  too, and a middle click closes a tab, as in browsers. Closing the last
  tab leaves its workspace in the sidebar, empty: the panes' area says it
  has no open terminals and offers **New Tab**; the workspace goes only
  with **Close Workspace…**. A program that ends by
  itself closes its pane the same way, and the finished terminal is removed
  from the terminal core.
- Zoom shows the focused pane alone in its tab; it is this browser's own
  view, not written to the document.
- Tabs and workspaces are shown in the document's order. Tabs that do not
  fit on one row continue on more rows and the tab bar grows, as with VS
  Code's wrapped tabs: every tab stays visible and the bar never scrolls.
  The sidebar toggle and the breadcrumb stay on the first row, `+` follows
  the last tab, and a label longer than 16em is cut with an ellipsis (the
  tooltip has it in full). The active tab has its own background, an
  outline and an accent bar under it. A tab the user has not named shows
  its position (1, 2, 3…, a short number: several tabs of shells would
  otherwise all read `user@host:~`), a named tab its name, and a tab
  holding no terminal (VS Code alone, a preview alone) the pane's mark
  (VSCodium's logo, an eye) and its name (the folder's, the file's); all
  keep their agents' status dot and their ×, a tab of several panes shows a small
  split mark, and the tooltip has the focused pane's name or title (a
  terminal's program and directory, `VS Code · <folder>`,
  `Preview · <file>`) and the number of panes. Outside the tab bar a tab
  is named with its workspace, never by a bare number: the Agents section,
  the palette's agents, notifications and toasts say where an agent is as
  `website · 2` (or the tab's name); the pane headers keep the pane's
  title, the status bar names the focused pane (a terminal's title and
  directory, VS Code and its folder, Preview and its file), and a dragged
  tab's ghost shows the tab's name or its focused pane's title. The window title stays the app's name, with the
  count of blocked agents. A workspace is called by its
  name, else it names itself after a folder: while it has one pane, that
  pane's (a terminal's current directory, which follows `cd`, or a VS Code
  pane's folder), else its own directory, the one it was created with or
  edited to or, for a workspace created without one, the directory its
  first terminal started in (`layout.adoptDirectory`), else, for one whose
  directory was emptied, its focused pane's. The folder is shown as the last
  component of its directory, `~` for
  the home directory or none, `/` for the root (`layout.workspaceTitle`;
  `Workspace` and `工作区`, which earlier versions named the workspaces they
  made, count as none), in the sidebar, the tab bar's breadcrumb (machine /
  workspace), the palette, menus and messages. The sidebar lists every
  workspace of a followed machine one below the other (the selected one
  with an accent bar); a machine not followed yet offers to show its
  terminals. The browser remembers the machines it followed (the desktop
  app's window too) and follows them again when the page opens, each once
  it is connected, so a reopened app shows their workspaces again; a
  machine removed is forgotten (`web/src/state/followed.ts`). A workspace's row stays quiet: its number, its name and,
  while one of its agents has a state, the most urgent one's dot; its
  directory and number of tabs are in its tooltip.
- Creating things: each button does one thing, named by its tooltip with
  its key. `+` at the end of the tab bar is **New Tab** in the workspace
  shown; the sidebar's head has **New Workspace…** (a folder with a plus,
  on the machine shown) and **Add Machine…** (a server with a plus), and
  each machine's list ends with **New Workspace…** on that machine. Rows
  of machines and workspaces show a `⋯` button while pointed at, which
  opens their menu; connecting actions (sign in, retry, enable) are text
  buttons in the machine's status, never in place of an icon.

**Rearranging and renaming** (`web/src/drag.ts`, `paneDrag.ts`,
`tabDrag.ts`, `reorderDrag.ts`, `InlineEdit.tsx`)

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
  new tab, on another workspace of its machine in the sidebar into a new
  tab at the end of that workspace, which is then shown. Escape cancels. All of these are edits of the layout document.
  VS Code and preview panes move the same way; a VS Code pane keeps its
  window wherever it goes ([05](05-vscode-panes.md)).
- A pane's **Move to Workspace** submenu lists the machine's other
  workspaces and **New Workspace…**: the pane goes into a new tab at the
  end of the one chosen, which is shown with the pane focused. A new
  workspace is asked for as when creating one, with the pane's directory
  to begin with, and holds just the moved pane (`actions.movePaneToWorkspace`,
  `layout.moveToNewTab`). A workspace the last pane leaves stays, without
  tabs, until it is closed; `pane.close` (`cmd+w`) closes it then, without
  asking, as there is nothing in it to lose. Only a press of its own does:
  a held key that closed the last pane repeats without closing the
  workspace (a run within 600 ms of the one before counts as held, since
  the desktop app's menu repeats without saying so). Panes move only between workspaces of one
  machine: a terminal runs in its machine's terminal core.
- **Go Back** and **Go Forward** (`pane.back`, `pane.forward`) move through
  the panes focused, as a browser through the pages it showed
  (`paneHistory.ts`): every change of the focused pane of the shown
  machine is a step (a click, a tab, a workspace or a machine shown), going
  back and forward moves along the steps, and a pane focused otherwise
  after going back drops what lay ahead. Going to a pane shows its machine,
  workspace and tab; panes closed since are passed over. The history keeps
  the last 100 steps, in the page only.
- **Close Pane** and **Close Tab** close at once, without asking, also
  when a program runs: they can be undone for 5 s (`closedPanes.ts`).
  Only a pane with changes not saved (an editor, a diff's working tree)
  asks first, as does closing its workspace: **Save**, **Don't Save** or
  **Cancel**; a save that fails keeps it (`web/src/unsaved.ts`, which
  panes join with `useUnsaved`). Leaving or reloading the page with such
  changes gets the browser's question; in the desktop app the main
  window asks natively before it closes or the app quits, and the core
  stops only once it has closed. A
  toast says what closed, with **Undo**; **Undo Close** (`pane.undoClose`)
  puts back what closed last, as it was: the same terminals, their programs
  still running, in their place (`layout.reopen`). In the tab that kept the
  closed pane's neighbors, unchanged since, the tab is as it was, with its
  splits' shares; a tab that changed meanwhile gets the pane split in
  beside its neighbor of then; a closed tab comes back at its place in its
  workspace (the selected one when that is gone). A terminal whose program
  ended meanwhile, or a VS Code or preview opened again elsewhere, stays
  closed. The closed terminals end when the 5 s are over: each gets the
  label `closing` with that time (`TermModel.closeLater`), and every page
  showing the machine ends a terminal so labeled without a pane once the
  time is over, so it ends also when the page that closed it is gone
  (reloaded, quit); Undo Close empties the label. In the desktop app on
  macOS its key is `cmd+z`: the page takes it in a terminal, while text
  fields and VS Code keep it for Undo (the Shell menu's item shows the key
  without taking it). Closing a workspace still asks, and ends its
  terminals at once.
- Dragging a tab off the tab bar onto a pane of the tab shown merges the
  tabs, as Edge's split screen does: the dragged tab's panes, with their
  own splits, become a split of that pane on the side the pointer is
  nearest (its half is highlighted; there is no middle), the dragged tab
  goes and the merged one is shown with the dragged tab's focused pane
  focused. Every kind of pane merges alike: terminals, VS Code (its window
  follows), previews and plugin views. Since a press shows the pressed tab
  (as in browsers), the tab shown before it comes back once the drag
  begins (or, when that was the dragged tab, the next tab, else the one
  before), so it can be dropped beside that one; resting the pointer on
  another tab of the bar for half a second shows that tab instead. A drag
  that reorders, ends elsewhere or is cancelled leaves the dragged tab
  shown. Splitting a pane back out into a tab is a pane drag onto `+`.
- Dragging a tab along the tab bar, or a workspace along its machine's list
  in the sidebar, shows an insertion bar and reorders it. A drop lands in a
  slot of the current order (0 before the first item, n after the last);
  the two slots beside the dragged item change nothing and show no bar. On
  a tab bar with several rows the row under the pointer (or the nearest) is
  picked first, then the slot within it; the end of one row and the start of
  the next are the same slot, drawn on the row the pointer is on. A tab
  stays in its workspace and a workspace on its machine.
- Everything with a name is renamed in place the same way: double-clicking
  a tab, a workspace, a pane's title or a machine's name (or the
  item's **Rename** in its menu, or a rename binding; a workspace's menu
  edits it in a dialog, below) puts a field in its
  place with the name selected; Enter or leaving the field saves, Escape
  cancels. A pane's name is the terminal's `name` label in the terminal
  core, which also names it in tabs, the sidebar and the palette (empty
  shows the terminal's title again); tab and workspace names are in the
  layout document (a tab's field starts with its name or its terminal's
  title and saves only a change: an emptied tab name shows its number
  again, an emptied workspace name its folder's; the fields show no
  placeholder); a machine's name is the core's ([02](02-multi-machine-transport.md)). A
  single click on a pane's title only focuses the pane; the first click
  of a double click on a machine folds or unfolds it and the second puts
  it back.
- Read-only mode and zoomed panes have no drag, rename or mutating buttons.

**Pane headers** (`components/PaneHeader.tsx`, `PaneActions.tsx`)

- Every pane has a header above its body. A terminal's shows the agent's
  state, the pane's name (else the terminal's title), the agent and the
  folder; a VS Code pane's shows VSCodium's mark, the folder's name (its
  tooltip `VS Code on <machine>: <folder>`) and its short path; a
  preview's shows an eye, the file's name and its directory. Then its buttons: a terminal's
  program windows ([14](14-gui-windows.md)), **Open in VS Code** (with
  VSCodium's logo), changes and Git Graph of the folder; a VS Code pane's
  **Reload VS Code**; then split right / down, zoom or restore, **More
  Pane Actions** (⋯, only while the header is narrow, below) and close
  (1.85rem targets, the tab bar's icon size, with 1.15rem icons in a
  2.3rem header; tooltips name the command and its key).
  They act on that pane, whichever pane has the focus, and a press on one
  leaves the keyboard in the terminal. Pressing the header focuses the
  pane; the focused pane's header is marked when the tab has several, and
  only the focused pane and the pane under the pointer show their buttons
  (a program window asking for attention stays visible).
  Read-only pages see titles, folders and program windows without the other
  buttons.
- Narrow headers keep one row. They drop, in this order: the folder; then
  the agent and the VS Code buttons (Open in VS Code, changes, Git Graph,
  Reload VS Code), and the ⋯ button appears, which opens the pane's menu
  with all its commands; then the split buttons; then zoom; then the
  title. The dropped commands stay in the pane's menu and key bindings;
  the close button always stays. Headers do not clip, so the program
  windows' menu can hang below them.

**Context menus** (`web/src/contextMenu.ts`, `menus.tsx`,
`components/ContextMenu.tsx`)

- Right-clicking a pane header, a tab, a workspace, a machine or the
  sidebar's free space opens an in-app menu at the pointer instead of the
  browser's. Every menu is in the same order: rename, what it creates, how
  it is arranged, then what ends something (with a red icon) last; items of
  commands have the commands' names:
  - a terminal's pane header (a header's ⋯ button opens the same menu):
    Rename Pane, Split Right / Down, Maximize or Restore Pane, Move to
    Workspace ▸ (below), Open in VS Code, Show Changes in VS Code, Open Git Graph, Close Pane;
  - a VS Code pane's header: Reload VS Code, Split Right / Down, Maximize
    or Restore Pane, Move to Workspace ▸, Stop VS Code on `<machine>`
    ([05](05-vscode-panes.md)), Close Pane;
  - a preview's header: Open in VS Code, Download (where downloads are
    offered, [06](06-quick-look-and-files.md)), Split Right / Down,
    Maximize or Restore Pane, Move to Workspace ▸, Close Pane;
  - tab: Rename Tab, New Tab, Move Left / Right, Close Tab;
  - workspace: Edit Workspace…, New Tab, Move Up / Down, Close Workspace…;
  - machine: New Workspace…, Machine Settings… (the settings in the
    machine's scope, [13](13-settings-and-appearance.md)), Rename Machine,
    Copy SSH Host (SSH machines), Move Up / Down
    ([02](02-multi-machine-transport.md)), Sign In… or Retry while it needs one,
    Enable or Disable Machine…, **Troubleshooting** ▸ Restart, Start or Stop
    the terminal service (its terminal core,
    [02](02-multi-machine-transport.md)), Remove Machine… (SSH machines);
  - free space: New Workspace…, Add Machine….
- An item with a submenu opens it beside itself when pointed at, or with →,
  Enter or a click; ← and Escape close it.
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
  machine (Tab, ↑↓; the folder must exist) and an optional name (else it
  is shown with the folder's, and stays without a name of its own). The workspace is added at the end of the layout document,
  selected, and opens a tab with a terminal in that directory. In the
  desktop app on macOS and Linux, folders dragged from
  the file manager onto the sidebar create a workspace each on the local machine,
  without the dialog (shown with the folder's name; the last one is selected); the sidebar shows where they go while they are over it, and
  dropped files that are not folders are skipped with a note. Folders
  opened with the app (dropped on its Dock icon on macOS, **Open With** in
  a Linux file manager) do the same, also
  skipping other items with that note; when they launched the app,
  they wait up to 30 s for the local machine to connect, else a note says
  they were not opened. Browsers do
  not tell the page where a dropped folder is, so they do not offer this, nor
  does read-only mode, nor the app on Windows, whose local machine has no
  agent (`local_unsupported`; `web/src/drop.ts`,
  [16](16-desktop-packaging.md)). Closing a pane or a tab where a program
  runs (below) and a workspace ask for confirmation;
  Enter cancels these unless
  the user moves to the confirm button. The browser's `prompt()` and
  `confirm()` are not used.
- **Edit Workspace…** (the workspace's menu, `workspace.edit`; a rule
  naming `workspace.rename`, the command of earlier versions, applies to
  it) asks for its name and directory in the same dialog. The directory
  may be left empty: the workspace then keeps none, and its new tabs start
  in the focused pane's directory, as splits do (`layout.editWorkspace`;
  a pane added later does not give it one back). Double-clicking the
  workspace still renames it in place.

**Keyboard** (`internal/keybindings`, `web/src/keymap.ts`; the system is
described in [13](13-settings-and-appearance.md))

- Commands (`tab.new`, `pane.splitRight`, `code.open`…) have default
  keys per platform (`mac`: the desktop app on macOS; `mac-browser`; `pc`: the desktop app elsewhere; `pc-browser`) and
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
  are the direct shortcuts below and, on every platform, the keyboard
  shortcuts (`cmd+/` on macOS, `ctrl+shift+/` elsewhere) and the command
  palette (`cmd+shift+p` and `ctrl+shift+p` in the desktop app, `cmd+k`
  in browsers on macOS; browsers elsewhere leave no key for it, and the
  status bar's **Command Palette…** button opens it everywhere). Commands
  without a key (renames, closing a workspace, VS Code's diff and Git
  Graph, and in browsers most of them) are in the menus, the context
  menus, the pane headers and the palette, and keys or chords can be bound
  to any of them.
- Keys are shown as the platform shows them: macOS's menu symbols
  (`⇧⌘P`, `⌥⌘←`) on macOS, `Ctrl+Shift+P` elsewhere (`keyLabel`).
- A user's chord lasts 3 s or until its next key; its first stroke
  pressed again is not taken (the terminal's key encoder sends it, so
  `ctrl+k ctrl+k` types `ctrl+k` with `ctrl+k` chords bound); a key that
  ends no chord is dropped.
- The command palette (`components/Palette.tsx`) lists the commands that
  can run now with their keys, the workspaces and agents of the machines
  followed, the agent kinds to start, the UI languages and themes, and
  enabling program windows ([14](14-gui-windows.md)). Items whose words
  start with what is typed come first, then those holding it, then those
  whose word starts spell it (`fpl` for Focus Pane Left); a click or Enter
  runs an item. `workspace.switch` opens it with workspaces and agents
  only; `app.keyboardShortcuts` opens the settings' **Keyboard Shortcuts**
  page.
- The PWA manifest allows installing the app in its own window, where fewer
  shortcuts are taken by browser chrome.

**Direct shortcuts** (`desktop/src/menu.ts`, `web/src/desktop.ts`)

- The desktop app owns its keys, so its platforms have direct shortcuts.
  On macOS they are those of Terminal.app, iTerm, Chrome and VS Code:
  `cmd+t` new tab, `cmd+1`…`cmd+8` the tab of that number and `cmd+9` the
  last one, `cmd+shift+}` / `cmd+shift+{` and `ctrl+tab` /
  `ctrl+shift+tab` next / previous tab, `cmd+shift+w` close the tab,
  `cmd+d` / `cmd+shift+d` split right / down, `cmd+w` close the focused
  pane (its terminal, not the tab; in a workspace with no tab left, the
  workspace), `cmd+shift+enter` maximize or restore
  the pane, `cmd+alt+arrows` focus the pane in that direction, `cmd+[` /
  `cmd+]` go back / forward through the panes focused, `cmd+z` undo the
  last close within 5 s, `cmd+n` new workspace (asking for its
  folder), `cmd+p` go to a workspace, `cmd+ctrl+down` / `cmd+ctrl+up` next /
  previous workspace, `cmd+shift+a` the agent needing attention, `cmd+,`
  settings, `cmd+b` sidebar, `cmd+j` Open in VS Code
  ([05](05-vscode-panes.md)), `cmd+f` / `cmd+g` / `cmd+shift+g` find,
  `cmd+shift+p` the command palette (as in VS Code and Ghostty), `cmd+/` the
  keyboard shortcuts, `cmd++` (or `cmd+=`), `cmd+-` and `cmd+0` the
  window's zoom ([16](16-desktop-packaging.md)), also in dialogs and,
  through the menu, from text fields and VS Code. On other systems the desktop app has `ctrl+shift`
  keys as terminal emulators do, since `ctrl+w` deletes a word in shells:
  `ctrl+shift+t` new tab, `ctrl+shift+w` close tab, `ctrl+shift+enter`
  maximize the pane, `ctrl+shift+n` new workspace, `ctrl+shift+a` the agent
  needing attention, `ctrl+shift+j` Open in VS Code, `ctrl+shift+p` the palette,
  `ctrl+shift+/` the shortcuts, `ctrl+,` settings, `ctrl+tab` /
  `ctrl+shift+tab` next / previous tab and `alt+1`…`alt+9` the tabs (as
  GNOME Terminal and Konsole), and `ctrl++` (or `ctrl+=`), `ctrl+-` and
  `ctrl+0` the zoom (as GNOME Terminal and Windows Terminal size their
  text; `ctrl+shift+-`, undo in shells, stays the terminal's). Browsers
  get none of these (they keep them; their zoom keys zoom the page),
  except find (`cmd+f` on macOS, `ctrl+shift+f` elsewhere: `ctrl+f`
  belongs to the programs in panes), the keyboard shortcuts and, on macOS,
  the palette as `cmd+k` (Firefox opens a private window on `cmd+shift+p`
  and `ctrl+shift+p` and gives pages neither).
- The desktop app's menu names each command as the palette, the keyboard
  shortcuts page and the tooltips do, and shows its items disabled when
  their command cannot run now (no terminal, a single tab or pane, a dialog
  open, read-only mode): the page tells the shell which
  (`desktopShell.setDisabledCommands`, [16](16-desktop-packaging.md)).
- A key is named after the character the keyboard layout gives it, as macOS
  names its shortcuts (`web/src/keys.ts`, shared by the shell and the
  page): on AZERTY, `cmd+z` stays undo
  although its physical key is QWERTY's W. Keys without an ASCII character
  (non-Latin layouts, Option characters, dead keys) and keys that type
  nothing fall back to the physical key, so `cmd+w` on a Russian layout is
  still `cmd+w`; Shift does not change the name (`cmd+shift+1`, not
  `cmd+!`).
- In the desktop app the page matches every key it sees itself
  (`web/src/keymap.ts`), direct shortcuts and users' chords alike, with the
  desktop platform's bindings, and cancels the keys it runs. A held key
  repeats, as in browsers and terminals, the commands that open, close and
  step through things (new and close tab, close pane, next and previous
  tab, workspace, pane focus and match: `REPEATING_COMMANDS` in
  `web/src/keymap.ts`); toggles, dialogs and splits run once per press. The application menu shows on each command item the
  first single-stroke key the keybindings give that command. On macOS keys
  with Cmd are the menu's accelerators, but Chromium on macOS gives a Cmd
  key to the page first, so the menu acts only on keys the page left: a
  text field has the keyboard (the page's window handler skips them), a
  VS Code pane does, a dialog is open, or another window has it. A key thus runs
  its command once. Keys without Cmd are shown but not registered (macOS
  would offer them to a menu before the page), and the page runs them. On
  Windows and Linux the menu registers no key at all, so Ctrl+C, Ctrl+M,
  Ctrl+Q and every other key reach the page and its terminals: the page
  runs the `pc` bindings it matches, and a key typed in a text field, in
  a VS Code pane or in another window runs no menu command.
- A menu command the page receives (`runMenuCommand`) runs in the same
  contexts as its key: while a VS Code pane has the keyboard (its iframe
  is the page's focused element) the commands for `terminal`, `vscode` or
  `always`, with that pane as the focused one (pane commands act on it);
  while a dialog or the palette is open only those for `dialog` or
  `always`. VS Code takes its own keys before the menu: `cmd+j` toggles
  its own bottom panel there, and `cmd+p`, `cmd+shift+p`, `cmd+t`,
  `cmd+1`…`cmd+9`, `cmd+f`, `cmd+,` and `cmd+n` are VS Code's; a key it
  leaves runs the menu's command where that applies. `cmd+w` closes
  VS Code's editor; in a window without editors (and one editor group),
  where VS Code would close the window, the bridge extension binds it to
  closing the pane showing that window (`bridge.close`, `closeWindowPane`;
  `ctrl+w` elsewhere), so a pane emptied by `cmd+w` closes with the next
  one. The page takes no key from VS Code.
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
- The desktop app's menu (`desktop/src/menu.ts`; its titles are the web
  UI's `desktop.menu.*` strings) has, on macOS, the application's menu
  (about, settings, keyboard shortcuts, hide, quit) and, on Windows and
  Linux, File (settings, keyboard shortcuts, quit, titled Exit on Windows)
  and Help (about) around the others: Shell (new terminal, splits,
  workspaces, rename tab, close terminal or tab), Edit (undo, redo, cut,
  copy, paste, select all, find), View (palette, switch workspace,
  sidebar, Open in VS Code, zoom, next and previous tab, workspace and pane, focus
  on a side) and Window ([16](16-desktop-packaging.md)). Items show the
  first single-stroke key of their command, none when it has none, and
  are rebuilt when the keybindings change.
- Key hints (tooltips, context menus, the palette, the status bar) show
  the direct shortcut in the desktop app, else the first key, and nothing
  for a command without one.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Each client keeping its own arrangement | Browsers and the desktop app would show the same terminals differently; the document is one arrangement for every client of the machine. |
| The selection kept per browser | Two windows on one machine would disagree about what is shown and focused. Zoom stays per browser, since it is a way of looking. |
| A toolbar above a lone pane instead of pane headers | With the page's own layout every pane has room for a header of its own. |
| A tab bar that scrolls sideways (with auto-scroll while dragging) | Tabs out of view are hidden with no sign that they exist. |
| Tabs that shrink to fit, as in Chrome | Labels become unreadable with many tabs. |
| A "more tabs" menu for the tabs that do not fit | Hides tabs again and costs a click. |
| Bindings to move tabs and workspaces | Rarely needed; the context menu's move items work from the keyboard. |
| A "⋯" button always shown on every header, tab and workspace row | Takes room on every tab and row; machine and workspace rows show theirs only while pointed at, a pane header only once it is too narrow for its buttons, and tabs rely on right-click. |
| A "+" on machine and workspace rows (a new tab in that workspace) | The same picture would mean three things in three places; one "+" makes tabs, a folder with a plus makes workspaces, a server with a plus adds machines. |
| Renaming by a single click on a pane's title, as earlier versions did | A click meant to focus the pane started a rename; every name is now renamed by a double click. |
| Renaming in dialogs | Takes the user away from the thing renamed; a field in its place is what file managers, VS Code and browsers' tab groups do. |
| A sidebar of fixed width | Machine and workspace names were cut; a sidebar that cannot be resized looks broken next to resizable splits. |
| A desktop shell as the only client, owning all shortcuts | Browser access lets the IDE work from other devices, with the mouse and the keys browsers leave to pages, and the desktop app adds direct shortcuts on top; Tauri's WKWebView on macOS lacks service workers, which VS Code webviews need. |
| The prefix chords as defaults (`ctrl+b`, then a key), as earlier versions had | They took `ctrl+b` from tmux and other programs in the terminals, and every press of it waited for a second key; the application is used with the mouse, and chords stay available to users who bind them. |
| Browser-specific bindings (`Cmd+…`) | Conflict with the browser; browsers do not deliver `Cmd+T`/`Cmd+W` to pages. The desktop app has them (above). |
| The desktop shell taking direct shortcuts before the page (`before-input-event`), as it did | Two key matchers (the shell's and the page's) with their own rules for VS Code, dialogs and recording keys; with the page matching every key and the menu getting the rest, a key runs once and VS Code keeps its own keys. |
| Desktop shortcuts per browser profile (localStorage) | The shell needs them before and outside the page; the core's keybindings keep one set for all windows. |
| `cmd+w` closing the tab on macOS, as the desktop app did | Terminal emulators with splits (Ghostty, iTerm) close the focused split with it, so `cmd+w` closes the focused terminal. **Close Tab** in the Shell menu and the tab's × close a tab. |
| Keyboard Lock API | Fullscreen-only and Chromium-only. |
| `cmd+]` / `cmd+[` for the next / previous pane | Safari, Finder and Xcode go forward and back with them; next and previous pane keep their commands without a key, and `cmd+alt+arrows` move between panes. |
| Asking before closing a pane or tab with a program running | A dialog stops the closing; with 5 s to undo, `cmd+w` closes at once, twice in a row too, and a close by mistake is taken back with its program untouched. |
| The page taking `pane.close`'s key (`cmd+w`) from VS Code, as earlier versions did | It closed the whole VS Code pane where VS Code's users close an editor; VS Code now has every key first, and its key closes the pane only in a window without editors, where VS Code would close its window. |
| Every new tab in the focused terminal's directory | A workspace created for a folder keeps its tabs there; only a workspace without one, or in the home directory where every shell starts anyway, follows the focused terminal. |
| Reopening a closed terminal later as a new shell in its directory | Its program and screen would be gone: Undo Close brings back the same terminal, and only while it still runs. |

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
  rules and problems (`TestUserRules`), rules naming `view.toggleCode`
  and `workspace.rename` applying to `code.open` and `workspace.edit`
  (`TestRenamedCommands`), conflicts
  (`TestConflicts`), edits of the file (`TestReload`), the desktop app's
  old shortcut settings (`TestMigrateDesktopShortcuts`).
- `web/src/__tests__/term.test.ts`: the layout vectors of
  `design/testdata/layout` (workspaces, tabs, splits, closing, swaps and
  moves, directional focus and pane drops, VS Code and preview panes in
  `views.json`, version 1 documents, unknown fields, malformed documents,
  the names workspaces are shown with, editing a workspace's name and
  directory).
- `web/src/__tests__/reopen.test.ts`: a closed pane put back in its place
  with its splits' shares, beside its neighbor in a tab that changed, a
  closed tab at its place; a closed terminal kept running until the time to
  undo is over, the same terminal put back by Undo Close, one labeled
  closing by a page that is gone ended; going back and forward past closed
  panes.
- `web/src/__tests__/tabLabels.test.ts`: tabs numbered unless named, a tab
  of VS Code or a preview alone shown by its mark and name, the
  terminal's title and pane count in the tooltip, renaming from the title
  (unchanged keeps the number, emptied gives it back), and agents named by
  workspace and tab in the Agents section and the palette.
- `web/src/__tests__/codePanes.test.ts`: splitting and closing a VS Code
  pane (a terminal in its folder; nothing ended), the panes **Open in
  VS Code**, changes, Git Graph and paths from a terminal open or reuse
  ([05](05-vscode-panes.md), [06](06-quick-look-and-files.md)).
- `web/src/__tests__/sidebarMachines.test.ts`: workspaces shown with their
  folder's name, rows without the tab count (in the tooltip), renaming in
  place and an emptied name giving the folder's back.
- `web/src/__tests__/terms.test.ts`: reading the document after the
  terminals, with a workspace without a name and without ended
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
  menu's commands: closing tabs and panes at once, their terminals ending
  once the close can no longer be undone, none under dialogs, the main UI's acting on the
  VS Code pane that has the keyboard, VS Code's keys left to it and
  `bridge.close` closing only the pane whose iframe has the keyboard, **Open in VS Code** (a tab for the focused terminal's folder,
  selected again the next time); the commands whose items are disabled
  (nothing to switch to, a dialog open, read-only).
- `desktop/src/menu.test.ts` (the menu's structure, items named as their
  commands in both languages, accelerators, a rebinding, an unbinding,
  chords and unbound commands without accelerators, keys without Cmd shown
  only, disabled items and the page's list checked, the Window menu, the
  Windows and Linux menus with File and Help and no key registered),
  `desktop/src/follow.test.ts` (reading the keybindings and settings, their
  pushes, reconnecting).
- `web/src/__tests__/followed.test.ts`: machines followed before followed
  again once connected, a removed machine forgotten.
- `web/src/__tests__/menus.test.ts`: insertion slots, also on wrapped rows,
  the area a drop counts in, drags measured on the screen, menu items and
  their commands, moves from the current position, a pane moved to
  another workspace or a new one, read-only, keyboard,
  focus and closing of the menu, submenus, the machine's menu and its
  terminal service under Troubleshooting.
- `web/src/__tests__/paneHeader.test.ts`: a header's buttons act on its own
  pane and keep the terminal's focus, rename by a double click, menu,
  read-only, a VS Code pane's header (named by its folder, its own
  buttons).
- `web/src/__tests__/settingsDialog.test.ts`: the palette's ranking.

Splits, new tabs and workspaces, closing and dragging the split handle were
checked in headless Chromium against a dev core; resizing the sidebar
(drag, double click), a split's handle (drag, double click), renaming a
tab, a workspace, a pane and a machine in place, every context menu and
the Troubleshooting submenu were exercised there with pointer events, in
English and Chinese, light and dark.
