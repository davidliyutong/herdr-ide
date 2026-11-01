# 04 · Layout and keyboard

## Context

herdr users already know its layout model (workspaces → tabs → binary split
trees of panes) and its prefix keymap (`ctrl+b` by default, customizable in
`~/.config/herdr/config.toml`, including custom commands such as plugin
actions). In a browser, `Cmd+W`, `Cmd+T` and similar shortcuts belong to the
browser and cannot be captured reliably.

## Goals / non-goals

Goals: the same topology as herdr (changes in either UI show up in the
other); the user's own herdr bindings work unchanged; nothing important
depends on browser-reserved shortcuts.

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

- All drags share `drag.ts`: a drag starts after the pointer moved a few
  pixels (so a click stays a click), a ghost follows the pointer, a marker
  shows where the drop lands, and Escape cancels.

- Dragging a pane header (after a few pixels, so a click stays a click)
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

- Right-clicking a pane header, a tab or a workspace in the sidebar opens an
  in-app menu at the pointer instead of the browser's:
  - pane header: rename, split right / down, zoom or restore, VS Code /
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
- Read-only mode offers no items, so the browser's menu shows. The pane
  surface keeps the browser's menu (copy, paste) unless the pane's program
  reports the mouse.

**Dialogs** (`web/src/dialog.ts`, `Dialogs.tsx`)

- Creating a workspace asks for its directory, with completion of folders on
  the machine (Tab, ↑↓; the folder must exist) and an optional name
  (`workspace.create` `label`). Closing a pane or tab with a working agent,
  and closing a workspace, ask for confirmation; Enter cancels these unless
  the user moves to the confirm button. The browser's `prompt()` and
  `confirm()` are not used.

**Keyboard** (`web/src/keymap.ts`)

- `/api/keymap` returns the host's herdr `[keys]` section and
  `[[keys.command]]` entries; defaults mirror herdr's.
- Prefix mode lasts 3 s or until the next key. `prefix prefix` sends the
  prefix key itself to the pane.
- Custom commands take precedence over built-in bindings with the same key.
  `plugin_action` commands call `plugin.action.invoke` on the pane's machine;
  `pane`/`popup`/`shell` commands run in a new pane.
- herdr-ide adds bindings for its own features (VS Code `prefix e`, diff
  `prefix d`, Git Graph `prefix shift+g`, palette `prefix space`, settings
  `prefix ,`).
- The command palette lists commands with their keys, workspaces and agents
  on every machine, agent kinds to start, UI languages and themes.
- The PWA manifest allows installing the app in its own window, where fewer
  shortcuts are taken by browser chrome.

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
| Browser-specific bindings (`Cmd+…`) | Conflict with the browser and with muscle memory from herdr. |
| Keyboard Lock API | Fullscreen-only and Chromium-only. |

## Failure modes

- **Config unreadable** → defaults are used.
- **Pane closed while focused** → focus falls back to the first pane of the
  tab on the next navigation.
- **Move refused** (for example the tab was closed meanwhile) → a toast with
  herdr's error; the order stays as herdr has it.

## Testing

`internal/server/server_test.go` (`TestLoadKeyConfig`),
`web/src/__tests__/core.test.ts` (pane geometry for directional focus),
`web/src/__tests__/settings.test.ts` (drop zones, key labels),
`web/src/__tests__/menus.test.ts` (insertion slots, also on wrapped rows,
the area a drop counts in, applying a move reply, menu items and their commands, moves from the
current position, read-only, keyboard, focus and closing of the menu);
`internal/server/server_test.go` (`TestAPIAllowlist`: moves are refused in
read-only mode). The `set_split_ratio` path semantics, the `pane.swap` /
`pane.move` behavior (including `same_tab` and the temporary tab closing
itself) and the `insert_index` slots of `tab.move` / `workspace.move` were
verified against a real herdr 0.9.5 session, and dragging, reordering and
the menus in Chrome.
