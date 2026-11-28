# 28 · File explorer

## Context

Looking around a project an agent works in, renaming a file or fixing a line of a config should not need a VS Code pane ([05](05-vscode-panes.md)), slow to start and a pane's room. The plugins' right sidebar ([27](27-plugins.md)) has room for a tree.

## Goals / non-goals

Goals:

- A tree of the shown machine's files that follows the focused terminal's directory, with what VS Code's explorer does, and uploads of files and folders with their structure.
- An editor pane (Monaco; media as Quick Look shows it, [06](06-quick-look-and-files.md)) with VS Code's preview editors, that **never overwrites a change made on the machine since it loaded the file**.
- Version control status in the tree's colors and the editor's gutter.

Non-goals: an IDE (language services beyond Monaco's JSON, CSS and HTML; search in files is [41](41-project-search.md), version control [31](31-git.md)); a file-system watch on machines; restoring from the trash.

## Design

Plugin `files`, on by default: a right-sidebar panel (`view.panel.files`) and the pane kind `editor`. Code: `web/src/plugins/files`, `backend/features/files/hub.ts`, `backend/features/files/machine.ts` and `machine/`. Its settings (`files.*`) and routes (below `/api/m/{id}/p/files/`) are in [reference.md](../reference.md).

### Tree

- **Root** (`FilesPanel.tsx` `rootFor`): the focused terminal's directory, a VS Code pane's folder or the workspace's. A terminal's directory (`web/src/term/place.ts`, shared with the Git panel, the status bar and new terminals) is a shell's as it changes and another program's only once it stayed there for `SETTLE_MS`: `cd project && claude` moves the tree, a build walking a tree does not. The panel never asks a machine about another's paths.
- **Polling, not watching** (`poller.ts`): while the panel is visible it stats the shown directories (`POST …/stat`) and lists again (`GET /api/m/{id}/list`) those that changed, backing off after failures; nothing runs on the machine once it is hidden.
- **Filter**: names across the project below the root (`GET …/find`, bounded, never following links); regular expressions in RE2's syntax are matched on the machine in linear time (`re2js`), so no pattern can stall the node.
- **Editors** open from the tree in tabs of the workspace, split beside the pane with Open to the Side or from a terminal's link. A click shows the file in the workspace's single **preview editor**, replaced by the next unless kept (double click, pin, first edit) or holding unsaved changes.
- **Drags** (`web/src/pathsDrag.ts`, carrying the machine and paths): onto a folder they move (Alt copies); onto a terminal of the same machine their paths are pasted shell-quoted; onto a chat's composer they attach as files ([37](37-agent-chats.md)); panes of another machine refuse them.
- **Uploads** (`upload.ts`): each taken name is asked about once (**Replace** writes in place as a save does and merges folders, never removing first; **Keep Both**, **Skip**, **Cancel**). The desktop app copies files of its own machine instead.
- **Reveal in Finder**: only for the hub's own machine and a page on that computer (the hub's `SameHost`).
- **Decorations** (`decorations.ts`): the panel publishes the directories it shows, so the Git plugin colors them without its own panel open.

### Changes on the machine

Every change is a mutating plugin route, refused in read-only mode and audited as `files.<action>`. The agent never replaces a name: `rename` and `move` use `renameNoReplace` (`backend/machine/sys/fs.ts`), a taken name fails with `exists` or gets a free one. `trash` (`machine/trash.ts`) uses macOS's `~/.Trash` or the freedesktop.org trash, a mount's only when it is the user's own and closed to others, else `trash_unavailable` and the panel offers to delete for good. `remove` does not follow links. Uploads are received in full into the agent's private `staging/` directory before they are written, so a cut-short upload leaves nothing at the path. `reveal` runs `open -R` or `xdg-open` from fixed system directories, never `PATH` or a shell.

**Refused paths** (`machine/guard.ts`): the root, any directory holding the home directory, home itself and the agent's data directory, compared by device and inode after following links, so a link or another letter case does not reach them.

### Editor pane

`EditorPane.tsx`, one per file per workspace.

- **Loading** (`GET /api/m/{id}/file`): binary files and invalid UTF-8 are offered for download, not opened, since a save could change what the editor did not show; a missing path opens empty; any other read error is shown, never an empty file.
- **Markdown** opens rendered (`web/src/markdown`), with Split and Source modes.
- **Links**: a path a pane links without a line is stat'ed first (`PluginDef.openFolder`); a folder is revealed in the tree instead of opening an editor.
- **Saving**: ⌘S/Ctrl+S is handled per editor (`plugins/saveKey.ts`), so Ctrl+S still reaches terminals. `POST …/write` carries the size and modification time the editor loaded; the agent receives the whole text, then checks the file is still as loaded. A change since is `409 conflict` and the pane offers **Load Theirs**, **Overwrite**, **Keep Editing**. The Git diff pane saves the same way.
- **Writing in place** (`machine/save.ts`), as VS Code does: open without following links, re-check the precondition on that descriptor, truncate, write, sync. The inode, hard links, owner, mode, xattrs and ACLs stay; nothing is created beside the file. A write failing after truncation answers `partial_write`; the pane keeps the text.
- **Mixed line endings**: Monaco normalizes them, so `git.mixedLineEndings` chooses `keep` (each line keeps its ending, `web/src/eol.ts`), `unify` or `readOnly`.
- **External changes**: the shown file is checked periodically; without unsaved changes a change reloads as one undoable edit, with them the conflict bar appears. A file deleted or moved away is struck through (`gone.ts`) and a save makes it again.
- **Quick diff** (`quickDiff.ts`): the gutter marks lines that differ from a provider's text (the Git plugin's index).
- **Undo history** outlives the pane: a model's URI is the file's (`file://<path>?m=<machine>`). Never `setValue` a model that shows text: that drops its history.

Monaco (`web/src/plugins/monaco.ts`) loads on first use with the JSON, CSS and HTML services; TypeScript's is left out (larger than the rest together). Code colors (`web/src/highlight`, shared with diffs, previews and Markdown) come from Shiki's TextMate grammars, colored by token role with the design tokens' `syntax` colors ([24](24-design-tokens.md)).

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A file-system watch pushed over `/ws` | Watchers need an owner, per-user limits and per-OS code; polling what is on screen stops with the panel. |
| Saving with the agent's `fs.write` | It replaces without looking. |
| Atomic save (temporary file, rename over) | Gives the path another inode: hard links keep the old text, ownership, xattrs and ACLs are lost, and the temporary file needs a writable directory others could exploit. |
| Replacing a folder on upload by removing it | Loses what the upload does not hold. |
| CodeMirror | The Git plugin's diffs want Monaco's diff editor. |
| Monaco's Monarch grammars | Too few languages (no Makefile, TOML, `.env`). |

## Failure modes

- Machine offline: the root shows the error, changes fail with `offline`, polls back off.
- A mount that does not answer: stats answer `busy` or `timeout`; the tree keeps what it shows.
- Conflicting save: `409`, nothing written. Write failing midway: `partial_write`, text kept in the pane.
- Upload cut short: nothing at the target; a staged file a killed agent leaves is removed later ([deployment](../deployment.md#remote-resources)).
- No trash for a location: `trash_unavailable`, permanent deletion offered.

## Security

[SECURITY.md](../../SECURITY.md) lists the explorer's guardrails (mutating routes, the guard above, the `0700` staging directory, Reveal's limits); otherwise the agent acts with the user's permissions, as a terminal does. A forced save (Overwrite, Save Again, Replace) writes whatever regular file is at the path then, so a user who can write the directory and hard-link the user's files could redirect it. Bounds: saves 8 MiB, uploads 4 GiB, path lists 1000, stats 200 paths.

## Testing

- `backend/features/files/machine.test.ts`, `machine/units.test.ts`, `machine/find.test.ts`: every action through the wire against real files (no-replace renames, trash layouts, refused paths, in-place saves, uploads, reveals, the filter).
- `backend/features/files/explorer.test.ts` (routes, audit, guards), `settings.test.ts`, `transfers.test.ts`.
- `web/src/__tests__/`: `files*.test.ts`, `termPlace.test.ts`, `editorPlacement.test.ts`, `quickDiff.test.ts`, `highlight.test.ts`; drags in `termPane.test.ts` and `conversationComposer.test.tsx`.
