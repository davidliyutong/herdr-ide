# 04 · Layout and keyboard

## Context

Terminal multiplexer users know a layout model: workspaces, tabs, and binary split trees of panes. This application is used with the mouse, so its default keys leave almost every key to the program in the terminal; the one exception, `ctrl+b`, moves the keyboard out of an editor to its pane header, and is left to the program while a terminal has the keyboard (tmux's prefix).

The terminal core keeps terminals, not layouts. Every client of a machine arranges terminals, VS Code views and previews in the machine's layout document ([22](22-terminal-protocol.md)), so browsers and the desktop app show the same arrangement.

In a browser, `Cmd+W`, `Cmd+T` and similar shortcuts belong to the browser and cannot be captured reliably; the desktop app owns its keys.

## Goals / non-goals

Goals:

- one topology per machine, shared by every client;
- every command within reach of the mouse (menus, context menus, buttons, the palette);
- default keys that take nothing from programs in the terminals;
- one set of changeable keybindings for every client;
- nothing important depends on browser-reserved shortcuts.

Non-goals: arbitrary docking of panes; floating panes.

## Design

### Layout document

(`web/src/state/terms.ts`, `web/src/term/layout.ts`, `components/Workspace.tsx`)

- Each machine has one layout document, `layout` in its terminal core (version 2; format and operations in [22](22-terminal-protocol.md)). Workspaces hold a name, a start directory and tabs; a tab holds a split tree whose leaves are panes: terminals, VS Code views ([05](05-vscode-panes.md)) and previews ([06](06-quick-look-and-files.md)).
- `layout.ts` implements the operations and runs the vectors of `spec/vectors/layout`. Unknown fields and node kinds are kept; a version 1 document (tabs without workspaces) reads as one workspace.
- The selected workspace, selected tab and focused pane are part of the document, so every client follows them. Zoom is the only per-browser view state.
- Edits are written one at a time with the version last read. A newer version written by another client wins; the client reads it again.
- The page follows the machines the user turned to: it subscribes to their terminals (which starts their terminal cores, [02](02-multi-machine-transport.md)), then reads their layouts. The followed machines are remembered per browser and followed again on load (`web/src/state/followed.ts`).
- A machine without a document gets a first workspace without a name. A machine whose workspaces were all closed stays without one, and the next pane opened there creates one (`TermModel.firstWorkspace`).
- Terminals that ended are dropped from the document; those that ended with their terminal core are started again ([33](33-workspace-restore.md)).

### Panes, tabs and workspaces

- Panes are sized by their split's ratio. Dragging a split handle sets it; double-clicking shares the split equally.
- A new tab starts in its workspace's directory, else (none, or the home directory) in the focused terminal's. A split starts in the split pane's directory, else the workspace's.
- Closing a terminal's pane ends its program; closing a VS Code or preview pane ends nothing. Closing a tab or workspace ends only its terminals. A program that exits by itself closes its pane.
- Closing the last tab leaves an empty workspace, which offers **New Tab**. A workspace goes only with **Close Workspace**, the last one too.
- A tab can be pinned (`tab.pin`, `tab.unpin`): pinned tabs stay first, show a pin instead of ×, and are skipped by Close Other Tabs, Close Tabs to the Right and middle clicks. `pane.close` (`cmd+w`) never closes a pinned tab's last pane, and a held key stops at a pinned tab (`L.onlyPaneOfPinnedTab`); Close Tab, the pane header's Close Pane and Close Workspace still close it, with Undo. The pin is a mark, not a button, so a stray click never unpins.
- A tab or a workspace can be muted (`tab.mute`, `tab.unmute`, `workspace.mute`, `workspace.unmute`; `muted: true` in the layout document, so every page and hub of the machine has it): its agents and terminals make no sound and no notification, while their status and the badge count still show ([07](07-agent-native-workflow.md)). A muted tab and workspace show a crossed-out bell.
- Tabs wrap onto more rows instead of scrolling or shrinking. An unnamed tab shows its position number (several shells would all read `user@host:~`); a tab without a terminal shows its pane's mark and name. Outside the tab bar a tab is always named with its workspace (`website · 2`).
- A workspace without a name is named after a folder (`layout.workspaceTitle`): its single pane's directory, else its own directory, else its focused pane's. Its own directory, when created without one, is adopted from its first terminal (`layout.adoptDirectory`).
- The sidebar is resizable, hides when dragged far left, and lies over the panes in narrow windows. It lists every workspace of the followed machines.
- Each create button does one thing: `+` in the tab bar is **New Tab**; the sidebar has **New Workspace…** (folder with a plus) and **Add Machine…** (server with a plus).
- The **New / Edit Workspace** dialog takes an optional folder and name. The folder is checked and resolved on the machine (`GET /api/m/{id}/list`), and the absolute path is stored, since the terminal core does not expand `~`. With no folder, new tabs start in the focused terminal's directory (`layout.editWorkspace`).
- In the desktop app on macOS and Linux, folders dropped on the sidebar or opened with the app create a workspace each on the local machine (`web/src/drop.ts`, [16](16-desktop-packaging.md)). Browsers do not reveal a dropped folder's path, and the Windows app's local machine has no agent, so neither offers this.

### Close and undo

(`web/src/closedPanes.ts`, `web/src/unsaved.ts`, `actions.ts`)

- **Close Pane**, **Close Tab** and **Close Workspace** close at once, without asking, even with programs running. A toast offers **Undo**.
- **Undo Close** (`pane.undoClose`) puts back the same terminals, programs still running, in their place: the same split shares when the tab is unchanged, beside the old neighbor otherwise; tabs and workspaces at their old positions (`layout.reopen`, `layout.restoreWorkspace`).
- The undo window is the setting `layout.undoClose` (5 s by default, 3 to 120). A closed terminal gets the label `closing` with its deadline (`TermModel.closeLater`); any page showing the machine ends it once the deadline passes, so it ends even if the closing page is gone.
- Only unsaved changes (an editor, a diff's working tree) ask first: **Save**, **Don't Save** or **Cancel**. Leaving the page with unsaved changes gets the browser's question; the desktop app asks natively before closing or quitting.
- An empty workspace closes with `pane.close` without asking. A held key does not do this: presses within 600 ms count as repeats, since the desktop menu repeats without saying so.

### Rearranging and renaming

(`web/src/drag.ts`, `paneDrag.ts`, `tabDrag.ts`, `reorderDrag.ts`, `InlineEdit.tsx`)

- All drags share `drag.ts`: a threshold so a click stays a click, a ghost, a drop marker, Escape to cancel, and auto-scroll near the sidebar's edges. Distance is measured in screen coordinates, because in macOS full screen the sliding menu bar moves the page under a still pointer.
- A tab is shown on press, not release, as in browsers.
- A pane dragged by its header swaps with another pane (middle), goes beside it (edge), joins another tab (drop on the tab), opens a new tab (elsewhere on the tab bar), or a new tab in another workspace (drop on it in the sidebar). VS Code panes keep their window wherever they go. Right sidebar panels dropped on the panes become panes ([27](27-plugins.md)).
- **Move to Workspace ▸** moves a pane (or selected tabs) into another workspace of the same machine, or a new one (`actions.movePaneToWorkspace`, `layout.moveToNewTab`). Panes never move between machines: a terminal runs in its machine's terminal core.
- A tab dragged onto a pane merges into it, as Edge's split screen does: its panes become a split on the nearest side. A pane dragged onto `+` splits it back out.
- Tabs and workspaces reorder by dragging; a drop lands in a slot of the current order. A tab stays in its workspace, a workspace on its machine.
- Everything with a name is renamed in place by a double click, its menu's **Rename**, or a binding. A single click only focuses or selects. Keys an input method uses while composing never save or cancel the field (`web/src/ime.ts`).
- Pane names are the terminal's `name` label in the terminal core; tab and workspace names are in the layout document; machine names are the hub's ([02](02-multi-machine-transport.md)). An emptied name falls back to the default.
- Read-only mode and zoomed panes have no drag, rename or mutating buttons.

### Pane history

**Go Back** and **Go Forward** (`pane.back`, `pane.forward`, `web/src/paneHistory.ts`) move through the panes focused, as a browser through pages. Closed panes and steps that would not move the focus are skipped. The history keeps the last 100 steps, in the page only.

### Selecting several

(`web/src/state/multiSelect.ts`)

- Tabs of a workspace, workspaces of a machine, and machines can be selected together with ⌘/Ctrl-click and Shift-click, as in file managers and Chrome. A selection holds rows of one list.
- The selection's menu offers:
  - tabs: Move to Workspace ▸, Close N Tabs;
  - workspaces: Close N Workspaces;
  - machines: Retry, Enable, Disable…, Remove….
- Closing several gives one **Undo** for all (`closedPanes.ts` groups them). Disabling or removing several asks once, naming them.
- Panes, the palette and settings lists select one item at a time.

### Keyboard in the sidebar and tab bar

(`web/src/rowKeys.ts`)

- The sidebar is a tree and the tab bar a tab list, each one Tab stop. They follow the usual ARIA keys: arrows, Home/End and type-ahead move; Shift extends the selection; Enter or Space acts as a click; F2 renames; Delete closes; Shift+F10 or the menu key opens the row's menu.
- Only the keyboard focuses a row. A mouse press leaves the focus in the terminal of the workspace or tab clicked.

### Pane headers

(`components/PaneHeader.tsx`, `PaneActions.tsx`)

- Every pane has a header: agent state, name, folder, then its buttons (program windows [14](14-gui-windows.md), Open in VS Code, changes, Git Graph, splits, zoom, close). Buttons act on their own pane and leave the keyboard in the terminal.
- Only the focused pane and the pane under the pointer show buttons.
- Narrow headers drop items in a fixed order and show a `⋯` button with the pane's full menu; close always stays.
- A header is a toolbar and one Tab stop. From a terminal, where F2 belongs to the program, **Rename Pane** (`pane.rename`) and **Pane Actions…** (`pane.actions`) are commands without a default key.

### Context menus

(`web/src/contextMenu.ts`, `menus.tsx`, `components/ContextMenu.tsx`)

- Pane headers, tabs, workspaces, machines and the sidebar's free space have in-app context menus. Every menu has the same order: rename, create, arrange, then items that end something (red icon) last.
- Items run the same commands as buttons and bindings and show their binding. A menu for a tab or workspace other than the current one shows no binding, since bindings act on the current one.
- Move items use the position at run time, which another client may have changed.
- The menu takes the keyboard and blocks key bindings while open. Typing filters it with the palette's matcher, so long menus (Move to Workspace on a machine with many workspaces) stay usable.
- The machine menu's **Troubleshooting ▸** starts, stops or restarts its terminal service ([02](02-multi-machine-transport.md)).
- Read-only mode offers no items, so the browser's menu shows. A pane's text has its own menu (copy, paste, find, paths and URLs; [26](26-web-terminals.md), [06](06-quick-look-and-files.md)).
- The browser's `prompt()` and `confirm()` are not used; dialogs are the page's own (`web/src/dialog.ts`, `Dialogs.tsx`).

### Keybindings

(`backend/kernel/config/keybindings`, `web/src/keymap.ts`, `web/src/commands.ts`; settings in [13](13-settings-and-appearance.md); the full table in [reference](../reference.md#keyboard-shortcuts))

- Commands have default keys per platform (`mac`, `windows`, `linux`: the desktop app; `mac-browser`, `windows-browser`, `linux-browser`) and a context (`when`: `terminal`, `editor`, `vscode`, `dialog`, `always`). `terminal` is the main window, its terminals and VS Code panes included (for the keys VS Code leaves); `editor` is the main window except while a terminal has the keyboard, where the key goes to the program. User rules in `keybindings[-<instance>].json` on the hub host add and remove keys. Clients follow the hub's `keybindings` messages.
- Command handlers are a table by id: a plugin's in its definition (`web/src/plugins/api.ts`), the rest in `web/src/commands.ts`.
- `ctrl+b` (`pane.leave`, `editor`) moves the keyboard from the focused editor or pane to its pane header, so app keys run without the editor taking them; pressed again (or `Escape`) it returns. In Monaco and text fields it is caught before the editor. In a terminal it is the program's: tmux and shells use it, and a key that sometimes leaves the terminal and sometimes does not cannot be learned. A rule with `"when": "terminal"` binds it there too. In a VS Code pane the bridge extension's own key gives the keyboard back ([05](05-vscode-panes.md)). Apart from it no default is a chord, `ctrl` or `alt` with a letter alone, or a function key, so every other non-default key reaches the terminal on the first press.
- Browsers get only keys they leave to pages: find (`cmd+f`, `ctrl+shift+f`), the keyboard shortcuts (`cmd+/`, `ctrl+shift+/`) and, on macOS, the palette as `cmd+k`. Every other command is in menus, the palette (also the status bar's button) and can be bound.
- User chords last 3 s or until the next key. A chord's first stroke pressed again goes to the terminal, so `ctrl+k ctrl+k` types `ctrl+k`.
- Keys are named after the character the keyboard layout gives them, as macOS does (`web/src/keys.ts`): on AZERTY `cmd+z` stays undo. Keys without an ASCII character fall back to the physical key.
- A keydown that belongs to an input method in one of the page's text fields reaches no handler of the page (`guardImeKeys` in `web/src/ime.ts`, a capture listener installed before the UI). Terminals and Monaco handle composition themselves.
- Key hints (tooltips, menus, palette) show the desktop app's direct shortcut, else the first key, and nothing for an unbound command.

### Command palette

(`components/Palette.tsx`)

- Lists runnable commands with their keys, workspaces and agents of followed machines, agent kinds to start, languages, themes, and program windows ([14](14-gui-windows.md)).
- Ranking: word starts first, then substrings, then initials (`fpl` for Focus Pane Left). Long lists render only rows in view (`lib/windowed.ts`), so hundreds of workspaces stay fast.
- `workspace.switch` opens it with workspaces and agents only.
- The PWA manifest allows its own window, where fewer shortcuts are taken by browser chrome.

### Desktop app shortcuts

(`desktop/src/menu.ts`, `web/src/desktop.ts`)

- The desktop app owns its keys, so it has direct shortcuts. On macOS they follow Terminal.app, iTerm, Chrome and VS Code (`cmd+t`, `cmd+w`, `cmd+d`, `cmd+1`…`cmd+9`, `cmd+[`/`cmd+]` back/forward, `cmd+z` undo close, …). On Windows and Linux they use `ctrl+shift` as terminal emulators do, since `ctrl+w` deletes a word in shells; tabs are `alt+1`…`alt+9`. Windows and Linux differ in a few keys (splits, workspace switching), following each system's terminals.
- `cmd+w` closes the focused pane, not the tab, as Ghostty and iTerm close the focused split.
- The page matches every key itself with the desktop platform's bindings and cancels the keys it runs. Held keys repeat only for commands that step or open/close (`REPEATING_COMMANDS` in `web/src/keymap.ts`).
- On macOS the menu's Cmd accelerators act only on keys the page left (Chromium gives Cmd keys to the page first): a text field, a VS Code pane, a dialog, or another window has the keyboard. A key thus runs once. Keys editors use (`cmd+z`, `cmd+[`, `cmd+]`, `cmd+d`, `cmd+f`, `cmd+g`, `cmd+/`…) are shown but not registered, so Monaco and text fields keep them. On Windows and Linux the menu registers no keys, so every key reaches the page and its terminals.
- A menu command the page receives (`runMenuCommand`) runs in the same contexts as its key; with a VS Code pane focused, pane commands act on that pane.
- VS Code keeps its own keys. `cmd+w` closes VS Code's editor; in a window without editors, the bridge extension binds it to closing the pane (`bridge.close`), except a pinned tab's only pane. The page takes no key from VS Code.
- With a program window or a VS Code window in front, `pane.close` and `tab.close` close that window.
- The menu's titles are the web UI's `desktop.menu.*` strings and its items the commands' names. Items show the first single-stroke key of their command and are disabled when the page says the command cannot run (`desktopShell.setDisabledCommands`, [16](16-desktop-packaging.md)). The menu is rebuilt when keybindings change; the shell starts from the defaults in `spec/generated/registry.json`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Each client keeping its own arrangement | Clients would show the same terminals differently. |
| The selection kept per browser | Two windows would disagree about what is shown; only zoom is per browser. |
| A toolbar above a lone pane instead of pane headers | Every pane has room for its own header. |
| A tab bar that scrolls sideways | Tabs out of view are hidden with no sign. |
| Tabs that shrink to fit, as in Chrome | Labels become unreadable. |
| A "more tabs" menu | Hides tabs and costs a click. |
| Bindings to move tabs and workspaces | Rarely needed; context menu moves work from the keyboard. |
| A `⋯` button always shown everywhere | Takes room; shown only on hover or when a header is narrow. |
| A `+` on machine and workspace rows | One picture would mean three things; each create button has its own icon. |
| Renaming by a single click on a pane title | A click meant to focus started a rename. |
| Renaming in dialogs | Takes the user away from the thing renamed. |
| A fixed-width sidebar | Names were cut; looks broken next to resizable splits. |
| A desktop shell as the only client | Browser access works from other devices; Tauri's WKWebView lacks the service workers VS Code webviews need. |
| Prefix chords as defaults (`ctrl+b`, then a key) | Delayed every press; chords stay available to bind. |
| Browser `Cmd+…` bindings | Browsers do not deliver `Cmd+T`/`Cmd+W` to pages. |
| The shell matching shortcuts before the page (`before-input-event`) | Two matchers with diverging rules; one matcher in the page runs each key once. |
| Desktop shortcuts per browser profile | The shell needs them outside the page; the hub keeps one set. |
| `cmd+w` closing the tab | Split-capable terminals close the focused split. |
| `cmd+w` closing a pinned tab's last pane | Held or repeated `cmd+w` closed pinned tabs by the way; VS Code's pinned editors do not close from the keyboard either. |
| Keyboard Lock API | Fullscreen-only and Chromium-only. |
| `cmd+]` / `cmd+[` for next / previous pane | Safari, Finder and Xcode use them for back / forward. |
| Asking before closing a pane with a running program | A dialog interrupts; a timed Undo with the program untouched is safer and faster. |
| The page taking `cmd+w` from VS Code | Closed the whole pane where users meant to close an editor. |
| Every new tab in the focused terminal's directory | A workspace made for a folder keeps its tabs there. |
| Reopening a closed terminal as a new shell | Its program and screen would be gone; Undo brings back the same terminal. |

## Failure modes

- **The keybindings file has errors** → a file that is not a JSON array keeps the previous rules (`parse`); bad entries and unknown commands are skipped (`invalid`, `unknown`). The **Keyboard shortcuts** page shows problems and conflicts ([13](13-settings-and-appearance.md)).
- **A focused pane closes** → the focus moves to its sibling.
- **Two clients edit the layout at once** → the second write is refused as a version conflict; its client reads the newer layout, which wins.
- **The terminal core is not ready** (installing, starting, failed) → the workspace area and the sidebar say so; the machine's menu starts it again.
- **The page that closed a terminal is gone before the undo time ends** → any other page showing the machine ends the terminal labeled `closing`.

## Testing

- `backend/kernel/config/keybindings/keybindings.test.ts`: key syntax, per-platform defaults, user rules and problems, conflicts, reload.
- `spec/vectors/layout` (run by `web/src/__tests__/term.test.ts`): layout operations, VS Code and preview panes, version 1 and malformed documents, workspace names; `pinned.json` and `tabs-block.json` for pinning and block moves.
- `web/src/__tests__/terms.test.ts`: reading and writing the document, version conflicts, ended programs, first workspace.
- `web/src/__tests__/reopen.test.ts`: Undo Close of panes, tabs and workspaces; terminals ended after the undo time; pane history.
- `web/src/__tests__/tabLabels.test.ts`, `sidebarMachines.test.ts`: labels, names, renames.
- `web/src/__tests__/menus.test.ts`, `paneHeader.test.ts`, `paneDrag.test.ts`, `multiSelect.test.tsx`: drags, context menus, filtering, headers, multi-selection and row keyboard.
- `web/src/__tests__/keys.test.ts` (key names, chords, defaults in `spec/vectors/keys/defaults.json`, `ctrl+b` leaving and returning focus), `vt.test.ts`, `ime.test.tsx`, `palette.test.tsx`, `settingsDialog.test.ts` (palette ranking), `followed.test.ts`, `codePanes.test.ts`, `core.test.ts`, `settings.test.ts`.
- `web/src/__tests__/desktop.test.ts` and `desktop/src/menu.test.ts`: the desktop menu, accelerators, disabled items, VS Code keys, `cmd+w` and pinned tabs; and `desktop/src/follow.test.ts`: following keybindings and settings.

Splits, drags, renames and context menus were also exercised in headless Chromium against a dev hub, in English and Chinese, light and dark.
