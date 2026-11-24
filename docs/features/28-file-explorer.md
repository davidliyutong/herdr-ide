# 28 · File explorer

## Context

Quick Look ([06](06-quick-look-and-files.md)) shows what a path in a pane
names, and VS Code panes ([05](05-vscode-panes.md)) browse and edit a
folder. But code-server takes a while to start on each machine and takes a
pane's room. Looking around a project an agent works in, renaming a file,
dropping in a few files or fixing a line of a config should need neither.
The plugins' right sidebar ([27](27-plugins.md)) has room for a tree beside
the panes; a file opened from it gets a pane of its own.

## Goals / non-goals

Goals:

- A tree of the shown machine's files that follows the focused terminal's
  directory, with what VS Code's explorer does: keyboard, filter, hidden
  files, new files and folders, rename, trash, delete, cut/copy/paste,
  drag and drop, copy paths, download, open in a terminal or VS Code, and
  Reveal in Finder for the core's own computer.
- Uploads of files and folders from the computer, with their structure,
  asking about names taken; rows dragged out of the page download.
- An editor pane (Monaco; media as Quick Look shows it) with VS Code's
  preview editors, that **never overwrites a change made on the machine
  since it loaded the file**, and marks files deleted or moved away.
- Version control status in the tree's colors and the editor's gutter.

Non-goals: an IDE (language services beyond Monaco's JSON, CSS and HTML,
search across files is Project Search, [41](41-project-search.md);
version control is the Git plugin, [31](31-git.md)); a file-system watch on machines; restoring from
the trash.

## Design

Plugin `files`, on by default: a right-sidebar panel (**Show Explorer**,
`view.panel.files`) and the pane kind `editor`. Code:
`web/src/plugins/files`, `internal/plugins/files` (core),
`internal/agent/plugin/files` (machine). Settings (`files.showHidden`,
`files.exclude`, `files.sortOrder`, `files.followFocus`,
`files.confirmTrash`) are listed in [reference.md](../reference.md).

### Tree

- **Root.** The focused terminal's directory, a VS Code pane's folder, or
  the workspace's directory (`FilesPanel.tsx` `rootFor`). A terminal's
  directory (`web/src/term/place.ts`) comes from the terminal core's record
  of the foreground program:
  - a shell's (or a terminal file manager's) directory is followed as it
    changes;
  - another program's is taken only once it stayed put for 1.5 s
    (`SETTLE_MS`), so `cd project && claude` moves the tree there, while a
    program walking a tree (`tar`, `find`, a build) leaves it — and the Git
    panel, the status bar and new terminals' directory — where the shell was.

  While an editor or preview has the focus the root stays put; another
  workspace or machine takes its own directory at once, before painting,
  so the panel never shows one machine's directory under another or asks a
  machine about another's paths. The **Follow** crosshair or a breadcrumb
  crumb turns following off.
- **Listings** come from `GET /api/m/{id}/list` when a folder is expanded.
  Expanded folders are remembered by path (at most 500). A failed listing
  keeps what was shown and is retried by the next poll; the root shows an
  error only when nothing of it is listed or it failed twice in a row
  (`tree.ts` `shownError`), since a single failure is often a busy machine.
- **View state per root.** Expanded folders, selection, cursor, filter and
  scroll position are remembered per machine and root (at most 32) and
  restored on return, across tabs, panels, workspaces and machines. The
  scroll position is recorded only from scroll events of the root they
  show (the browser clamps it while another root is listed) and restored
  once the rows are tall enough. An unvisited root starts without a
  selection, so a key never acts on rows the tree no longer shows.
- **Reveal the focused editor.** When the focused pane is an editor whose
  file is under the root, the tree expands to that row, selects it and
  scrolls it into view; a file outside the root leaves the root alone.
- **Polling, not watching** (`poller.ts`). While the panel is visible, every
  2 s it stats the shown directories (at most 200) through
  `POST …/p/files/stat` and lists again those that changed. One poll at a
  time; after failures the wait doubles up to a minute. Nothing runs on the
  machine between requests or once the panel is hidden.
- **Rows** are the shared virtualized tree rows ([27](27-plugins.md)) with
  file-type icons in the design tokens' hues ([24](24-design-tokens.md)),
  so thousands of entries scroll cheaply. Names sort naturally (`a2` before
  `a10`); the filter matches names case-insensitively in listed folders.
- **Keys** follow VS Code's explorer on each system (arrows, PgUp/PgDn,
  Home/End, type-ahead, Space for preview, Delete/⌘⌫ to trash, Shift for
  permanent delete, ⌘/Ctrl C/X/V, Escape): on macOS Enter renames and ⌘O
  or ⌘↓ opens; elsewhere Enter opens and F2 renames. A cut stays on the
  clipboard until its paths are moved.
- **Editors open in tabs** of the workspace, never split into the shown tab.
  A click shows the file in the workspace's single **preview editor**
  (italic title), replaced by the next click; a double click, the open key, the pin
  button or a first edit keeps it. A preview with unsaved changes is never
  replaced.
- **Context menu** and the panel's **…** menu hold the actions above plus
  Open to the Side, Open Changes (the Git plugin's diff), Upload
  Files/Folder…, Copy Relative Path, Download (a zip for folders and
  several rows, `download.ts`), Refresh and Collapse Folders. Several
  selected rows apply where it makes sense. The entries that open, copy and
  download paths are shared with other file lists (`ops.ts`
  `fileMenuEntries`, `revealInExplorer`), e.g. the Git panel's rows.
- **Drags.** Rows dropped onto a folder move (Alt copies). Dropped out of
  the page they download through `DownloadURL` (Chromium and the desktop
  app; Firefox and Safari ignore it), not for the desktop app's own machine.
- **Uploads** (`upload.ts`): dropped, chosen or pasted (from the system
  clipboard onto the focused tree) files and folders keep their
  structure (at most 10 000 entries). Each taken name is asked about once:
  **Replace** (a file written in place as a save is; a folder merged, never
  removed first), **Keep Both** (`name-1.ext`), **Skip**, **Cancel** (stops
  the whole upload). Folders are made first, then a folder's files go as one
  upload in the uploads panel. In the desktop app, files of its own machine
  are copied, not uploaded.
- **Reveal in Finder** (Reveal in File Manager on Linux): only for the
  core's own machine and only to a page on that computer (the desktop app,
  or a browser on the core's loopback, the core's `SameHost`). A window on a
  remote screen would help nobody. The page asks `GET …/p/files/reveal`;
  the core checks again on `POST`.
- **Decorations** (`decorations.ts`): `registerFileDecorations` lets
  another plugin color names and add badges per directory. The panel
  publishes the directories it shows (`useShownDirs`), so the Git plugin
  colors the tree without its own panel open ([31](31-git.md)).

### Changes on the machine

Every change is a plugin route, refused in read-only mode (the UI offers
none there) and audited as `files.<action>` with its paths (first 50) and
outcome. The agent's actions:

| Action | What it does |
| --- | --- |
| `mkdir`, `create`, `mkdirs` | A folder, an empty file, folders with parents. A taken name fails with `exists`; `unique` picks `name-1`… |
| `rename`, `move` | Never replace (`renameat2`/`RENAME_NOREPLACE` on Linux, `renamex_np`/`RENAME_EXCL` on macOS, a check first elsewhere). Across file systems: copy, then remove the original. |
| `copy` | Files with modes, folders with contents, links as links; taken names become `name copy.ext`. Never into itself, also through a link. |
| `trash` | macOS `~/.Trash`; elsewhere the freedesktop.org trash, or the top-of-mount trash for another file system. A mount's trash is used only if it is the user's own, not a link and closed to others (as gio checks). Otherwise `trash_unavailable`, and the panel offers to delete for good. |
| `remove` | Deletes for good without following links (as `os.RemoveAll`). |
| `write` | An editor's save, below. |
| `upload` | Up to 4 GiB, received in full into the agent's private `staging/` directory, then written under a free name, or in place with `replace`. A cut-short upload leaves nothing at the path. |
| `reveal` | `/usr/bin/open -R <path>` on macOS; `xdg-open <folder>/` elsewhere, found in fixed system directories, never `PATH`. No shell, standard streams on `/dev/null`, answers within 10 s, at most 4 waited for. |
| `stat` | Up to 200 paths. At most 8 stats run at once and each answers within 10 s (`busy`/`timeout`), so a dead mount holds few threads. |

Copies and removals stop between entries (and between 1 MiB chunks) once
the core's request ends; a partial copy is removed.

**Refused paths.** Paths expand as every agent operation's (`~`, relative
to home). The agent refuses (`refused`) the root, any directory holding the
home directory, the home directory itself, and its own data directory
(`~/.<slug>[-<instance>]`) with everything in it. It compares by name and by
file identity (`os.SameFile`) after following links in the path's
directories, so a home reached through a link or another letter case on a
case-insensitive volume is refused too. Lists of paths hold at most 1000.

### Editor pane

`EditorPane.tsx`, view `{plugin: 'files', kind: 'editor', path, preview}`;
one per file per workspace. Images, video, audio and PDFs show as in Quick
Look (`MediaView`).

- **Loading.** `HEAD`/`GET /api/m/{id}/file`; the ETag carries size and
  modification time. Files over 8 MiB, binary files (a NUL in the first
  8000 bytes) and invalid UTF-8 are not opened — a save could change what
  the editor did not show — and are offered for download. A missing path
  (404) opens empty and the first save creates it; any other read error is
  shown, never an empty file. A UTF-8 BOM is preserved.
- **Mixed line endings.** Monaco normalizes endings, so a save would rewrite
  every line. `git.mixedLineEndings` ([31](31-git.md)) chooses `keep`
  (default: each line keeps its ending, `web/src/eol.ts`), `unify` or
  `readOnly`.
- **Quick diff** (`quickDiff.ts`): the gutter marks lines that differ from
  what a provider (`registerQuickDiff`; the Git plugin's index text) gives,
  unsaved changes included; **Open Changes** opens the provider's diff.
- **Saving.** ⌘S/Ctrl+S is handled per editor (`plugins/saveKey.ts`), not
  app-wide, so Ctrl+S still reaches terminals. The save is
  `POST …/p/files/write?path=&mtime=&size=` (`new=1`, `force=1`). The agent
  receives the whole text and checks the file is as loaded before touching
  it; a change since is `409 conflict`, and the pane offers **Load
  Theirs**, **Overwrite**, **Keep Editing**. The Git diff pane saves through
  the same route.
- **Writing in place** (`save.go`), as VS Code writes a user's file: open
  without following links anywhere on the real path (`O_NOFOLLOW_ANY` on
  macOS, `openat2` `RESOLVE_NO_SYMLINKS` on Linux) and without blocking;
  require a regular file; re-check the precondition on that descriptor;
  truncate, write, sync. Through a symbolic link the target is written and
  the link stays. The inode, hard links, owner, mode, xattrs and ACLs stay;
  no temporary file or backup is written. A read-only file is refused
  (`denied`). A new file gets `0666` minus the umask.
- **Partial writes.** A write failing after truncation (disk full) answers
  `partial_write` with the cause; the pane keeps the text and offers **Save
  Again**. A new file whose write failed is removed. Readers of the file
  during the write may see part of it, as with VS Code.
- **External changes.** Every 5 s while shown, the pane checks the file.
  Unchanged text reloads as one undoable edit (the cursor stays), a change
  of line ends as another; text with unsaved changes gets the conflict bar
  at once. **Keep Editing** dismisses
  the bar until the next change.
- **Files gone** (`gone.ts`): an editor whose file was deleted or moved away
  has its title struck through ("Deleted"), as VS Code does; the text stays
  and a save makes the file again. The shown editors' and preview panes'
  paths are stat'ed together, one request per machine every 5 s; the
  explorer's own changes mark at once.
- Closing with unsaved changes asks **Save / Don't Save / Cancel**
  ([04](04-layout-and-keyboard.md)). Unsaved text and Monaco's view state
  (cursor, selection, scroll, folding) survive the pane not being drawn
  ([27](27-plugins.md)); closing the pane drops them.
- **Undo history** outlives the editor as in VS Code: a model's URI is the
  file's (`file://<path>?m=<machine>`, with `&pane=<pane>` for a second
  pane of a file shown at once), and it is made with the file's text, so
  Monaco gives a file opened again with the text it closed with the history
  it had (20 MB of closed files' history at most). A file changed
  meanwhile starts without one. Never `setValue` a model that shows text:
  that drops its history.
- **Show in Explorer** reveals the file in the tree; outside its root the
  tree stops following and shows the file's folder.

### Monaco and code colors

**Monaco** (`web/src/plugins/monaco.ts`) is loaded on first use with the
JSON, CSS and HTML services; TypeScript's service is left out (larger than
the rest together; VS Code panes have it). Its theme is built from the
design tokens and its font is the terminal's. `createEditor` and
`createDiffEditor` serve other plugins.

**Code colors** (`web/src/highlight`) are shared by editors, diffs, the
preview pane and Markdown code blocks:

- TextMate grammars from Shiki, about 125 languages (`languages.ts`), each a
  lazily loaded chunk, run by the browser's regex engine.
- `languageOf` tells a language by whole name, name prefix, extension or
  shebang line.
- Tokens are colored by **role** (`roles.ts`: comment, keyword, string…),
  and the design tokens' `syntax` colors give each role its color
  ([24](24-design-tokens.md)). Text is tokenized once; switching themes
  only recolors.
- Code over 300 000 characters or lines over 20 000 stay plain.
- Package-only chunks ship without source maps (`vite.config.ts`); notices
  are in `licenses.md`.

### Routes

All below `/api/m/{id}/p/files/`; each is listed in
[reference.md](../reference.md).

| Route | Purpose |
| --- | --- |
| `POST stat` | Up to 200 paths. A POST because 200 paths overflow a URL; read-only, not audited. |
| `POST mkdir`, `mkdirs`, `create`, `rename`, `move`, `copy`, `trash`, `remove` | The actions above. |
| `POST write` | A save (body at most 8 MiB); `409 {"error": "conflict", "current"}`. |
| `POST upload` | Body streamed (at most 4 GiB) to a free name, or in place with `&replace=1`. |
| `GET reveal` / `POST reveal` | Whether Reveal is offered / do it; `400 remote_machine`, `403 local_only`. |

Changes answer `{"paths": [made], "failed": {path: code}}`; failures
`{"error": code}` (`not_found`, `exists`, `refused`, `denied`,
`trash_unavailable`, `too_large`, `no_space`, `partial_write`, `offline`, …).

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A file-system watch (inotify, FSEvents) pushed over `/ws` | Watchers need an owner, per-user limits and per-OS code; polling what is on screen costs one stat per folder and stops with the panel. |
| Saving with the agent's `fs.write` | It replaces without looking; a save must not overwrite a change made since loading. |
| Atomic save (write a temporary file, rename over) | Gives the path another inode: hard links keep the old text, ownership, xattrs, ACLs and macOS tags are lost, `tail -f` and single-file bind mounts lose it, and it needs a writable directory and leaves a temporary file other users could swap. |
| Rename or write-in-place by case (Vim's `backupcopy=auto`), or a backup before writing | Two code paths and staged files to protect; a backup only helps a failed write, which the editor survives by keeping the text. |
| Uploading through the core's `/upload` | It cannot replace or make folders and lacks the explorer's guard. |
| Asking about each file of a merged folder; replacing a folder by removing it | Hundreds of questions; removal loses what the upload does not hold. |
| Deleting without a trash | A mistaken Delete is easy; the trash keeps the file where the system's tools find it. |
| CodeMirror | The Git plugin's diffs want Monaco's diff editor; one editor for both. |
| Monaco's Monarch grammars; Shiki's themes or Oniguruma engine | Too few languages (no Makefile, TOML, `.env`); themes would need re-tokenizing; a second WebAssembly module. |
| Opening files only in VS Code | Slow to start and a pane's room for a small fix. |

## Failure modes

- **Machine offline:** listings show the error at the root, changes fail
  with `offline`, polls back off up to a minute.
- **A mount that does not answer:** stats answer `busy`/`timeout` within
  10 s; the tree keeps what it shows.
- **Huge directories:** listings are capped at 20 000 entries.
- **Conflicting save:** `409`, nothing written. **Save cut short** before
  the text arrived: file unchanged. **Write failing midway:**
  `partial_write`, file possibly truncated, text kept in the pane.
- **Upload cut short:** nothing at the target; a replaced file is as it was.
  If the agent is killed, the staged file stays in
  `~/.<slug>/staging/` for 7 days
  ([deployment](../deployment.md#remote-resources)).
- **No trash for a location:** `trash_unavailable`, the panel offers
  permanent deletion.
- **Reveal without a display:** `xdg-open` fails and the menu says so.
- **Plugin off:** routes answer `404 plugin_disabled`; editor panes say so.
  An older agent answers `unknown_plugin`.

## Security

- Every change is a mutating route: Origin-checked, refused in read-only
  mode, audited.
- The agent refuses the root, directories above home, home itself and its
  own data directory, by name and file identity, so the explorer cannot
  delete the machine's or its own state wholesale. Otherwise it acts with
  the user's permissions, as a terminal does.
- A top-of-mount trash is used only when it is the user's own and closed to
  others, so trashed files never go into a directory another user planted.
- A save writes only the named file (a link's target), in place, through the
  descriptor it checked, and creates nothing beside it. A forced save
  (Overwrite, Save Again, Replace) writes whatever regular file is at the
  path then; a user who can write the directory and hard-link the user's
  files could redirect it ([SECURITY.md](../../SECURITY.md)).
- Uploads are staged in the agent's `0700` `staging/` directory and pass the
  same guard.
- Reveal in Finder runs a program on the core's host: only for the core's
  own machine and a client on that host (`SameHost`), the path as its own
  argument, never shell text. A browser reaching the core through an ssh
  forward counts as on the host and opens the window there.
- Bounds: saves 8 MiB, uploads 4 GiB, path lists 1000, stats 200 paths and 8
  concurrent, reveals 4.

## Testing

- `internal/agent/plugin/files/`: `files_test.go` (each action, no-replace
  renames and moves also across file systems, copies through links, both
  trash layouts and planted mount trashes, refused paths through links and
  case, dead mounts), `save_test.go` (in-place saves keeping inode, links
  and mode; FIFOs refused; links swapped in; `partial_write`;
  `PruneStaged`), `upload_test.go`, `remove_test.go`, `reveal_test.go`.
- `internal/plugins/files/`: routes, audit records, settings,
  `TestRevealGate`; `internal/server` `TestMutatingRoutesAreGuarded`,
  `list_test.go` (large listings), `download_test.go`;
  `internal/agent/serve_test.go` `TestServeWaitsForRequestsToClean`.
- `web/src/__tests__/`: `files.test.ts` (rows, keys, menus, polling,
  settings, decorations), `filesUpload.test.ts`, `filesEditor.test.ts`
  (versions, conflicts, line endings, reloads), `filesGone.test.ts`,
  `filesFollow.test.ts`, `termPlace.test.ts`, `editorPlacement.test.ts`,
  `highlight.test.ts` (languages, roles, 4.5:1 contrast of syntax colors).
