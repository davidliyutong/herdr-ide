# 14 · GUI windows

## Context

Programs started in panes on remote machines sometimes open windows (a matplotlib figure, the MuJoCo viewer, a Qt tool); over plain ssh they fail with `cannot open display`. Machines are typically shared servers without root, so nothing may need system packages or listen on TCP. What is needed is the program's window, not a remote desktop, often drawn with the GPU (OpenGL, or Vulkan for Isaac Sim), on the one the user picks where there are several.

## Goals / non-goals

Goals: windows of programs on remote Linux machines in the browser, one browser window per program window, with keyboard and mouse; no privileged installation; OpenGL and Vulkan on the machine's GPU, the chosen one where there are several; programs surviving network interruptions; nothing to configure for the common case.

Non-goals: a full remote desktop; the local machine (its windows open on the user's screen); macOS machines (capturing windows needs a permission granted only in a GUI session); audio, clipboard and input methods.

## Design

One X display per instance and machine; the agent is its window manager and captures each top-level window separately; the hub routes frames to browser windows and input back. A node adopts the display and windows an earlier node of the instance left running.

### The machine side and the GUI helper

The node (`backend/features/gui/machine.ts`, `machine/`) decides; a native helper does the X work. The helper is one static executable per Linux architecture without a C library (it runs on glibc as old as CentOS 7's and on musl), released from its own repository, pinned in `backend/scripts/deps.ts` and fetched by `backend/scripts/fetch-deps.ts`. The Linux machine build carries it and places it in `<data>/gui/<digest prefix>/` (0700), checking its SHA-256 before each start (`machine/helper.ts`, which also speaks its protocol, `src/proto.zig` there). Its commands: `gui-wm` (the window manager: damage, capture through MIT-SHM, JPEG, PNG and video encoding, input through XTEST), `gui-probe`, `gui-keep` (the keeper) and `gui-wl` (the GPU display's compositor).

The node keeps the display (`machine/display.ts`), the GPUs (`gpu.ts`), gpupick (`pick.ts`) and the encoder (`video.ts`), and decides what is sent, when and to whom (`wm.ts`, `flow.ts`); pixels never cross its one thread. The helper checks every message against fixed bounds and connects only to the X server whose process the node recorded and whose peer credentials are the user's.

### Display

- **Two kinds**, chosen by `gui.display` (`auto` or `xvfb`). The *GPU display* is Xwayland drawing through glamor, which gives clients DRI3: OpenGL and Vulkan render on the GPU without VirtualGL. `auto` takes it where the machine has an Xwayland whose `-terminate` takes a delay and a render node the user may open; one that fails or lacks DRI3 is replaced by Xvfb. The *plain display* is Xvfb, fetched where missing with `apt-get download xvfb` (no privileges, verified by apt) into `~/.veldr/hosts/<host>/xvfb/`.
- **A compositor of our own.** Xwayland needs a Wayland compositor and machines have none. Nobody looks at Xwayland's screen, so `gui-wl` serves that one client over a socket pair and draws nothing: it offers the globals glamor needs (including `wl_drm` for Xwayland before 24.1) and releases buffers at once.
- **Display number and cookie.** The number is reserved in `gui.json` of the runtime directory ([40](40-shared-homes.md)) and kept across restarts, so terminals keep a valid `DISPLAY`; each start writes a new cookie (`xauth.server`, and `xauth` for terminals, 0600). Anyone can create sockets in `/tmp/.X11-unix` and X clients cannot authenticate the server, so a number is used only while no other user's lock, socket or listener is on it, and the cookie goes only to a server whose peer credentials are the process the node started.
- **Lifetime.** The server runs with `-nolisten tcp` in its own session (it survives the agent and ssh) and exits a minute after its last client. The keeper holds a connection while the instance's terminal core runs, so the display lives as long as terminals with its `DISPLAY`; the hub asks for it (action `keep`), never in read-only mode. A change of kind waits until only the instance's own processes use the display.

### GPUs

`machine/gpu.ts`, `pick.ts`, `backend/features/gui/state.ts`.

- **The display's GPU** is NVIDIA's driver's first (`/dev/nvidia0`), else the first render node the user may open. NVIDIA's driver shares buffers with the X server only in a layout (modifier) both name, else it copies every frame through the CPU; the compositor loads no driver, so it offers every layout NVIDIA's modifier can name and the driver takes those it has.
- **Vulkan presents only from the driver's first GPU** on a display without NVIDIA's X driver, Xvfb included: a program told to render elsewhere (Isaac Sim with `CUDA_VISIBLE_DEVICES`) fails to create its swapchain. The display state names the GPU that works (`vulkan_gpu`).
- **gpupick** (`gui.gpuPick`, off by default; a library released from its own repository like the helper), on machines with two or more NVIDIA GPUs, is preloaded into new panes' programs: a program started with `CUDA_VISIBLE_DEVICES` sees only those GPUs, as in a container, so the chosen GPU is the driver's first. Indices are rewritten to count among the GPUs left. The machine build writes it to `~/.veldr/gpupick/<digest prefix>/` (0600) when the hub asks (action `pick`), after checking the dynamic loader takes it.

### Terminals

`backend/features/gui/state.ts`, `enable.ts`; `backend/features/terminals/client.ts`, `shells.ts`.

- **New terminals.** While a machine's display is ready, the hub adds `DISPLAY` and `XAUTHORITY` to `terminal.run`'s `env` ([22](22-terminal-protocol.md)), replacing a client's own values; with `gui.gpuPick`, gpupick's variables, and where `vglrun` works `VGL_DISPLAY=egl0` (with `gui.gpu` = `all` also VirtualGL's `LD_PRELOAD`, except on the GPU display, where it would only add a copy per frame).
- **Open terminals** keep their environment. "Enable in open panes" (per machine) and palette commands (`POST /api/m/{id}/gui/enable`) type ` export DISPLAY=… XAUTHORITY=…` (leading space: not in history) only into a known shell waiting at its prompt; a terminal running a program is reported with the command to copy.

### Capture and video

- The helper keeps windows at their requested size at the origin and treats menus and tooltips as layers. A window's terminal comes from `HC_TERMINAL_ID` in its program's environment when `HC_TERMINAL_SOCKET` is the instance's terminal core.
- **Pictures.** Composite gives each window its own pixmap; Damage reports changes. Each tick the changed areas of watched windows are sent as JPEG tiles (PNG for small areas), and a window that stays unchanged again as PNG, so still pictures end up exact. Frames in flight are bounded by the bandwidth-delay product of the window's pacing viewer, measured from acknowledgements (`flow.ts`).
- **Video** (`gui.video`). A window that keeps changing (a simulator) is sent as a video stream while all its viewers decode a kind the machine makes (`?video=`: `avc1`, `vp8`; WebCodecs, secure contexts only); once still it goes as PNG, and any failure sends pictures (`#stats` says why). The encoder is a small program on ffmpeg's libraries (H.264 from NVENC or VA-API, VP8 on the CPU) that writes each frame's packet at once; every hub executable embeds both Linux encoders and pushes the machine's to `~/.veldr/video/<digest prefix>/`, run only when its SHA-256 matches.
- **Input** is replayed with XTEST; keys are physical (`KeyboardEvent.code` → X keycode) on a US layout, so programs' key bindings work.

### Routing and browser windows

`backend/features/gui/manager.ts`, `router.ts`; `web/src/gui/`.

- The hub prepares a machine's display once per connection (status, install, start, attach) and retries failures with a backoff. Every `/ws` client gets `gui` messages with each machine's phase (`installing`, `ready`, `error`, `unavailable`, `not_running`, `disconnected`, …) and windows.
- **Several hubs** ([39](39-nodes.md)) attach to the one window manager. One controls (input, focus, closing); the others show **View only** with **Take Control**; when the controller goes, the hub attached longest takes over. Each hub, and each browser window, that falls behind skips frames and then gets the whole window, so a slow viewer never slows the fastest. Commands to the agent are built by the hub, never forwarded from the browser.
- **Read-only mode** attaches only to a running display (`not_running` otherwise): nothing is installed or started, no input is sent, closing is refused.
- `/m/{machine}/gui/{window}` shows one window at the program window's size. A window that appears while its terminal is on screen opens at once (else a toast offers it); others are marked on their pane header ([04](04-layout-and-keyboard.md)) and listed in the status bar. Closing the browser window closes the program window after a grace that a reload cancels; losing the connection closes nothing.

### Settings

`gui.enabled` (also the plugin's switch, [27](27-plugins.md)), `gui.display`, `gui.gpu` (`vglrun`, `all`), `gui.gpuPick` and `gui.video`, in the "Program windows" section, per remote machine or fixed by flags ([reference](../reference.md#program-windows)). Turning the GUI off for a machine stops giving new panes the variables; running programs keep their windows. Processes and files on machines and their bounds: [deployment](../deployment.md#remote-resources).

## Alternatives considered

| Option | Why not |
| --- | --- |
| VNC with noVNC, Xpra, GTK Broadway | A whole desktop or all windows in one page, root or conda to install; Broadway is GTK only. |
| Only Xvfb | No DRI3: OpenGL on the CPU, NVIDIA Vulkan copies every frame (Isaac Sim at a third of the GPU display's frame rate). |
| An existing compositor (weston, cage, sway) | Not on machines and needs libraries missing there. |
| Xwayland on the chosen GPU, or a display per GPU | The driver presents Vulkan only from its first GPU regardless; `DISPLAY` is set before a program chooses. |
| Hiding GPUs with namespaces or seccomp, or a wrapper command | Unprivileged namespaces are restricted; projects' launch commands set `CUDA_VISIBLE_DEVICES` themselves and work unchanged with a preload. |
| WebRTC | UDP does not pass the ssh connection, and it leaves the guarded WebSocket. |
| Only pictures | MuJoCo at 60 fps needs 44 Mbit/s as pictures, 1.7 Mbit/s as H.264. |
| The ffmpeg program, or the machine's own | Its muxers hold each frame until the next, stalling acknowledgement-paced streams; machines' builds are missing or vary. |
| A long idle timeout instead of a keeper | The display would outlive its terminal core as an orphan. |
| `DISPLAY` only when asked, or typed into every pane | Setup in every pane; typing would land in agents' prompts and editors. |
| The X client or the keeper in JavaScript | Capture at frame rate on the node's one thread would hold back every terminal; a Bun keeper idles at tens of MB. |
| Building the helper, gpupick and the encoder here | CI and contributors would need zig and ffmpeg's toolchain per architecture; pinned releases checked by SHA-256 give the same bytes. |

## Failure modes

- **No Xvfb and no apt** → phase `unavailable`; panes behave as over plain ssh.
- **Preparation or attach error** → the status bar shows it with a link to the settings; logs on the machine: `xvfb.log`, `xwayland.log`, `gui-keep.log` in the host's directory.
- **Network interruption** → browser windows show "Reconnecting"; programs and windows stay and are adopted again.
- **Display number taken by another user** after the display idled out → a new number; terminals created earlier point at the old one.
- **Vulkan on another GPU than the driver's first, gpupick off** → the swapchain fails; the settings name the GPU that works.
- **No GPU encoder** → VP8 on the CPU where viewers decode it, else pictures; a browser without WebCodecs or a secure context gets pictures.
- **No GUI helper in the build** (a run from the sources) → the attach fails with "this build carries no GUI helper for the machine"; panes still get the display.
- **The helper ends** → the hubs attach again with a new window manager; programs and windows stay.

## Security

- The display is reachable only with its cookie (0600, new at each start), never over TCP; programs on it run as the user and X11 does not isolate them from each other.
- Other users cannot pose as the display while the node uses it (peer credentials, ownership checks in `/tmp`), but a terminal created earlier keeps `DISPLAY` after its display ended.
- Window contents and input travel the guarded paths of terminals; a client cannot override the display variables.
- What runs on the machine is verified: Xvfb packages by apt, the helper (before each start), gpupick and the encoder by SHA-256. The compositor listens nowhere.

See [SECURITY.md](../../SECURITY.md).

## Testing

- `backend/features/gui/machine.test.ts`, `machine/*.test.ts`: the machine side with a fake helper (two hubs' control, malformed commands, flow on a simulated slow link, video decisions, display numbers against other users' files, placement by digest).
- `state.test.ts`, `manager.test.ts`, `router.test.ts`, `routes.test.ts`: terminal environments, enabling open panes, routing, forged acknowledgements, read-only, the close request; `backend/features/terminals/terminals.test.ts` and `integration.test.ts` (`shells`): the variables in `terminal.run`.
- `backend/features/gui/integration.test.ts` (`make it` with Xvfb, or `scripts/gui-it.sh` in Docker): the helper against a real X server with `e2e/fakes/xclient.ts`, video through a stand-in encoder.
- `web/src/__tests__/gui*.test.ts`: keycodes, decoding, the window session and the status bar.
- `e2e/machines` (`payloads/gui`): the machine side on old kernels and C libraries (CentOS 7, Ubuntu 18.04, Alpine). The helper, gpupick and the encoder are tested in their own repositories; GPU displays, NVENC, VA-API and gpupick are checked by hand on NVIDIA and AMD machines.
