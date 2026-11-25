# 06 · Quick Look and files

## Context

Agents and scripts produce plots, renders, videos and logs on remote
machines, and their paths scroll by in terminals. Looking at one should take
one click, without opening VS Code or copying files. Taking results home (a
checkpoint, a results folder) should be as easy. The other way round, users
hand screenshots and files to agents running on those machines.

## Goals / non-goals

Goals:

- ⌘/Ctrl-click (or right-click) a path or URL in a pane, also one wrapped
  over several rows.
- Preview images, GIFs, video (with seeking), audio, PDF, text and
  directories; step through sibling media.
- Paste or drop files into a pane to paste their paths, uploading them when
  they are not on the pane's machine.
- Follow uploads and downloads in panels: progress, speed, cancel, history.
- Download a path, or entries of the pane's directory, into the browser;
  folders as zip archives.

Non-goals: browsing, changing and editing files. The file explorer
([28](28-file-explorer.md)) and VS Code panes do that; the download chooser
only picks entries.

## Design

### Links

`web/src/terminal/links.ts` finds links, `openLink.ts` opens them.

- With ⌘ or Ctrl held, the row under the pointer is scanned for OSC 8
  hyperlinks first, then URLs, paths, `~`-paths and bare file names with
  known extensions, optionally with `:line[:col]`. Requiring the modifier
  leaves plain clicks to mouse-aware programs.
- A row whose text reaches the last column is joined with the next one (up
  to 20 rows). Programs that wrap their own text (Claude Code, Codex) leave
  no soft-wrap marks, so this one signal covers both kinds of wrapping. A
  path wrapped in a way detection does not join is opened by selecting it.
- A right click offers **Preview**, **Open in VS Code** and **Copy full
  path** for a path (or the selection), **Open** and **Copy link** for a URL.
- Relative paths resolve against the terminal's directory, `~` against the
  machine's home.
- Media opens in the workspace's preview pane, else a new one split beside
  the terminal. Other files open at the line in a VS Code pane of the
  workspace whose folder holds the file, else a new one beside the terminal
  (`actions.openPath`, [05](05-vscode-panes.md)).

### Preview

`web/src/components/PreviewPane.tsx`.

- A preview is a pane of the layout document (`{"preview": {"id",
  "path"}}`, [22](22-terminal-protocol.md)). It splits, moves and survives
  reloads like any pane ([04](04-layout-and-keyboard.md)). Stepping to a
  sibling or into a directory changes the document's path, so every client
  follows.
- `GET /api/m/<machine>/file?path=` streams through the agent (`fs.stat`,
  `fs.read`) with single HTTP ranges, ETags and `download=1`.
- Images, video and audio use native elements, PDFs an iframe. Text shows
  the first 2 MiB, highlighted (`web/src/highlight`), and refuses binary
  content. Directories list up to 20 000 entries (`GET
  /api/m/<machine>/list`). An undecodable video codec shows a hint with
  download and VS Code options.
- Markdown renders (`web/src/markdown`, loaded on first use) with GitHub's
  extensions, KaTeX formulas and highlighted code blocks; a button shows the
  source. See [Security](#security) for what the renderer refuses.
- A file deleted or moved away is struck through in the header, as in the
  explorer's editors ([28](28-file-explorer.md)), and the preview keeps the
  last content it showed. It loads again once the file is back.

### Downloads

`web/src/download.ts`, `backend/features/files/hub.ts`, `names.ts`,
`backend/machine/fsops.ts`.

- `GET /api/m/<machine>/download?path=…&path=…` takes up to 1000 absolute
  paths. One file comes as itself; a directory or several paths come as one
  zip the agent writes while it is downloaded (`fs.archive`). Each path sits
  at the archive's root; repeated names get `-1`, `-2`….
- The pane menu offers **Download <name>** for the path under the pointer
  (checked with `HEAD` first) and **Download files…**, a chooser over the
  pane's working directory with a filter and Shift ranges. Neither is shown
  for the desktop app's own machine, whose files are already local.
- The page starts the download with a same-origin link, so the browser (or
  the desktop app's save dialog) saves it like any download. Nothing is held
  in the page's memory.
- The agent sends the archive in chunks (`agentproto.ChunkWriter`) and marks
  its end. When the machine's connection drops, yamux ends streams as if
  complete; a stream without the end mark is therefore a truncated archive,
  and the hub aborts the response so the browser reports a failure instead
  of saving a broken zip.
- A download that ends early stops the hub reading the agent's stream and
  closes it, which ends the agent's walk.
- The agent follows the named paths when they are symlinks but stores links
  below them as links. It skips sockets, devices, FIFOs and unreadable
  entries, writes nothing on the machine, and uses the fastest deflate level.
- VS Code's explorer downloads through the same endpoint
  ([05](05-vscode-panes.md)).

### Pasted and dropped files

`web/src/drop.ts`, `web/src/lib/files.ts`.

- Pasted or dropped files end up as shell-quoted paths sent to the pane as a
  paste, the way a terminal delivers dropped files. Programs that tell pastes
  from typing (shells, coding agents) treat them as a paste.
- A pane outlines what a drop does there. Read-only mode takes no drop. Drops
  nothing takes are refused, so the browser does not open the file in place
  of the app.
- In the desktop app, files dropped on a pane of the local machine are
  already there: their paths are pasted and nothing is copied
  ([16](16-desktop-packaging.md)). Browsers do not reveal local paths, so
  there every file is uploaded.
- Uploads go one at a time to `POST /api/m/<machine>/upload?name=`, streamed
  with chunk framing; the reply holds the path. Folders are skipped with a
  note on panes (the file explorer uploads them).
- Dropped files go into the pane's working directory (`&dir=`, the
  foreground program's), so the agent finds them next to its project. A
  taken name gets `-1`, `-2`… and nothing is replaced. If that directory
  does not take the file, it goes to the upload directory with a note.
- Pasted files (mostly clipboard screenshots, all called `image.png`) go to
  the machine's upload directory with a timestamp and random suffix, and
  expire after 7 days ([10](10-remote-resource-lifecycle.md)).

### Transfer panels

Uploads: `web/src/transfers.ts`, `web/src/components/Transfers.tsx`.
Downloads: `web/src/components/Downloads.tsx`,
`backend/features/files/downloads.ts`.
Shared: `web/src/transferList.ts`, `web/src/components/TransferPanel.tsx`,
`web/src/components/useHoverOpen.ts`.

- Each panel has a status bar button that appears after the first transfer.
  It opens on hover and stays open after a click.
- Running transfers show bytes, speed over the last 3 seconds and time left.
  Finished ones (newest first, the last 50 kept in `localStorage`: names,
  machines and paths, never contents) show size, time and speed, or the
  error. A finished upload can be previewed; a download can be repeated.
- Upload progress comes from `XMLHttpRequest`'s upload events. The hub
  streams the body to the agent as it arrives, so bytes sent are close to
  bytes written on the machine.
- Cancelling an upload aborts its request; the agent then removes the
  temporary file it was writing. Once the body is sent the upload shows as
  saving and can no longer be cancelled, since the file arrives anyway.
- Browsers tell a page nothing about downloads, so the hub reports them.
  The page gives the link a random id (`dl=`) and sends `download.watch
  {ids}` over `/ws`. The hub sends `download {id, state, sent, total?,
  name?, error?}` to that page alone, and answers each watch with what it
  knows. A page that reconnects asks again; an id the hub has forgotten
  (kept 10 minutes after the end) ends as `lost`.
- Cancelling a download (`download.cancel {id}`) makes the hub break the
  response off, so the browser fails it instead of saving a partial file.
  A request that arrives after its cancel gets `410 Gone`.
- Failures carry a code: `not_found`, `unavailable`, `invalid`, `changed`
  (`416` for a resumed download past the file's end) or `interrupted`. Only
  `interrupted` aborts the response; the others are answered with their
  error.
- A download the hub has not seen after 30 s shows as not started:
  browsers hold back downloads to one host beyond a few.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Preview only inside VS Code | Heavy for a glance; needs code-server. |
| Inline terminal images (sixel, Kitty) | The browser's emulator has no image support ([26](26-web-terminals.md)). |
| `ssh … cat` / `dd` per range request | A process per range; tool differences across platforms. |
| Client-chosen upload paths | Collisions and path injection; the server owns the name. |
| Upload to the upload directory, then move | Two steps and a copy across file systems. |
| `fetch` with a streamed body for upload progress | Needs HTTP/2 and is not in every browser; `fetch` has no upload progress. |
| Upload progress reported by the hub | Duplicates what the browser already knows. |
| Cancelling during saving | The file may already be renamed into place. |
| Zipping with `zip`/`tar` on the machine | Not installed everywhere, flags differ, a process to own. |
| Archive to a temporary file, then serve | Disk and retention on the machine; nothing arrives until done. |
| tar.gz instead of zip | Windows does not open it on double click; zip streams as well. |
| Zipping in the page | Holds everything in memory, a request per file. |
| One download per checked file | Browsers prompt for multiple downloads; folders still need an archive. |
| Download progress by fetching in the page | Holds the whole file in the page's memory. |
| File System Access API | Chromium only, asks where to save every time. |
| Progress from the desktop app's download events | Desktop only; the hub's count works everywhere and knows why it failed. |
| Download events to every page | Other pages (read-only ones too) would learn names and ids, and could cancel. |
| Checking the zip's end record in the hub | Ties the hub to the archive format; the mark says the agent finished. |

## Failure modes

- A machine that disconnects mid-download: the archive lacks its end mark,
  the response is aborted, the browser reports a failure.
- A hub restarted or a page away longer than 10 minutes: running downloads
  in the panel end as `lost`.
- A page reloaded during a download no longer follows it; the browser's own
  download list still does.
- A pane directory that cannot take an upload: the file goes to the upload
  directory, with a note.

## Security

- Served files carry `X-Content-Type-Options: nosniff` and a sandboxing CSP
  (except PDFs, whose viewer refuses sandboxed frames); HTML and JavaScript
  are served as `text/plain`. A file cannot run script on the app's origin.
- The Markdown renderer treats the file as untrusted: HTML shows as text;
  links keep their target only for `http`, `https`, `mailto` and files beside
  the document; images load only from raster `data:`, `blob:` or files beside
  the document. Remote images become links, so opening a file does not tell
  a server who reads it.
- Uploads are limited to 4 GiB and refused in read-only mode. An upload into
  a pane's directory must name an absolute directory; the hub keeps only the
  base name and the agent claims it exclusively, so no file is replaced and
  no symlink followed. A cancelled or interrupted upload leaves no partial
  file.
- Downloads read only what the preview reads, with the same headers, are
  allowed in read-only mode and are audited (`file.download`). Links below
  the named paths are not followed.
- Download events carry ids, names, sizes and states, never contents, and go
  only to the page that watches the id. Cancelling needs the id, is allowed
  in read-only mode (it changes nothing on a machine) and is audited
  (`file.download.cancel`).

## Testing

- `backend/features/files/serve.test.ts`: ranges (`parseRange`), content
  types (`content types are never active`); `names.test.ts`: upload names
  (`upload names are unique and safe`, `upload into a directory`);
  `transfers.test.ts`: aborted uploads (`a cancelled upload leaves no
  file`).
- `backend/machine/agent.test.ts`: ranged reads and chunked writes
  (`file operations`).
- `backend/machine/fsops.test.ts`: archive contents, names, links, the end
  mark.
- `backend/features/files/names.test.ts` (`downloadPaths`),
  `transfers.test.ts` (`files and archives`, `progress, ends and cancels`,
  `edges`): downloads.
- Web (`web/src/__tests__`): `core.test.ts` (path resolution, wrapped and
  selected links), `codePanes.test.ts` (where a path opens), `vt.test.ts`
  (hyperlinks), `filesGone.test.ts`, `drop.test.ts`, `transfers.test.ts`,
  `download.test.ts`.
