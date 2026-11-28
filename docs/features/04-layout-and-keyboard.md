# 04 · Layout and keyboard

## Context

Terminal multiplexer users know a layout model: workspaces, tabs and binary split trees of panes. This application is used with the mouse, so its default keys leave almost every key to the program in the terminal. The terminal core keeps terminals, not layouts, so the arrangement lives in one layout document per machine that every client shares ([22](22-terminal-protocol.md)). In a browser, `Cmd+W`, `Cmd+T` and similar shortcuts belong to the browser; the desktop app owns its keys.

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

`web/src/term/layout.ts` (the operations, run against `spec/vectors/layout`), `web/src/state/terms.ts` (reading and writing).

- Each machine has one document, `layout` in its terminal core (format in [22](22-terminal-protocol.md)): workspaces with a name, a start directory and tabs; a tab is a split tree whose leaves are terminals, VS Code views ([05](05-vscode-panes.md)), previews ([06](06-quick-look-and-files.md)) and plugin panes ([27](27-plugins.md)). Unknown fields and node kinds are kept.
- The selected workspace, tab and focused pane are in the document, so every client follows them; zoom is the only per-browser view state.
- Edits are written one at a time against the version last read; on a conflict the newer version wins and the client reads it again.
- Terminals that ended are dropped from the document; those that ended with their terminal core are started again ([33](33-workspace-restore.md)).

### Panes, tabs and workspaces

- A new tab starts in its workspace's directory, else in the focused terminal's. A workspace's folder is stored as an absolute path resolved on the machine (the terminal core does not expand `~`); a workspace the user did not name is named after its folder, else after its focused pane's directory (`layout.workspaceTitle`).
- Closing a terminal's pane ends its program; closing a VS Code or preview pane ends nothing; closing a tab or workspace ends only its terminals. A program that exits closes its pane.
- Closing the shown tab shows the tab whose pane had the focus most recently in this page (`layout.showRecentTab`), as a browser goes back to the tab it showed before. A workspace goes only with **Close Workspace**.
- Pinned tabs stay first and are skipped by Close Other Tabs and Close Tabs to the Right. `pane.close` never closes a pinned tab's last pane, so a held `cmd+w` stops there; Close Tab still closes it, with Undo.
- Muted tabs and workspaces (`muted` in the document, so every client has it) make no sound or notification and add no badge ([07](07-agent-native-workflow.md)). Tabs wrap onto more rows instead of scrolling or shrinking.

### Close and undo

`web/src/closedPanes.ts`, `web/src/unsaved.ts`.

- Close Pane, Close Tab and Close Workspace close at once, without asking, even with programs running. **Undo** (`pane.undoClose`) puts back the same terminals, programs still running, in their place.
- A closed terminal gets the label `closing` with a deadline (`layout.undoClose`); any page showing the machine ends it once the deadline passes, so it ends even if the closing page is gone.
- Only unsaved changes (an editor, a diff's working tree) ask first; leaving the page asks through the browser, the desktop app natively.

### Rearranging and renaming

- Panes and tabs are dragged to swap, split, merge or move to another workspace (`web/src/drag.ts` and its users), never to another machine: a terminal runs in its machine's terminal core.
- A tab dragged out of the window opens a window with only its panes (`web/src/detachedWindow.ts`); it stays in the layout document, hidden from the main window's tab bar, and docks back with **Move Back to Main Window**.
- Everything named is renamed in place (a double click, its menu or a binding); a single click only focuses. Pane names are the terminal's `name` label, tab and workspace names are in the layout document.
- Tabs, workspaces or machines are selected together with ⌘/Ctrl-click and Shift-click (`web/src/state/multiSelect.ts`). Read-only mode and zoomed panes offer no drag, rename or mutating buttons.

### Pane history

**Go Back** and **Go Forward** (`pane.back`, `pane.forward`, `web/src/paneHistory.ts`) move through the panes focused, as a browser through pages, in the page only; their keys work in Monaco editors and pane inputs too (`handleEditorKey` in `keymap.ts`).

### Headers, menus, palette

- Every pane has a header (`components/PaneHeader.tsx`) whose buttons act on their pane and leave the keyboard in the terminal. The sidebar and the tab bar are one Tab stop each (`web/src/rowKeys.ts`); only the keyboard focuses a row.
- Context menus (`web/src/menus.tsx`) run the same commands as buttons and keys. A menu for a tab or workspace other than the current one shows no keys, since keys act on the current one.
- The command palette (`components/Palette.tsx`) also finds workspaces, agents and program windows ([14](14-gui-windows.md)).

### Keybindings

The model, files and API are in [13](13-settings-and-appearance.md); key syntax, contexts and every default in [reference](../reference.md#keyboard-shortcuts). Keys are matched in `web/src/keymap.ts`; handlers are a table by command id (`web/src/commands.ts`, and the plugins' definitions).

- Defaults are single strokes that terminal programs do not read: no chord, `ctrl` or `alt` with a letter alone, or function key, so every other key reaches the terminal's program on the first press. Two exceptions:
  - `ctrl+b` (`pane.leave`, context `editor`) moves the keyboard from an editor or VS Code pane to its pane header and back. In a terminal it stays the program's, since tmux and shells use it, and a key that sometimes leaves the terminal and sometimes does not cannot be learned.
  - `ctrl+t` is New Tab in the desktop app on Windows and Linux, the browsers' key, taken over the shells' transpose.
- Browsers get only keys they leave to pages: find, the keyboard shortcuts and, on macOS, the palette as `cmd+k`. Every other command is in menus and the palette, and can be bound.
- Keys are named after the character the keyboard layout gives them, as macOS does (`web/src/keys.ts`): on AZERTY `cmd+z` stays undo. A keydown that belongs to an input method reaches no handler (`web/src/ime.ts`).

### Desktop app shortcuts

`desktop/src/menu.ts`, `web/src/desktop.ts`; the menu in [16](16-desktop-packaging.md).

- The desktop app owns its keys, so it has direct shortcuts: on macOS those of Terminal.app, iTerm, Chrome and VS Code; on Windows and Linux `ctrl+shift` keys as terminal emulators use, since `ctrl+w` deletes a word in shells. `cmd+w` closes the focused pane, not the tab, as Ghostty and iTerm close the focused split.
- The page matches every key itself and cancels the keys it runs, so a key runs once; the menu acts only on keys the page left (on macOS; on Windows and Linux it registers none). Keys editors use (`cmd+z`, `cmd+f`…) stay theirs, and VS Code keeps its own ([05](05-vscode-panes.md)).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Each client keeping its own arrangement or selection | Clients would show the same terminals differently. |
| A desktop shell as the only client | Browser access works from other devices; Tauri's WKWebView lacks the service workers VS Code webviews need. |
| The shell matching shortcuts before the page (`before-input-event`) | Two matchers with diverging rules; one matcher in the page runs each key once. |
| `cmd+w` closing the tab | Split-capable terminals close the focused split. |
| `cmd+[` / `cmd+]` for previous / next pane | Safari, Finder and Xcode use them for back / forward. |
| Asking before closing a pane with a running program | A dialog interrupts; a timed Undo with the program untouched is safer and faster. |
| The page taking `cmd+w` from VS Code | Would close the whole pane where users mean to close an editor. |

## Failure modes

- **Two clients edit the layout at once** → the second write is refused as a version conflict; its client reads the newer layout.
- **The terminal core is not ready** → the workspace area and the sidebar say so; the machine's menu starts it again.
- **The page that closed a terminal is gone before the undo time ends** → another page showing the machine ends it.

## Testing

- `spec/vectors/layout` (run by `web/src/__tests__/term.test.ts`) for the layout operations; `web/src/__tests__/` `terms`, `reopen` (Undo Close, the recent tab, pane history), `menus`, `paneDrag`, `multiSelect`, `detachedWindow`, `keys` (key names, chords, defaults, keys in editors), `palette`, `desktop`.
- `backend/kernel/config/keybindings/keybindings.test.ts` (defaults and their exceptions, user rules, conflicts) and `desktop/src/menu.test.ts` (accelerators, `cmd+w` and pinned tabs).
