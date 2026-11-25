# 14 · GUI windows

## Context

Programs started in panes on remote machines sometimes open windows: a
matplotlib figure, the MuJoCo viewer, a Qt tool. Over plain ssh they fail
(`cannot open display`). Machines are typically shared servers where the
user has no root, so nothing may require installing system packages, and
nothing may listen on TCP. What is needed is the program's window, not a
remote desktop. Such programs often draw with the GPU (OpenGL, or Vulkan,
which Isaac Sim requires), and on a server with several GPUs the user picks
the one that is free.

## Goals / non-goals

Goals:

- windows of programs on remote Linux machines appear in the browser, one
  browser window per program window, with keyboard and mouse;
- no privileged installation;
- OpenGL and Vulkan render on the machine's GPU, on the one the user chose
  where there are several;
- programs survive network interruptions;
- nothing to configure for the common case.

Non-goals: a full remote desktop; the local machine (its windows already
open on the user's screen); macOS machines (capturing windows needs a
permission granted only in a GUI session); audio, clipboard and input
methods.

## Design

One X display per instance and machine; the agent is its window manager
and captures each top-level window separately; the core routes the frames
to browser windows and their input back.

The machine side exists in both machine builds
([42](42-typescript-backend.md)) with the same wire, files and processes,
so either build's node takes over a display the other started: the Go
agent (`internal/agent/gui*.go`) and the TypeScript machine side
(`backend/features/gui/machine.ts`, `machine/`) with the GUI helper
(below). File names below are the Go agent's where they differ.

### The TypeScript machine side and the GUI helper

What is native work is a helper written in Zig (`scripts/gui-helper`):
one static executable per architecture (linux/amd64, linux/arm64; no C
library, so it runs on glibc machines as old as CentOS 7's and on musl
alike), which the TypeScript machine build carries
(`backend/scripts/build.ts`, `gui-helper.gz` beside the payload) and
places in `<data>/gui/<sha256 prefix>/<bin>-gui` (the directory 0700),
checked against the digest of the copy it carries before each start. Its
commands:

- `gui-wm`: the X client of the window manager. It connects to the
  display, makes itself its window manager (the Go agent's `guiwm.go`:
  windows at the origin, EWMH, layers, focus, adoption), reports windows,
  layers, the pointer image and damage (coalesced per drawable) to the
  node, replays the controller's input with XTEST, and captures and
  encodes what the node asks for: every rectangle of a batch requested
  through MIT-SHM before the first reply is read, JPEG (the Go agent's
  `internal/jpegstrip` ported: byte for byte image/jpeg's output for one
  row group, row groups on all cores), PNG (deflate of Zig's standard
  library) and video frames through the window's encoder process, which
  it starts and ends. It speaks to the node over its stdin and stdout
  (`proto.zig`, `machine/helper.ts`: [u32 length][u8 type][payload],
  little-endian).
- `gui-probe`: one connection, for the node: whether the display has DRI3
  (the GPU display's check) and its clients' processes (X-Resource, the
  change of kind); a connection that closes arms `-terminate`.
- `gui-keep`: the display keeper (below).
- `gui-wl`: the GPU display's compositor (below), on descriptor 3.

The node keeps the rest, in TypeScript on its one thread: the display's
files, number and cookie, starting and stopping Xvfb and Xwayland
(`machine/display.ts`; the socket pair of Xwayland and its compositor made
with `socketpair(2)` through `bun:ffi`), fetching Xvfb, the GPUs
(`machine/gpu.ts`), gpupick (`machine/pick.ts`), the encoder's install and
its probe (`machine/video.ts`), and everything that decides what is sent
(`machine/wm.ts`, `flow.ts`): the cores attached and their roles, the
flow, which areas go as JPEG, PNG or video and when, the stats, the
routing of frames to each core's queue. Pixels never cross the node's
thread: the helper reads them from shared memory, encodes them and writes
the encoder's input itself; the node moves encoded frames (and handles a
frame's bytes once, from the helper's pipe to the attach stream).

Every message the node sends the helper is checked before it is used
(type, length, rectangles inside X's coordinates and at most 8192 a side,
video frames whole windows of at most 4096, at most 1024 jobs and
256 Mpixels a batch, at most one batch waiting while one is encoded, the
encoder's path absolute; a job captures only a window the helper manages
or one of its layers); one that is not ends the helper, as does a node that stops reading
(256 MB waiting) or goes (end of its stdin). Every X connection goes only
to the server whose process the node recorded and whose user is this one,
on the socket and its abstract twin, as the Go agent's.

### Display

Agent: `internal/agent/gui.go`; `backend/features/gui/machine/display.ts`.

- **Two kinds of X server.** The setting `gui.display` chooses: `auto` (the
  default) or `xvfb`.
  - The *GPU display* is Xwayland drawing with a GPU through glamor, which
    gives clients DRI3: OpenGL and Vulkan render on the GPU without
    VirtualGL. `auto` takes it where the machine has an Xwayland whose
    `-terminate` takes a delay and a GPU render node the user may open.
  - The *plain display* is Xvfb, drawing in memory. Where the machine has
    none it is fetched with `apt-get download xvfb` (no privileges; apt
    verifies the package) and unpacked into
    `~/.veldr/hosts/<host>/xvfb/<version>/` (per host: a package is of
    the host's distribution and architecture).
    Xwayland is never fetched.
  - An Xwayland that does not come up, or comes up without DRI3, is ended
    and Xvfb started instead; the next connection tries again.
- **A compositor of our own** (`internal/agent/guiwl.go`; the helper's
  `wl.zig`). Xwayland needs a Wayland compositor and machines have none.
  Nobody looks at Xwayland's screen (windows are captured from the X
  side), so the machine's binary (the GUI helper in the TypeScript build)
  run as `gui-wl` is a Wayland server for one client that draws nothing: it
  offers the globals Xwayland needs with a GPU (including `wl_drm`, which
  Xwayland before 24.1 requires for glamor), releases each buffer as soon as
  it is committed and answers frame callbacks at 60 Hz only while there are
  any. The two talk over a socket pair (`WAYLAND_SOCKET`); no Wayland socket
  exists on disk.
- **Display number** reserved in `gui.json` of the runtime directory
  ([40](40-shared-homes.md); from `:20`) and kept across restarts, so
  terminals keep a valid `DISPLAY`. The socket must be
  `/tmp/.X11-unix/X<n>` (libxcb before 1.16 cannot use a path in
  `DISPLAY`), where anyone can create a socket and X clients cannot
  authenticate the server. So a number is used only while no lock file,
  socket or listener of another user is on it and `/tmp/.X11-unix` is safe
  (owned by root or the user, sticky or not group/other-writable). The agent
  sends its cookie only to a server whose peer credentials are the process
  it started, on both the path and the abstract socket. `gui.lock`
  serializes reservation and start between agents.
- **Cookie.** Each start writes a new MIT-MAGIC-COOKIE-1: the server reads
  `xauth.server`, terminals get `xauth` (both 0600, in the runtime
  directory), so a program editing its `XAUTHORITY` cannot leave the
  server open.
- **Lifetime.** The server runs with `-nolisten tcp`, a 2560×1440 screen, in
  its own session (it survives the agent and ssh), and with `-terminate 60`:
  it exits a minute after its last client left. Its clients are the
  programs, the agent's window manager while the core is connected, and the
  display keeper. The display thus lives as long as terminals that have its
  `DISPLAY` may start programs.
- **Keeper** (`internal/agent/guikeep.go`; the helper's `keep.zig`): the
  machine's binary (the GUI helper in the TypeScript build) run as
  `gui-keep`, one per instance whichever build started it (its lock file). It holds a connection to the display while
  the instance's terminal core (`hc.sock`) runs, follows a terminal core
  restarted within a short grace period, and exits once none runs. The core
  asks for one (action `keep`) when the display is ready and whenever the
  terminal core becomes reachable again; never in read-only mode.
- **Changing kind.** A display of another kind than wanted (after a setting
  change) is replaced only while nothing but the instance's own processes is
  connected to it (X-Resource names every client's process). Terminals keep
  their `DISPLAY`: number and cookie file stay the same.

### GPUs

Agent: `internal/agent/guigpu.go`; `backend/features/gui/machine/gpu.ts`,
`pick.ts`; library `scripts/gpupick`.

- **The display's GPU.** With NVIDIA GPUs it is the driver's first one
  (`/dev/nvidia0`, read from `/proc/driver/nvidia/gpus/*/information`; not
  necessarily first in `nvidia-smi`); elsewhere the first render node the
  user may open.
- **Buffer layouts for NVIDIA.** NVIDIA's driver shares a buffer with the X
  server only in a layout (modifier) both name, and copies every frame
  through the CPU otherwise. The compositor loads no driver, so it cannot
  ask which layouts exist; instead it offers, through linux-dmabuf, every
  layout the NVIDIA modifier's fields can name plus linear, and the driver
  takes those it has. Mesa's drivers need no named layouts, so other GPUs
  get no linux-dmabuf.
- **Vulkan presents only from the driver's first GPU.** On a display without
  NVIDIA's own X driver, a Vulkan program shows windows only from the first
  GPU it sees, whatever GPU the display uses and on Xvfb too. A program told
  to render elsewhere (e.g. Isaac Sim with `CUDA_VISIBLE_DEVICES`) fails to
  create its swapchain. The display state in the settings names that GPU
  (`vulkan_gpu`, counted as `nvidia-smi` does) on machines with several.
- **gpupick** (setting `gui.gpuPick`, off by default) lets a program choose.
  The library is preloaded into new panes' programs (`LD_PRELOAD`); a
  program started with `CUDA_VISIBLE_DEVICES` then sees only those GPUs, as
  in a container: opening any other `/dev/nvidiaN` fails with `EPERM`, so
  the chosen GPU is the driver's first.
  - The pane's environment carries the GPU table (`GPUPICK_TABLE`,
    `GPUPICK_MIXED`, `GPUPICK_DISPLAY`); the first program of a process tree
    works out the set and passes it on in `GPUPICK_KEEP`.
  - Indices in `CUDA_VISIBLE_DEVICES` are rewritten to count among the GPUs
    left (`2` becomes `0`), as CUDA and `nvidia-smi` then number them;
    UUIDs stay. Indices mean bus order, so with GPUs of mixed models only
    when `CUDA_DEVICE_ORDER=PCI_BUS_ID`. An invalid or ambiguous value
    changes nothing.
  - With the display's GPU hidden, NVIDIA's GLX cannot reach the display, so
    the library sets `__GLX_VENDOR_LIBRARY_NAME=mesa` (unless set): Mesa
    draws through Vulkan on the visible GPU.
  - Windows from a GPU other than the display's are copied through the CPU
    by the driver: slower, but they work.
- The library is ~10 kB of C, built for linux/amd64 and linux/arm64 against
  glibc 2.17 (`scripts/build-gpupick.sh`; builds and digests committed and
  checked by `make check`). The agent carries it (the TypeScript build
  carries its architecture's as `gpupick.so`) and writes it to
  `~/.veldr/gpupick/<sha256 prefix>/` (0600) when the core asks (action
  `pick`, never in read-only mode), after checking the dynamic loader takes
  it (a `noexec` home would make every program complain). Machines with
  fewer than two NVIDIA GPUs get nothing.

### Terminals

`backend/features/gui/manager.ts`, `state.ts`, `enable.ts`,
`backend/features/terminals/backend.ts`, `shells.ts`.

- **New terminals.** When the GUI is on for a machine and its display is
  ready, the core adds `DISPLAY` and `XAUTHORITY` to the `env` of the
  terminal core's `terminal.run` ([22](22-terminal-protocol.md)). They
  replace a client's own values, so a client cannot point terminals at
  another display; a malformed `env` is refused. The audit log records them.
- **Existing terminals** keep their environment. "Enable in open panes"
  (settings, per machine) and palette commands for the focused pane or a
  whole machine (`POST /api/m/{id}/gui/enable`) catch them up without
  restarting anything:
  - only a known shell (bash, zsh, fish, …) waiting at its prompt is typed
    into (from the terminal core's `terminal.get` and the agent reading
    `/proc/<pid>/environ`, action `shells`, checked again right before);
  - it gets Ctrl-C, then ` export DISPLAY='…' XAUTHORITY='…'` (leading space
    keeps it out of history), through a short attach at the terminal's own
    size;
  - a terminal running a program (an agent, an editor) is not typed into and
    is reported with the command to copy; a program already running keeps
    its environment.
- **VirtualGL.** Where `vglrun` and its EGL back end work, terminals get
  `VGL_DISPLAY=egl0`, so `vglrun program` renders on the GPU on either kind
  of display. With `gui.gpu` = `all` terminals also get VirtualGL's
  `LD_PRELOAD`, except on the GPU display, where OpenGL is on the GPU anyway
  and VirtualGL would add a copy per frame.
- **gpupick.** With `gui.gpuPick` on and the library installed, terminals
  get its variables, its library first in `LD_PRELOAD`.

### Window manager and capture

Agent: `internal/agent/guiwm.go`, `guiframes.go`, `guishm.go`; the
helper's `wm.zig`, `capture.zig`, `jpeg.zig`, `png.zig` and the node's
`backend/features/gui/machine/wm.ts`, `flow.ts`.

- The agent connects to the display (jezek/xgb, pure Go; the helper's own
  X11 client, `x11.zig`) and becomes its window manager: windows keep their requested size at the origin, get the
  EWMH basics toolkits wait for, and are adopted from a previous agent.
  Override-redirect windows (menus, tooltips) are layers of their
  transient-for or the focused window.
- **Capture.** Composite gives every window its own pixmap, so overlapping
  windows do not hide each other. Damage reports changed areas; at most
  every 16 ms the changed area of each watched window is captured as tiles
  of at most 1024×1024 (bounded memory per frame) and sent as JPEG, or PNG
  for small areas. After 400 ms without changes JPEG areas are sent again as
  PNG, so still pictures end up exact.
- **Speed.** Tiles are read through MIT-SHM into one shared segment (0600,
  at most 64 MB, removed when the agent goes), else with `GetImage`. JPEG is
  encoded by `internal/jpegstrip`: Go's encoder split into row groups coded
  on separate cores and joined with restart markers, giving one ordinary
  JPEG with the same pixels.
- **Flow control.** A window may have frames in flight up to a byte budget
  (and at most 32 frames). The budget is the bandwidth-delay product of the
  fastest viewer, measured from acknowledgements, plus a small queue,
  bounded between 64 kB and 8 MB. Because queued frames inflate measured
  round trips, frames go one at a time now and then to measure again. This
  replaced a fixed number of frames in flight (see Alternatives).
- **Statistics.** While watched, the agent reports once a second what a
  window's frames cost (`stats` event: frames, bytes, capture and encode
  time, budget, round trip); browser windows show them with `#stats`.
- **Focus.** A new window takes the focus only when nothing has it or it is
  a dialog of the focused window; before each key press the focus is moved
  back to the window the key was typed for.
- **Origin.** A window's program comes from `_NET_WM_PID` or X-Resource; its
  terminal from `HC_TERMINAL_ID` in the process's (or nearest ancestor's)
  environment, when `HC_TERMINAL_SOCKET` is the instance's terminal core
  (terminals of the user's own herdr-core are not named). The window record
  carries `terminal`, which the web UI uses below.
- **Input** arrives in window coordinates and is replayed with XTEST. Keys
  are physical (`KeyboardEvent.code` → X keycode) and the display's layout
  is US, so programs' key bindings work. Closing sends `WM_DELETE_WINDOW`,
  or disconnects the client without it. The pointer image follows XFIXES.

### Video

Setting `gui.video`, on by default. Agent `internal/agent/guiwm_video.go`,
`guivideo.go`; the node's `machine/wm.ts`, `video.ts` and the helper's
`video.zig`; encoder `scripts/encoder/`.

- **When.** A window that keeps changing (a simulator) would cost a whole
  JPEG per frame. It is sent as a video stream instead while it keeps
  changing (most recent ticks changed a quarter of it or more) and all its
  viewers decode a kind of stream the machine can make. Unchanged for
  400 ms it is sent as PNG (4:2:0 video blurs colored text); after 5 s the
  stream ends. Layers stay pictures; windows under 64 or over 4096 pixels a
  side are never video.
- **Kinds.** Browsers name what they decode in the WebSocket's `?video=`:
  `avc1` (H.264) and `vp8`, probed with WebCodecs, only in a secure context.
  The core passes the kinds every viewer decodes, H.264 first.
- **Encoder.** A small program on ffmpeg's libraries (LGPL build with
  libvpx, libva and libdrm; static except glibc 2.28; linux/amd64 and
  arm64) that the core embeds and pushes to each Linux machine:
  `~/.veldr/video/<sha256 prefix>/encoder`, verified by digest. Release
  builds embed it (`scripts/build-ffmpeg.sh`, [deployment](../deployment.md));
  a build without it sends pictures. A core that deploys the TypeScript
  build carries only its own platform's encoder; for another machine it
  asks for the machine build's own (action `video` without a digest),
  which the TypeScript build installs from its copy and the Go build
  answers without video.
  - H.264 comes from NVENC, else VA-API (the first usable render node whose
    driver encodes H.264, loaded by the built-in libva, VA-API ≤ 1.24); VP8
    from libvpx on the CPU. The agent probes once which kinds work.
  - It reads raw frames from a pipe and writes one packet per frame at once
    (no muxer holding a frame back). One encoder per window sent as video,
    in a process group of its own that dies with the agent (the GUI
    helper starts it from its main thread with `PR_SET_PDEATHSIG`).
- **Stream.** A `video` event (codec, size) and a key frame start a stream;
  frames are paced by acknowledgements like pictures. A resize or a change
  of the kinds viewers share starts a new stream; a viewer can ask for a key
  frame.
- **Routing.** A viewer that missed a frame (behind, or joined mid-stream)
  gets nothing until the next key frame, which the core requests for it.
- **Browser.** One `VideoDecoder` per window (`optimizeForLatency`), frames
  and pictures decoded in arrival order; a decoding error resets the decoder
  and asks for a key frame.
- **Fallback.** Any failure (no encoder, no common kind, the encoder not
  starting or exiting) sends pictures; a failing encoder is retried with a
  backoff. `#stats` shows the encoder in use or why pictures are sent.

### Routing

`backend/features/gui/manager.ts`, `display.ts`, `router.ts`.

- The core prepares a machine's display once per connection (status,
  install, start, attach), keeps one attach stream per machine, and retries
  failures with a backoff (5 s doubling to 5 minutes). A change of the GUI
  setting or a reconnect starts over. Every `/ws` client gets `gui` messages
  with each machine's phase (`installing`, `starting`, `ready`, `error`,
  `unavailable`, `disconnected`, …) and windows.
- **Several cores** ([39](39-nodes.md)). Every core a machine's node
  serves attaches to the one window manager (`internal/agent/guiclients.go`)
  and gets every window. One controls them, the others view:
  - input, focus and closing come from the controller only; a viewer's
    browser windows show **View only** with **Take Control**, which takes
    it at once (command `control`), the other core then viewing; the
    agent tells each core its role (event `role`), the core its browsers
    and the machine's state (`view_only`);
  - the controller gone, the core attached longest takes control; the
    same core's new attach after a reconnect replaces its old one with its
    role;
  - a window's flow is paced by the controller while it watches the
    window, else by the core attached longest that does; another core's
    frames go through a queue of its own (256 messages), and one that is
    full misses them and gets the whole window (a key frame for video)
    once it has room, so a slow viewer never slows the controller;
  - a core that starts watching a window sent as video ends its stream, so
    the next one starts for every watcher; the video codecs are those all
    watchers decode.
- A machine disabled, removed or disconnected is shown as `disconnected`
  without windows, not as an error.
- **Viewers.** Frames go to every browser window showing the window. The
  fastest viewer's acknowledgements pace the agent; a viewer that falls
  behind skips frames and then gets the whole window again; a frame no
  viewer got is acknowledged by the core. Commands to the agent are built by
  the core from a viewer's message, never forwarded as is, and refreshes are
  rate-limited.
- **Read-only mode.** The core attaches only to a display already running
  (`not_running` otherwise); nothing is installed or started. Installs and
  starts are audited.

### Browser windows

`web/src/gui/`.

- `/m/{machine}/gui/{window}` shows one window: canvases for the window and
  its layers, scaled with the aspect kept, input over
  `/m/{machine}/gui/{window}/ws`. The browser window opens at the program
  window's size and follows it.
- **Opening.** A window that appears while its terminal is on screen opens
  at once (`window.open`); if the browser blocks the pop-up, a toast offers
  it. Other windows are marked on the program windows button of their
  terminal's pane header ([04](04-layout-and-keyboard.md)); the status bar
  lists every window. With several, the list is searchable
  (`components/Picker.tsx`). A dialog (`WM_TRANSIENT_FOR`) is opened by its
  parent's browser window.
- Pictures are decoded concurrently (`createImageBitmap`) and drawn in
  order.
- **Closing** the browser window closes the program window: a `keepalive`
  POST to `/m/{machine}/gui/{window}/close` (audited), applied after a
  2 s grace unless a viewer shows the window again (a reload). Losing the
  connection closes nothing.

### Settings

`gui.enabled`, `gui.display` (`auto`, `xvfb`), `gui.gpu` (`vglrun`, `all`),
`gui.gpuPick` and `gui.video`, in the settings dialog's "Program windows"
section and as flags ([reference](../reference.md#program-windows),
[13](13-settings-and-appearance.md)).

- Each can be set per remote machine; a machine without its own value
  follows the global one, and a flag fixes it for every machine.
- Program windows are also a plugin ([27](27-plugins.md)): its switch is the
  global `gui.enabled`.
- Turning the GUI off for a machine detaches and stops adding the variables
  to new panes; running programs keep their windows. A change of
  `gui.display` prepares the display anew; `gui.gpuPick` applies to panes
  created afterwards; `gui.video` takes effect from the next frame.

## Alternatives considered

| Option | Why not |
| --- | --- |
| VNC (`Xvnc`, x11vnc) with noVNC | A whole desktop in one canvas; `Xvnc` was on one of seven machines tried and needs root to install. |
| Xpra with its HTML5 client | All windows in one page; rootless only via a conda environment; protocol varies between versions. |
| GTK Broadway | GTK only; not Tk (matplotlib), Qt or GLFW (MuJoCo). |
| Only Xvfb | No DRI3: OpenGL on the CPU without VirtualGL, NVIDIA Vulkan copies every frame (Isaac Sim 24–33 fps vs 80–100 on the GPU display). |
| An existing compositor (weston, cage, sway) | Not on machines, and each needs libraries missing there; ours is ~400 lines without dependencies and reached headless weston's frame rates. |
| Asking the driver for its buffer layouts (EGL) | The machine binary is static and loads no library; offering every layout lets the driver pick anyway. |
| No buffer layouts for NVIDIA | Programs fall back to copying frames (`glxgears` 300–550 fps instead of 6000). |
| Xorg with NVIDIA's driver | Needs root and mode setting rights. |
| Xwayland on the chosen GPU, or a display per GPU | The driver presents Vulkan only from its first GPU regardless; `DISPLAY` is set before a program chooses. |
| A Vulkan layer with its own swapchain on any GPU | Rewrites the driver's own copy per GPU; hiding GPUs reuses the driver's path. |
| Hiding GPUs with namespaces or seccomp | Unprivileged user namespaces are restricted; seccomp cannot read paths cheaply. A preload costs a comparison. |
| A wrapper command (as `vglrun`) instead of preloading | Projects' launch commands set `CUDA_VISIBLE_DEVICES` themselves and work unchanged with the preload. |
| Viewport on the first GPU, compute on the chosen one | An application-specific setting, and the first GPU is often the busy one. |
| Isaac Sim's own streaming | WebRTC over UDP does not pass the ssh connection. |
| Terminal graphics (sixel, Kitty) | The browser's emulator has none ([26](26-web-terminals.md)); not interactive. |
| Socket-activated display | Xvfb cannot take a listening socket; relaying through the agent would cut programs when it exits. |
| A display per pane or workspace | Many X servers for rare windows; per-window capture already separates them. |
| Only pictures | MuJoCo at 60 fps: pictures 48 fps at 44 Mbit/s (7.5 fps on 10 Mbit/s), H.264 58 fps at 1.7 Mbit/s on both, at a third of JPEG's CPU. |
| The ffmpeg program as encoder | Its muxers hold each frame until the next arrives, stalling acknowledgement-paced streams. |
| The machine's own ffmpeg | Often missing, of varying versions and builds. |
| NVENC from the agent (purego) | Hand-written bindings, no VP8 fallback, and the agent would depend on the machine's libc. |
| WebRTC to the browser | Needs connections outside the guarded WebSocket. |
| AV1 | NVENC encodes it only from Ada GPUs; Safari decodes it only in hardware. |
| HEVC | Browsers decode it only in hardware. |
| WebP pictures | No encoder in Go's standard library. |
| JPEG row groups as separate frames | Extra headers, tearing between parts, separate acknowledgements. |
| A fixed number of frames in flight | Large pictures queue on slow links; small video frames are held back. |
| The machine's libva | The encoder would not start where libva is missing; drivers do not need it linked. |
| Xvfb exiting hours after its last client | Outlived its terminal core as an orphan; the keeper ties the display to it. |
| `DISPLAY` only when asked | MuJoCo and matplotlib would need setup in every pane; machines can be turned off individually. |
| Restarting the terminal core with `DISPLAY`, or a wrapper shell | Every terminal would inherit a display; a wrapper changes the user's shell. |
| Typing the export into every pane | Would land in agents' prompts and editors. |
| The TypeScript machine side's X client in JavaScript (the `x11` npm package, or one of our own) | `x11` is unmaintained since 2019 and has neither MIT-SHM nor X-Resource; capturing and encoding at frame rate on the node's one thread would hold back every terminal of the machine. The helper is the X client; the node decides. |
| libjpeg-turbo in the helper | Its SIMD on x86-64 is NASM assembly, which zig cannot assemble; without it the gain over the port of the Go agent's encoder (the same bytes, row groups on every core) is small, for a CMake project to build per architecture and a library to track. |
| The flow and the routing in the helper too | The decisions the tests reason about would move to a third language, and a core's queue is the node's: the helper cannot see it. The helper reports damage and does what a batch says; the node assigns the frames' numbers, so a core that missed frames gets the whole window from the next number on without a marker from the helper. |
| The node writing frames to the encoder | About 400 MB/s of raw pixels for a 1706×960 window at 60 fps through the node's thread. |
| The keeper in TypeScript (the executable run as `gui-keep`) | A Bun runtime idles at 30–40 MB for as long as the terminal core runs; the helper's keeper at a few hundred kB. |
| The helper built by every build | CI and contributors have no zig: its executables are committed with the digests of their sources and of themselves, which `make check` verifies, as with gpupick and the terminal emulator's module. |
| A helper per machine linked to its C library | Machines are as old as glibc 2.17 and as different as musl: static and without a C library (raw system calls, its encoding threads started per batch), one executable per architecture runs on all. |

## Failure modes

- **No Xvfb and no apt** → phase `unavailable`; panes get no `DISPLAY` and
  behave as over plain ssh.
- **Preparation or attach error** (e.g. unpacked Xvfb missing libraries) →
  the status bar shows the machine's display failed; clicking shows the
  error, how it is retried, and a link to the settings. Retries back off to
  one every 5 minutes. Logs on the machine:
  `~/.veldr[-<instance>]/hosts/<host>/xvfb.log`, `xwayland.log`,
  `gui-keep.log`.
- **Network interruption** → browser windows show "Reconnecting"; programs
  and windows stay and are adopted again.
- **Display number taken** by another user after the display idled out →
  a new number is reserved; terminals created earlier point at the old one
  (see Security).
- **xorg-server before 21.1** → no `-terminate` delay: Xvfb exits as soon as
  its last client leaves; such an Xwayland is not used.
- **No Xwayland, GPU or render node access** (not in the `render` group) →
  the plain display.
- **Xwayland fails or draws on the CPU** → Xvfb in its place; the agent logs
  why.
- **Compositor killed** → Xwayland exits; the next preparation starts anew.
- **Display in use when its kind should change** → it stays until nothing
  uses it.
- **Vulkan on another GPU than the driver's first, gpupick off** → the
  swapchain fails; the settings name the GPU that works.
- **Two NVIDIA Vulkan ICDs registered** (a stale `nvidia_icd.json`) → every
  GPU listed twice; `VK_DRIVER_FILES` or removing the stale file fixes it.
- **gpupick cannot be preloaded** (`noexec` home, non-glibc) → logged;
  panes get the display without it. Programs of another word size or setuid
  ones see every GPU.
- **Another window manager on the display** (two cores of one instance) →
  attach fails; the phase shows the error.
- **Slow connection** → the flow budget skips frames; pictures lag but stay
  consistent, video keeps its frame rate at lower bandwidth.
- **No GPU encoder for H.264** (no NVENC, no usable VA-API driver) or all
  NVENC sessions in use → VP8 on the CPU if viewers decode it, else
  pictures.
- **No MIT-SHM** → captures through the X connection (slower); logged once.
- **No GUI helper in the TypeScript build** (a run from the sources, or a
  build without `scripts/gui-helper/bin`) → the attach fails with "this
  build carries no GUI helper for the machine"; panes still get the
  display.
- **The GUI helper ends** (the display went away, a protocol violation,
  the node not reading) → the cores' attach streams end and they attach
  again, starting a new window manager; programs and windows stay.
- **Keeper not running** → the display ends a minute after its last client;
  the next connection starts it again, on the same number if still free.
- **Browser without WebCodecs or secure context** → pictures, for every
  viewer of that window.

## Security

- The display is reachable only with its cookie (0600, new at each start),
  never over TCP. Programs on it run as the user and X11 does not isolate
  them from each other.
- Other users cannot pose as the display while the agent uses it (peer
  credentials, ownership checks in `/tmp`), but a terminal created earlier
  keeps `DISPLAY` after its display ended.
- Window contents and input travel the same guarded paths as terminals
  (same origin, Host/Origin checks, proxy secret). In read-only mode nothing
  is installed or started, input is not sent and closing is refused.
- Commands to the agent are built by the core, never forwarded from the
  browser; a client cannot override the display variables.
- The GPU display's compositor listens nowhere and opens no file, talks to
  Xwayland over a close-on-exec socket pair, and bounds what its one client
  can make it hold; Xwayland is checked like Xvfb.
- gpupick is off by default, written from the agent's own binary into a
  directory only the user can write, and only restricts what a program sees.
- Xvfb packages are verified by apt; the video encoder runs only as pushed
  by the core and verified by its SHA-256 (or, in the TypeScript build, as
  the build carries it, verified the same way).
- The TypeScript build's GUI helper runs only as the build carries it
  (its SHA-256 checked before each start, in a 0700 directory), with the
  agent's environment; it checks every message of the node, the X
  server's peer credentials on every connection, and the bounds of what
  the compositor's client may make it hold, as the Go agent does.

See [SECURITY.md](../../SECURITY.md).

## Testing

- `internal/agent/gui_test.go` (real Xvfb, skipped without one;
  `GUI_TEST_INSTALL=1` fetches it): a window announced with its terminal,
  streamed, clicked, typed into and closed; cookie rotation, display
  reservation against another user's files, the socket directory check,
  capture tiles, shell recognition, the flow on a simulated slow link.
  `TestGUIWindowsGPU` runs it on Xwayland with the compositor.
  `BenchmarkGUICapture` times capture and encoding.
- `internal/agent/guiwl_test.go`: the compositor's wire protocol and the
  NVIDIA layouts it offers.
- `internal/agent/guigpu_test.go`: GPUs from the driver's description, the
  display kind and its fallback, the change of kind, gpupick itself (Linux).
- `internal/agent/guikeep_test.go`, `guiorigin_test.go`, `guivideo_test.go`
  (encoder protocol against a stand-in, install digests, switching between
  video and pictures).
- `internal/jpegstrip`: one row group equals `image/jpeg`'s bytes, any
  number its pixels.
- The TypeScript machine side (`backend/features/gui/machine.test.ts`,
  `machine/wm.test.ts`, `machine/display.test.ts`): two cores through the
  wire with a fake helper (control, viewing, input from the controller
  only, a command of the wrong shape dropped, a display that ends, a
  helper that does not start), the encoder's install held to its digest;
  the Go tests' tiles, flow on a simulated slow link, stats and video
  decisions ported; the cookie, the display number against another user's
  files and listeners (Linux), the socket directory, Xvfb packages,
  shells, GPUs from the driver's description, the kind wanted, the
  helper's placement by digest and retention, the helper's message
  layout.
- The GUI helper (`zig build test` in `scripts/gui-helper`, run by
  `make gui-helper`): its JPEG byte for byte the Go agent's
  (`src/testdata`, written by `gen.go` from `internal/jpegstrip`), PNG
  decoding to its pixels, every malformed message of the node refused,
  the compositor's protocol, errors and bounds, NVIDIA's layouts.
- `backend/features/gui/integration.test.ts` (`make it`, Linux with Xvfb;
  `scripts/gui-it.sh` runs it in Docker): the helper against a real Xvfb
  through the node, as `TestGUIWindows` (and on the GPU display where the
  machine has one); an Xwayland that does not come up leaving Xvfb, as
  `TestGPUDisplayFallsBack`; video through a stand-in encoder (the
  encoder's protocol, VP8 only): probed, installed by digest, a window that
  keeps changing sent as a stream that ends when nobody watches.
- `backend/features/gui/state.test.ts`, `manager.test.ts`,
  `router.test.ts`: terminal environments, enabling open panes (`enable`),
  frame and video routing, forged acknowledgements and refresh floods
  (`abuse`), read-only, the close grace, retry backoff, the keeper request.
- `backend/features/terminals/terminals.test.ts` (`terminal.run gets the
  display`, `shells`) and `integration.test.ts` (`shells`, real
  herdr-core): display variables in `terminal.run` and typing into a shell;
  `backend/features/gui/routes.test.ts` (`close`): the close request's
  Origin check.
- `web/src/__tests__/gui.test.ts`, `guiVideo.test.ts`, `guiError.test.ts`,
  `guiStatus.test.ts`: keycodes, decoding, the status bar's error, the
  window list, the display state.

Measured by hand on NVIDIA machines (RTX PRO 6000 Blackwell, RTX 5090, A40)
and an AMD iGPU (VA-API): a 1706×960 MuJoCo viewer at 48 fps as pictures
and 58 as H.264 (58 also on a 10 Mbit/s link with 50 ms added); Isaac Sim
24–33 fps on Xvfb, 79–84 on the GPU display, 17–26 with gpupick on another
GPU; `glxgears` 5500–7000 fps on the GPU display. Not run: Mesa GPUs under
Xwayland, linux/arm64, Xwayland 24.1 or newer.

The TypeScript machine side with the GUI helper, on the machines of
`e2e/machines` (`payloads/gui`: a program's window announced with its
terminal and process, its pixels, clicks, keys and closing, the keeper
holding the display and leaving with it, gpupick's install): CentOS 7's
VM (kernel 3.10, glibc 2.17; its Xvfb 1.20 has no `-terminate` delay),
Ubuntu 18.04's (4.15), containers of CentOS 7 and Alpine 3.20 (musl), an
Ubuntu 24.04 host (kernel 7.0) without Xvfb, which the machine side
fetched with `apt-get download`, and a workstation with an RTX 5090 on
Xvfb (its GPU, busy with other work, was not used). On the Ubuntu host
(AMD Radeon 780M) the GPU display came up (Xwayland 23.2, the helper's
compositor with `wl_drm`, DRI3) and a 640×360 window that changes every
frame went as H.264 through VA-API at 54–62 fps, then as VP8 at 61 fps
when the viewers decoded only that. The encoder (glibc 2.28) makes no
kind on CentOS 7 or musl, as with the Go agent. The helper's JPEG of a
1706×960 picture takes 16 ms on one core of an Apple M4 (the Go agent's
encoder 47 ms; both code row groups on every core). Not run with the
TypeScript build: NVIDIA's GPU display, NVENC and gpupick on a machine
with several NVIDIA GPUs.
