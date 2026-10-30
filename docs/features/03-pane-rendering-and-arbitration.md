# 03 · Pane rendering and arbitration

## Context

Each pane must feel like a native terminal: Chinese input methods, mouse in
TUIs (vim, htop, coding agents), scrollback, paste, Shift+Enter for agent
prompts, correct wide characters. herdr renders panes itself and sends ANSI
frames ([01](01-herdr-integration.md)). The web UI may be open in several
browsers at once (desk, laptop, tablet), while herdr allows one controller
per pane whose size becomes the PTY size.

## Goals / non-goals

Goals: one xterm.js per visible pane; input, mouse and scroll routed to the
application exactly as herdr would; several browsers viewing the same pane
without fighting over its size or corrupting the screen.

Non-goals: local scrollback search (scrollback lives in herdr), terminal
graphics protocols (dropped by the stream).

## Design

**Rendering** (`web/src/terminal/TermController.ts`)

- xterm.js 6 with WebGL (DOM fallback), Unicode 11 widths, `scrollback: 0`.
  herdr positions every wide character explicitly, so width tables never
  drift.
- Binary frames `[sid][flags][cols][rows][ANSI]` are written as-is. A stream
  `open` event resets the terminal; a frame of a different size resizes it
  first.

**Input mapping**

| Browser event | Sent to herdr |
| --- | --- |
| `onData` / `onBinary` | `terminal.input` (text or base64 bytes) |
| paste | wrapped in bracketed-paste markers; herdr re-pastes according to the pane's own mode |
| Shift+Enter | `ESC CR` (newline in Claude Code and similar prompts) |
| wheel | `terminal.scroll` with cell position and modifiers; herdr routes it to the app or to its scrollback |
| mouse down/drag/up | `terminal.mouse`; herdr drops it unless the app enabled mouse reporting |
| drag held past the top or bottom edge | `pane.scroll` (see "Selections longer than the pane") |
| Alt/Option-drag | local selection only |
| ⌘ shortcuts | left to the browser (copy, paste) |
| prefix key | app keymap ([04](04-layout-and-keyboard.md)) |

**Key routing** (`web/src/terminal/keys.ts`)

Every key event in a pane passes through `routeKey`, which has three
outcomes: xterm.js encodes it; the app consumes it (keymap) or sends its own
bytes (Shift+Enter); or the browser keeps it (⌘ shortcuts). Consumed events
are always cancelled. A keydown that xterm.js does not see but that is not
cancelled is followed by a keypress, which xterm.js turns into a second
character: Shift+Enter once sent `ESC CR` followed by a CR, which submitted
the prompt instead of inserting a newline.

The bytes a pane receives for each key are pinned in
`web/src/__tests__/testdata/keys.json`, which two tests share:

- `web/src/__tests__/input.test.ts` drives the real `TermController`, keymap
  and xterm.js with the browser's event order (keydown, keypress only if the
  keydown was not cancelled, keyup) and compares every row's bytes. It also
  catches encoding changes from xterm.js upgrades.
- `TestIntegrationKeyParity` (`make it`) sends each row's key with herdr's
  own encoder (`pane.send_keys`) into a raw reader in normal mode and in
  application cursor/keypad mode, and compares the result with the table.
  Rows where the browser deliberately or unavoidably differs from herdr say
  so (`herdr.legacy`, `herdr.app`, `note`).

**Input modes**

herdr's frames carry only synchronized output and cursor visibility, not the
pane's input modes, so xterm.js always encodes keys as in a terminal's default
modes. Consequences, recorded in the key table:

- In application cursor mode (vim, less, zsh's line editor with keypad
  transmit) arrow keys arrive as `ESC [ A` instead of `ESC O A`. Applications
  generally accept both; key bindings made for one form only (for example a
  zsh binding on `$terminfo[kcuu1]`) do not fire.
- Applications that enable the kitty keyboard protocol receive legacy
  encodings; modifiers that legacy encodings cannot express (Ctrl+Enter,
  Shift+Enter) are lost or mapped as above.
- Focus reporting is not sent.
- Mouse reporting is decided by herdr from the pane's real modes, so clicks
  reach an application exactly once; xterm.js still makes its local selection
  during a drag.

**Selections longer than the pane** (`web/src/terminal/longSelection.ts`)

xterm.js has no scrollback here, so its own selection covers the visible
rows only. A selection drag that is held past the top or bottom edge of a
pane scrolls the pane and extends the selection, as herdr's own client
does, using herdr's public API:

- When the pointer first leaves the pane during a drag, `pane.get` gives
  the scroll position (`offset_from_bottom`, `max_offset_from_bottom`,
  `viewport_rows`). If herdr has lines to scroll in that direction, the drag
  is taken over from xterm.js; otherwise (no scrollback, an alternate
  screen, already at the end) xterm.js keeps it.
- The selection is kept in herdr's absolute rows: row 0 is the oldest line
  kept, the first visible row is `max_offset_from_bottom -
  offset_from_bottom`. Its ends are cell boundaries rounded as xterm.js
  does; past the top edge the end is the start of the first visible row,
  past the bottom the end of the last.
- Every 40 ms while the pointer stays past the edge, `pane.scroll` sets a
  new absolute offset, 1 line per step at the edge and up to 15 further
  away, one request at a time; the reply carries the new position. herdr
  clamps the offset, so scrolling stops at the oldest line and at the live
  bottom.
- xterm.js only paints the visible part of the selection (`select`), again
  after every frame (frames redraw the rows under it) and after wheel
  scrolling or typing (debounced `pane.get`, since typing returns herdr to
  the live bottom).
- On release `pane.selection.read` returns the text between the two ends
  (both cells included, rows trimmed as herdr does). Copying (⌘C/Ctrl+C or
  the browser's menu) puts that text on the clipboard instead of xterm.js's
  visible part. A copy before the text arrived copies the visible part and
  writes the whole text when it arrives.
- Only plain drags are taken over: not double- or triple-click word and line
  selections, Shift-click extension, or Alt-drag column selections (outside
  macOS; there Option-drag is a normal selection and is taken over too).
  Only the controlling browser scrolls the pane, since the scroll position
  is shared with every viewer: in read-only mode, and in an observed pane
  until a plain click has claimed it (Option-drag does not claim), the drag
  stays local.
- A new selection (a click, a double click, a stream reopening) replaces
  the long one. A right click keeps it for the browser's menu.

**Arbitration** (`internal/server/arbiter.go`)

- Per pane, the core tracks viewers (browser, stream id, container size,
  last activity) and one controller.
- A joining viewer becomes controller if there is none; otherwise it opens an
  **observe** stream at the controller's size and the UI scales it down to
  fit.
- Typing, clicking or scrolling in an observed pane sends `claim`: the
  claimant opens a control stream with takeover at its own size, the previous
  controller and other observers reopen observe streams at the new size. The
  UI queues the input that triggered the claim and replays it once control is
  granted.
- When the controller leaves, the most recently active viewer takes over.
- A takeover from outside the core (another core, the herdr CLI) turns the
  viewer into an observer with a notice code.
- Every switch opens a fresh stream, which starts with a full frame; frames
  from superseded streams are dropped by generation number.
- `resize` from the controller is forwarded to herdr outside the global lock
  so a stalled machine cannot freeze other panes.

## Alternatives considered

| Option | Why not |
| --- | --- |
| One shared control stream fanned out to all browsers | Frames are diffs; a late joiner cannot render without a full frame, and replay logs or forced redraws (resize jiggle) disturb applications. |
| Every browser takes over on attach | Browsers fight; panes resize back and forth. |
| xterm.js scrollback | Frames redraw the viewport; local scrollback would fill with duplicates. herdr's scrollback is the source of truth. |
| Long selections from lines collected out of successive frames | Frames are diffs; how far each scroll moved would have to be guessed from their content, and lines that wrap or repeat break the guess. herdr already offers absolute positions and `pane.selection.read`. |
| Long selections through stream `terminal.scroll` | Relative, with no reply: the position reached (and the end of the scrollback) is unknown. `pane.scroll` sets an absolute offset and answers with it. |
| ghostty-web instead of xterm.js | Promising, but xterm.js is mature in Chromium and WebKit and herdr already does the emulation. |

## Failure modes

- **Pane gone or stream error** → overlay with herdr's reason and a reconnect
  button.
- **Browser send queue overflow** (a client far behind) → the core drops that
  WebSocket; the client reconnects and reattaches with fresh full frames.
- **Browser reconnects** → all panes reattach; pending API requests are
  rejected and never replayed.
- **Output arrives while a long selection is shown** → herdr keeps a
  scrolled-back view in place, but at the live bottom new lines move the
  text under the highlight until the next scroll or keystroke; the copied
  text is the range read at release.
- **App with mouse reporting outside the alternate screen** → it receives the
  drag as before, and a drag held past the edge also scrolls herdr's
  scrollback (frames do not say whether the app reports the mouse).
- **`pane.selection.read` fails** → copying falls back to xterm.js's visible
  part.

## Testing

`internal/server` tests (guards, allowlist) and the integration test for
stream semantics; the key contract above (`input.test.ts`,
`TestIntegrationKeyParity`); `web/src/__tests__/longSelection.test.ts`
(absolute rows, painted and read ranges, scrolling both ways and stopping
at the ends, which drags are taken over, copy, replacement by another
selection). The arbiter flow (join, claim, resize, leave) was exercised
with scripted WebSocket clients against a dev herdr session. `pane.scroll`
clamping, absolute rows and the inclusive ends of `pane.selection.read`
were checked against herdr 0.9.5's sources and a dev session. Interactive
behavior (IME, vim mouse, scrollback, long selections and copying them)
was verified in Chrome.
