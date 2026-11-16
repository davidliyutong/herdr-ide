# 28 · File explorer

## Context

Quick Look ([06](06-quick-look-and-files.md)) shows what a path in a pane
names, and VS Code panes ([05](05-vscode-panes.md)) browse and edit a
folder, but VS Code is a code-server per machine that takes a while to
start and a pane's worth of room. Looking around a project an agent works
in, renaming a file, dropping a few files into a directory or fixing a line
of a config should not need either. The right sidebar of plugins
([27](27-plugins.md)) has room for a tree beside the panes; a file opened
from it gets a pane of its own.

## Goals / non-goals

Goals: a tree of the shown machine's files that follows the focused
terminal's directory, with what VS Code's explorer does (expand, collapse,
filter, hidden files, the keyboard, new files and folders, rename, the
trash, delete, cut, copy and paste, drag and drop, copy paths, download,
open in a terminal or VS Code); files from the computer dropped on it are
uploaded; a click shows a file in Quick Look; text files open in an editor
pane that never overwrites a change made on the machine since it loaded the
file.

Non-goals: an IDE (language services beyond what Monaco has for JSON, CSS
and HTML, search across files: VS Code panes do that; version control:
the Git plugin, [31](31-git.md)); a
watch of the file system on machines (the panel polls what it shows);
restoring files from the trash (the system's file manager does that).

## Design

**Plugin** `files`: on by default (`plugins.files.enabled`), a panel of the
right sidebar (**Show Explorer**, `view.panel.files`, ⌘⇧E in the desktop
app on macOS) and a pane kind `editor`. The web side is
`web/src/plugins/files`, the core's `internal/plugins/files`, the
machine's `internal/agent/plugin/files`.

**Tree** (`tree.ts`, `FilesPanel.tsx`)

- The root is the focused terminal's directory (its foreground program's,
  as for splits), a VS Code pane's folder, or the workspace's directory
  when no pane has the focus. While a preview or an editor has the focus
  the tree stays where it is, so a click that opens Quick Look does not
  move it. **Follow** (the crosshair) turns this off; a crumb of the
  breadcrumb roots the tree at that directory and turns it off too. Follow
  and hidden files are kept per browser.
- Directories are listed with the core's `GET /api/m/{id}/list` when they
  are expanded. Expanded directories are kept by path, so going back to a
  directory shows it as it was. Folders come first, names sort as people
  sort them (`a2` before `a10`).
- The filter keeps entries whose names contain its text (case ignored) in
  the directories listed so far, and opens the folders that lead to them.
- Rows are drawn only where they are in view (fixed height), so a
  directory of thousands of entries scrolls without drawing them all.
- Keys on the tree: ↑ ↓ (with Shift to extend the selection), Home, End,
  → (expand, then the first child), ← (collapse, then the parent), Enter
  (open), Space (Quick Look), F2 (rename), Delete or ⌘⌫ (trash), Shift
  with them (delete for good, after asking), ⌘/Ctrl C, X, V, Escape (the
  clipboard, then the filter). The page's own shortcuts work as anywhere
  outside a terminal.
- A click selects (⌘/Ctrl adds, Shift extends), expands a folder or shows
  a file in Quick Look (`actions.openPreview`) and keeps the keyboard in
  the tree; a double click or Enter opens a file: media in Quick Look,
  anything else in the editor pane.
- Changes are typed in the tree: a new file or folder gets a row with a
  name field in its folder, F2 turns a row's name into one. Names with `/`,
  empty names, `.` and `..` are refused before anything is sent.
- The context menu: Open, Quick Look, Open in VS Code, Open in Terminal (a
  terminal split beside the focused pane, in the folder), New File, New
  Folder, Cut, Copy, Paste, Copy Path, Copy Relative Path (to the root),
  Download (`download.ts`; not for the desktop app's own machine), Rename,
  Move to Trash, Delete Permanently; on the empty part of the tree, the
  root's entries and Refresh, Collapse Folders.
- Drags: rows dragged onto a folder (or the empty part, the root, or a
  crumb) move there, with Alt they copy. Files from the computer are
  uploaded into the folder (`transfers.ts`, followed in the uploads tray);
  in the desktop app files of its own machine are copied where they are,
  not uploaded. Folders from another computer cannot be uploaded, as on
  panes.
- **Polling**: while the panel is shown and the page visible, every 2 s
  the panel asks `GET …/p/files/stat` for the modification times of the
  root and the expanded directories below it (at most 200) and lists
  again those that changed; one gone is dropped. A directory is listed once
  more the first time a poll sees it (its listing may be older than the
  time). Nothing runs on the machine between requests and nothing is
  watched once the panel is hidden.
- **Decorations**: `registerFileDecorations(provider)`
  (`decorations.ts`) lets another plugin color names and add a badge and a
  tooltip, per directory (version control status); `refreshDecorations()`
  draws them again.

**Changes** go through the plugin's routes, each audited as
`files.<action>` and refused in read-only mode, where the menu and the keys
offer none (`ops.ts`). The agent's actions (`internal/agent/plugin/files`):

| Action | What it does |
| --- | --- |
| `mkdir`, `create` | A folder, an empty file; a taken name fails with `exists`. |
| `rename` | One path to another; never replaces (`renameat2` with `RENAME_NOREPLACE` on Linux, `renamex_np` with `RENAME_EXCL` on macOS, a check first on file systems without them); not into itself. |
| `move` | Paths into a folder under their names, replacing nothing: a taken name fails for that path alone (`failed`), the others move. |
| `copy` | Paths into a folder: files with their modes, folders with their contents, links as links; a taken name becomes `name copy.ext`, `name copy 2.ext`… (a copy into the same folder). |
| `trash` | Into the user's trash: on macOS `~/.Trash` (`name 2.ext`… when taken); elsewhere the freedesktop.org trash, `$XDG_DATA_HOME/Trash` (`~/.local/share/Trash`) with an info file holding the original path and the time, or, for a path on another file system, `.Trash-<uid>` at the top of its mount. A path no trash takes fails with `trash_unavailable`, and the panel offers to delete it for good. |
| `remove` | Deletes for good (folders with their contents). |
| `write` | An editor's save, below. |
| `stat` | Size, modification time and kind of up to 200 paths, for the polls and the editor. |

Every path is expanded as the agent's other operations do (`~`, relative to
home). The agent refuses (`refused`) the root, any directory that holds
the home directory (the home directory too) and the agent's own data
directory (`~/.<slug>[-<instance>]`) and everything in it, also when a
path reaches them through a symbolic link in its directory. A list of
paths (trash, remove, move, copy) holds at most 1000; one that fails alone
fails the request, several report the failed ones by code.

**Editor pane** (`EditorPane.tsx`, `{view: {plugin: 'files', kind:
'editor', path}}`; one per file in a workspace, opened again it is
focused). Its title is the file's name, new terminals beside it start in
its directory.

- It reads the file with `HEAD` and `GET /api/m/{id}/file`; the response's
  ETag carries the size and modification time the save sends back. Files
  over 8 MiB, binary files (a NUL in the first 8000 bytes) and text that is
  not valid UTF-8 are not opened (a save could change what the editor did
  not show); the pane offers Quick Look. A path not there yet opens empty
  and is created by the first save.
- ⌘S (Ctrl+S) or the toolbar saves: `POST …/p/files/write?path=&mtime=&size=`
  with the text as the body (`new=1` for a file not there yet, `force=1`
  to overwrite). The agent checks the file is as loaded, writes a
  temporary file beside it, checks again and renames it over the file,
  keeping its mode; through a symbolic link the link's target is written.
  A file changed or removed meanwhile is a `409 conflict` with its state
  now: the pane says so and offers **Load Theirs**, **Overwrite** and
  **Keep Editing**.
- Every 5 s while it is shown, the pane checks the file's state: unchanged
  text is loaded again when the file changed on the machine; text with
  unsaved changes gets the conflict bar at once.
- Closing the pane (or its tab or workspace) with unsaved changes asks
  **Save**, **Don't Save** or **Cancel** first
  ([04](04-layout-and-keyboard.md)).
- **Show in Explorer** reveals the file in the tree; outside its root the
  tree stops following and shows the file's folder.

**Monaco** (`web/src/plugins/monaco.ts`) is the editor of the editor pane
and of later plugins' panes (diffs): loaded on first use (dynamic imports,
so the main bundle does not grow), with its editor features, every
language's colors and the services of JSON, CSS and HTML, each with its
worker; TypeScript's service and worker are left out (larger than the rest
together; TypeScript and JavaScript keep their colors). Its theme is made
from the design tokens of the app's light or dark theme and follows them,
its font is the terminal's. Its chunks ship without source maps
(`vite.config.ts`), its license and third-party notices are in
`licenses.md`. `createEditor` and `createDiffEditor` give a plugin an editor
in an element.

### Routes

| Route | Writes | Purpose |
| --- | --- | --- |
| `GET /api/m/{id}/p/files/stat` | – | `?path=`… (1–200): `{"entries": [{path, exists, is_dir, size, mtime}]}`. |
| `POST /api/m/{id}/p/files/mkdir` | writes | `{"path"}`. |
| `POST /api/m/{id}/p/files/create` | writes | `{"path"}`: an empty file. |
| `POST /api/m/{id}/p/files/rename` | writes | `{"path", "to"}`. |
| `POST /api/m/{id}/p/files/move` | writes | `{"paths", "dir"}`. |
| `POST /api/m/{id}/p/files/copy` | writes | `{"paths", "dir"}`. |
| `POST /api/m/{id}/p/files/trash` | writes | `{"paths"}`. |
| `POST /api/m/{id}/p/files/remove` | writes | `{"paths"}`. |
| `POST /api/m/{id}/p/files/write` | writes | The body (at most 8 MiB) into `?path=`, with `&mtime=&size=`, `&new=1` or `&force=1`; `409 {"error": "conflict", "current"}`. |

Changes answer `{"paths": [made], "failed": {path: code}}`; failures
`{"error": code}` with `not_found` (404), `exists`, `refused`, `denied`,
`trash_unavailable`, `too_large`, `bad_params`, `offline` (409).

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A file system watch on machines (inotify, FSEvents) pushed over `/ws` | A watcher per expanded directory on every machine needs an owner, limits (inotify's per-user watches) and code per system; polling the directories on screen every 2 s costs one stat each and stops with the panel. |
| Writing saves with the agent's `fs.write` (uploads) | It replaces the file without looking; a save must not overwrite a change a program made since the editor loaded the file. |
| Deleting without a trash | A mistaken Delete in a tree is easy; the trash keeps the file where the system's tools find it. |
| CodeMirror instead of Monaco | The diffs of a version control plugin want Monaco's diff editor; one editor for both. |
| The full Monaco bundle with TypeScript's service | Its worker and source maps grew the embedded UI by more than the whole app; VS Code panes have TypeScript. |
| Opening files in VS Code only | code-server takes a while to start on each machine and a pane's room; a small fix should not need it. |

## Failure modes

- Machine offline: listings fail and the tree shows the error at its root;
  changes fail with `offline`; polls fail quietly and try again.
- A path changed by someone else between a listing and a change: the change
  fails (`not_found`, `exists`) and the next poll shows the directory as it
  is.
- No trash for a location (another volume on macOS, a mount without a
  trash it can make): `trash_unavailable`, and the panel asks whether to
  delete for good.
- A save into a file that changed since it was loaded: `409 conflict`,
  nothing written, the pane offers to load or overwrite.
- A save that breaks off: the temporary file (`.<slug>-save-*` beside the
  file) is removed; the file is as it was.
- An older agent during an upgrade: actions fail with `unknown_plugin`.
- A plugin turned off: its routes answer `404 plugin_disabled`, the panel is
  gone and editor panes say the plugin is off.

## Security

Every change is a mutating route: refused in read-only mode, audited
(`files.mkdir`, `files.rename`, …), behind the core's guards. The agent
refuses the root, directories above the home directory, the home directory
itself and its own data directory, so the explorer cannot delete the
machine's or its own state wholesale; within them it acts with the user's
permissions, as a terminal does. Saves are bounded to 8 MiB, lists of
paths to 1000, stats to 200. Files moved to the trash stay in the user's
trash ([deployment](../deployment.md#remote-resources)).

## Testing

- `internal/agent/plugin/files/files_test.go` (HOME in a temporary
  directory): each action, renames and moves that replace nothing, copies
  with new names, links and into itself, both trash layouts (info files,
  unique names, relative paths of a mount's trash), the refused paths
  (also through a link), saves with their precondition (changed, removed,
  new, forced, through a link, too large, no temporary file left).
- `internal/plugins/files/files_test.go`: the routes (all but `stat`
  mutating and audited) and a save's query; `TestMutatingRoutesAreGuarded`
  (`internal/server`) checks them for Origin and read-only mode.
- `web/src/__tests__/files.test.ts`: rows (order, hidden files, the filter,
  a new entry's row), breadcrumb and paths, the root following the focused
  terminal, the keyboard, the context menu's changes and the routes they
  call, Delete and Shift+Delete, polling, read-only mode, decorations.
- `web/src/__tests__/filesEditor.test.ts` (Monaco replaced): versions from
  the ETag, saves with them, conflicts overwritten and loaded, new files,
  read-only mode, files that are not text.
