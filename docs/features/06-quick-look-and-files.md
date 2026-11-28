# 06 · Quick Look and files

## Context

Agents on remote machines produce plots, videos and logs whose paths scroll by in terminals. Looking at one should take one click; taking results home, and handing screenshots to agents there, should be as easy.

## Goals / non-goals

Goals: ⌘/Ctrl-click a path or URL in a pane, also one wrapped over rows; preview images, video (with seeking), audio, PDF, text, Markdown and directories; paste or drop files into a pane as paths, uploading them when they are not on its machine; download paths, folders as zip archives; follow transfers in panels.

Non-goals: browsing, changing and editing files ([28](28-file-explorer.md), VS Code panes).

## Design

### Links

- `web/src/terminal/links.ts` finds OSC 8 hyperlinks, URLs, paths and bare file names with optional line, column or range suffixes in the row under the pointer, only with ⌘/Ctrl held so plain clicks stay with mouse-aware programs. Soft-wrapped rows, rows filled to the last column (programs that wrap their own text leave no soft-wrap mark) and paths inside a TUI's box borders are joined; boundaries stop at CJK text and punctuation.
- `openLink.ts` resolves relative paths against the terminal's directory and hands them to `actions.openPath`: a folder is revealed in the file explorer's tree; a file opens (`files.openLinks` = `editor`) in the explorer's preview editor split beside the terminal, reused by the next link, at the line given, or with `vscode` (non-media files) in VS Code ([05](05-vscode-panes.md)); without the explorer, in VS Code or Quick Look.

### Preview

`web/src/components/PreviewPane.tsx`: a pane of the layout document (`{"preview": {"id", "path"}}`, [22](22-terminal-protocol.md)) that splits, moves and survives reloads like any pane; stepping to a sibling or into a directory changes the document, so every client follows. `GET /api/m/{id}/file` streams through the agent with HTTP ranges and ETags, so a video seeks without downloading everything. Text is highlighted, Markdown rendered (`web/src/markdown`). A file deleted or moved away is struck through and its last content stays.

### Downloads

`GET /api/m/{id}/download` (`backend/features/files/hub.ts`): one file as itself, a directory or several paths as one zip the agent writes while it is downloaded (`fs.archive`, `backend/machine/fsops.ts`). A same-origin link starts it, so the browser saves it like any download and the page holds nothing. The agent marks the archive's end; yamux ends a dropped connection's streams as if complete, so the hub aborts a response without the mark and the browser reports a failure instead of saving a broken zip.

### Pasted and dropped files

`web/src/drop.ts`: pasted or dropped files arrive in the pane as shell-quoted paths, as a terminal delivers dropped files. The desktop app pastes local files' own paths on the local machine ([16](16-desktop-packaging.md)); otherwise each file is uploaded (`POST /api/m/{id}/upload`, streamed; folders are left to the file explorer). Dropped files go into the pane's working directory, next to the agent's project, never replacing a file; pasted ones (clipboard screenshots, all `image.png`) go to the machine's upload directory under a unique name and expire there ([10](10-remote-resource-lifecycle.md)).

### Transfer panels

`web/src/transfers.ts`, `components/Downloads.tsx`, `backend/features/files/downloads.ts`: status bar panels with progress and recent history (names and paths, never contents). A cancelled upload leaves no partial file. Browsers tell a page nothing about downloads, so the hub reports them: the page tags the link with a random id and sends `download.watch` over `/ws`, the hub sends that page alone the download's events, and `download.cancel` makes it break the response off.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Preview only inside VS Code | Heavy for a glance; needs code-server. |
| Inline terminal images (sixel, Kitty) | The browser's emulator has no image support ([26](26-web-terminals.md)). |
| Client-chosen upload paths | Collisions and path injection; the server owns the name. |
| `zip`/`tar` on the machine, or an archive in a temporary file | Not installed everywhere; disk and retention, nothing arrives until done. |
| Zipping or fetching downloads in the page | Holds everything in the page's memory. |
| Download events to every page | Other pages, read-only ones too, would learn names and could cancel. |

## Failure modes

- A machine that disconnects mid-download: no end mark, the browser reports a failure.
- A hub restarted, or a page away too long: running downloads end as `lost`.
- A pane directory that cannot take an upload: the file goes to the upload directory, with a note.

## Security

Rows of [SECURITY.md](../../SECURITY.md): served files carry `nosniff` and a sandboxing CSP, HTML as `text/plain`, so a file cannot run script on the app's origin; the Markdown renderer sanitizes with an allowlist (`web/src/markdown/sanitize.ts`) and turns remote images into links; uploads (at most 4 GiB, refused read-only) never replace a file or follow a link; downloads are audited and their events go only to the watching page.

## Testing

- `backend/features/files/`: `serve.test.ts`, `names.test.ts`, `transfers.test.ts` (ranges, content types, names, transfers, cancels); `backend/machine/fsops.test.ts` (archives, the end mark).
- `web/src/__tests__/`: `core.test.ts`, `terminalLinks.test.ts` (detection, where a path opens), `vt.test.ts` (hyperlinks), `previewPane.test.tsx`, `drop.test.ts`, `transfers.test.ts`, `download.test.ts`.
