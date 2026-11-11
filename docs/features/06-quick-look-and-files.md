# 06 · Quick Look and files

## Context

Agents and scripts produce plots, renders, GIFs, videos and logs on remote
machines; their paths scroll by in terminals. Looking at them should take one
click, without opening VS Code or copying files. Conversely, users want to
hand screenshots and files to agents running on remote machines.

## Goals / non-goals

Goals: ⌘/Ctrl-click (or right-click) any path or URL in a pane, also one
wrapped over several rows; preview images, GIFs, video
(with seeking), audio, PDF, text and directories; step through sibling media;
paste or drop files into a pane to paste their paths, uploading them to the
pane's machine when they are not there (dropped files into the pane's
directory); follow uploads (progress, speed, time left), cancel them and see
the recent ones.

Non-goals: a file manager; editing files (that is VS Code's job).

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
is per browser and holds names and paths only.

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
