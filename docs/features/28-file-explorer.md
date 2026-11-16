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
open in a terminal or VS Code); files and folders from the computer
dropped on it or chosen in its menus are uploaded with their structure,
asking about names taken, and rows dragged out of the page download; a click shows a file in a preview editor that the next click
replaces and a double click keeps, as VS Code's preview editors (media
too, as Quick Look shows them); the editor never overwrites a change made
on the machine since it loaded the file; files changed in version control
are colored in the tree and the editor's gutter marks the changed lines.

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

**Settings** (section `files`, the plugin's page in Settings ›
Plugins; `internal/plugins/files/settings.go`):

| Setting | Default | What it does |
| --- | --- | --- |
| `files.showHidden` | off | Names starting with a dot are shown, in browsers where the panel's eye button was not used (each browser keeps the choice it made there). |
| `files.exclude` | `.git`, `.svn`, `.hg`, `CVS`, `.DS_Store`, `Thumbs.db` | Patterns of names the tree never shows, as VS Code's `files.exclude`: `*`, `?`, `[abc]`, `[!abc]`; a leading `**/` matches the same; no other `/` (at most 100 patterns). Folders excluded are neither shown nor polled, also with hidden files shown. |
| `files.sortOrder` | `default` | Folders first (`default`), `mixed`, `filesFirst`, by extension (`type`) or newest first (`modified`), folders first in those two; names sort as people sort them after. |
| `files.followFocus` | on | The root follows the focused pane, in browsers where the crosshair was not used. |
| `files.confirmTrash` | off | Move to Trash asks first (Delete Permanently always does). |
| `files.saveMethod` (per machine) | `auto` | `auto` saves in place when a rename would lose something, as below; `replace` always renames a new file over the old one (hard links keep the old text, the file becomes the user's, a folder the user may not write cannot take a save). The core sends it to the agent with each save and replacing upload. |

**Tree** (`tree.ts`, `FilesPanel.tsx`)

- The root is the focused terminal's directory (its foreground program's,
  as for splits), a VS Code pane's folder, or the workspace's directory
  when no pane has the focus. While a preview or an editor has the focus
  the tree stays where it is, so a click that opens a preview does not
  move it. **Follow** (the crosshair) turns this off; a crumb of the
  breadcrumb roots the tree at that directory and turns it off too. Follow
  and hidden files are kept per browser once its buttons were used, else
  the settings `files.followFocus` and `files.showHidden` decide.
- Directories are listed with the core's `GET /api/m/{id}/list` when they
  are expanded. Expanded directories are kept by path (at most 500; beyond
  that the oldest outside the root are forgotten), so going back to a
  directory shows it as it was, listed again. Only the listings of the
  root and the expanded directories below it are kept: another root, or
  Collapse Folders, drops the rest. Another root also clears the selection
  and the cursor, so a key never acts on rows the tree no longer shows. A
  listing that fails keeps the entries listed before, with the error
  beside them (the root's is shown). Folders come first (`files.sortOrder`), names sort as
  people sort them (`a2` before `a10`).
- The filter keeps entries whose names contain its text (case ignored) in
  the directories listed and kept, opens the folders that lead to them,
  and marks the text in each name.
- Rows are the shared tree rows ([27](27-plugins.md), `components/tree`):
  indent guides, a twisty, the file type's icon (`fileIcons.tsx`: special
  names such as `package.json`, `Dockerfile` or `README.md`, compound
  extensions such as `.d.ts` or `.tar.gz`, extensions, special folders
  such as `.git`, `src` or `node_modules`, in the design tokens' file icon
  hues, [24](24-design-tokens.md); a symbolic link has the link icon of
  its kind in its type's color), the name and a decoration. They are drawn
  only where they are in view (fixed height), so a directory of thousands
  of entries scrolls without drawing them all.
- Keys on the tree: ↑ ↓ PgUp PgDn Home End (with Shift to extend the
  selection), → (expand, then the first child), ← (collapse, then the
  parent), ⌘A (Ctrl+A elsewhere) selects every row shown, letters go to
  the next row whose name starts with them (type-ahead), Enter
  (open, kept; on a selection of several, its files), Space (preview, the keyboard stays in the tree), F2 (rename), Delete or ⌘⌫ (trash), Shift
  with them (delete for good, after asking), ⌘/Ctrl C, X, V, Escape (the
  clipboard, then the filter). Arrows with ⌘, Ctrl or Alt are left to
  the page's shortcuts. The keys act on the selected rows the tree
  shows; V pastes into the cursor's folder, or the root when the cursor is
  on no row. A cut stays on the clipboard until its paths are moved: the
  ones that failed to move stay on it. The page's own shortcuts work as anywhere
  outside a terminal.
- A click selects (⌘/Ctrl adds, Shift extends), expands a folder or shows
  a file in the workspace's **preview editor** (`openEditor` with
  `preview`) and keeps the keyboard in the tree; the next click shows its
  file in the same pane, as VS Code's preview editors do, so browsing
  files does not fill the workspace with panes. A double click or Enter
  keeps the file open: an editor showing it already is kept (no longer a
  preview), else it opens in an editor of its own. The preview's title is
  in italics in its header and tab; the pin button of its bar, a double
  click or its first edit keeps it. A preview with unsaved changes is
  never replaced. One pane kind shows every file: text in Monaco, media
  (images, video, audio, PDF) as Quick Look shows them.
- Changes are typed in the tree: a new file or folder gets a row with a
  name field in its folder, F2 turns a row's name into one. Names with `/`,
  empty names, `.` and `..` are refused before anything is sent.
- The context menu: Open (the files of the selection, several at once),
  Open to the Side (a kept editor beside the focused pane, as Open places
  editors), Open Preview, Open in VS Code, Open in Terminal (a terminal
  split beside the focused pane, in the folder; these three for one row),
  Open Changes (a file version control marks as changed, with a letter:
  the quick diff provider's diff, the Git plugin's), New File, New
  Folder, Upload Files…, Upload Folder… (on a folder), Cut, Copy, Paste,
  Copy Path, Copy Relative Path (to the root), Download (`download.ts`, a
  zip for folders and several rows; not for the desktop app's own
  machine), Rename, Move to Trash, Delete Permanently; on the empty part
  of the tree, the root's entries and Refresh (the shown directories
  listed again), Collapse Folders, Show Uploads and Show Downloads (the
  status bar's panels). The panel's **…** button has New File, New Folder,
  Upload Files… and Upload Folder… (into the cursor's folder, else the
  root), Download of the selection, Refresh, Collapse Folders and the
  transfers.
- Drags: rows dragged onto a folder (or the empty part, the root, or a
  crumb) move there, with Alt they copy; the folder under the pointer is
  highlighted, the whole tree for the root. Dropped out of the page onto
  the computer they download (`DownloadURL`: one file as itself, folders
  and several rows as the zip the core makes; Chromium's browsers and the
  desktop app take it, Firefox and Safari ignore it), also in read-only
  mode, but not from the desktop app's own machine. Such a download is the
  browser's own: it does not show in the downloads panel, which hears
  only of downloads the page started.
- **Uploads** (`upload.ts`): files and folders dropped from the computer,
  or chosen with Upload Files… and Upload Folder… (the browser's dialog),
  go into the folder with their structure: a dropped folder is read with
  everything in it (`webkitGetAsEntry`, its readers' batches; items that
  cannot be read are left out with a note), a chosen one from its files'
  relative paths (the browser does not tell its empty folders); at most
  10 000 entries at once. Names already in the folder are asked about
  once each (**Replace**, **Keep Both**, **Skip**, Escape skipping, a box
  applying the answer to the rest): a replaced file is written as a save
  writes it (in place when a rename would lose something), a replaced
  folder is merged (its files replace those of the same names, the others
  stay), Keep Both gives the upload a free name (`name-1.ext`, a folder
  `name-1`). A name taken by the other kind (a file where a folder is
  dropped) is kept beside without asking. A folder's folders are made
  first (`mkdir` with `unique`, then `mkdirs` for its deepest ones), then
  its files go one after the other as one upload of the uploads panel
  (`transfers.ts` `uploadPlaced`: the progress of its files together,
  Cancel stopping it, what arrived staying; a file that fails does not
  stop the others, and the upload fails saying how many did); each file
  dropped alone is an upload of its own. In the desktop app files of its
  own machine are copied where they are (`copy`), not uploaded.
- **Polling**: while the panel is shown and the page visible, every 2 s
  the panel asks `POST …/p/files/stat` for the modification times of the
  shown directories, the root and the expanded ones below it that are not
  in a collapsed folder (nor, without hidden files, in a hidden one; at
  most 200), and lists again those that changed; one gone is dropped, one
  whose state is not known (an `error`: a mount that does not answer, no
  permission) stays as it is. A directory is listed once more the first
  time a poll sees it (its listing may be older than the time). A time is
  recorded once the listing after it succeeds, so a failed listing is
  tried again by the next poll. The next poll is planned when the last
  one (its listings included) ended, never two at once; after a failed
  one the wait doubles, up to a minute (`poller.ts`). Nothing runs on the
  machine between requests and nothing is watched once the panel is
  hidden.
- **Decorations**: `registerFileDecorations(provider)`
  (`decorations.ts`) lets another plugin color names and add a badge and a
  tooltip, per directory (version control status); `refreshDecorations()`
  draws them again. While the panel is shown it publishes the directories
  it shows (its root and the expanded ones not in a collapsed folder,
  `useShownDirs`), so a provider
  can follow them: the Git plugin watches their repositories
  ([31](31-git.md)), and the tree is colored as VS Code's without the Git
  panel open.

**Changes** go through the plugin's routes, each audited as
`files.<action>` once it ended, with the paths it acted on (`path`, `to`,
`dir`, the first 50 of `paths` with their `count`) and how it ended
(`status`, `error`), and refused in read-only mode, where the menu and the
keys offer none (`ops.ts`). A copy or a removal stops between entries, and
between 1 MiB chunks of a file, when the core stops waiting for it (its
request ended, 10 minutes at most); a partial copy is removed, what a
removal reached stays removed. The agent's actions
(`internal/agent/plugin/files`):

| Action | What it does |
| --- | --- |
| `mkdir`, `create` | A folder, an empty file; a taken name fails with `exists`, or with `unique` (a folder uploaded beside one of its name) the folder gets the first free `name-1`, `name-2`… |
| `mkdirs` | Folders with the folders leading to them (an upload's); those there are kept, a file in the way fails with `exists`. |
| `rename` | One path to another; never replaces (`renameat2` with `RENAME_NOREPLACE` on Linux, `renamex_np` with `RENAME_EXCL` on macOS, a check first on file systems without them); across file systems (`EXDEV`) a copy as `copy` makes it, which replaces nothing, then the removal of the original (a copy that fails is removed, the original stays); not into itself, also through a link. |
| `move` | Paths into a folder under their names, replacing nothing: a taken name fails for that path alone (`failed`), the others move. |
| `copy` | Paths into a folder: files with their modes, folders with their contents, links as links; a taken name becomes `name copy.ext`, `name copy 2.ext`… (a copy into the same folder); a folder is not copied into itself, also when the folder named is a link into it. |
| `trash` | Into the user's trash: on macOS `~/.Trash` (`name 2.ext`… when taken); elsewhere the freedesktop.org trash, `$XDG_DATA_HOME/Trash` (`~/.local/share/Trash`) with an info file holding the original path and the time, or, for a path on another file system, the trash at the top of its mount (found along the path's real directory, with paths relative to it): `.Trash/<uid>` when `.Trash` is an administrator's (a directory with the sticky bit, not a link), else `.Trash-<uid>`. Other users may write at the top of a mount (`/tmp`), so such a trash and its `files` and `info` are used only when each is a directory of the user, not a link, closed to others (made `0700` when missing), as gio checks. A path no trash takes fails with `trash_unavailable`, and the panel offers to delete it for good. |
| `remove` | Deletes for good (folders with their contents): each folder opened relative to its parent without following a link, links removed and never followed, as `os.RemoveAll` does. |
| `write` | An editor's save, below. |
| `upload` | A file from the computer (at most 4 GiB) received in full beside the path, then given the path's name or, when taken, the first free `name-1.ext`, `name-2.ext`… in a rename that replaces nothing; with `replace` written over the file there as a save writes it (through a link its target, in place when a rename would lose something). Cut short (cancelled, the connection lost), it leaves nothing. |
| `stat` | Size, modification time and kind of up to 200 paths, for the polls and the editor; `error` on a path whose state is not known: `denied`, `failed`, or `busy` and `timeout` when stats do not answer. At most 8 stats run at once on the machine, and a path being stat'ed is not stat'ed again meanwhile: a mount that does not answer holds at most 8 threads, and a stat answers within 10 s. |

Every path is expanded as the agent's other operations do (`~`, relative to
home). The agent refuses (`refused`) the root, any directory that holds
the home directory (the home directory too) and the agent's own data
directory (`~/.<slug>[-<instance>]`) and everything in it, also when a
path reaches them through a symbolic link in its directory. It compares
names and file identities (`os.SameFile`): the home directory and the
directories above it, along its configured path and its real one (a home
that is a link, `/home/me -> /data/me`), against what the path names once
the links of its directory are followed (not its last name: removing a
link removes the link), and every directory holding that against the data
directory; so another case of a name on a case-insensitive volume
(`/Users/ME`) is refused too. The folder a move or copy puts paths into is
not checked itself (the home directory takes files), but where each path
lands is. A list of paths (trash, remove, move, copy) holds at most 1000;
one that fails alone fails the request, several report the failed ones by
code.

**Editor pane** (`EditorPane.tsx`, `{view: {plugin: 'files', kind:
'editor', path, preview}}`; one per file in a workspace, opened again it is
focused; `preview` marks the workspace's preview editor). Its title is the
file's name, new terminals beside it start in its directory. Images,
video, audio and PDFs show as in Quick Look (`MediaView`), with a download
button.

- It reads the file with `HEAD` and `GET /api/m/{id}/file`; the response's
  ETag carries the size and modification time the save sends back. Files
  over 8 MiB, binary files (a NUL in the first 8000 bytes) and text that is
  not valid UTF-8 are not opened (a save could change what the editor did
  not show); the pane offers to download them. A path not there yet (404)
  opens empty and is created by the first save; a file that could not be
  read otherwise (403 without permission, 502 when the machine did not
  answer or its stat failed) shows the error, never an empty file. A
  UTF-8 byte order mark is not shown and a save writes it back.
- A file whose lines end in more than one way (LF and CRLF, or a lone
  CR): Monaco gives the text one kind of ending, so a save would rewrite
  every line's. The Git plugin's setting `git.mixedLineEndings`
  ([31](31-git.md)) says what the editor does with it: `keep` (by
  default) saves each line with its own ending (`web/src/eol.ts`, after
  a line diff of the text as loaded or saved against the edited one; new
  lines take a neighbour's), `unify` saves the editor's endings, and
  `readOnly` opens the file read-only. A note above the text says which.
- **Quick diff** (`quickDiff.ts`): as in VS Code, the gutter and the
  overview ruler mark the lines that differ from what version control has
  (added, changed, removed), unsaved changes included, computed again a
  quarter of a second after typing stops. A provider
  (`registerQuickDiff`; the Git plugin) gives the text the file is compared
  with (the index's) and follows the file's repository while the editor
  shows it; the lines are compared with Myers' algorithm after the common
  start and end, and beyond 2000 edits the lines between the first and the
  last difference are one change. With changes, the bar offers **Open
  Changes**, the provider's diff of the file.
- ⌘S (Ctrl+S) or the toolbar saves: `POST …/p/files/write?path=&mtime=&size=`
  with the text as the body (`new=1` for a file not there yet, `force=1`
  to overwrite). The agent checks the file is as loaded and receives the
  whole text before it touches the file, so a save that breaks off
  changes nothing; a save that fails (a full disk) still reads the whole
  text, so the core gets its answer. Through a symbolic link the link's
  target is written and the link stays. The file is then written as Vim
  writes with `backupcopy=auto` (`save.go`):
  - Usually a new file beside it (private while the text is written,
    synced) gets the file's group and mode and, once the file is checked
    again, is renamed over it: a crash leaves the old file or the new one.
    A new path gets what the umask leaves of `0666`, as a program's new
    file does.
  - A rename would lose something when the file has several hard links
    (the other names would keep the old text), belongs to another user
    (it would become the user's), its group cannot be given to a new file
    of the user, or its directory takes no new file. Such a file is
    written in place: opened for writing without following a link (a file
    the user may not write is left alone; one swapped for a link or
    another file since it was checked is a conflict), copied from that
    descriptor to a backup, truncated, written and synced, so
    it keeps its inode, owner, group, mode and links. When that fails the
    backup's content is written back and the save fails with the code of
    what went wrong (`no_space`, `denied`, `read_only`…); a backup that
    cannot be written back stays and the failure names it
    (`restore_failed`). The backup is removed once the save ended.
  - The backup (`0600`) goes beside the file
    (`.<name>.herdr-ide-backup-<hex>`), recorded by a link in the agent's
    private `~/.herdr-ide/saves/` (`0700`); in a directory that takes no
    new file, or one where someone else may rename entries (another
    user's, or one its group or others may write that is not sticky), it
    goes into `saves/` itself, with the text waiting to be written. A
    text staged beside the file (`.herdr-ide-save-<hex>`, also an
    upload's) is recorded by a link there too. The agent that starts more
    than 7 days after a save or an upload left them (it ended during it:
    killed, a crash) removes them, and the staged texts and backups the
    links name: only regular files of the user with those names, older
    than 7 days themselves, never through a link. An agent whose session
    ended waits up to 5 s for the requests still running, which then fail
    and remove what they staged, before it exits.
  - The staged text and the backup are used only through the descriptors
    the agent created them with: the text is written, given the file's
    group and mode and copied into the file from its descriptor, the
    backup written back from its own, and a staged file is renamed only
    while its name still names it (checked again right after the rename).
    A file another user swapped in by name (a link to one of the user's
    secrets) is never read, changed or given the file's name: the save is
    a `409 conflict` and the file stays as it was.
  - With `files.saveMethod` set to `replace` (for every machine or one)
    every save takes the first way; in a directory the user may not
    write it fails with `denied`.

  A file changed or removed meanwhile is a `409 conflict` with its state
  now: the pane says so and offers **Load Theirs**, **Overwrite** and
  **Keep Editing**. The Git plugin's diff pane saves its right side
  through the same route ([31](31-git.md)).
- Every 5 s while it is shown (one check at a time, less often after
  failures), the pane checks the file's state: unchanged text is loaded
  again when the file changed on the machine, as one edit of the part that
  changed (the cursor stays, undo takes it back); text with unsaved
  changes gets the conflict bar at once. Typing while the text is loaded
  again wins: the text stays and the bar offers the change. **Keep
  Editing** dismisses the bar for that state of the file: it comes back
  for a newer change (and for a save, which the change still refuses).
- Closing the pane (or its tab or workspace) with unsaved changes asks
  **Save**, **Don't Save** or **Cancel** first
  ([04](04-layout-and-keyboard.md)).
- Unsaved text stays while the pane is not drawn (another tab, workspace or
  machine shown, another pane zoomed, the plugin off): it is still asked
  about and saved from the question, with the version it was loaded in, and
  comes back with the pane ([27](27-plugins.md)).
- **Show in Explorer** reveals the file in the tree; outside its root the
  tree stops following and shows the file's folder.

**Shared with other lists of files** (`ops.ts`, [27](27-plugins.md)):
`fileMenuEntries(m, paths, options)` gives the entries of the context menu
that open paths and copy or download them, with **Reveal in Explorer**
(`revealInExplorer(m, path)`: the panel shown, the path's folders expanded,
it selected and scrolled to); the Git panel's rows offer them as the
explorer's rows do. Entries for several rows act on all of them where that
makes sense (Open, Open to the Side, Copy Path, Copy Relative Path,
Download, and in the explorer Cut, Copy, Move to Trash, Delete
Permanently and dragging); a paste or a new entry goes into the folder of
the row pointed at; Open Preview, Open in VS Code, Open in Terminal, Open
Changes and Rename take one.

**Monaco** (`web/src/plugins/monaco.ts`) is the editor of the editor pane
and of later plugins' panes (diffs): loaded on first use (dynamic imports,
so the main bundle does not grow), with its editor features, every
language's colors and the services of JSON, CSS and HTML, each with its
worker; TypeScript's service and worker are left out (larger than the rest
together; TypeScript and JavaScript keep their colors). Its theme is made
from the design tokens of the app's light or dark theme and follows them,
its font is the terminal's and follows it, also in editors and diffs
already open. Its chunks ship without source maps
(`vite.config.ts`), its license and third-party notices are in
`licenses.md`. `createEditor` and `createDiffEditor` give a plugin an editor
in an element.

### Routes

| Route | Writes | Purpose |
| --- | --- | --- |
| `POST /api/m/{id}/p/files/stat` | – | `{"paths"}` (1–200): `{"entries": [{path, exists, is_dir, size, mtime, error}]}`. A POST because 200 paths in a query make a URL longer than proxies take; it changes nothing, so it is not audited and read-only mode allows it. |
| `POST /api/m/{id}/p/files/mkdir` | writes | `{"path"}`, `"unique": true` for a free name. |
| `POST /api/m/{id}/p/files/mkdirs` | writes | `{"paths"}`. |
| `POST /api/m/{id}/p/files/create` | writes | `{"path"}`: an empty file. |
| `POST /api/m/{id}/p/files/rename` | writes | `{"path", "to"}`. |
| `POST /api/m/{id}/p/files/move` | writes | `{"paths", "dir"}`. |
| `POST /api/m/{id}/p/files/copy` | writes | `{"paths", "dir"}`. |
| `POST /api/m/{id}/p/files/trash` | writes | `{"paths"}`. |
| `POST /api/m/{id}/p/files/remove` | writes | `{"paths"}`. |
| `POST /api/m/{id}/p/files/write` | writes | The body (at most 8 MiB) into `?path=`, with `&mtime=&size=`, `&new=1` or `&force=1`; `409 {"error": "conflict", "current"}`. |
| `POST /api/m/{id}/p/files/upload` | writes | The body (at most 4 GiB, streamed to the machine) into `?path=` under a free name, or over the file there with `&replace=1`; audited with `size` and `replace`. |

Changes answer `{"paths": [made], "failed": {path: code}}`; failures
`{"error": code}` with `not_found` (404), `exists`, `refused`, `denied`,
`trash_unavailable`, `too_large`, `bad_params`, `no_space`, `read_only`,
`restore_failed`, `offline` (409).

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A file system watch on machines (inotify, FSEvents) pushed over `/ws` | A watcher per expanded directory on every machine needs an owner, limits (inotify's per-user watches) and code per system; polling the directories on screen every 2 s costs one stat each and stops with the panel. |
| Writing saves with the agent's `fs.write` (uploads) | It replaces the file without looking; a save must not overwrite a change a program made since the editor loaded the file. |
| Always renaming a new file over the old one | It breaks hard links, gives a file of another user to the user and needs a directory the user may write; Vim and Emacs write such files in place for the same reasons. |
| Always writing in place | A crash during the write leaves a file cut short; the rename leaves the old file or the new one, so it stays the usual way. |
| Explorer uploads through the core's `/upload` (as panes) | It never replaces a file, cannot make folders and does not pass the explorer's guard (the data directory); the plugin's `upload` streams the same way and replaces as a save does when asked. |
| Asking about each file inside a folder that is merged | A folder of hundreds of files would ask hundreds of times; the user chose to replace the folder's files when choosing Replace for it. |
| Replacing a folder by removing it first | What the dropped folder does not hold would be lost; merging loses only the files replaced. |
| Backups in the private directory only | One beside the file is where the user finds it when a crash left it, on the same file system; the private directory serves when the file's directory takes no new file. |
| Deleting without a trash | A mistaken Delete in a tree is easy; the trash keeps the file where the system's tools find it. |
| CodeMirror instead of Monaco | The diffs of a version control plugin want Monaco's diff editor; one editor for both. |
| The full Monaco bundle with TypeScript's service | Its worker and source maps grew the embedded UI by more than the whole app; VS Code panes have TypeScript. |
| Opening files in VS Code only | code-server takes a while to start on each machine and a pane's room; a small fix should not need it. |

## Failure modes

- Machine offline: listings fail and the tree shows the error at its root;
  changes fail with `offline`; polls fail quietly and try again, less
  often the longer it lasts (up to a minute).
- A mount that does not answer (NFS): its stats answer `busy` or `timeout`
  within 10 s and the tree keeps what it shows; at most 8 stats wait on
  the machine.
- A listing that fails (the machine hiccups): the folder keeps its
  entries, and the next poll lists it again.
- A move to another file system: copied and removed; a name taken there
  fails as a rename's does.
- A save of a file with several hard links, of another user, or in a
  directory the user may not write: written in place after a backup, so
  every link sees the new text and the owner stays; a write that fails
  midway (a full disk) brings the content back from the backup.
- The agent ends during a save in place (a crash, a kill): the backup
  beside the file (or in `~/.herdr-ide/saves/`) holds the content before
  the save, the file may be cut short; the backup stays for 7 days, then
  the next agent removes it.
- The agent is killed during an upload or a save: the partial
  `.<slug>-save-*` beside the target (an upload's up to 4 GiB) stays for
  7 days, recorded in `saves/`, then the next agent removes it; when only
  its session ended, the agent waits for the upload to remove it before
  it exits.
- A path changed by someone else between a listing and a change: the change
  fails (`not_found`, `exists`) and the next poll shows the directory as it
  is.
- No trash for a location (another volume on macOS, a mount without a
  trash it can make, or with one another user planted): `trash_unavailable`,
  and the panel asks whether to delete for good.
- A save into a file that changed since it was loaded: `409 conflict`,
  nothing written, the pane offers to load or overwrite.
- A save that breaks off: the temporary file (`.<slug>-save-*` beside the
  file, or in `saves/`) is removed; the file is as it was.
- An upload cut short (Cancel, the page closed, the connection lost): the
  agent removes what it received; the file there (a replaced one) is as
  it was. A folder's files that arrived before stay.
- A name taken meanwhile by an upload's free name: the rename that
  replaces nothing fails and the next free name is taken.
- An older agent during an upgrade: actions fail with `unknown_plugin`.
- A plugin turned off: its routes answer `404 plugin_disabled`, the panel is
  gone and editor panes say the plugin is off.

## Security

Every change is a mutating route: refused in read-only mode, audited
(`files.mkdir`, `files.rename`, …, with the paths and the outcome), behind
the core's guards. The agent
refuses the root, directories above the home directory, the home directory
itself and its own data directory, by name and by file identity (a home
reached through a link, another case on a case-insensitive volume), so
the explorer cannot delete the machine's or its own state wholesale;
within them it acts with the user's permissions, as a terminal does. A
trash at the top of a mount other users write to is used only when it is
the user's own and closed to others, so trashed files never go to a
directory another user planted. A save writes only the file named (a
link's target) and, for a save in place, a private backup of it (`0600`)
beside it or in the agent's own `saves/` directory (`0700`), removed when
the save ended. Uploads go through the same guard (an upload into the
agent's data directory is refused), take a free name unless the user
chose Replace, and are bounded to 4 GiB; saves are bounded to 8 MiB, lists of
paths to 1000, stats to 200 paths and 8 running at once. Files moved to
the trash stay in the user's trash
([deployment](../deployment.md#remote-resources)).

## Testing

- `internal/agent/plugin/files/files_test.go` (HOME in a temporary
  directory): each action, renames and moves that replace nothing (also
  across file systems, `TestMoveAcrossFileSystems`), copies with new
  names, links and into itself (also through a link,
  `TestCopyIntoLinkInsideItself`), moves and copies into the home
  directory, both trash layouts (info files, unique names, relative paths
  of a mount's trash), a mount's trash made private and a planted one
  refused (`TestMountTrash`, `TestMountTopFollowsLinks`), the refused paths
  (also through a link, a home that is a link, another case:
  `TestRefusedThroughLinkedHome`, `TestRefusedInAnotherCase`), stats of a
  mount that does not answer (`TestStatOfADeadMount`), saves with their
  precondition (changed, removed, new, forced, through a link, too large,
  no temporary file left), a new file's mode from the umask, a save that
  cannot be written reading its text to the end (`TestReceiveDrains`).
- `internal/plugins/files/settings_test.go`: the patterns `files.exclude`
  takes, the save method per machine and without settings.
- `web/src/__tests__/files.test.ts` also: the sort orders, names excluded
  (also from polls), the switches from the settings unless the browser
  chose, Move to Trash asking when the setting says so.
- `internal/agent/plugin/files/save_test.go`: saves in place that keep
  hard links (same inode, every name sees the new text, also through a
  symbolic link, which stays; `replace` makes a new file), a file of
  another owner (the check replaced), a writable file in a directory
  that is not (its text and backup in `saves/`, emptied after), a write
  that fails midway restored from the backup and one whose restoring
  fails keeping and naming it, and `PruneBackups` removing what is older
  than the retention (and the staged texts and backups beside files its
  links name, old themselves, never another file or a link;
  `TestBackupAndStagedNames`); a file swapped for a link or another file after its
  check is not written through (`TestSaveInPlaceRefusesASwap`); a staged
  text and a backup swapped for links to a secret are never used by name,
  in place, when the write fails and on the rename path, and for an
  upload (`TestSaveUsesOnlyItsDescriptors`); a save in place in a
  directory others may rename entries of keeps them in `saves/`
  (`TestSaveInPlaceInASharedDirectory`).
- `internal/plugins/files/files_test.go`: the routes (all but `stat`
  mutating and audited, `stat` a POST), the stat's body and a save's query;
  `TestMutatingRoutesAreGuarded` (`internal/server`) checks them for Origin
  and read-only mode. `internal/server/download_test.go`: `/file` answers
  404 only for a path not there (`TestFileStatFailures`, `TestStatFailure`).
- `internal/agent/plugin/files/remove_test.go`: removals of large and
  nested trees that follow no link, copies and removals that stop once
  cancelled.
- `internal/plugins/files/audit_test.go`: the paths of the audit records.
- `web/src/__tests__/files.test.ts`: rows (order, hidden files, the filter,
  a new entry's row, file icons, indent guides, the filter's match marked),
  breadcrumb and paths, the root following the focused terminal, the
  keyboard (pages, select all, type-ahead too), the context menu's changes and the routes they
  call, Delete and Shift+Delete, polling (the shown folders only, as a
  POST, one at a time and less often after failures, a failed listing
  kept and tried again), Refresh, what a new root keeps and clears, paste
  into the root, a cut kept until moved, read-only mode, decorations.
- `web/src/__tests__/files.test.ts` also: a selection of several rows
  (Enter opening its files, the entries that apply to them all), Open
  Changes for a file a provider marks as changed, the shared entries and
  Reveal in Explorer (inside and outside the root).
- `web/src/__tests__/filesUpload.test.ts`: a drop's folders read with
  everything in them (in batches, unreadable items counted), the deepest
  folders made, files and folders uploaded with their structure (a
  folder as one upload, its folders made first), names taken asked about
  (replace, keep both, skip, once for all; a folder replaced merged, the
  other kind kept beside), a folder's upload adding up its files, failing
  once they went and stopping when cancelled, the menus' upload and
  transfer entries (none that write in read-only mode), the `DownloadURL`
  of rows dragged out.
- `internal/agent/plugin/files/upload_test.go`: uploads under free names
  (also a dot file), replacing in place when the file has other links, a
  folder never replaced by a file, the data directory refused, uploads cut
  short leaving nothing; `mkdir` with `unique` and `mkdirs`.
- `internal/agent/serve_test.go`: an agent whose session ends during an
  upload returns only once the upload removed what it staged
  (`TestServeWaitsForRequestsToClean`).
- `web/src/__tests__/filesEditor.test.ts` (Monaco replaced): versions from
  the ETag, saves with them, conflicts overwritten and loaded, new files,
  read-only mode, files that are not text, files that cannot be read (an
  error, not an empty file), a byte order mark written back, a file that
  mixes line endings saved with each line's own ending, unified or opened
  read-only as the setting says, a change on
  disk loaded as an edit undo takes back, typing during that load kept
  and the change offered, Keep Editing not undone by the next check.
