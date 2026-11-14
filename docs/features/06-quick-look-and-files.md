# 06 · Quick Look and files

## Context

Agents and scripts produce plots, renders, GIFs, videos and logs on remote
machines; their paths scroll by in terminals. Looking at them should take one
click, without opening VS Code or copying files, and so should taking them
home: a checkpoint, a results folder, a log. Conversely, users want to hand
screenshots and files to agents running on remote machines.

## Goals / non-goals

Goals: ⌘/Ctrl-click (or right-click) any path or URL in a pane, also one
wrapped over several rows; preview images, GIFs, video
(with seeking), audio, PDF, text and directories; step through sibling media;
paste or drop files into a pane to paste their paths, uploading them to the
pane's machine when they are not there (dropped files into the pane's
directory); follow uploads (progress, speed, time left), cancel them and see
the recent ones; download a path from a pane, or files and folders chosen in
the pane's directory, into the browser, folders as zip archives.

Non-goals: a file manager (the download chooser picks entries, nothing
more); editing files (that is VS Code's job).

## Design

**Links** (`web/src/terminal/links.ts`)

- With ⌘ or Ctrl held, the row under the pointer is scanned for URLs, paths
  with a slash, `~`-paths and bare file names with known extensions,
  optionally followed by `:line[:col]`; OSC 8 hyperlinks from the program
  come first. Cell columns are mapped from string indices so wide characters
  do not shift ranges ([03](03-pane-rendering-and-input.md)).
- Long paths wrap. A row whose text reaches the pane's last column is
  joined with the next row, after that row's indentation (a program that
  wraps its own text may indent continued lines), up to 20 rows either
  way. A path that happens to end exactly at the last
  column joins the next row too; the underline shows what a click opens.
  herdr's grid has no soft-wrap marks, so this is the only signal for both
  terminal and program wrapping.
- A right click offers the same for the path or URL under the pointer, or
  for the selection when it is one: **Preview**, **Open in VS Code** (not for
  media) and **Copy full path**, or **Open** and **Copy link** for URLs. A
  path wrapped in a way detection does not join (a margin before the last
  column, a diff's `+` in front of the next row) is opened by selecting it.
- Relative paths resolve against the pane's `foreground_cwd` from herdr;
  `~` against the machine's home.
- Activation requires ⌘ or Ctrl, so plain clicks still reach mouse-aware
  applications. Media opens in the preview panel; other files open in VS Code
  at the line ([05](05-vscode-panel.md)), falling back to the preview.

**Preview** (`web/src/components/Dock.tsx`)

- `GET /api/m/<machine>/file?path=` streams through the agent (`fs.stat`,
  `fs.read` with offset/length) and supports single HTTP ranges, ETags and
  `download=1`.
- Images, video and audio use native elements; PDFs an iframe; text files
  read the first 2 MiB and refuse binary content; directories list entries
  that open on click. Sibling media in the same directory are navigable with
  ← →.
- A video codec the browser cannot decode shows a hint with download and
  VS Code options.

**Downloads** (`web/src/download.ts`, `internal/server/files.go`,
`internal/agent/archive.go`)

- `GET /api/m/<machine>/download?path=…&path=…` takes up to 1000 absolute
  paths. One file comes as itself (the preview's file serving, as an
  attachment); a directory or several paths come as one zip the agent makes
  while it is downloaded (`fs.archive`), named after the one path or the
  directory holding them all. Each path is at the archive's root under its
  name (a repeated name gets `-1`, `-2`…), directories with everything
  below them, with modes and times.
- The pane menu offers **Download <name>** for the path under the pointer
  or selected (checked with a `HEAD` request first, so text that names no
  file becomes a note instead of a failed download) and **Download files…**:
  a chooser listing the pane's working directory, where entries are
  checked (or all at once), directories entered by clicking their names and
  left with the up button, and **Download** takes the checked entries of the
  directory shown in one download. Neither is offered for the desktop app's
  own machine, whose files are already on the computer; a browser offers
  them for every machine.
- The page starts a download with a same-origin link, so the browser (or the
  desktop app's save dialog) saves it like any download, where the user
  wants it. Nothing is held in the page's memory. The link carries an id
  (`dl=`), by which the downloads panel follows it (below). The core copies
  the agent's stream to the response; a download that ends early (cancelled
  in the browser or the panel) stops reading the stream before its next
  read and closes it, which stops the agent's walk. (Closing a yamux stream
  only ends its writes, and a read deadline is not checked while received
  data is waiting, which it always is while the agent keeps sending.)
- The agent sends the archive in chunks (`fs.archive` with `chunked`,
  `agentproto.ChunkWriter`) and marks its end once the archive is
  complete. A stream that ends without that mark, as when the machine's
  connection drops (yamux then ends every stream as if it were complete),
  is a truncated archive: the core aborts the response, so the browser
  reports a failed download instead of saving a broken zip. One file needs
  no mark: the response has its length, which the browser checks.
- The agent follows the paths it is given when they are symbolic links (the
  user named them) but stores links below them as links, so a link to `/`
  inside a project is not followed; sockets, devices and FIFOs are left out
  (reading a FIFO would block), and so is anything it cannot read. Nothing
  is written on the machine. Files are compressed at the fastest deflate
  level: the archive is made while it downloads.
- VS Code's explorer downloads through the same endpoint
  ([05](05-vscode-panel.md)).

**Pasted and dropped files** (`web/src/drop.ts`, `web/src/lib/files.ts`)

- Files pasted into a pane, or dragged from outside the page onto one, end
  up as their paths in the pane, shell-quoted and separated by spaces, sent
  as a paste, the way a terminal delivers dropped files: herdr brackets it
  when the program asked for that, so programs that tell pastes from typing
  (shells, coding agents) handle it as a paste. The paths go to the pane
  under the drop, which gets the focus.
- While files are dragged over a pane, it is outlined with what a drop does
  there. Read-only mode and a page that does not use the session (another
  browser has it) take no drop. Drops that nothing on the page takes are
  refused, so a file dropped beside a target is not opened by the browser in
  place of the app.
- In the desktop app, files dropped on a pane of the local machine are
  already there: their own paths are pasted, folders too, and nothing is
  copied. The shell's bridge says where a dropped file is on disk
  ([16](16-desktop-packaging.md)); browsers do not tell a page, so there
  every file is uploaded.
- Other files are `POST`ed to `/api/m/<machine>/upload?name=` of the pane's
  machine, one after the other, streamed with chunk framing; the reply holds
  the path. Folders are not uploaded; they are skipped with a note. A failed
  or cancelled upload shows in the uploads panel (a failure also as a note),
  and the paths of the others are still pasted.
- Dropped files go into the pane's working directory (herdr's
  `foreground_cwd`, so the directory of the agent running there), given as
  `&dir=`: the user put them there on purpose, and the agent finds them next
  to its project. Each keeps its own name (without control characters); a
  name already taken gets `-1`, `-2`… before the extension, so nothing there
  is replaced. The overlay and the note name that directory. When it does
  not take the file (not writable, gone) or herdr reports none, the file
  goes to the upload directory instead, with a note.
- Pasted files (mostly clipboard screenshots) go to the machine's upload
  directory, where the server adds a timestamp and random suffix (several
  clipboard images are all called `image.png`) and files expire after 7 days
  ([10](10-remote-resource-lifecycle.md)).

**Uploads panel** (`web/src/transfers.ts`, `web/src/components/Transfers.tsx`)

- Every upload of a pasted or dropped file is listed in a panel opened from
  the status bar, where a button appears once the browser has uploaded
  something; while files go it shows how many and how far they are
  together. The note of a drop that uploads has a **Show** button for it.
- The files of one paste or drop are queued together. A running upload
  shows the bytes sent of its size, its speed over the last 3 seconds and
  the time left; a waiting one shows that it waits. The browser sends the
  body with `XMLHttpRequest`, whose upload events report the bytes sent;
  the core streams the body to the agent as it arrives, so these are close
  to what has reached the machine.
- **Cancel** (and **Cancel all**) stops a running upload by aborting its
  request; the core then closes its stream to the agent, which removes the
  temporary file it was writing, so nothing of the file is left on the
  machine. A waiting upload is never sent, and the paths of the others in
  the drop are still pasted. Once the whole body is sent, the agent is
  saving the file (moving it to its name); the upload then shows as saving
  and can no longer be cancelled, since the file would arrive anyway.
- Finished uploads (done, failed or cancelled) move to the history, newest
  first: the machine, where the file is (or the directory it was going to),
  its size, time and average speed, or the error. A done upload can be
  opened in the preview panel and its path copied. The browser keeps the
  last 50 in `localStorage` (names, machines and paths, not contents);
  opening the panel shows the ones other tabs finished. Entries can be
  removed one by one or all at once; this does not touch the files.

**Downloads panel** (`web/src/download.ts`, `web/src/components/Downloads.tsx`,
`internal/server/downloads.go`)

- The same design as the uploads panel, with its own button in the status
  bar (shown once the browser has downloaded something): the downloads
  running, then the finished ones, newest first.
- A browser tells a page nothing about the downloads it saves, so the core
  reports them. A download whose link has an id (8–64 URL-safe characters;
  the page makes 128 random bits) is followed. Before starting it, the page
  tells the core over its WebSocket that it follows the id
  (`download.watch {ids}`); the core sends
  `download {id, state, sent, total?, name?, error?}` to that page alone:
  when the request arrives, when it knows the name the file is saved under
  and its size, every 250 ms while it writes the response, and once at the
  end. `sent` counts the bytes the core wrote to the response, which over a
  machine's link is close to what the browser received. At most 64
  downloads are followed at once (the others still download, without
  progress), a `HEAD` check is not.
- Every `download.watch` is answered with what the core knows of each id:
  its progress, how it ended (kept for 10 minutes, at most 256), or
  `unknown`. So a request that arrives before the page's message, or a
  download that ends while the page is reconnecting, loses nothing: after
  every reconnect the page asks again about the downloads it shows as
  running. One the core reported and no longer knows (it restarted, or the
  page was away longer than that) ends as failed with `lost`; one it has
  not seen yet keeps waiting.
- A running download shows the bytes received of its size, its speed over
  the last 3 seconds and the time left. An archive is made while it
  downloads, so its size is not known: it shows the bytes received and the
  speed, with a moving bar.
- **Cancel** (and **Cancel all**) asks the core
  (`download.cancel {id}` over the WebSocket) to break the response off:
  the browser's download fails instead of saving a partial file, the
  agent's stream ends, and the panel shows it as cancelled. A download the
  core does not know (its request never arrived) ends as cancelled at once;
  one that just ended shows how it ended. A download cancelled in the
  browser (or the desktop app's save dialog) ends the request, which the
  core also reports as cancelled.
- It ends as done once the core wrote the whole response; as failed with a
  reason when the path or machine is not there (`not_found`), the machine
  is not connected (`unavailable`), the paths were refused (`invalid`) or
  the transfer broke off (`interrupted`; the response is aborted, so the
  browser reports a failure, not a truncated archive); a note says so too.
  A download the core never reported within 30 s of connected time (the
  request did not reach it) counts as failed (`no_response`).
- Finished downloads show the machine, the paths, the size, time and
  average speed, or why they ended, and can be downloaded again or removed
  from the list. The browser keeps the last 50 in `localStorage` (names,
  machines and paths, not contents). A page reloaded during a download no
  longer follows it; the browser's own downloads still show it.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Preview only inside VS Code | Heavy for a glance; needs code-server running. |
| Inline terminal images (sixel, Kitty) | Not carried by herdr's terminal-session stream. |
| `ssh … cat` / `dd` per range request | One process per range; POSIX tool differences across platforms. |
| Client-chosen upload paths | Collisions and path injection. The browser names at most an existing directory; the server owns the file name and the agent never replaces a file. |
| Upload to the upload directory, then move | Two steps and a copy across file systems; writing in the target directory renames within it. |
| `fetch` with a streamed request body for upload progress | Streaming request bodies (`duplex: 'half'`) need HTTP/2 and are not in every browser; the core serves HTTP/1.1. `fetch` reports no upload progress otherwise. |
| Progress reported by the core over `/ws` | Another message type for what the browser already knows; the core streams the body as it arrives, so the bytes sent are close to the bytes written. |
| Cancelling during saving | The agent may already have renamed the file; a cancel that leaves the file would be misleading. |
| Zip folders with a tool on the machine (`zip`, `tar`) | Not installed everywhere, different flags across platforms, and a process to own and end; the agent's Go zip writer is the same on every machine. |
| Archive into a temporary file, then serve it | Disk on the machine and a retention rule for it, and nothing arrives until the whole archive is made. |
| tar.gz instead of zip | Not opened by a double click on Windows; zip streams just as well (data descriptors, zip64 for large files). |
| Fetch the files in the page and zip them there | Holds everything in the page's memory and needs a request per file. |
| One download per checked file | The browser asks to allow several downloads, and a folder still needs an archive. |
| Download progress by fetching the file in the page | Holds the whole file (or archive) in the page's memory before it can be saved. |
| Save with the File System Access API to follow progress | Chromium only, and asks where to save every time; downloads would behave differently per browser. |
| Progress from the desktop app's download events | Only in the desktop app; the core's count works in every browser and also tells why a download failed. |
| Download events to every page, each ignoring the ids it did not make | Other pages, read-only ones included, would learn the names saved and the ids, with which they could cancel the download. |
| Checking a zip's end record in the core instead of marking the end | Ties the core to the archive format and to the agent writing no trailing comment; the mark says the agent finished, whatever it sent. |

## Security

Files are served with `X-Content-Type-Options: nosniff`, a sandboxing CSP
(except PDFs, whose viewer refuses sandboxed frames) and HTML/JavaScript as
`text/plain`, so a file cannot run script on the app's origin. Uploads are
limited to 4 GiB and refused in read-only mode; uploads in the upload
directory expire after 7 days ([10](10-remote-resource-lifecycle.md)).
Uploads into a pane's directory must name an absolute directory; the core
takes only the file's base name, and the agent claims the name exclusively,
so an upload replaces no file and follows no symlink there. Such files are
the user's and stay. A cancelled or interrupted upload leaves no partial
file: the agent writes to a temporary file in the target directory and
removes it when the stream ends before its last chunk. The upload history
is per browser and holds names and paths only. Downloads read only what
the file preview reads, with the same headers (`nosniff`, a sandboxing
CSP), are allowed in read-only mode like viewing files, and are audited as
`file.download`; links below the paths named are not followed. Download
events carry the page's random id, the saved name, sizes, the state and a
reason code, never contents, and go only to the page that follows the id;
cancelling needs the id, is allowed in read-only mode (it changes nothing
on a machine) and is audited as `file.download.cancel`.

## Testing

`internal/server/server_test.go` (range parsing, content types, upload
names, uploads into a directory), `internal/agent/agent_test.go` (ranged
reads, chunked writes, writes that keep existing files),
`web/src/__tests__/core.test.ts` (path resolution, media detection, wrapped
links, selected links), `web/src/__tests__/surfaceSelect.test.ts` (wrapped
link underline, the pane menu's items, copy, paste and opening; which drags
a pane takes and pasting dropped files' paths), `web/src/__tests__/drop.test.ts`
(dropped files' paths on the local machine, uploads and skipped folders for
another, refused stray drops), `web/src/__tests__/transfers.test.ts`
(progress and speed, cancelling running and waiting uploads, the fallback
to the upload directory, the kept history, the panel), and
`TestCancelledUploadLeavesNoFile` in `internal/server/server_test.go` (an
aborted upload through a real agent leaves no file; a complete one arrives).
Downloads: `internal/agent/archive_test.go` (archive contents, repeated
names, links followed only at the top, modes, missing paths, an abandoned
stream, the end mark of a chunked archive), `internal/server/download_test.go` (path checks, archive names, a
file as itself and directories as zips through a real agent, `HEAD`,
read-only mode, the audit record; `TestDownloadProgress`: events of a file
and an archive to the page following them only, failure codes, the state
for a page that asks late and for an unknown id, cancelling from the panel
and in the browser with the response broken off, an archive whose machine
goes away failing instead of ending, no events without an id or for
`HEAD`),
`web/src/__tests__/download.test.ts` (the pane menu's items, the check
before a path's download, the chooser, no downloads for the desktop app's
own machine; the panel: progress and speed, an archive without a size,
failures and their notes, cancelling, a download that never started,
asking again after a reconnect and ending what the core no longer knows,
downloading again, the status bar button).
