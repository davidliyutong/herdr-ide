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
open in a terminal or VS Code, reveal in Finder or the file manager for
the computer the core runs on); files and folders from the computer
dropped on it or chosen in its menus are uploaded with their structure,
asking about names taken, and rows dragged out of the page download; a
click shows a file in a preview editor that the next click
replaces and a double click keeps, as VS Code's preview editors (media
too, as Quick Look shows them); the editor never overwrites a change made
on the machine since it loaded the file, and marks a file deleted or
moved away since, as VS Code does; files changed in version control
are colored in the tree and the editor's gutter marks the changed lines.
The editor does not mark characters of the user's languages (the browser's
languages and the app's language), such as Chinese punctuation, as
confusable with ASCII; invisible characters stay marked.

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

**Tree** (`tree.ts`, `FilesPanel.tsx`)

- The root is the focused terminal's directory (as for splits), a VS Code
  pane's folder, or the workspace's directory when no pane has the focus.
  A terminal's directory is where its user is (`web/src/term/place.ts`,
  kept by `TermModel`), worked out from the terminal core's record, which
  has the directory of the foreground program: the shell's while it waits
  at its prompt, any program's while that runs. A shell's directory (and a
  terminal file manager's: ranger, yazi, lf, nnn, mc and the like) is
  followed as it changes. Another program's is taken only once it stayed
  where it was first seen for 1.5 s (`SETTLE_MS`; the core looks twice a
  second), so an agent started as `cd project && claude` moves the tree
  there; a program that moves before that is not followed while it runs,
  nor is a move a program makes later, and while the core cannot read the
  foreground program (another user's, as under `sudo`) the directory
  stays. So a program walking a tree (`tar -zcf x.tar.gz dir`, which
  changes its directory to every folder it packs, `find`, a build) leaves
  the tree, the Git panel, the status bar and what new terminals start in
  where the shell was. A page opened while such a program runs has only
  what it sees: the directory the program is in then, until the shell is
  back. While a preview or an editor has the focus
  the tree stays where it is in that workspace, so a click that opens a
  preview does not move it. Another workspace or machine shown takes its
  own directory at once, also while an editor has the focus there: that
  of its terminal or VS Code pane focused last (the focus history), else
  the workspace's, else the machine's home (`FilesPanel.tsx` `rootFor`;
  the tree records the workspace its root was taken for). The root is
  taken before the panel is painted, and the panel draws a tree only of
  the machine shown, so it never shows one machine's directory under
  another, nor asks a machine about another's paths. **Follow** (the
  crosshair) turns following off; a crumb of the breadcrumb roots the tree
  at that directory and turns it off too. Without it the root stays where
  the user put it, across the machine's workspaces; another machine starts
  at its workspace's directory as above. Follow and hidden files are kept
  per browser once its buttons were used, else the settings
  `files.followFocus` and `files.showHidden` decide.
- Directories are listed with the core's `GET /api/m/{id}/list` when they
  are expanded. Expanded directories are kept by path (at most 500; beyond
  that the oldest outside the root are forgotten), so going back to a
  directory shows it as it was, listed again. Only the listings of the
  root and the expanded directories below it are kept: another root, or
  Collapse Folders, drops the rest. Another root also clears the selection
  and the cursor, so a key never acts on rows the tree no longer shows. A
  listing that fails keeps the entries listed before and is tried again by
  the next poll, whatever started it (its recorded time is forgotten). A
  failure alone says nothing: a machine busy unpacking an archive, or a
  request that timed out, answers the next time. The root's error shows
  when nothing of it is listed (its first listing failed, or a poll found
  it gone) or when its listing failed again (`tree.ts` `shownError`), and
  goes with the next listing that succeeds. An empty directory's listing
  is an empty list, polled as any other. Folders come first
  (`files.sortOrder`), names sort as people sort them (`a2` before `a10`).
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
  the next row whose name starts with them (type-ahead), Enter on Windows/Linux or ⌘O / ⌘↓ on macOS
  (open, kept; on a selection of several, its files), Space (preview, the keyboard stays in the tree), Enter on macOS or F2 on Windows/Linux (rename), Delete or ⌘⌫ (trash), Shift
  with them (delete for good, after asking), ⌘/Ctrl C, X, V, Escape (the
  clipboard, then the filter). Arrows with ⌘, Ctrl or Alt are left to
  the page's shortcuts. The keys act on the selected rows the tree
  shows; V pastes into the cursor's folder, or the root when the cursor is
  on no row. A cut stays on the clipboard until its paths are moved: the
  ones that failed to move stay on it. The page's own shortcuts work as anywhere
  outside a terminal.
- Editors open in tabs of the workspace, as terminals, VS Code and the
  Git graph do, never split into the tab shown, so opening files does not
  squeeze its panes; they move, split and merge as any pane does
  ([04](04-layout-and-keyboard.md)). A click selects (⌘/Ctrl adds, Shift
  extends), expands a folder or shows a file in the workspace's **preview
  editor** (`openEditor` with `preview`), whose tab it shows, and keeps
  the keyboard in the tree; the next click shows its file in the same
  pane, as VS Code's preview editors do, so browsing files does not fill
  the workspace with tabs. A double click or Enter keeps the file open:
  an editor showing it already is shown and kept (no longer a preview),
  else it opens in a tab of its own. The preview's title is
  in italics in its header and tab; the pin button of its bar, a double
  click or its first edit keeps it. A preview with unsaved changes is
  never replaced. One pane kind shows every file: text in Monaco, media
  (images, video, audio, PDF) as Quick Look shows them.
- Changes are typed in the tree: a new file or folder gets a row with a
  name field in its folder, Enter on macOS or F2 elsewhere turns a row's name into one. Names with `/`,
  empty names, `.` and `..` are refused before anything is sent.
- The context menu: Open (the files of the selection, several at once,
  each in a tab), Open to the Side (a kept editor split beside the focused
  pane, unless that tab shows the file already), Open Preview, Open in VS Code, Open in Terminal (a terminal
  split beside the focused pane, in the folder; these three for one row),
  Reveal in Finder (one row, below),
  Open Changes (a file version control marks as changed, with a letter:
  the quick diff provider's diff, the Git plugin's), New File, New
  Folder, Upload Files…, Upload Folder… (on a folder), Cut, Copy, Paste,
  Copy Path, Copy Relative Path (to the root), Download (`download.ts`, a
  zip for folders and several rows; not for the desktop app's own
  machine), Rename, Move to Trash, Delete Permanently; on the empty part
  of the tree, the root's entries (Open in Terminal and Reveal in Finder
  of the root among them) and Refresh (the shown directories listed
  again), Collapse Folders, Show Uploads and Show Downloads (the status
  bar's panels). The panel's **…** button has New File, New Folder,
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
- **Reveal in Finder** (Reveal in File Manager on Linux; `ops.ts`
  `revealEntries`), in the menus of the tree's rows and root and of an
  editor's tab and header: the file manager of the computer the core runs
  on shows the path, Finder with it selected (`open -R`), the default file
  manager elsewhere with the folder, or the file's folder (`xdg-open`).
  Offered only for the core's own machine (the local one) and only to a
  page on that computer: the desktop app, or a browser talking to the
  core's loopback address directly, not through a proxy (the core's
  `SameHost`); the page asks the core once (`GET …/p/files/reveal`), and
  the core checks again when asked to reveal. Remote machines' files, and
  pages on other computers, have no such entry: the window would open on a
  screen nobody there sees. It runs a program, so read-only mode has none.
- **Uploads** (`upload.ts`): files and folders dropped from the computer,
  or chosen with Upload Files… and Upload Folder… (the browser's dialog),
  go into the folder with their structure: a dropped folder is read with
  everything in it (`webkitGetAsEntry`, its readers' batches; items that
  cannot be read are left out with a note), a chosen one from its files'
  relative paths (the browser does not tell its empty folders); at most
  10 000 entries at once. Names already in the folder are asked about
  once each (**Replace**, **Keep Both**, **Skip** when other names go too,
  a box applying the answer to the rest; **Cancel** or Escape stops the
  whole upload, nothing goes, as Finder's Stop): a replaced file is written as a save
  writes it (in place), a replaced
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
  most 200) that are listed or whose listing failed, and lists again those
  that changed; one gone is dropped, one
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
| `trash` | Into the user's trash: on macOS `~/.Trash` (`name 2.ext`… when taken); elsewhere the freedesktop.org trash, `$XDG_DATA_HOME/Trash` (`~/.local/share/Trash`, its folders made `0700` when missing, as on a server account no desktop used) with an info file holding the original path and the time, or, for a path on another file system, the trash at the top of its mount (found along the path's real directory, with paths relative to it): `.Trash/<uid>` when `.Trash` is an administrator's (a directory with the sticky bit, not a link), else `.Trash-<uid>`. Other users may write at the top of a mount (`/tmp`), so such a trash and its `files` and `info` are used only when each is a directory of the user, not a link, closed to others (made `0700` when missing), as gio checks. A path no trash takes fails with `trash_unavailable`, and the panel offers to delete it for good. |
| `remove` | Deletes for good (folders with their contents): each folder opened relative to its parent without following a link, links removed and never followed, as `os.RemoveAll` does. |
| `write` | An editor's save, below. |
| `upload` | A file from the computer (at most 4 GiB) received in full into the agent's private `staging/` directory, then written into a new file at the path or, when taken, the first free `name-1.ext`, `name-2.ext`… (created only where nothing is); with `replace` written over the file there as a save writes it (through a link its target, in place). Cut short (cancelled, the connection lost), it leaves nothing at the path. |
| `reveal` | Shows a path in the system's file manager (`reveal.go`): `/usr/bin/open -R <path>` on macOS, elsewhere `xdg-open <folder>/` (the file's folder for a file; the trailing slash makes a folder swapped for a file meanwhile fail rather than open in that file's program), `xdg-open` found in `/usr/bin`, `/bin` or `/usr/local/bin`, never through `PATH`. Started as a program with its arguments (no shell), the environment of the agent's processes and its standard streams on `/dev/null`, so a file manager it starts as its child holds no pipe of it. The path is expanded as every action's and must be there; the paths changes refuse (the home directory, the data directory) may be shown, as they may be stat'ed: it changes nothing. It answers once the program exits (with its exit status when it failed) or after 10 s; one still running then (an `xdg-open` that runs the file manager itself) is left to the user and reaped when it ends. At most 4 are waited for at once (`busy`), each freeing its place when it answers. The core asks for it only on its own machine. |
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
- ⌘S (Ctrl+S) or the toolbar saves the pane that has the keyboard: each
  editor listens to its own keys (Monaco's shared keybinding service would
  give the chord to the editor created last), and keys pressed on the pane's
  toolbar or banner outside the editor save the pane too (`plugins/saveKey.ts`);
  the chord is not bound app-wide, Ctrl+S keeps reaching terminals, and a
  save that is running is not started again by a held key. The save:
  `POST …/p/files/write?path=&mtime=&size=`
  with the text as the body (`new=1` for a file not there yet, `force=1`
  to overwrite). The agent checks the file is as loaded and receives the
  whole text before it touches the file, so a save that breaks off
  changes nothing; a save that fails (a full disk) still reads the whole
  text, so the core gets its answer. Through a symbolic link the link's
  target is written and the link stays. The file is then written as VS
  Code writes a user's file (`save.go`): opened for writing without
  following a link anywhere on its real path (`O_NOFOLLOW_ANY` on macOS,
  `openat2` with `RESOLVE_NO_SYMLINKS` on Linux 5.6 and later) and
  without blocking, checked to be a regular file (a FIFO or a device is
  never written) and checked again on that descriptor (still the file as
  loaded: a change since is a conflict, and a link swapped in for the file
  or a directory above it is one even when forced), truncated, written
  from its start and synced. The path keeps its file: its inode,
  hard links (every name sees the new text), owner, group, mode, extended
  attributes and ACLs stay, and a file in a directory the user may not
  write is saved. A file the user may not write is left alone (`denied`,
  its mode unchanged). A new path is created only where nothing is, with
  what the umask leaves of `0666`, as a program's new file is. Nothing
  else is written: no temporary file and no backup, beside the file or
  elsewhere.
  - A write that fails after the file was truncated (the disk filled up,
    an I/O error) leaves part of the text in it: the save fails with
    `partial_write` (its message the cause's code, `no_space`…), the pane
    keeps the text, still unsaved, and the error offers **Save Again**,
    which overwrites the file whatever it holds now. A new file whose
    write failed is removed. VS Code writes the same way and fails the
    same way; it keeps no backup either.
  - While the text is written, a program that reads the file at that
    moment (a development server reloading) can read part of it, as with
    VS Code.

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
  While the bar shows, the checks go on: it says how the file is now
  (removed, or changed when it came back otherwise), and it goes once the
  file is back as it was loaded (restored from the trash), the unsaved
  changes staying unsaved.
- **A file gone** (deleted, or moved or renamed away; `gone.ts`): its
  editor's title is struck through in the pane's header and in its tab,
  and their tooltips end with "Deleted", as VS Code marks the editors of
  deleted files (`PaneViewDef.useGone`, [27](27-plugins.md)). The text
  stays as it is, unsaved changes too, and the pane is not closed: a save
  (Overwrite in the bar) makes the file again. The mark goes once the file
  is there again. The paths of the editors whose titles are drawn (every
  tab of the workspace shown, also those not selected, and the panes'
  headers) are checked together, one `stat` per machine every 5 s while
  the page is visible; an editor's own checks, loads and saves and the
  explorer's renames, moves and deletions tell at once. A path whose state
  is not known (the machine does not answer) keeps its mark; an editor
  opened on a path not there (404) is marked from the start. Preview panes
  (the app's own, [06](06-quick-look-and-files.md)) are marked the same
  way and their paths checked with the editors': the plugin answers for
  them (`PluginDef.useFileGone`, [27](27-plugins.md)); with the explorer
  off, nothing is marked.
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
so the main bundle does not grow), with its editor features, its
languages (brackets, comments, indentation) and the services of JSON, CSS
and HTML, each with its worker; TypeScript's service and worker are left
out (larger than the rest together; TypeScript and JavaScript keep their
colors). Its theme is made from the design tokens of the app's light or
dark theme and follows them, its font is the terminal's and follows it,
also in editors and diffs already open. Its chunks ship without source maps
(`vite.config.ts`), its license and third-party notices are in
`licenses.md`. `createEditor` and `createDiffEditor` give a plugin an editor
in an element.

**Colors of code** (`web/src/highlight`) are the app's own, shared by the
editors, the diffs, the preview pane and code in rendered Markdown:

- The grammars are TextMate grammars, as VS Code's, from Shiki
  (`@shikijs/langs`), run by the browser's regular expression engine (no
  second WebAssembly module). `languages.ts` lists the languages colored,
  about 125: each grammar is a chunk of its own, loaded when a file or a
  code block of that language first shows. Monaco's own languages lack
  Makefile, TOML, CMake, diff, `.env`, Nix, Zig, Haskell, LaTeX, Vue, TSX
  and more, which the table adds with their comment signs and brackets;
  ignore files (`.gitignore` and its kin) have a small grammar of the app's
  (`grammars.ts`).
- `languageOf` tells a file's language: by its whole name (`Makefile`,
  `CMakeLists.txt`, `.bashrc`), a name's start (`Dockerfile.dev`,
  `.env.local`), its extension, the same without an ending such as `.in`
  or `.example`, and for a name that says nothing by the program of its
  first line (`#!/usr/bin/env python3`). The editor and diff panes set
  their models' language with it (`setLanguage`); a file the table does not
  know keeps what Monaco makes of its name.
- Tokens are colored by role, not by theme (`roles.ts`): Shiki colors with
  one theme whose colors stand for roles (comment, keyword, string, number,
  type, function, property, tag, attribute, delimiter, regexp, and those
  of markup and diffs), and the design tokens' `syntax` colors give each
  role its color in the theme in use ([24](24-design-tokens.md)). Text is
  tokenized once whichever theme shows it, and switching themes changes
  colors only. In Monaco a token's type is its role
  (`registerTokensProviderFactory`, which replaces Monaco's own coloring of
  a language) and the theme's rules color the roles; JSON keeps the
  tokenizer of its language service, whose token names take the same
  rules. Outside Monaco, `Code` renders spans of the classes `syn-<role>`.
- Code over 300,000 characters and lines over 20,000 stay plain, and a line
  is given up after half a second.
- The grammars are about 5 MB of the embedded UI. Chunks made only of
  packages' code (the grammars, the highlighter, Monaco, KaTeX, the Markdown
  renderer) ship without source maps (`vite.config.ts`), which would
  otherwise double that; the grammars' third-party notices (those of the
  collection they come from, `tm-grammars`) are in `licenses.md`.

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
| `GET /api/m/{id}/p/files/reveal` | – | `{"available"}`: whether this client is offered Reveal in Finder for the machine (the core's own, the client on its host, macOS or Linux). |
| `POST /api/m/{id}/p/files/reveal` | writes | `{"path"}` shown in the file manager of the core's host; `400 remote_machine` for another machine, `403 local_only` for a client elsewhere; audited as `files.reveal`. |

Changes answer `{"paths": [made], "failed": {path: code}}`; failures
`{"error": code}` with `not_found` (404), `exists`, `refused`, `denied`,
`trash_unavailable`, `too_large`, `bad_params`, `no_space`, `read_only`,
`partial_write` (a write that stopped after the file was truncated, with
the cause's code as its message), `offline` (409); a reveal also
`remote_machine`, `local_only` (403), `reveal_unavailable` (no `open` or
`xdg-open` where they are looked for), `reveal_failed` (the program failed,
with its exit status), `busy` (4 of them waited for).

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A file system watch on machines (inotify, FSEvents) pushed over `/ws` | A watcher per expanded directory on every machine needs an owner, limits (inotify's per-user watches) and code per system; polling the directories on screen every 2 s costs one stat each and stops with the panel. |
| Writing saves with the agent's `fs.write` (uploads) | It replaces the file without looking; a save must not overwrite a change a program made since the editor loaded the file. |
| Renaming a new file over the old one (an atomic save), as JetBrains' safe write and GIO do | It gives the path another file: hard links keep the old text, a file of another user becomes the user's, extended attributes, ACLs and macOS tags are lost, programs that follow the inode (`tail -f`, a single-file Docker bind mount) lose it, and it needs a directory the user may write. The temporary file beside the target also gave other users of a shared directory something to swap; VS Code keeps renames for its own state files. |
| Renaming, and writing in place after a backup when a rename would lose something (Vim's `backupcopy=auto`) | Two ways and the cases between them, with a backup and a staged text beside files to keep from other users; writing in place always is one way and keeps everything a rename loses. |
| A backup of the file before writing it in place | It only helps when the write fails midway, which the editor survives anyway (it keeps the text and saves again); it doubled what a save writes and needed a retention rule. |
| Explorer uploads through the core's `/upload` (as panes) | It never replaces a file, cannot make folders and does not pass the explorer's guard (the data directory); the plugin's `upload` streams the same way and replaces as a save does when asked. |
| Asking about each file inside a folder that is merged | A folder of hundreds of files would ask hundreds of times; the user chose to replace the folder's files when choosing Replace for it. |
| Replacing a folder by removing it first | What the dropped folder does not hold would be lost; merging loses only the files replaced. |
| Deleting without a trash | A mistaken Delete in a tree is easy; the trash keeps the file where the system's tools find it. |
| CodeMirror instead of Monaco | The diffs of a version control plugin want Monaco's diff editor; one editor for both. |
| Monaco's own colors (Monarch grammars) | It has 80 languages and no way to add VS Code's grammars: a Makefile, a TOML or a `.env` file stayed plain, a file without an extension too, and previews and Markdown would need a second highlighter anyway. |
| Shiki's themes (`@shikijs/monaco`) | That bridge takes over Monaco's themes, which the app rebuilds from its tokens at every change of a preference, and a theme's colors would have to be tokenized again for the other theme; roles are tokenized once and colored by the tokens. |
| Shiki's Oniguruma engine | A second WebAssembly module on the page (SECURITY.md lists them) for grammars the browser's engine runs. |
| The full Monaco bundle with TypeScript's service | Its worker and source maps grew the embedded UI by more than the whole app; VS Code panes have TypeScript. |
| Opening files in VS Code only | code-server takes a while to start on each machine and a pane's room; a small fix should not need it. |

## Failure modes

- Machine offline: listings fail and the tree shows the error at its root;
  changes fail with `offline`; polls fail quietly and try again, less
  often the longer it lasts (up to a minute).
- A mount that does not answer (NFS): its stats answer `busy` or `timeout`
  within 10 s and the tree keeps what it shows; at most 8 stats wait on
  the machine.
- A listing that fails (the machine hiccups, an archive being unpacked
  keeps its disk busy): the folder keeps its entries without a word, and
  the next poll lists it again; failing again, the root says why.
- A directory of thousands of entries (an archive unpacked into it): its
  listing follows the agent's reply line as a body, as a line holds at
  most 1 MiB, up to 20 000 entries (the rest are not listed).
- Another workspace or machine shown while an editor has the focus: the
  tree takes that workspace's directory before it is painted.
- A file of an open editor deleted, or moved away: its title is struck
  through within 5 s (at once when the explorer did it); its text stays.
- Reveal in Finder where the core's environment has no display (a core
  started without one on Linux): `xdg-open` fails and the menu's action
  says so.
- A move to another file system: copied and removed; a name taken there
  fails as a rename's does.
- A save whose write fails after the file was truncated (a full disk):
  `partial_write`, the file on the machine may be cut short; the pane
  keeps the text and offers **Save Again**.
- The agent ends during a save (a crash, a kill): before the text arrived
  in full the file is as it was; during the write it may be cut short,
  and the editor still holds the text.
- The agent is killed during an upload: what it received stays in
  `~/.herdr-ide/staging/` (up to 4 GiB) for 7 days, then the next agent
  removes it; nothing is at the target. When only its session ended, the
  agent waits for the upload to remove it before it exits.
- A path changed by someone else between a listing and a change: the change
  fails (`not_found`, `exists`) and the next poll shows the directory as it
  is.
- No trash for a location (another volume on macOS, a mount without a
  trash it can make, or with one another user planted): `trash_unavailable`,
  and the panel asks whether to delete for good.
- A save into a file that changed since it was loaded: `409 conflict`,
  nothing written, the pane offers to load or overwrite.
- A save that breaks off before its text arrived in full: nothing was
  written; the file is as it was.
- An upload cut short (Cancel, the page closed, the connection lost): the
  agent removes what it received; the file there (a replaced one) is as
  it was. A folder's files that arrived before stay.
- A name taken meanwhile by an upload's free name: creating the file there
  fails (it never replaces one) and the next free name is taken.
- An older agent during an upgrade: actions fail with `unknown_plugin`.
- A plugin turned off: its routes answer `404 plugin_disabled`, the panel is
  gone and editor panes say the plugin is off.

## Security

Every change is a mutating route: refused in read-only mode, audited
(`files.mkdir`, `files.rename`, …, with the paths and the outcome), behind
the core's guards. So is Reveal in Finder, which runs a program on the
core's host: only for the core's own machine (whose agent runs in the
core's process) and only for a client on that host (`SameHost`: a request
from the host's loopback, not through a proxy; the desktop app's window is
one), with the path as an argument of its own after the expansion every
action has, never a shell's text; it opens a window of the file manager
and changes nothing on disk. A browser of another computer reaching the
core through an ssh forward of its port counts as on the host (its
connections come from the host's loopback): Reveal in Finder then opens
the window on the host's screen. The agent
refuses the root, directories above the home directory, the home directory
itself and its own data directory, by name and by file identity (a home
reached through a link, another case on a case-insensitive volume), so
the explorer cannot delete the machine's or its own state wholesale;
within them it acts with the user's permissions, as a terminal does. A
trash at the top of a mount other users write to is used only when it is
the user's own and closed to others, so trashed files never go to a
directory another user planted. A save writes only the file named (a
link's target), in place, through the descriptor it checked: it creates
nothing beside the file, so it leaves nothing of its own for another user
who may write the file's directory to swap. A save the user forces
(Overwrite, Save Again, Replace) writes whatever regular file is at the
path then: such a user who may also hard-link the user's files (macOS;
Linux with `fs.protected_hardlinks` off) could have another of them
written ([SECURITY.md](../../SECURITY.md)). Uploads are received in the
agent's own `staging/` directory (`0700`) and go through the same
guard (an upload into the agent's data directory is refused), take a
free name unless the user chose Replace, and are bounded to 4 GiB; saves
are bounded to 8 MiB, lists of
paths to 1000, stats to 200 paths and 8 running at once. Files moved to
the trash stay in the user's trash
([deployment](../deployment.md#remote-resources)).

## Testing

- `web/src/__tests__/highlight.test.ts`: the language table (unique ids,
  names, extensions and aliases; every grammar loads and tokenizes in the
  browser's engine), the language of file names and first lines, the roles
  of tokens in several languages, the line tokenizer the editor uses, a
  style for every role, and 4.5:1 of every syntax color against the
  background in both themes. `markdown.test.tsx`: what links and images
  may point to, HTML and scripts in the text creating no elements, code
  blocks colored, formulas through KaTeX's renderer.
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
  takes, every setting in the plugin's section.
- `web/src/__tests__/files.test.ts` also: the sort orders, names excluded
  (also from polls), the switches from the settings unless the browser
  chose, Move to Trash asking when the setting says so.
- `internal/agent/plugin/files/save_test.go`: saves in place that keep
  the inode, hard links (every name sees the new text) and mode and add
  nothing to the directory, also through a symbolic link, which stays
  (`TestSaveInPlace`); a writable file in a directory that is not, a new
  file refused there and a read-only file left alone with its mode
  (`TestSaveInUnwritableDirectory`); a FIFO and a directory refused
  without blocking (`TestSaveRefusesWhatIsNotAFile`); the precondition
  checked on the file opened, a link swapped in never written through
  (`TestSaveChecksTheFileItOpens`), also for a directory above the file,
  forced or not (`TestSaveRefusesALinkAboveTheFile`); a write that fails midway answering
  `partial_write` with its cause and a new file removed
  (`TestSaveFailureIsPartial`); `PruneStaged` removing old uploads'
  files only (`TestPruneStaged`).
- `internal/plugins/files/files_test.go`: the routes (all but `stat`
  mutating and audited, `stat` a POST), the stat's body and a save's query;
  `TestMutatingRoutesAreGuarded` (`internal/server`) checks them for Origin
  and read-only mode. `internal/server/download_test.go`: `/file` answers
  404 only for a path not there (`TestFileStatFailures`, `TestStatFailure`).
- `internal/agent/plugin/files/remove_test.go`: removals of large and
  nested trees that follow no link, copies and removals that stop once
  cancelled.
- `internal/plugins/files/audit_test.go`: the paths of the audit records.
- `internal/agent/plugin/files/reveal_test.go`: the command of each system
  (the program by its absolute path, none from `PATH` nor a file that is
  not executable; the path an argument of its own, a file's folder and a
  trailing slash for `xdg-open`), the paths it shows (expanded, home too)
  and refuses (not there, none, NUL) without running anything, a program
  that fails or is missing, an `xdg-open` leaving a file manager that
  holds its streams answered at once with its place free
  (`TestRevealLeavesTheFileManager`), one that does not exit answered
  after the wait with its place free, the bound of 4 waited for at once
  (`TestRevealWaitsBounded`; scripts stand in for the file manager).
- `internal/plugins/files/files_test.go` `TestRevealGate`: Reveal in
  Finder refused for another machine and for a client elsewhere, offered
  and passed to the agent for the core's own machine from its host.
- `internal/server/list_test.go`: `/list` of 15 000 entries through a real
  agent (the body after the reply line), an empty directory's empty list.
- `web/src/__tests__/termPlace.test.ts`: a terminal's directory: the
  shell's as it changes; unchanged while a program walks a tree, also one
  first seen inside the tree and one that later stays long somewhere; an
  agent started in another directory once it stayed there, with the page
  told; unchanged while the foreground program cannot be read; and the
  model's directory through the core's events.
- `web/src/__tests__/filesFollow.test.ts`: the root across two machines'
  workspaces whose editors have the focus, another workspace of the same
  machine, the terminal focused last there, the editor's focus keeping the
  root in its workspace, a root chosen by the user kept on its machine,
  and no machine asked about another's paths.
- `web/src/__tests__/filesGone.test.ts`: the struck-through titles of
  editors and previews of files gone, of a tab not shown and of the
  header, with their tooltips, going once the files are back; a preview
  keeping what it showed when drawn again and loading the file again once
  it is back; no preview marked with the explorer off; Reveal in Finder in the tab's
  and the tree's menus only for the core's own machine when the core
  offers it, none in read-only mode, none asked for another machine.
- `web/src/__tests__/editorPlacement.test.ts`: editors in tabs of their
  own, the preview's tab reused, a file open already shown, Open to the
  Side split beside the focused pane; Source Control's diffs in a reused
  tab, the graph's beside the graph, showing the next file there.
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
  (replace, keep both, skip, once for all, cancel stopping everything, no
  Skip for a single name; a folder replaced merged, the
  other kind kept beside), a folder's upload adding up its files, failing
  once they went and stopping when cancelled, the menus' upload and
  transfer entries (none that write in read-only mode), the `DownloadURL`
  of rows dragged out.
- `internal/agent/plugin/files/upload_test.go`: uploads under free names
  (also a dot file), replacing in place (the inode and other links kept), a
  folder never replaced by a file, the data directory refused, uploads cut
  short leaving nothing; `mkdir` with `unique` and `mkdirs`.
- `internal/agent/serve_test.go`: an agent whose session ends during an
  upload returns only once the upload removed the file it was received into
  (`TestServeWaitsForRequestsToClean`).
- `web/src/__tests__/filesEditor.test.ts` (Monaco replaced): versions from
  the ETag, saves with them, conflicts overwritten and loaded, new files,
  read-only mode, files that are not text, files that cannot be read (an
  error, not an empty file), a byte order mark written back, a file that
  mixes line endings saved with each line's own ending, unified or opened
  read-only as the setting says, a change on
  disk loaded as an edit undo takes back, typing during that load kept
  and the change offered, Keep Editing not undone by the next check; a
  file removed keeping the text (unsaved changes too) and marked gone, the
  conflict bar following the file back, Overwrite making it again.
- `web/src/__tests__/files.test.ts` also: a listing that failed once kept
  without a word, failing again shown, and tried again by the next poll
  whatever started it; a folder whose first listing failed, and an empty
  one, polled; an empty root said to be empty.
