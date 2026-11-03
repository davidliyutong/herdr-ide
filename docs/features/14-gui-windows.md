# 14 · GUI windows

## Context

Programs started in panes on remote machines sometimes open windows: a
matplotlib figure, the MuJoCo viewer, a Qt tool. Over plain ssh they fail
(`cannot open display`) or fall back to no output. Machines are typically
shared servers and workstations where the user has no root, so nothing may
require installing system packages, and nothing may listen on TCP. What is
needed is the program's window, not a remote desktop.

## Goals / non-goals

Goals: windows of programs on remote Linux machines appear in the browser,
one browser window per program window, with keyboard and mouse; no
privileged installation; GPU rendering where VirtualGL is installed;
programs survive network interruptions; nothing to configure for the common
case.

Non-goals: a full remote desktop; the local machine (its windows already
open on the user's screen); macOS machines (capturing their windows needs a
permission that can only be granted in a GUI session); audio, clipboard and
input methods.

## Design

**Display** (agent `internal/agent/gui.go`)

- Each instance has one virtual display per machine: Xvfb, found on `PATH`,
  in `/usr/bin` or `/usr/local/bin`, or else fetched with
  `apt-get download xvfb` (no privileges; apt checks the package against its
  signed lists) and unpacked with `dpkg-deb -x` into
  `~/.herdr-ide/xvfb/<version>/` (shared by instances). The unpacked server
  uses the libraries, `xkbcomp` and keyboard data that a desktop or Xwayland
  already put on the machine; it was verified on Ubuntu 24.04 machines that
  have no Xvfb.
- The display number is reserved in `run/gui.json` (from `:20`) and kept
  across restarts, so panes keep a valid `DISPLAY`. The socket has to be
  `/tmp/.X11-unix/X<n>`: libxcb before 1.16 (Ubuntu 24.04 ships 1.15) cannot
  use a socket path in `DISPLAY`, and on Linux it tries the abstract socket
  of the same name first. Anyone can create those, and X clients cannot
  authenticate the server, so a number is used only while no lock file,
  socket or listener of another user is on it (and `/tmp/.X11-unix` is a
  directory of root or the user that is sticky or not writable by group and
  others); otherwise another one is reserved.
  The agent sends the cookie only to a server whose peer credentials
  (`SO_PEERCRED`) are the Xvfb it recorded, and after starting Xvfb checks
  that both sockets answer with it (clients try the abstract one first). A
  file lock (`run/gui.lock`) serializes
  reservation and start between agents of the instance.
- Each Xvfb start writes a new MIT-MAGIC-COOKIE-1 for the display: Xvfb reads
  `run/xauth.server`, panes get `run/xauth` (both 0600). Programs that edit
  their `XAUTHORITY` file cannot leave the server without a cookie, which
  would let any local user in. Xvfb runs with `-nolisten tcp`, a 2560×1440
  screen, in its own session so that it survives the agent and the ssh
  connection, and with `-terminate 21600`: it exits six hours after its last
  client disconnected. The agent connects once right after starting it, so
  a display nobody attaches to exits too. xorg-server before 21.1 lacks the
  delay: such a server exits as soon as its last client leaves, and one that
  never got a client stays until an agent attaches. While an agent is
  connected its window manager is a client, so the display stays.

**Panes** (`internal/server/gui.go`, `internal/gui`)

- When the GUI setting is on for a machine, the core adds `DISPLAY` and
  `XAUTHORITY` to the `env` of `workspace.create`, `tab.create` and
  `pane.split` for that remote machine once its display is ready (verified
  as the instance's own). Variables the browser set win. The audit log
  records which variables were added.
- Panes created otherwise (before the display existed, in herdr's own UI or
  CLI) keep their environment: a shell gets its variables when it starts,
  and herdr has no default environment for new panes. "Enable in open
  panes" (settings dialog, per machine) and the palette command for the
  focused pane (`POST /api/m/{id}/gui/enable`) catch them up without
  restarting anything: for each pane the core asks herdr for the shell and
  its foreground process group (`pane.process_info`) and the agent which
  shells were started with the display (`/proc/<pid>/environ`, action
  `shells`, which also reports each process's executable name). A known shell
  (bash, zsh, fish, dash, sh, ksh and similar) waiting at its prompt (checked
  again right before) gets Ctrl-C, which discards a half-typed command line,
  and after 200 ms
  ` export DISPLAY='…' XAUTHORITY='…'` (`pane.send_text`, values
  single-quoted, leading space to keep it out of history where enabled); a
  pane running a program (an agent, an editor, a program that replaced its
  shell with `exec`) is not typed into and is reported, with the command to
  copy. A shell busy with a builtin (`read`) looks idle and gets the text.
  Unreachable panes are skipped and reported; the audit record lists the
  panes typed into even when the request fails. The core remembers the shells it typed
  into until it restarts. A program already running keeps its environment:
  an agent started before has to be restarted from a shell that has the
  display.
- On machines with a working VirtualGL EGL back end (`vglrun` found, its
  `eglinfo egl0` succeeds) panes also get `VGL_DISPLAY=egl0`, so
  `vglrun program` renders on the GPU without a 3D X server. With
  `gui-gpu=all` panes get VirtualGL's `LD_PRELOAD` and `VGL_ISACTIVE=1`, as
  if the shell ran under `vglrun`.

**Window manager and capture** (agent `internal/agent/guiwm.go`)

- The agent connects to the display (jezek/xgb, pure Go) and becomes its
  window manager. Top-level windows keep the size their program asks for and
  are placed at the origin; the window receiving input is raised first.
  Windows get `WM_STATE`, `_NET_FRAME_EXTENTS` and EWMH basics that toolkits
  wait for. Override-redirect windows (menus, tooltips) are layers of their
  transient-for window or, without one, of the focused window. Windows left
  by a previous agent are adopted.
- Composite's automatic redirection gives every window its own pixmap, so
  overlapping windows do not hide each other. Damage reports changed
  rectangles; at most every 16 ms the changed area of each watched window is
  read with `GetImage` and sent as JPEG (quality 85) or, for areas under
  128×128, PNG. After 400 ms without changes, areas sent as JPEG are sent
  again as PNG, so still pictures end up exact. At most three frames per
  window wait for acknowledgement; the frame rate follows what the browser
  can show. Captures are split into tiles of at most 1024×1024, so a huge
  window costs bounded memory per frame.
- While a window is watched, the agent reports once a second what its
  frames cost (`stats` event): updates (ticks that sent frames) and frames,
  pixels and bytes, time spent capturing, converting and encoding, ticks
  held back by unacknowledged frames, and the time from capture to
  acknowledgement. The core passes it to the window's browser windows.
- A new window takes the keyboard focus only when nothing has it or it is a
  dialog of the focused window; a click focuses its window first, and before
  each key press the window manager checks where the focus is and moves it
  back to the window the key was typed for, also when a program took the
  focus itself.
- The program of a window comes from `_NET_WM_PID`, else the X-Resource
  extension; its herdr pane from `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` in
  `/proc/<pid>/environ` (or its nearest ancestor's). The core keeps the pane
  only when the socket is the machine's herdr session.
- Input arrives in window coordinates and is replayed with XTEST: pointer
  motion, buttons, wheel steps (buttons 4–7) and keys as X keycodes. The
  browser sends the physical key (`KeyboardEvent.code` → evdev code + 8), so
  key bindings of programs work; the display's US layout produces the
  characters. Closing asks the program with `WM_DELETE_WINDOW`, or
  disconnects it when it does not support that. The pointer image follows
  XFIXES cursor changes.

**Video** (experimental, `--gui-video on`; agent
`internal/agent/guiwm_video.go`, `guivideo.go`, encoder `scripts/encoder/`)

- A window that keeps changing (a simulator, a rotating plot) costs a whole
  JPEG per frame. With video on, a watched window is sent as frames of a
  video stream of the whole window instead, while all its viewers decode
  one kind of stream the machine can make and at least 8 of the last 12
  ticks changed a quarter of it or more. Each change is then one video
  frame, small ones too. Once the window is unchanged for 400 ms it is sent
  again as PNG (video blurs colored text, 4:2:0), and after 5 s unchanged
  the stream ends. Layers stay pictures. Windows under 64 pixels a side are
  never video.
- Browsers name the streams they decode in the WebSocket's `?video=`:
  `avc1` (H.264) and `vp8`, probed with WebCodecs' `isConfigSupported`, and
  only in a secure context (localhost, HTTPS, the desktop app). The core
  passes the kinds every viewer of the window decodes to the agent with
  `watch` and `refresh`, ordered H.264 before VP8, and `codecs` when viewers
  leave; without `--gui-video` it passes none.
- The encoder is a small program on ffmpeg's libraries (LGPL build, static
  except for glibc 2.28) that the core embeds and pushes to each machine
  when its display is ready: `~/.herdr-ide/video/<sha256 prefix>/encoder`,
  verified by its SHA-256, shared by instances. The agent then runs it once
  per stream kind on a small frame to learn what works: H.264 through
  NVENC (the NVIDIA driver's libraries, driver 550.54 or newer), VP8
  through libvpx on the CPU. It reads raw frames from a pipe and writes one
  packet per frame, a key frame when asked, so frames are not held back (a
  muxer, as in the ffmpeg program, keeps each frame until the next one
  arrives). One encoder runs per window sent as video.
- A stream starts with a `video` event (codec string, coded size) and a key
  frame; frames carry `Enc` 3, or 4 for key frames, and are paced by
  acknowledgements like pictures. The agent starts a new stream when the
  window is resized or its viewers now all decode a preferred kind, and
  makes a key frame when a viewer asks (`keyframe`, `refresh`).
- The core routes video frames like pictures, except that a viewer that
  missed one (it was behind, or joined during a stream) gets no frames of
  the stream until the next key frame, which the core asks for once the
  viewer has nothing in flight, at most twice a second. A viewer joining
  gets the stream's `video` event first.
- The browser decodes with one `VideoDecoder` per window
  (`optimizeForLatency`), in the order frames arrive (pictures included),
  draws each frame on the window's canvas and then acknowledges it. A
  decoding error drops the decoder and asks for a key frame.
- Anything failing sends the window as pictures: no encoder in the build or
  on the machine, no stream kind in common, the encoder not starting or
  exiting (then pictures for 5 s, doubling up to 5 minutes, before trying
  again). `#stats` shows the encoder in use or why pictures are sent.

**Routing** (`internal/gui/gui.go`)

- The core prepares a machine's display when the machine connects (status,
  install, start, attach; phases `installing`, `starting`, `ready`, `error`,
  `unavailable`, `unsupported`, `off`, `local`), keeps one attach stream per
  machine and re-attaches after errors. A display is prepared once per
  connection of the machine; a failed preparation or an attach stream that
  ends within a minute is retried after 5 s, doubling up to 5 minutes, and
  a change of the GUI setting or a reconnect starts over. Turning the
  setting off while a display is prepared leaves it detached. Every `/ws`
  client gets `gui` messages with each machine's phase and windows.
- Frames go to every browser window showing that window. The fastest viewer
  acknowledges frames to the agent (only frames it was sent count); a viewer
  more than four frames behind skips frames and, once it caught up, gets the
  whole window again; a frame no viewer got is acknowledged by the core. A
  viewer may ask for the whole window at most twice a second.
- In read-only mode the core attaches only to a display that already runs
  (phase `not_running` otherwise): nothing is installed or started. Installs
  and starts are audited (`gui.install`, `gui.start`).

**Browser windows** (`web/src/gui/`)

- `/m/{machine}/gui/{window}` is the app showing one window: canvases for the
  window and its layers, scaled to fit the browser window with the aspect
  kept, input sent back over `/m/{machine}/gui/{window}/ws`. The browser
  window opens at the program window's size and follows its size changes.
- A window that appears while its pane is on screen opens at once
  (`window.open`). Browsers block pop-ups not caused by a click unless the
  site is allowed to open them; then a toast offers to open it. Other new
  windows are marked on the program windows button of the tab's toolbar
  ([03](03-pane-rendering-and-input.md)) while their pane is focused, until
  opened; the button lists the pane's windows, and the status bar lists every window, including
  those without a pane. A dialog of a window (`WM_TRANSIENT_FOR`) is opened
  by the browser window of its parent, which may still do so after the click
  that caused it; if blocked, that window shows a button for it.
- With `#stats` at the end of its address, a browser window shows these
  figures next to its own: frames and bytes received, decode and draw time,
  frames the core skipped for it. They tell whether the machine, the
  connection or the browser limits the frame rate.
- Closing the browser window closes the program window: the page sends a
  `keepalive` POST to `/m/{machine}/gui/{window}/close` (audited), and the
  core closes the window
  two seconds later unless a viewer is showing it again (a reload) or another
  browser window still shows it. Losing the connection closes nothing.

**Settings**: `--gui-video` (`off`, `on`) is a flag only while video is
experimental. `gui` (`on`, `off`) and `gui-gpu` (`vglrun`, `all`), in the
settings dialog's "Program windows" section and as flags
([13](13-settings-and-appearance.md)). Both can be set per remote machine
("Per machine" in the same section, which also shows each machine's
display state); a machine without its own value follows the global one, and
a flag fixes the value for every machine. Turning the GUI off for a machine
detaches from its display and stops adding the variables to its new panes;
its programs keep their windows until the display idles out.

## Alternatives considered

| Option | Why not |
| --- | --- |
| VNC (TigerVNC `Xvnc`, x11vnc) with noVNC | A whole desktop in one canvas instead of program windows; `Xvnc` was on one of seven machines tried and needs a package installed by root. |
| Xpra with its HTML5 client | Seamless windows, but all inside one browser page; rootless only through a conda environment with Python, GTK and ffmpeg; its protocol changes between versions while core and agent ship together. |
| GTK Broadway | Only GTK programs; not Tk (matplotlib's default), Qt or GLFW (MuJoCo). |
| Terminal graphics (sixel, Kitty) | herdr's terminal-session stream drops them ([01](01-herdr-integration.md)); not interactive. |
| Starting the display on the first connection (socket activation) | Xvfb cannot take a listening socket; relaying through the agent would end every program's connection when the agent exits. |
| A display per pane or per workspace | Many X servers for windows that rarely exist; one display with per-window capture separates windows anyway. |
| Only pictures (no video) | Measured with a 1706×960 MuJoCo viewer: 29 frames per second at 30 Mbit/s directly and 8 on a 10 Mbit/s link with 50 ms more round trip, against 49 at 1.6 Mbit/s and 31 with H.264 from NVENC; per frame the machine spends a third of the CPU time. Pictures stay for windows that rarely change, where they are exact and need no encoder. |
| The ffmpeg program as the encoder | Its muxers write a frame when the next one arrives (Annex B ends a frame at the next delimiter, fragmented MP4 at the next fragment); with acknowledgement-paced frames the stream stalls. IVF writes at once but carries only VP8, VP9 and AV1. |
| The machine's own ffmpeg | Missing on some machines (one of seven tried) and of varying versions and builds. |
| NVENC from the agent through the driver's API (purego, without cgo) | Bindings for NVENC's and CUDA's C structures written by hand, no VP8 fallback, and loading libraries this way makes the agent a dynamically linked program, so it depends on the machine's libc. |
| WebRTC to the browser | Needs ICE and connections outside the guarded WebSocket; frames already reach the browser over it and WebCodecs decodes them there. |
| AV1 (av1_nvenc) | Smallest frames, but NVENC encodes AV1 only from Ada GPUs on (not the A40), and Safari decodes it only with hardware support. |
| HEVC | Browsers decode it only with hardware support. |
| WebP pictures | No encoder in Go's standard library; a library would be loaded like the video encoder for less gain. |
| `DISPLAY` only when asked | MuJoCo and matplotlib would need setup in every pane. With a display, `plt.show()` blocks until its window is closed, which is visible in the browser; machines where that is unwanted are turned off individually. |
| Restarting herdr's server with `DISPLAY` set, or `terminal.default_shell` pointing at a wrapper | Restarting ends every pane and agent; a wrapper means editing the user's herdr configuration. |
| Typing the export into every pane | Would land in agents' prompts and editors; only shells at their prompt are typed into. |

## Failure modes

- **No Xvfb and no apt** → phase `unavailable`; panes get no `DISPLAY`, so
  programs behave as over plain ssh.
- **Unpacked Xvfb cannot start** (missing libraries) → phase `error` with
  Xvfb's output (`~/.herdr-ide/xvfb.log` on the machine); retried with the
  backoff, so at most one start every 5 minutes.
- **Any preparation or attach error** → the status bar shows that the
  machine's display failed; clicking it shows the error the core reported
  (the agent's or Xvfb's message), how it is retried, a button to copy it
  and one to open the settings, where the machine's program windows can be
  turned off.
- **Network interruption** → browser windows show "Reconnecting"; programs
  and windows stay; after reconnecting the windows are adopted again.
- **Display number taken** by another user (lock file, socket or listener)
  after Xvfb idled out → a new number is reserved; panes created earlier
  point at the old one and reach whatever server holds it (see Security).
- **Old xorg-server** (before 21.1) → Xvfb exits as soon as its last client
  leaves instead of six hours later; the next connect starts it again.
- **Install interrupted** (agent killed) → its `.fetch-*` directory is removed
  by the next agent after an hour.
- **Another window manager on the display** (two cores of one instance) →
  attach fails after 3 s; the phase shows the error.
- **Slow connection** → frames are skipped, the picture lags but stays
  consistent; measured 24 frames per second for a 1706×960 MuJoCo viewer
  from a campus machine.
- **VirtualGL's EGL device not accessible** → `VGL_DISPLAY` is not set;
  OpenGL programs render with Mesa on the CPU.
- **Video encoder cannot start or stops** (no NVIDIA driver, all NVENC
  sessions in use, killed) → the window is sent as pictures and video is
  tried again after 5 s, doubling up to 5 minutes; VP8 is used where
  H.264 is not available and the viewers decode it.
- **Browser without WebCodecs or not in a secure context** (plain HTTP on a
  LAN) → it asks for no video and gets pictures; so does every viewer of a
  window one of whose viewers does not decode the stream.
- **Slow connection with video** → frames are paced by acknowledgements
  like pictures; three in flight per window limit the frame rate to about
  three per round trip (31 per second with 87 ms from capture to drawing
  on a 10 Mbit/s link), well below the bandwidth.

## Security

The display is reachable only with its cookie (0600 in the private run
directory, new at each start) and not over TCP; programs on it run as the
user, like everything in the panes, and X11 does not isolate them from each
other. Other users cannot pose as the display while the agent uses it (peer
credentials, ownership of everything in `/tmp` for the number), but a pane
created earlier keeps `DISPLAY` after its display ended. Window contents and
input travel the same guarded paths as terminals: same-origin pages,
Host/Origin checks, proxy secret. In read-only mode nothing is installed or
started, browser windows show windows but send no input, and closing is
refused. Xvfb packages are fetched through apt, which verifies them. The video
encoder is run only as pushed by the core and verified by its SHA-256; it
reads frames from a pipe and writes packets to one. See
[SECURITY.md](../../SECURITY.md).

## Testing

`internal/agent/gui_test.go` runs a real Xvfb (skipped where there is none;
`GUI_TEST_INSTALL=1` fetches the package): a helper program's window is
announced with its pane, streamed, receives clicks and keys (also after a
second window appeared) and is closed; plus cookie rotation, display
reservation against another user's files and listeners (played by another
uid in a private directory), the socket directory check, capture tiles,
staging cleanup, library ownership and package pruning.
`internal/gui/gui_test.go` covers pane environments (also per machine),
the export command's quoting, frame routing, forged acknowledgements and
refresh floods, the read-only plan, the close grace period, preparing once
per connection and the retry backoff;
`internal/server/server_test.go` covers malformed `env` parameters and the
Origin check of the close request;
`internal/agent/gui_test.go` also covers recognizing shells started with the
display (a process still in exec has an empty environment and is skipped)
and frame statistics; `internal/gui/gui_test.go` that they reach only the
window's viewers; `internal/server/server_test.go` the environment merge;
`web/src/__tests__/gui.test.ts` keycodes, paths, unseen windows and the
statistics shown. Video: `internal/agent/guivideo_test.go` runs the
encoder's protocol against a stand-in process (key frames on request,
codec strings, an encoder that exits), installs with a wrong and the right
digest and prunes old builds, and decides when a window becomes video,
changes stream and goes back to pictures; `internal/gui/gui_test.go` routes
streams (common kinds in order of preference, viewers behind waiting for a
key frame, joining mid-stream, the stream's end, video off);
`web/src/__tests__/guiVideo.test.ts` decodes from key frames and starts
over after errors, and asks for video only with WebCodecs in a secure
context. The encoder was measured with MuJoCo and matplotlib windows on
NVIDIA machines (RTX PRO 6000, RTX 5090), checked on an A40 machine without
ffmpeg and an Intel-only machine (VP8), and killed while streaming. `BenchmarkGUICapture` (`go test ./internal/agent -run '^$'
-bench GUICapture` on Linux with Xvfb) times capturing, converting and
encoding a 1706×960 window, a rendered scene and a plot, in tiles as the
window manager does; on a Core Ultra 9 285K a frame takes about 3 ms to
capture, 1.4 ms to convert and 12–14 ms as JPEG (160–170 kB).
matplotlib (TkAgg) and the MuJoCo viewer under `vglrun` were used end to end
in Chrome on Ubuntu 24.04 machines, one with Xvfb installed and one where it
was fetched without privileges. Enabling open panes was checked in an
isolated herdr session with panes created by herdr's CLI: idle shells got
the variables, a pane running a program was reported busy, a second call
typed nothing; turning a machine off and back to the default in the
dialog detached and re-attached its display.
