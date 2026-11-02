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
paste or drop files into a pane to upload them and type their paths.

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

**Uploads**

- Pasted or dropped files are `POST`ed to `/api/m/<machine>/upload?name=`.
  The server picks the destination in the machine's upload directory with a
  timestamp and random suffix (several clipboard images are all called
  `image.png`), streams it with chunk framing, and returns the path, which
  the UI types into the pane, shell-quoted.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Preview only inside VS Code | Heavy for a glance; needs code-server running. |
| Inline terminal images (sixel, Kitty) | Not carried by herdr's terminal-session stream. |
| `ssh … cat` / `dd` per range request | One process per range; POSIX tool differences across platforms. |
| Client-chosen upload paths | Collisions and path injection; the server owns naming. |

## Security

Files are served with `X-Content-Type-Options: nosniff`, a sandboxing CSP
(except PDFs, whose viewer refuses sandboxed frames) and HTML/JavaScript as
`text/plain`, so a file cannot run script on the app's origin. Uploads are
limited to 4 GiB and refused in read-only mode; uploads expire after 7 days
([10](10-remote-resource-lifecycle.md)).

## Testing

`internal/server/server_test.go` (range parsing, content types, upload
names), `internal/agent/agent_test.go` (ranged reads, chunked writes),
`web/src/__tests__/core.test.ts` (path resolution, media detection, wrapped
links, selected links), `web/src/__tests__/surfaceSelect.test.ts` (wrapped
link underline, the pane menu's items, copy, paste and opening).
