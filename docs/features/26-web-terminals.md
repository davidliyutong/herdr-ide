# 26 · Web terminals

## Context

The terminal core hands each viewer a terminal's raw output and takes the
bytes the viewer encodes ([21](21-terminal-core.md),
[22](22-terminal-protocol.md)). So the browser UI (and the desktop app)
must emulate terminals itself: parse output, keep scrollback, encode keys
and mouse, and answer programs as a desktop terminal would.

## Goals / non-goals

Goals: Ghostty's emulation from a pinned commit; every `terminal.*`
setting honored; keeping up with programs flooding output with bounded
memory; keys, mouse, pastes and focus encoded for each program's modes
(kitty keyboard, modifyOtherKeys, SGR mouse, …); input methods, dead keys,
AltGr and Option as Meta; selection, find, links and clipboard in the
page; builds without zig.

Non-goals: images in terminals (kitty graphics are not built for
WebAssembly); regex or whole-word find; ligatures.

## Design

**Module** (`scripts/fetch-ghostty-vt.sh`, `web/src/vt/`). Ghostty's
libghostty-vt built as WebAssembly (`-Demit-lib-vt
-Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall`) from a pinned
commit. `ghostty-vt.wasm` (about 800 KB, 250 KB compressed, no imports),
Ghostty's MIT license and the module's SHA-256 are committed, so builds
and CI need no zig. `make check` compares the module with the digest;
`make vt-wasm` (zig 0.17) rebuilds it reproducibly.

**Loading** (`vt/module.ts`). Struct layouts and enum values come from the
library's own type description (`ghostty_type_json`), so no offsets are
hard-coded. Memory views are taken again after every call, since memory
may grow. Callbacks go through the function table: since a JavaScript
function cannot be put in a table directly, the page builds a small
trampoline module that imports the functions and exports them with the
right signatures.

**Emulator** (`vt/terminal.ts`). One per attached terminal, configured from
the settings (colors, `terminal.scrollback`, cursor, bold-as-bright;
grapheme widths per Unicode, mode 2027). Callbacks deliver answers to
programs (as automatic input), bells, titles, OSC 52 clipboard writes and
synchronized output (mode 2026, drawn at the latest after 1 s). The
terminal core answers color, device attribute and size queries itself
from the pane's display facts ([22](22-terminal-protocol.md)); the
emulator answers what the terminal core passes on. Each frame reads only changed
rows from the render state.

**Renderer** (`vt/renderer.ts`, `vt/atlas.ts`). `drawRow` (pure) computes
a row's backgrounds and glyphs: styles, wide characters, box-drawing and
block characters drawn as shapes so borders join at any size, underline
styles, cursor, selection and find matches.

- WebGL2 draws each frame: a one-texel-per-cell background texture and an
  instanced quad per glyph from a glyph atlas (doubling up to 4096², then
  restarting).
- Canvas 2D is the fallback when WebGL2 is missing or its context is lost;
  `?renderer=canvas` forces it.
- The cell is the width of "W" times `terminal.lineHeight`, in whole
  device pixels, remeasured when font, size or pixel ratio change.

**Input** (`vt/input.ts`). A key becomes Ghostty's key event from the
physical key, modifiers and text, so Ctrl+С on a Russian layout is
Ctrl+C. The encoder reads the terminal's modes before every key. The key
table `web/src/__tests__/testdata/vt-keys.json` pins the bytes. Cmd
shortcuts, IME composition and dead keys stay with the browser and arrive
as text. On macOS Option types characters unless `terminal.optionIsMeta`.
Pastes are bracketed when asked, with unsafe control characters replaced.
Focus is reported when asked (mode 1004).

**In the page** (`vt/pane.ts`, `components/TerminalView.tsx`,
`components/Workspace.tsx`):

- **Attach and credit.** A pane attaches once its grid is known. Output
  goes into the emulator and is drawn at the next animation frame; the
  drawn bytes are then acknowledged. So a program floods only as fast as
  the page draws, and a page far behind gets a fresh paint.
- **First paint.** The protocol has no end-of-paint mark, and drawing the
  paint as it arrived scrolled the history past before the screen stood.
  So after an attach nothing is drawn until the output pauses: frames of
  4 KiB or more ("bulk") extend the wait (40 ms, or 250 ms once the paint
  exceeds one credit window); small frames, such as an agent's spinner,
  never extend it; at 600 ms the screen is drawn regardless
  (`PAINT_*` in `vt/pane.ts`). Meanwhile output is acknowledged at once and
  bells do not ring.
- **Reattach.** A stream ending with `disconnected` is reattached with a
  new emulator when the connection or the machine's terminals are back. A
  refused attach (a shell herdr-core is restarting,
  [33](33-workspace-restore.md)) is retried 5 times 1.5 s apart, then at
  each reconnection. A pane whose program ended attaches again when the
  terminal's record is live with another pid (the core started a new shell
  at a kept terminal's address; `TermPane.setProgram`), bringing back the
  saved output and the agent ([36](36-terminal-history.md)); a finished
  terminal stays closed.
- **Prelude** (`state/preludes.ts`). Output saved from before a terminal's
  program was replaced ([36](36-terminal-history.md)) is written into each
  new emulator before the stream's first byte, at the grid it was captured
  at (at most 1000 × 500, else the pane's), followed by a dim note and
  newlines that push it into the scrollback. The first paint clears only
  the screen ([21](21-terminal-core.md)), so the prelude stays above the
  terminal's own history, found, selected and copied like it. The bytes are
  untrusted program output: while they are written the emulator's answers
  go nowhere and titles, clipboard writes, bells and synchronized output
  are dropped, and a complete reset (`PRELUDE_RESET` in `vt/pane.ts`)
  restores modes, colors, cursor and links to the settings' so nothing
  leaks into the live terminal. A prelude that changes while attached
  makes the pane attach again once changes pause for 50 ms; input typed
  meanwhile waits (up to 64 KiB) for the new stream. Preludes live in page
  memory, at most 2 MiB each.
- **Kept terminals** (`keptPanes.ts`). The terminals shown last stay
  mounted and attached, hidden, while another tab, workspace or machine is
  shown: up to `performance.keptTerminals` (default 12, 0–64,
  [13](13-settings-and-appearance.md)). A hidden terminal takes and
  acknowledges output but draws and measures nothing, so it is not
  resized; its renderer is disposed, releasing its WebGL context (a page
  has about 16). Its cost is the emulator and scrollback (about 11 MB for
  127 columns × 10 000 lines). Returning shows it at once, where it was
  scrolled. Older ones are unmounted and detached.
- **Size across detach.** Leaving a terminal does not resize it: the hub
  keeps the last viewer's stream attached until the next viewer arrives
  ([22](22-terminal-protocol.md)), so full-screen programs keep their
  layout and the next paint is exact. 10 s after the last page leaves the
  machine, terminals take the headless size.
- **Scroll memory** (`vt/scrollMemory.ts`). A pane that gets a new
  emulator (unmounted or reattached) notes the text of its first 3 rows
  shown and its distance from the end. After the new first paint, it
  searches for those rows (starting at the same distance from the end,
  then upward, at most 200 screens) and scrolls there, else to the same
  distance. Nothing is noted at the end or on the alternate screen. At
  most 200 places are kept, in page memory only, each used once.
- **Focus.** The focused pane has the keyboard; focus goes to the hub (it
  marks a finished agent turn seen, [25](25-agent-detection.md)) and, when
  asked, to the program. A pane that reattaches while focused reports
  focus again once the paint brought mode 1004.
- **Mouse.** Where the program asked for mouse events (no Shift held, not
  read-only), events are encoded at the pixel position; the right button
  opens the pane menu. Elsewhere the left button selects with Ghostty's
  gestures (word, line), `terminal.copyOnSelect` copies at release. The
  wheel goes to mouse-tracking programs, as arrow keys to alternate-screen
  programs, otherwise scrolls the scrollback.
- **Copy** uses Ghostty's formatter (wrapped lines joined, trailing blanks
  trimmed).
- **Links.** With ⌘/Ctrl held, OSC 8 hyperlinks (`http`, `https`,
  `mailto` only) and URLs or paths in the text are underlined; a click
  opens URLs in a new tab and paths in a preview or VS Code pane
  (`terminal/links.ts`, [06](06-quick-look-and-files.md)). Formulas:
  [19](19-formulas-in-panes.md).
- **Menu** (right click): Copy, Paste, Find…, the URL or path under the
  pointer, downloads ([06](06-quick-look-and-files.md)). Dropped or pasted
  files become their paths, uploaded first when not on the machine
  (`drop.ts`).
- **Bell**: `terminal.bell` flashes, beeps or does nothing.
- **Program clipboard writes** (OSC 52, `vt/clipboard.ts`), per
  `terminal.programClipboard`: **Automatic** copies at once if the write
  comes within 10 s of the user's last input in a terminal (or the release
  of a tracked mouse button, for drag-to-copy) and the browser allows it;
  otherwise a toast offers **Copy**. **Ask** always asks; **Off** ignores.
  An automatic copy also backs the menu's Copy and ⌘C for 2 minutes.
  Clipboard reads (OSC 52 `?`) are never answered. Codex emits OSC 52 only
  inside ssh or a multiplexer, which is why ssh machines' terminals carry
  `SSH_CONNECTION` ([21](21-terminal-core.md)).
- **Find** (`vt/find.ts`, `components/FindBar.tsx`): `find.open` (⌘F on
  macOS, Ctrl+Shift+F elsewhere) searches screen and scrollback, ASCII
  case-insensitive, newest match first; Enter / Shift+Enter move between
  matches, which stay highlighted as output arrives.

## Alternatives considered

| Option | Why not |
| --- | --- |
| xterm.js | Its own parsing and key encodings; Ghostty's library brings a desktop terminal's emulation and encoders. |
| A cell grid rendered on the machine | A renderer on every machine, one browser at a time, and a round trip for scrollback, selection and find. |
| Reading the screen with `terminal.read` instead of emulating | A request per change, no local scrollback, and no way to answer programs or encode keys for their modes. |
| A zig/C glue module of our own | Needs zig in every build; the trampoline module needs none. |
| Polling the emulator for replies and events | Late, reordered replies and lost events. |
| Canvas 2D only | A CPU draw call per glyph; too slow for busy screens at high pixel ratios. |
| One canvas per tab | The split layout would have to be drawn in the canvas; a canvas per pane keeps the tree HTML. |
| Keeping every hidden terminal attached | Streams and scrollback would grow with every terminal ever shown. |
| A fixed number of kept terminals | Memory to spend differs per computer; a setting, with 0 for none. |
| Kept terminals keeping their renderers | Each holds a WebGL context and a page has about 16; the browser would steal contexts from shown terminals. |
| Detaching every hidden terminal | Each return repaints from scratch and loses selection and scroll position. |
| Passing the pane's size as `size` to `terminal.run` | herdr-core uses it only until the first viewer; after viewers leave, the headless size applies. |
| A hidden zero-size stream per terminal to hold the size | A zero-size viewer's behavior is not part of herdr-core's API; the departing viewer's own stream is. |
| Writing the size into herdr-core's `config.toml` | The user's own file, shared with their sessions; veldr never writes it. |
| Closing the last viewer's stream | The terminal became 200x120 between viewers: full-screen programs laid out twice, lost their scroll position and painted wrongly. |
| Restoring scroll by row number from the top | The terminal core's history may be cut at the top where the page's was not. |
| Restoring scroll by distance from the end alone | Output written meanwhile shifts it; the distance is only the search's start and fallback. |
| Drawing the first paint as it arrives | The history visibly scrolled past before the screen stood. |
| Every frame extending the first-paint wait | A working agent's spinner kept the pane blank until the deadline. |
| Building the module in CI | Needs zig and Ghostty's dependencies; the reproducible build's digest is checked instead. |
| Regex and whole-word find | The emulator's search finds plain text only. |

## Failure modes

- **WebAssembly refused** → terminals stay empty; the hub's CSP allows
  `'wasm-unsafe-eval'`.
- **No WebGL2 or context lost** → Canvas 2D, slower on large busy screens.
- **Page draws slower than the program writes** → the hub pauses at
  256 KiB unacknowledged; 4 MiB behind it sends a fresh paint.
- **Connection, machine or terminal core lost** → streams end with
  `disconnected`; terminals (shown and kept) reattach with a new paint,
  scrolled where they were, and may be resized once.
- **No page on a machine for 10 s** → terminals take the headless size;
  the next pane resizes once.
- **Page reloaded** → scroll places are forgotten; terminals paint at the
  end.
- **Noted rows not found** → the view goes to the same distance from the
  end.
- **Output pauses mid-paint** (slow link) → what came is drawn, the rest
  as it comes.
- **Terminal font loads late** → terminals are remeasured and resized.
- **Emulator and terminal core disagree on a character's width** → the cursor is
  off on that row until the program redraws.
- **A program writes the clipboard without user input** → offered, not
  copied.
- **Prelude of unknown or oversized grid** → written at the pane's grid; on
  a taller pane the lines right above the saved screen are lost.
- **Input during a reattach for a prelude** → sent on the new stream, but
  encoded before the paint brought the program's modes (a paste is not
  bracketed).
- **Terminal core restarted while a page is open** → kept terminals' panes
  show that their program ended, then attach again to the new shell.

## Security

The UI's CSP allows compiling WebAssembly (`'wasm-unsafe-eval'`), not
`eval` or inline scripts; the module is served from the hub. Programs'
clipboard writes follow the setting above and reads are refused; only
`http`, `https` and `mailto` hyperlinks open. Scroll-memory rows and
preludes stay in page memory, neither stored nor sent; a prelude is
written as untrusted output, its answers and side effects dropped and a
complete reset after it. The stream kept for a terminal's
size belongs to no client. See [SECURITY.md](../../SECURITY.md).

## Testing

- `web/src/__tests__/vt.test.ts` loads the module in Node: trampoline,
  layouts, cells and attributes, answers, OSC 52, selection, find,
  hyperlinks, encoders, every key-table row in each mode, and `drawRow`.
- `keptPanes.test.ts`, `scrollMemory.test.ts`, `perf.test.tsx`,
  `terms.test.ts`, `termOptions.test.ts`, `clipToast.test.ts`,
  `drop.test.ts`, `menus.test.ts`, `codePanes.test.ts`.
- `termPane.test.ts`: kept panes, preludes (order, grids, hostile output
  reset, answers dropped, input queued) and reattaching to a new program;
  `terminalViewProgram.test.tsx`, `machineSwitch.test.ts`.
- Manual, in headless Chromium against a dev hub: colors, CJK and emoji,
  vim, resizing, splits, find, copy, WebGL and Canvas 2D, and a
  200 000-line flood; Claude Code's size and scroll position kept across
  unmounting.
- The hub's side: `backend/features/terminals/terminals.test.ts`
  ([22](22-terminal-protocol.md)).
