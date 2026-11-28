# 26 · Web terminals

## Context

The terminal core hands each viewer a terminal's raw output and takes the bytes the viewer encodes ([21](21-terminal-core.md), [22](22-terminal-protocol.md)). So the browser UI (and the desktop app) emulates terminals itself: parses output, keeps scrollback, encodes keys and mouse, and answers programs as a desktop terminal would.

## Goals / non-goals

Goals: Ghostty's emulation from a pinned release; every `terminal.*` setting honored; keeping up with programs flooding output, with bounded memory; keys, mouse, pastes and focus encoded for each program's modes, input methods included; selection, find, links and clipboard in the page; builds without zig.

Non-goals: images in terminals (kitty graphics are not built for WebAssembly); regex or whole-word find; ligatures.

## Design

**Module** (`web/src/vt/`). Ghostty's libghostty-vt as WebAssembly, released from its own repository, pinned by SHA-256 in `backend/scripts/deps.ts` and fetched into `web/src/vt/` by `backend/scripts/fetch-deps.ts`; `make check` compares it with the pin. `vt/module.ts` reads struct layouts from the library's own type description (`ghostty_type_json`), so no offsets are hard-coded, takes memory views again after every call, and passes callbacks through a small trampoline module the page builds.

**Emulator and renderer** (`vt/terminal.ts`, `vt/renderer.ts`). One emulator per attached terminal; its callbacks send answers to programs as automatic input. The terminal core answers color and size queries itself from the display facts the pane sends ([22](22-terminal-protocol.md)). WebGL2 draws changed rows from a glyph atlas, box characters as shapes so borders join; Canvas 2D is the fallback (`?renderer=canvas` forces it).

**Input** (`vt/input.ts`). A key becomes Ghostty's key event from the physical key, modifiers and text, encoded for the terminal's current modes; a keydown that sent bytes is cancelled, so the browser does not send its text again. `web/src/__tests__/testdata/vt-keys.json` pins the bytes. IME composition and dead keys arrive as text; on macOS Option types characters unless `terminal.optionIsMeta`.

**In the page** (`vt/pane.ts`, `components/TerminalView.tsx`):

- **Credit.** Output is acknowledged only once drawn, so a program floods only as fast as the page draws.
- **First paint.** The protocol has no end-of-paint mark, so nothing is drawn until the bulk output after an attach pauses, or a deadline passes; small frames, such as an agent's spinner, do not extend the wait.
- **Reattach.** A stream ending `disconnected` is reattached with a new emulator once the machine is back; a pane whose program ended attaches again to a kept terminal's new shell ([33](33-workspace-restore.md)).
- **Prelude** (`state/preludes.ts`, [36](36-terminal-history.md)). Output saved from before a terminal's program was replaced is written into each new emulator before the stream, and stays above the terminal's history since the first paint clears only the screen. It is untrusted: its answers and side effects are dropped and a complete reset follows (`PRELUDE_RESET`).
- **Kept terminals** (`keptPanes.ts`). Up to `performance.keptTerminals` terminals shown last stay attached, hidden, without drawing, measuring or a WebGL context, so returning shows them at once, unresized and where they were scrolled. Leaving a terminal does not resize it either: the hub keeps the last viewer's stream ([22](22-terminal-protocol.md)).
- **Scroll memory** (`vt/scrollMemory.ts`). A pane getting a new emulator finds the rows it showed in the new paint's scrollback, else keeps its distance from the end.
- **Links** (`terminal/links.ts`, `openLink.ts`). With ⌘/Ctrl held, OSC 8 hyperlinks and URLs or paths in the text are underlined; a click opens URLs in a new tab and paths through `actions.openPath` ([06](06-quick-look-and-files.md)): a folder is revealed in the File Explorer's tree, a file opens in its preview editor beside the terminal, replaced by the next link's (VS Code with `files.openLinks` = `vscode`). Formulas: [19](19-formulas-in-panes.md).
- **Drops.** Dropped or pasted files become their paths, uploaded first when not on the machine (`drop.ts`); the file explorer's rows of the terminal's machine are pasted as shell-quoted paths, another machine's refused (`pathsDrag.ts`, [28](28-file-explorer.md)).
- **Program clipboard writes** (OSC 52, `vt/clipboard.ts`, `terminal.programClipboard`): **Automatic** copies when the write closely follows the user's input, else a toast offers **Copy**; **Ask**; **Off**. Reads are never answered.
- **Find** (`vt/find.ts`): `find.open` searches screen and scrollback.

## Alternatives considered

| Option | Why not |
| --- | --- |
| xterm.js | Its own parsing and key encodings; Ghostty's library brings a desktop terminal's emulation and encoders. |
| Rendering on the machine, or `terminal.read` | A round trip for scrollback, selection and find, and no way to answer programs or encode keys for their modes. |
| Keeping every hidden terminal attached, or none | Memory grows with every terminal shown; detaching repaints from scratch and loses the scroll position. |
| Holding the size by `terminal.run`'s size, a zero-size stream or herdr-core's `config.toml` | The first applies only until the first viewer, a zero-size viewer's behavior is not part of herdr-core's API, and the file is the user's own. |
| Closing the last viewer's stream | The terminal would take the headless size between viewers, and full-screen programs would lay out twice. |
| Drawing the first paint as it arrives | The history visibly scrolls past before the screen stands. |

## Failure modes

- **WebAssembly refused** → terminals stay empty; the hub's CSP allows `'wasm-unsafe-eval'`.
- **No WebGL2 or context lost** → Canvas 2D, slower on large busy screens.
- **Page far behind the program** → it gets a fresh paint.
- **Connection, machine or terminal core lost** → terminals reattach with a new paint, scrolled where they were.
- **Emulator and core disagree on a character's width** → the cursor is off on that row until the program redraws.

## Security

The UI's CSP allows compiling WebAssembly (`'wasm-unsafe-eval'`), not `eval` or inline scripts. Programs' clipboard reads are refused and their writes follow the setting; only `http`, `https` and `mailto` hyperlinks open; preludes stay in page memory. See [SECURITY.md](../../SECURITY.md).

## Testing

- `web/src/__tests__/vt.test.ts` loads the module in Node: answers, selection, find, every key-table row in each mode, `drawRow`.
- `termPane.test.ts` (kept panes, hostile preludes, reattaching, drops), `keptPanes.test.ts`, `scrollMemory.test.ts`, `terminalLinks.test.ts`, `perf.test.tsx`.
- By hand in headless Chromium against a dev hub: CJK, vim, both renderers, a 200 000-line flood.
