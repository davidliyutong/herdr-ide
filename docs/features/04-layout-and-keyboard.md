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

**Layout** (`web/src/components/LayoutView.tsx`)

- The split tree comes from `layout.export` per tab; `zoomed` shows only the
  focused pane. Pixel sizes are computed in the browser, so each browser
  lays out at its own size while sharing herdr's ratios.
- Dragging a divider calls `layout.set_split_ratio` with the path from the
  root (`false` = first child, `true` = second; `[]` is the root split).
- Split, close, zoom, new tab and new workspace call the corresponding herdr
  methods with the focused pane's cwd.
- Tab and workspace selection is local to each browser (it does not move the
  focus of herdr TUI clients); opening an agent from the inbox calls
  `pane.focus` so herdr marks it as seen.

**Rearranging and renaming** (`web/src/paneDrag.ts`, `InlineEdit.tsx`)

- Dragging a pane header (after a few pixels, so a click stays a click)
  shows a highlight of where the pane will go. The middle of another pane
  swaps the two (`pane.swap`); an edge places the pane beside it
  (`pane.move` with `split` right/down and `target_pane_id`; left/top add a
  swap, since herdr splits only to the right or down). Dropping on a tab
  moves the pane into it, on `+` into a new tab. Escape cancels.
- herdr 0.9.5 refuses `pane.move` within one tab (`same_tab`), so a move
  beside a pane of the same tab first moves the pane to a new tab, which herdr
  closes again when the pane leaves it.
- Clicking a pane's title edits it in place (`pane.rename`; empty clears the
  label so the terminal title shows again). Double-clicking a tab or
  workspace, or its rename binding, edits it in place (`tab.rename`,
  `workspace.rename`). Enter or leaving the field saves, Escape cancels.
- Read-only mode and zoomed panes have no drag, rename or mutating buttons.

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
| Desktop shell (Electron/Tauri) to own all shortcuts | Electron was replaced by browser access so the IDE works remotely; Tauri's WKWebView on macOS lacks service workers, which VS Code webviews need. |
| Browser-specific bindings (`Cmd+…`) | Conflict with the browser and with muscle memory from herdr. |
| Keyboard Lock API | Fullscreen-only and Chromium-only. |

## Failure modes

- **Config unreadable** → defaults are used.
- **Pane closed while focused** → focus falls back to the first pane of the
  tab on the next navigation.

## Testing

`internal/server/server_test.go` (`TestLoadKeyConfig`),
`web/src/__tests__/core.test.ts` (pane geometry for directional focus),
`web/src/__tests__/settings.test.ts` (drop zones, key labels); the
`set_split_ratio` path semantics and the `pane.swap` / `pane.move` behavior
(including `same_tab` and the temporary tab closing itself) were verified
against a real herdr 0.9.5 session, and dragging and renaming in Chrome.
