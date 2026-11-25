# 42 — The backend in TypeScript

## Context

The core and the machine agent are one Go program (`cmd/veldr`,
`internal/`). The web UI, the desktop shell and the end-to-end tests are
TypeScript. Three things argue for one language:

- the desktop app runs the Go core as a child process that listens on
  loopback TCP, so any local process can reach the desktop's core, and the
  shell talks to its own core over HTTP;
- the chat host drives Claude Code with a hand-written copy of the
  protocol of `@anthropic-ai/claude-agent-sdk`, which Anthropic publishes
  for TypeScript;
- protocol types (agentproto, chatproto, settings) exist in both
  languages.

This document describes the goal of a rewrite in stages on the `dev`
branch: the backend in TypeScript under `backend/`, run by Bun as one
executable, with unchanged behavior, and the desktop app running the core
inside Electron without a TCP listener.

## Goals / non-goals

Goals:

- One executable per platform, built with `bun build --compile`.
- Behavior as before: the end-to-end tests (`make e2e`), the shared vectors
  (`spec/vectors`) and the ported unit tests are the measure.
- The desktop app's core runs in an Electron utility process and serves
  its window without listening on TCP.
- Official SDKs where the Go program reimplements one: Claude Code through
  `@anthropic-ai/claude-agent-sdk`, ACP through `@agentclientprotocol/sdk`;
  Codex's app-server types generated from the schema Codex prints.

Non-goals:

- New features while the rewrite runs.
- The Linux GUI windows' X client, capture and encoding in TypeScript: they
  are a native helper (below).

## Design

### Layers and features

`backend/` has layers that import only downwards (its README):
`shared/` (wire protocols, libraries, state), `kernel/` (the core's
machinery: routing and guards, channels, machines and their connections,
settings, events, audit), `machine/` (the node, the dispatch of the agent
protocol, system calls), `features/` (everything the product does, each a
directory with its typed protocol, its core side and its machine side) and
`hosts/` (composition roots). It is not a translation of the Go packages:
the server and the agent are not single packages any more, a feature is
not spread over four directories, and an agent action is a typed
definition rather than a name and untyped JSON.

Mature libraries do what they do: Hono routes and serves (the same
`Request → Response` in `Bun.serve` and behind Electron's protocol
handler), zod validates input, jsonc-parser reads and edits the
hand-edited JSON files (keeping the user's formatting and comments),
ssh-config reads the OpenSSH configuration, execa runs processes,
@simplewebauthn/server verifies WebAuthn, yazl writes zip archives,
node-pty gives the desktop's core a terminal for an ssh login, re2js runs
the agent detection rules' regular expressions on machines (below), the
official MCP SDK (`@modelcontextprotocol/server`) serves the vault's MCP
server (below). yamux
is the exception: the maintained implementation (`@chainsafe/libp2p-yamux`)
is bound to libp2p's stream framework; ours is a few hundred lines over
Node streams, tested against hashicorp/yamux.

### One core, two hosts

`backend/shared` and `backend/kernel`, and the core side of every feature,
use Node's modules only, so the same core runs under Bun (the command
line) and in Electron's Node (the desktop app); `tsconfig.node.json`
typechecks them with Node's types only. Requests are handled as
`Request → Response`; WebSockets are `Channel`s of text and binary
messages.

Both hosts compose the core alike (`backend/hosts/common/compose.ts`:
the features, the settings and keybindings files, the machines file and
the machines a run connects, the host's own routes); they differ in how
requests reach it.

- **Bun** (`backend/hosts/bun`): `Bun.serve`, its WebSocket upgrades
  turned into channels; the guards stay as they are (Host/Origin, proxy
  secret, read-only). Its clients are browsers.
- **Electron** (`backend/hosts/electron`): the core runs in a
  `utilityProcess` (a crash leaves the window, heavy work does not block
  it), which the main process (`desktop/src/core.ts`) forks with the
  app's bundle of it (`dist/core.mjs`), starts with a message on its parent
  port (instance, node instance, the verify key of the launch, where the
  payloads are) and restarts after a crash, at most 3 times a minute. The
  app's windows live in a session of their own (`persist:app`), which
  intercepts the origin `https://<slug>.localhost` with
  `protocol.handle('https')` and hands each request to the core; requests
  to other hosts pass through. The core's guard allows that origin, and
  in-process requests are the desktop client on the core's host (`Peer`
  without a remote address): the client is the desktop because the main
  process says so, not by a cookie. The main process's own requests (the
  settings it follows, what a vault nonce is for) go to the core the same
  way, without a page.

The bridge (`backend/hosts/electron/bridge.ts`, without imports, which
both processes and the tests import):

- a request has a MessagePort of its own; its head goes on the parent
  port with the port, its body and the response's in chunks, each side
  sending at most 8 chunks the other has not taken; a response body that
  breaks off fails the transfer in Chromium, and a cancel aborts the
  core's request;
- a channel (a WebSocket of a browser) is a MessagePort too: a frame of
  the app's origin asks for one (`desktopChannels.open`, `desktop/src/frames.ts`),
  the main process checks the frame and builds the request's Origin and
  Host itself, gives the core one end and the frame the other; text and
  binary messages pass as they are, with `open` and `close` frames and the
  client's `ack` of what it took in, so the core sees what is buffered as
  on a WebSocket;
- the web UI opens its channels with `openChannel` (`web/src/lib/transport.ts`):
  a WebSocket in a browser, a PortSocket (`web/src/lib/portSocket.ts`)
  over such a port in the app.

The intercepted `https:` origin rather than a custom scheme: code-server
builds its resource URLs from the page's scheme, and on a custom one its
own CSP refuses them (no grammars, icons or themes); CacheStorage needs a
secure context too. The handler's responses set no cookies in Chromium,
and the app needs none. code-server's frames get a WebSocket that opens a
channel for their own host, installed into their main world by the
preload (`contextBridge.executeInMainWorld` of the same PortSocket), so
VS Code needs no listener either. Uploads from the desktop use `fetch`
with a streamed body (an XHR's body reaches a protocol handler whole and
reports no progress). The handler's responses are not decoded by
Chromium, so proxied requests ask for `identity`.

What Chromium does for a request over the network it does not do for one
a handler answers: the handler gets no Origin header (Electron removes an
`Origin: null` too) and no Fetch Metadata, and the page that asked may
read the answer, CORS or not; a probe of Electron 45 had a sandboxed
frame and a frame of another origin read a JSON answer of the
intercepted origin in full. Who asked is the request's `initiatorOrigin`,
set by Electron from the frame or worker that made it ("null" for an
opaque origin, none for a request the browser started itself): the main
process puts it in the request's Origin, in place of any header, and the
core's guard refuses every origin but the app's (SECURITY.md). A
document the core serves sandboxed (a machine's file opened as a page)
is of an opaque origin, so in the app the images it names are refused,
which a browser loads.

The core's bundle loads at run time Node's own modules and node-pty
only: ws's optional native helpers (`bufferutil`, `utf-8-validate`) are
bundled as modules that fail to load, which ws takes as their absence,
and `desktop/build.mjs` fails when the bundle would load anything else.
Electron trims the module search of a file inside the app's resources to
them, but a module the app does not carry has no reason to be looked
for.

The app carries what the core carries for machines as resources, laid out
as `scripts/build.sh` stages them (`payload/`: machine builds and
herdr-core, or the TypeScript machine side's digests and its own
platform's executable, the video encoders, the VS Code extension; `web/`:
the web UI), and
node-pty 1.1.0 for the ssh login's terminal: a Node-API module, so the
binary built for Node loads in Electron's utility process without a
rebuild for Electron; it ships prebuilt for macOS and Windows and is
built by `pnpm install` on Linux. The app no longer carries the core's
executable.

### The machine side

`backend/machine` and the machine side of features run under Bun only, on
Linux and macOS:

- `backend/machine`: the node (`node.ts`: one per instance per host,
  `run/node.lock` taken with `flock`, `node.sock`, the hello of `serve`,
  `stop` and `takeover`, the idle end, the drain once taken over, its
  retirement once its executable is gone), its clients (`dial.ts`: `node dial`,
  `node stop`), the agent its sessions share (`agent.ts`: a yamux server
  per session, the core's ops `hello`, `fs.*`, `fs.archive`, `dial-unix`
  (each session's pipes counted per socket), `hc`, `hc-api`, `privacy` and
  `plugin`), the dispatch of `plugin` to the
  features' machine sides (`dispatch.ts`, `feature.ts`), the terminal core
  (`hc.ts`), hidden terminals (`hidden.ts`), housekeeping, the vault's
  socket, the coding agents' sessions, which the agents feature, AI usage
  and the chat host read (`agents/`), and system calls (`sys/`).
- A feature's machine side is its `machine.ts` (and `machine/`), made with
  `defineMachine(protocol, start)`: `start` runs once per agent and
  returns the handlers of the protocol's actions, which keep what the
  feature shares between requests; params are checked by the protocol's
  schemas, a `Fail` thrown is the refusal's code (the error reads
  `code: message`, as the Go agent wrote it), an action that does not
  stream ends when the core closes its stream. A feature may serve ops of
  the agent protocol besides (`Served.ops`: the agents feature's `detect`,
  which the core opens as an op of its own, VS Code's `code-server`); an
  op no feature serves is refused as an unknown plugin. A feature sees the
  agent's sessions (`env.sessions()`, and an action's own as
  `ctx.session`: its core, its open pipes to each socket and when it last
  opened one, a stream towards its core), ends what it owns when the agent
  ends (`Served.close`, once the sessions' requests were waited for) and
  hands it to the node that took over (`Served.handOver`).
- `backend/hosts/machine`: the machine side's commands (`cli.ts`: `node`,
  `node dial`, `node stop [--terminal-core]`, with the Go build's flags),
  which the one command line (`backend/hosts/bun/main.ts`) runs, and the
  features its node serves (`features.ts`). The executable is the core's
  too; the layers keep apart what runs where (Bun's APIs only on the
  machine side and the command line's host, Node's modules only in what
  the desktop app's core runs: backend/README.md).

It serves the machine sides of the terminals (the terminal core and hidden
terminals), files, git, search, monitor, history, browser, AI usage,
agents (detection and the agents' sessions), VS Code, chat (the chat host,
the `chat-host` command, below) and program windows (op `gui`) features,
and the vault's MCP server (the `mcp` command, below). An op or plugin it
does not serve is refused as an unknown plugin is (`unknown_plugin`); the
core treats it as a machine without that feature. AI usage's `session`
action finds a session's transcripts with the coding agents' sessions
(`backend/machine/agents`), as the Go build's does
([29](29-ai-usage.md#one-sessions-usage)).

VS Code's machine side ([05](05-vscode-panes.md)) answers op
`code-server` as the Go agent does, on the same files (the releases in
`~/.<slug>/code-server/<version>-<os>-<arch>`, the pid file `cs.pid`
naming the node that owns code-server, `cs.sock`, `bridge.sock`), so
a node of either build adopts, ends or hands over the other's
code-server; it is restructured rather than translated: the releases
(`machine/release.ts`: receiving, downloading, unpacking, retention), the
process (`server.ts`), the extensions (`extensions.ts`), the bridge's
socket (`bridge.ts`, tunnelled to the session that last opened a pipe to
`cs.sock`, else the newest) and the op (`op.ts`). A release the core
uploads or the machine downloads is written to a file beside the releases
and hashed as it arrives; only one of the digest the core sends is
unpacked (the core now sends the one it verified the upload by; a core
that sends none, an older one, gets it unpacked unchecked, as the Go
agent did). Unpacking does not hold the node's thread: the file is read
in chunks, gunzipped by zlib's stream (its work in the runtime's pool) and
unpacked by node-tar, a mature library (npm's own), which parses headers a
block at a time and writes with asynchronous calls; unpacking code-server
4.144.0 (210 MB, 7204 entries, 600 MB unpacked) took 2.5 s and held the
thread for at most 2 ms at a time, so no worker thread is needed. An
external `tar` would hold nothing either, but the tars of machines (GNU's,
BSD's, BusyBox's) differ in what they refuse. Where the Go agent
skipped an entry of a tarball that would leave the release (an absolute
path, `..`, a link leaving it), this side refuses the whole archive, an
entry of another kind too (a FIFO, a device), and with node-tar's strict
mode an entry written through a link; modes lose setuid, setgid and
others' write bits as before, and nothing takes the archive's owner or
times. Besides the Go agent's retention at each install (releases unused
for 14 days), its housekeeping touches the running code-server's release
every 24 h and removes the other releases unused for 14 days and what an
interrupted install left beside them after a day; a download stops past
1 GiB, an upload too, and an unpack past 4 GiB. curl, wget, the release's
Node and code-server's extension installer run in sessions of their own,
killed as a group at their bound.

AI usage on the machine side ([29](29-ai-usage.md)) keeps the Go agent's
answers, files, lock protocol and cost cache (the same tables and
entries, so a node of either build reads the other's), and is restructured
rather than translated: the providers in `machine/limits.ts`, Kimi Code's
renewal in `kimi.ts`, Antigravity in `antigravity.ts`, the scan and its
cache in `scan.ts` and `cache.ts`, the logs' parsers in `parsers.ts`.
Where the runtime has what the Go program wrote itself, it is used:
SQLite (`node:sqlite`) reads OpenCode's and Antigravity's databases in
place of the Go agent's reader of the file format, and `fetch` asks the
providers through the environment's proxy. The price table is
`spec/pricing/pricing.json`, which both builds and the core read. A cost
scan runs on the node's thread in slices (chunks of a log read with
`fs/promises`, the summing yielding every 8 ms); only SQLite, whose opens
and reads are synchronous and by name, runs in a worker thread started
from a Blob (no entrypoint of its own in the compiled executable), so
that a FIFO swapped in at a database's name or a mount that stopped
answering holds the worker, never the node.

Program windows ([14](14-gui-windows.md)) on Linux machines are split
between the node and a native helper. The helper (`scripts/gui-helper`,
Zig 0.17, `make gui-helper`) is what must not run on the node's thread or
cannot be written with Bun's APIs: the X client that manages the display
and captures its windows (MIT-SHM, damage, XTEST), the encoding of
pictures (JPEG, the Go agent's encoder ported byte for byte; PNG) and of
video (it owns the windows' encoder processes and writes them raw
frames, about 400 MB/s for a large window at 60 fps), the GPU display's
Wayland compositor (descriptors passed with `SCM_RIGHTS`, which Bun's
sockets do not receive) and the display keeper (a process that lives as
long as the terminal core, at a few hundred kB rather than a Bun runtime's
30–40 MB). It is one static executable per architecture without a C
library (raw system calls, so CentOS 7's glibc 2.17 and Alpine's musl
alike), 473 kB for x86-64 and 362 kB for arm64 (180 and 170 kB
gzip-compressed), carried by the
Linux machine builds gzip-compressed beside the payload and placed in
`<data>/gui/<sha256 prefix>/` (0700), checked by its digest before each
start. Its executables are committed with the digests of their sources and
of themselves, which `make check` verifies, since CI and contributors have
no zig (as gpupick's libraries and the terminal emulator's module). The
node keeps in TypeScript what decides and what manages processes and
files: the display's number, cookie and servers (Xwayland's socket pair to
its compositor made with `socketpair(2)` through `bun:ffi`), Xvfb's fetch,
the GPUs, gpupick, the encoder's install, and the window manager's
decisions (the cores and their roles, the flow, pictures or video, the
stats, the routing), speaking to the helper over its stdin and stdout
(`features/gui/machine/helper.ts`, `proto.zig`); frames cross the node's
thread once, encoded. A pure-JavaScript X11 client was not used: the
`x11` package is unmaintained since 2019 and has neither MIT-SHM nor
X-Resource, and the capture would be on the node's thread anyway.

Agent detection ([25](25-agent-detection.md)) reads herdr's manifests,
the Go build's files (`internal/agent/detect/manifests`), embedded as text
and parsed with Bun's TOML parser strictly (unknown members, types,
herdr's limits); what every manifest parses to is a file both builds'
tests compare with (`testdata/manifests.json`, which `go test -update`
writes), and the screens, identifications, regions and gates of
`testdata/` are both builds' cases. The rules' regular expressions are
RE2's, run by re2js, a JavaScript port of RE2 (by way of RE2/J) with Go's
syntax and semantics, in linear time: JavaScript's RegExp would read the
same rules otherwise (`\s` is ASCII space in RE2 and Unicode space in
RegExp; case folding; `\A`, `\x{…}` and `(?s)` it does not take) and
backtrack, so a screen could make a rule take long; Google's WebAssembly build of RE2
(`re2-wasm`) is unmaintained since 2022, and the native `re2` package
would need a build per platform inside the compiled executable. The
detector follows the terminal core's events, attaches as an observer and
reads screens without history lines, as the Go build's; its timing and the
sessions' schedule are the same. The coding agents' sessions
(`backend/machine/agents`) are found from their files as the Go build
finds them, reading everything with `fs/promises`: a transcript is opened
with no link on its path (`O_NOFOLLOW_ANY` on macOS; on Linux, which has
no such flag for `open(2)` and whose `openat2` would be a call through FFI
on the node's thread, with `O_NOFOLLOW` in the runtime's pool, the
descriptor refused before any read when `/proc/self/fd` names another
path than the one located), a Claude Code record relative to its checked
directory's descriptor (`/proc/self/fd/<dir>/<name>` on Linux), processes
from `/proc` on Linux and through sysctl on macOS. Claude Code's
transcripts are mapped to events by `backend/shared/agents/transcript`,
which the chat host's Claude Code adapter uses too, against the shared
vectors.

System calls Node lacks go through `bun:ffi` to libc (`machine/sys`): peer
credentials of unix sockets (`SO_PEERCRED`; `LOCAL_PEERCRED`,
`LOCAL_PEERPID`), `flock`, `openat2` with `RESOLVE_NO_SYMLINKS` (falling
back on ENOSYS, below 5.6, and on EPERM, a seccomp filter, to the last
name's `O_NOFOLLOW`), `openat` relative to a directory, `renameat2` and
`renamex_np` without replacing, `unlinkat`, `sysctl` `kern.proc.pid` and
`kern.proc.pgrp` on macOS (a process's parent, group and start time). Variadic C functions are not called through FFI (on macOS/arm64
their arguments go on the stack): files are opened with `fs.openSync`,
which passes flags such as `O_NOFOLLOW_ANY` through (without `O_NOFOLLOW`,
which macOS refuses beside it), and the system calls Linux's C libraries
wrap in no function of fixed arguments (`openat2` in none, `renameat2` not
in glibc 2.17, `openat` relative to a descriptor) go through `syscall(2)`
with integer arguments only, which both of Linux's ABIs pass in the
registers of a fixed argument list. A database is known to be unheld when a
connection in `locking_mode = EXCLUSIVE` gets its lock without waiting,
instead of a byte-range lock (`BEGIN EXCLUSIVE` alone takes only the
write-ahead log's lock and misses an idle reader). SQLite's calls are
synchronous in both runtimes: a database's busy timeout blocks the thread
that waits, so the core keeps them short. A new session for a child is
`detached: true`; a group is killed with `process.kill(-pgid)`. Bun's unix
socket server removes the path it bound when it closes, so the agent binds
each socket under a temporary name and renames it into place: a server
that closes never removes the socket another node or agent put at the path
since.

A core built to deploy the TypeScript machine side
(`backend/scripts/build.ts --machine ts`) is that machine build itself:
one executable per platform holds the core (`serve`, the web UI and its
API), the machine side (`node`, `node dial`, `node stop`), that platform's
herdr-core and, on Linux, its video encoder, besides the VS Code bridge
(`backend/hosts/bun/main.ts`, one command line; the machine side's commands
in `backend/hosts/machine/cli.ts`, the features its node serves in
`backend/hosts/machine/features.ts`). The platforms are linux x64 (a
baseline build, for processors without AVX2), linux arm64, the same two
for musl (Alpine), darwin x64 and darwin arm64; a Windows build is the
core alone (the desktop app's platform, reaching SSH machines only). Users
run it as the web UI (`serve`, in a browser) or in the desktop app, whose
core runs in Electron and which carries its own platform's executable for
the local machine. A machine keeps it at `~/.<slug>/agent/<version>/<slug>`
(the version is the start of the executable's SHA-256) as the Go build is,
so command lines are the same for both; the local machine gets a copy of
the running executable (the desktop app's from its resources). The
executable is compiled without loading a `.env` file or `bunfig.toml`
(`--no-compile-autoload-dotenv`, `--no-compile-autoload-bunfig`) and
installs nothing; what Bun reads from the environment besides,
`BUN_OPTIONS` (whose `--preload` it honours), `BUN_BE_BUN` (which makes it
Bun's command line) and `BUN_INSPECT*`, the deployment's command line
unsets before it runs the executable, the local transport and the command
line's `node` leave out of the environment they start it with, and the
executable removes from its own at once, so nothing it starts gets them; a
compiled executable writes no transpiler cache. Its node installs the
terminal core from the copy it carries (the `hc` op's `install-embedded`),
when that copy is the one the core's build recorded for the platform
(`machine/hc.json`: the digests of the herdr-core executables the build
embeds, from the archives `scripts/fetch-hc` verified against the digests
pinned in `internal/hcdist`); the core uploads none to it. Sizes with Bun
1.4.5 and herdr-core 0.1.21, the executable and its release archive:

| Platform | Executable | Archive |
| --- | --- | --- |
| linux x64 | 130.8 MiB | 58.3 MiB |
| linux arm64 | 130.7 MiB | 58.0 MiB |
| linux x64 musl | 124.7 MiB | 55.4 MiB |
| linux arm64 musl | 123.4 MiB | 54.9 MiB |
| darwin x64 | 120.0 MiB | 50.6 MiB |
| darwin arm64 | 111.3 MiB | 47.5 MiB |

(without the video encoder, about 2 MB more on Linux, nor the GUI helper
and gpupick, 0.2 MB more; the web UI is about 20 MB of each)

A release publishes each platform's archive (`<slug>-<platform>.tar.gz`,
the executable at `<slug>-<platform>/<slug>` with the licenses beside it,
what users download too) and `SHA256SUMS`, the digests of every asset and
of the executable in each archive. A machine downloads the archive rather
than a bare executable: one asset per platform, the licenses of what it
runs (herdr-core's among them) travel with it, and unpacking one member
(`gunzip -c | tar -xf - -O <member>`) works with the tar of CentOS 7 and
BusyBox's alike, after the archive's digest was checked. No core carries
another platform's executable: each takes the release's manifest and the
archives from the release (`backend/kernel/machines/transport`,
`release.ts` and `ssh.ts`).

The manifest is the first of: the operator's directory (`--agent-dir`,
with the release's `SHA256SUMS`: offline sites); the core host's cache
(`~/.<slug>/cache/machine/`, per version, a manifest the core fetched); the
release, fetched by the core over its own HTTPS (Bun's or Node's fetch,
which verify the certificate, through the proxy of `HTTPS_PROXY`,
`HTTP_PROXY` and `NO_PROXY`: Bun's fetch reads those itself; the desktop
app's core, in Node, sets them for its own process with
`http.setGlobalProxyFromEnv`, `backend/shared/lib/proxy.ts`, loopback
always excepted, so no variable reaches the programs it starts, as
`NODE_USE_ENV_PROXY` would make every Node program of the local machine
send its requests, loopback's too, to the proxy). When that fetch finds the
release unreachable (no name, no route, a refused connection, no answer
within 15 s), the core does not try it again for 10 minutes and fetches the
manifest through the machine instead: an ssh stdio forward (`ssh -W
<host>:443` over the control master; a core without one, on Windows, opens
a non-interactive connection of its own) carries the core's own TLS
(`tunnel.ts`), which verifies the release's certificate against its host
name as fetch does, so the machine carries bytes it can neither read nor
change. A fetch that reached something else (a certificate the core does
not trust, an HTTP answer, a manifest it refuses) ends there with
`build_unavailable` and the reason in the core's log; a machine whose sshd
forbids forwarding (`AllowTcpForwarding no`, common on clusters) fails the
same way, and its site gives the core a route to the release or uses
`--agent-dir`. A manifest is this build's only when it names the core's own
executable by its digest (its platform's line): one of another release is
refused (the desktop app on Windows, which has no executable of its own,
cannot tell, and logs it), and so is one that names a file twice with
different digests. Without one, a machine of the core's own platform still
gets the core's own executable: the running program, opened when the core
started (`/proc/self/exe` on Linux), not whatever an upgrade in place put
at its path since.

A machine that does not hold its build gets it, in this order:

1. The machine downloads the release's archive itself, with `curl`, else
   `wget`, unless the setting `machines.download` is off for it (or
   `--machine-download=false`) or its download failed within the last day
   (the core keeps that in memory, per machine, and uploads first
   meanwhile, asking the machine again when it has nothing to upload; only
   the download's own failures count, not the connection's). The tool runs
   without its user's configuration (`curl -q`; an empty `WGETRC`, GNU
   wget's `--no-config` where it has it), with one try, few redirects and
   10 s to connect; curl keeps to the URL's scheme, redirects included
   (`--proto`, `--proto-redir`), while wget may follow a redirect to http
   (GNU wget's `--https-only` holds in recursive downloads only) and
   BusyBox's may not verify the server's certificate: what either gives is
   held to the manifest the core verified. The download goes to a file
   beside its place through `head`, at most 256 MiB, and a watchdog ends it
   after 5 minutes in all, whatever the tool (wget's `-T` bounds each read,
   not the whole). Only an archive of the manifest's SHA-256 is unpacked,
   within 2 minutes.
2. Else, or when that fails (neither tool, no route to the release, a
   timeout, an archive that is not the release's), the core uploads it over
   ssh, taking the first of: the operator's directory (the archive, or the
   executable as `<slug>-<platform>`), its cache, its own executable for a
   machine of its platform, a download of the archive from the release
   (then cached). Each is read and hashed piecewise, bounded, checked
   against the manifest before it is used or cached (a file of the
   directory that is not the build is refused, a cached one removed), and
   loaded once for the machines of one platform. This is the path of a core
   that reaches the internet for machines that do not.

Both install the same way, the core's local install too (the same script,
run on the core's host): the archive's SHA-256 checked before it is
unpacked, the executable written beside its place, its SHA-256 computed on
the machine (`sha256sum`, `shasum` or `openssl`), renamed into place only
when it is the one the manifest names, else removed and failed, and
printed, which the core checks again. Its files (`.upload.<pid>`, with
`.in`, the archive, and `.rc`, wget's empty configuration) are removed when
the script ends (`trap`): an upload ends when its input does (the connection went), a
download within its bounds (sshd sends no hangup to a session without a
terminal, so a dropped connection does not end it sooner); the nodes'
housekeeping removes what a killed shell left, after an hour. When none of
the sources has the build the machine is refused with `build_unavailable`
and what each source said (naming no path of the core's host, which the
core logs), which the UI explains; it is dialed again later. A build of no
release (development, the end-to-end tests) has no download URL: its
machines get their build from `--agent-dir` (with its `SHA256SUMS`) or the
core's own executable. Which C library a machine has is what glibc answers
(`getconf GNU_LIBC_VERSION`, `ldd --version`), musl's loader in `/lib` only
without it (a glibc system with musl's package has one); musl's executable
needs `libstdc++` and `libgcc`, which the probe reports when missing. Builds
unused for 14 days are removed (the nodes touch the directories of
theirs), the core's cache likewise.

The trust is the release's: a build is as trustworthy as the GitHub
release and the core's TLS to it. Whoever can replace the release's assets
(a leaked token, say) can replace `SHA256SUMS` too; the checks protect
against damage and, when the core fetched the manifest, against the
machine's network path. A signature over `SHA256SUMS` would be an addition
to this, not a change of it.

The node serves every core on one thread: what a user or a mount controls
is not waited for on it. The core's file ops, git's reads of a repository,
the reads of the coding agents' sessions and records, the node's check of
its executable and housekeeping are asynchronous (a call
that does not return holds a thread of the runtime's pool and its own
request), and a file is opened to be read with `O_NONBLOCK` and read only
when it is a regular file, so a FIFO swapped in waits for no writer. The
files feature's changes and saves go through `bun:ffi`, which is
synchronous: each opens without blocking on a FIFO, but a change on a
mount that stopped answering stalls the node until it answers; and the
node needs its data directory (its log, the terminal history's database).

The vault's MCP server ([30](30-variable-vault.md#machines)) is the
`mcp` command of every TypeScript executable (`backend/hosts/machine/mcp.ts`,
the server and its runner in `backend/features/vault/machine/`), also when
the executable is started by the name of its link in a data directory's
`bin` (`process.argv0`, which a compiled executable has as exec gave it;
its `argv[0]` is `bun`); the node points that link at its own executable
when it starts, as the Go agent does (`linkMCP`, `backend/machine/vault.ts`:
the same script, byte for byte, so a node of either build leaves the
other's in place). The protocol is the official MCP SDK's
(`@modelcontextprotocol/server` 2.4.0, Apache-2.0, pinned; it depends on
zod and its own core package only, and bundles ajv for the JSON Schema
validation it offers, which THIRD_PARTY_NOTICES.md names): its stdio
transport, the handshake and version negotiation, ping, "method not
found", and `notifications/cancelled`, which aborts the call's signal and
leaves the call unanswered. The tools are handlers of its low-level
`Server` rather than its `McpServer`, whose zod schemas would change the
tools' definitions and turn wrong arguments into a tool's error text; the
Go server's definitions and refusals (-32602) are kept. A command runs as
the Go server runs it (`sh -c`, a session of its own, the watcher on fd 3
that kills the group once the server's end of the pipe closes, the output
captured 64 KiB beyond its bound and masked by bytes); Node's spawn cannot
ask for Linux's `Pdeathsig`, which the Go server adds, so the watcher alone
ends a command of a server killed outright. What a client sees differently:
a line that is no JSON gets no parse error, calls still running when stdin
closes are not answered, and the newer revisions 2025-11-25 and 2024-10-07
negotiate too.

Which machine build a core deploys is a choice of its build
(`backend/scripts/build.ts --machine go|ts`, `scripts/build.sh MACHINE=ts`;
the release workflow's repository variable `MACHINE`), not a flag of the
product: the product's builds deploy the Go machine build until the
TypeScript side serves every feature. Both speak the same protocols on the
same sockets, locks and files (the terminal history's database, the
terminal core's executable and session), so a node of either build takes
over from the other with the terminals kept, which is the upgrade path.
`scripts/e2e.sh` builds the cores of both, the TypeScript build for the
host and Docker's Linux (glibc and musl) into a directory with its
`SHA256SUMS`, which the cores take as `--agent-dir`, offline;
`E2E_MACHINE=ts` runs the end-to-end tests against the TypeScript build,
and `tests/nodes.spec.ts` has a newer node of the other build take a node
over.

### The chat host

The chat host ([37](37-agent-chats.md)) is the `chat-host` command of
the same executable (`backend/hosts/machine/chathost.ts`, the Go build's
flags and statuses), which the node has the terminal core run as a hidden
terminal (`backend/features/chat/machine.ts`, the chat feature's `open`
action: the start, the hand-over to a newer build and the stuck host as
the Go agent has them). The host itself is `backend/features/chat/machine/host`,
restructured for one thread rather than translated: no locks; a chat
(`chat.ts`) is a state machine whose agent calls and permissions are
promises, its connections (`subscriber.ts`) bounded queues written by a
loop each, the host (`host.ts`) its requests, bounds, idle end and stop.
Its wire, journal tables, log, socket and lock are the Go host's, so either
build's host takes over from the other with its chats.

The journal is SQLite, whose calls are synchronous. It runs in a worker
thread (`journal.ts`, a script started from a Blob, as AI usage's reads;
the host's thread only opens, checks and migrates the database once,
before it serves), because the host streams every agent's output and
serves every connection on one thread: a write that waits (a data
directory on a network mount that stopped answering, a checkpoint's sync
on a slow disk, a lock of a database another host still holds after a
hand-over that timed out) would stop all of them, where the Go host
stopped one goroutine. The worker runs the statements in the order they
were sent, each change a transaction, and answers each. So that no client
ever sees what the journal does not have, a chat's events reach its
connections only once they are stored, in the order the chat made them,
live increments behind the stored events made before them; an append is
refused by the worker unless the chat's row has the event before it, so
when one write fails, nothing made after it is stored or told, the chat
fails and goes on numbering from its last stored event: the log never has
a hole. What a write that waits holds is the chats' stored events (and
the replays of attaches), at most 64 MiB of them waiting before the chats
that make more fail; the agents' output is still read, the sockets
served, the requests that need no journal answered. The host's log is
written in order by the runtime's pool, at most 1 MiB waiting, the rest
counted.

Every process the host and its adapters start (the agents, the probes
that list or import sessions, the login shell) goes through
`AgentProcesses` (`features/chat/machine/agentproc.ts`): a process group
of its own (`detached`, a session of its own, where the Go host had a
group in the host's session), the end of its standard error kept, ended
gracefully (input closed, SIGTERM to the group after a grace period,
SIGKILL after another, then what it left in its group), and signalled as
a whole when the host stops on the terminal core's signals.

The adapters implement `features/chat/machine/adapter.ts` (`Adapter`,
`Session`, `Sink`; doc 37 has the rules); the host gets them by name from
its composition root (`hosts/machine/features.ts` `chatAdapters`), so an
adapter is added there and nowhere in the host. The TypeScript build has
the ACP adapter (`features/chat/machine/acp`): ACP is spoken through
`@agentclientprotocol/sdk` 2.6.0, pinned exactly (Apache-2.0; protocol
version 1, as the Go client's). It frames the agent's lines (at most
16 MiB), pairs calls with answers and answers the agent's requests.
Notifications are taken out of its stream before it sees them and handed
to the session synchronously, in the order of the agent's output: the
SDK's client parses every `session/update` with the protocol's stable
schema, dropping an agent's newer kinds and values, and dispatches
asynchronously, which would not keep a turn's last updates ahead of the
answer that ends it.

It has Codex's adapter (`features/chat/machine/codex`), which keeps the
app-server's JSON-RPC and the Go adapter's behaviour (doc 37: threads
read-only and the policy per turn, approvals without amendments, plans,
steering and the queue, the interrupt's restart, compaction, usage and
limits, sessions and imports through `thread/list` and
`thread/turns/list`). It is written against TypeScript types generated
from the JSON schema Codex prints: `spec/codex-app-server` keeps the
schema of the version pinned verbatim
(`codex_app_server_protocol.schemas.json`, what `codex app-server
generate-json-schema --experimental` writes, 980 KB for 0.171.0) and
`backend/scripts/codex-schema.ts` makes of it `appserver.gen.ts`: the
types of the requests the adapter sends with their results, of every
request of the app-server with its answer, of the notifications it maps,
the names of every method and the definitions they reach (232 of them,
92 KB). A keyword of JSON Schema the script does not translate fails it,
so a newer schema is never read as something else; `make check` fails
when the types are not what the schema makes; the script takes another
version's schema from what Codex wrote, or from Codex's repository
(`--fetch`, its tag's experimental exports), without running Codex. The
typecheck holds the adapter to the types (each request's params and
result, each answer, the notifications it passes over by name), and its
tests validate every message of the recordings and what the adapter
sends against the schema itself, with zod's `fromJSONSchema`: that
replaces, for the TypeScript side, the Go adapter's hand-pinned summary
(`summary.json`, `TestSchemaPinned`), which the Go side keeps while it
exists. The framing is the adapter's own (`rpc.ts`, a few dozen lines):
Codex writes JSON-RPC without the `jsonrpc` member, which json-rpc-2.0
refuses and vscode-jsonrpc adds (framing with headers besides); a line
over 16 MiB is passed over and the connection goes on; and every line
is handed on synchronously in the order of the app-server's output, so a
call's answer settles it only after the notifications before it reached
the session. What starts or steers a turn, compacts, carries out an
approved plan or starts the app-server again holds the session's lock
across its calls (a promise queue, nothing blocks the thread), as one of
them at a time does in the Go adapter.

And it has Claude Code's adapter (`features/chat/machine/claude`), which
runs on Anthropic's Agent SDK, fetched by the machines when a chat needs
it ([Claude Code](#claude-code)).

### Wire compatibility while both exist

yamux (`backend/shared/proto/yamux.ts`) speaks hashicorp/yamux's protocol with
its semantics (a close is a half-close; window, keepalive and backlog as
`agentproto.YamuxConfig`), and agentproto, herdr-core's protocol and the
chat host's protocol keep their wire forms, so a TypeScript core serves Go
machine builds and the other way round. The stages: shared libraries;
the core in TypeScript with the Go machine builds, which then becomes the
product's core, the Go core removed (the Go program is the machine build
only); the desktop app's core in process; the machine side in TypeScript;
the Go program removed.

### What changes on the wire

Behavior stays; a few answers become uniform where the Go core was not:

- every refused request answers JSON `{error, message}` with a code (the Go
  core answered some with plain text, an unknown machine among them);
- read-only mode refuses with the code `read_only` (it was
  `{"error": "read-only mode"}` on the core's own routes);
- every audit record of a change carries `status` and, when it failed,
  `error` (the code), whichever feature made it.

Where the web UI shows the core's text (the editor's file errors, the
upload dialog, VS Code's bridge toasts) the answers keep it as before.
Other differences a user or an operator can see:

- the settings and keybindings files are read as JSONC (comments,
  trailing commas), and a change from the UI rewrites only what changed,
  keeping the file's comments and layout; a rule's member names in the
  keybindings file are case-sensitive;
- a request with a body over a route's limit answers 413 `too_large`;
- a feature that is off answers `plugin_disabled` before read-only mode
  answers `read_only`, and an unknown machine answers 404 before either;
- a streamed download has no `Content-Length` (Bun sends it chunked): the
  downloads panel's progress comes over `/ws` as before, and a download
  that breaks off fails in the browser instead of ending short;
- the core logs only its own failures (500), not a machine's or a
  program's (502, 503, 504).

### Building and testing the core

`backend/scripts/build.ts` packs the payloads (the web UI, the machine
builds, herdr-core, the video encoder, the VS Code extension) into one tar
archive and compiles `backend/hosts/bun/main.ts` with it embedded (`bun
build --compile`, a Bun target per platform: x64 Linux and Windows as
baseline builds); the core reads it with `Bun.Archive`, keeping the UI's
files in memory and reading a machine build when a machine needs one.
`scripts/build.sh` stages the payloads in `dist/payload` and builds the
core of each platform; `scripts/e2e.sh` runs the end-to-end tests against
that executable, with the Go machine builds while machines run them. The
checks that read the Go core read the TypeScript one now: the flags and
routes `docs/reference.md` must list come from the core composed as
`serve` composes it (`backend/scripts/reference.ts`), the registry from
the features it composes too (`backend/scripts/registry.ts`).

### Claude Code

The adapter (`features/chat/machine/claude`, an `Adapter` of
`features/chat/machine/adapter.ts`, one of the chat host's adapters) runs
each session as a `query()` of `@anthropic-ai/claude-agent-sdk` 0.3.322,
with the user's own `claude` (`pathToClaudeCodeExecutable`: the host's
command for the kind). The SDK is fetched on use, never shipped (below):
the adapter `import()`s it at run time from the machine's data directory.
The SDK writes the command line, the protocol's lines and its variables of
the environment, pairs the control requests with their answers, answers
the program's requests (`can_use_tool` through `canUseTool`, an MCP
server's elicitation declined, any other refused as unsupported, as the
Go adapter did) and hands the program's messages on in their order. The
adapter gives it:

- `systemPrompt: {type: 'preset', preset: 'claude_code'}` (without it the
  SDK sends Claude Code an empty system prompt);
- `settingSources` always (`user`; `project` and `local` too in a folder
  Claude Code or the user trusted) and `permissionMode` always,
  `includePartialMessages`, `sessionId` for a new session and `resume`
  for one taken up, `model`, and `allowDangerouslySkipPermissions` only
  for full access, which starts the program again on the same session;
- the host's environment for the program with
  `CLAUDE_CODE_ENTRYPOINT=<slug>`, so the sessions show in the terminal's
  `/resume` (the SDK adds `CLAUDE_AGENT_SDK_VERSION` and
  `CLAUDE_CODE_SDK_READS_SESSION_STATE` and drops `NODE_OPTIONS` and
  `DEBUG`; it also sets `CLAUDE_AGENT_SDK_VERSION` in the host's own
  environment, which the host gives every agent's login shell, so the
  adapter puts that back);
- `spawnClaudeCodeProcess` (`sdk.ts`, `AgentSpawn`): the program runs
  through the host's `AgentProcesses` (a process group of its own, the end
  of its standard error kept, ended gracefully, what it left in its group
  swept once it exited), and its output is framed before the SDK reads it:
  a line longer than 16 MiB is passed over (the SDK's reader has no bound),
  and the `session_state_changed` messages Claude Code marks as the host's
  (`sdk_host_only`), which the SDK drops, lose the mark, so that the SDK
  hands them on in their place among the others (a turn that ends without
  a result ends at `idle`); read beside the SDK, they would overtake the
  messages before them;
- the prompts, an `AsyncIterable` of user messages, each prompt done once
  the SDK wrote it;
- `canUseTool` for permissions, questions (`AskUserQuestion`) and plans
  (`ExitPlanMode`). The SDK calls it as it reads the request, ahead of the
  messages before it that it has not handed on yet; the adapter asks the
  host on the next turn of the event loop, by when they were, so the host
  has a tool call's event before the permission asked for it. A request
  the program cancelled gets the denial `canUseTool` returns, as the SDK
  answers every request it hands on (the Go adapter sent nothing).

`interrupt` (with the queued messages it leaves, `still_queued`),
`setModel`, `setPermissionMode`, `applyFlagSettings` (the effort),
`getContextUsage` and `initializationResult` are the SDK's, each bounded
by the adapter (30 s, initialize 60 s; the SDK waits without end).
Withdrawing a queued message uses the SDK's `cancelAsyncMessage`, which
its types do not declare, through a wrapper that refuses as unsupported
when it is gone and whose test (`sdk.test.ts`) fails then. What the SDK
does not do stays the adapter's: the messages as the chat's events
(through `backend/shared/agents/transcript`, as in the Go adapter), turns
and queued messages, the configuration options, Claude Code's trust of
folders (`~/.claude.json`, at most 32 MiB, read asynchronously), the
sessions and imports from the transcripts, and the sessions another Claude
Code runs.

**Fetched, not shipped.** The SDK's license reserves all rights
("© Anthropic PBC. All rights reserved. Use is subject to the Legal
Agreements"); the product's releases are MIT. So no executable, release
archive or desktop app carries it: a machine gets it when a Claude Code
chat needs it, from the npm registry, as the user's own deployment
downloads code-server. What is pinned (`features/chat/claudesdk.ts`) is
the registry's tarball of version 0.3.322, its URL
(`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.322.tgz`,
a mirror's with `--npm-registry`) and its integrity, the lockfile's
`sha512-r88ij7R3…` (`claudesdk.test.ts` reads it from
`backend/pnpm-lock.yaml`); and the SHA-256 of its entry, `sdk.mjs`. The entry
carries what it uses of the SDK's dependencies (zod among them)
and imports Node's own modules only, so the one tarball is all it needs.
`backend/package.json` has the SDK as a development dependency, for its
types and the tests; Claude Code's own executables, which it carries as
optional packages, are not installed (`ignoredOptionalDependencies`), nor
its peer dependencies but zod. The product's code imports nothing of it
but its types (`scripts/check.sh`), and `backend/scripts/build.ts` refuses
an executable that holds its code.

`--npm-registry` is an `http` or `https` URL without user information,
query or fragment, where credentials go: the machines get the tarball's
URL on their command lines, which every local user there can read, so the
core refuses to start with one (`hosts/bun/serve.ts`), and so does
`--code-server-url`; a mirror that needs credentials is served through a
`--seed-dir`. What the core and the machines say of a URL, in an error a
page gets or in the log, is its origin and path only
(`shared/lib/urls.ts`).

Before a request that starts a Claude Code chat (a new chat or an import:
`POST new`; and, without waiting for it, a page's subscription to such a
chat, whose next prompt may start its agent), the core makes sure the
machine has it (`features/chat/sdkprovision.ts`; a read-only core asks
nothing). Once the machine had it, the core asks again on the same agent
session after an hour (each ask is a use of the machine's copy, and puts
back one its retention removed). Once it could not get it, a
subscription's ask fails with that answer for 5 minutes on the same agent
session, asking nothing (every page that shows the chat would otherwise
run each source again, the machine's download of up to 5 minutes among
them), while `POST new`, the user's own request, asks again. Each install,
and each that failed, is audited as `chat.sdk_install`, with the machine,
where its copy came from (`machine`, `seed`, `cache`, `download`, or
`none` when nothing was tried), whether it was installed, and the error,
its URLs by origin and path, cut to 256 bytes:

1. the machine side's action `sdk` says whether the pinned version is
   installed, and, unless the core is `--offline`, has the machine download
   it itself from the registry (`curl -q`, else `wget` with an empty
   regular file as its `WGETRC` and GNU wget's `--no-config` when its
   untranslated help names it, at most 32 MiB in 5 minutes;
   `#machine/artifacts.ts`, as code-server's releases come), its answer
   saying whether it did (`fetched`, for the audit record);
2. a machine that could not gets it from the core (`sdkUpload`, in chunks):
   from an operator's directory (`--seed-dir`, as code-server's tarballs),
   the core's cache (`~/.veldr/cache/npm`, 14 days unused), or the core's
   own download from the registry through the proxy of its environment,
   then cached. A copy in a directory or the cache is a regular file,
   opened without blocking: another file under its name (a FIFO, a device,
   a directory) is refused at once, never waited on. The core loads its
   copy once for every machine that waits for it, and drops a load that
   has not settled within the download's bound and a minute, so that the
   next ask loads it anew;
3. every copy, the machine's download, the operator's and the cached one,
   the core's download and the upload, is checked against the pinned
   integrity before it is used, cached or unpacked; the machine unpacks
   only `package.json`, `sdk.mjs`, `LICENSE.md` and `README.md`, with
   code-server's refusals (node-tar strict, no absolute path, `..` or link
   leaving the directory), into `<data>/claude-agent-sdk/0.3.322`, which
   becomes the version once its entry's SHA-256 is the pinned one.

The chat host loads it from there (`machine/claude/load.ts`), its entry's
SHA-256 checked again first, once per process; a load counts as a use, and
a version unused for 14 days goes (the chat feature's housekeeping on the
node). A compiled executable `import()`s the file as Bun does (Bun's
compiled executables load modules from the file system), resolving nothing
but Node's own modules: no import map, plugin or rewriting is needed
(`installed.test.ts` compiles one that does). A machine that has it not
and could not get it refuses the chat with `sdk_unavailable`, which the
core answers `POST new` with, saying what each source said; a chat whose
agent starts without it fails with it, and the host goes on. A machine of
the Go build has no `sdk` action: its chat host speaks Claude Code's
protocol itself, and nothing is fetched.

Anthropic's terms govern the user's use of the SDK and of their Claude
account. A chat runs the user's own `claude`, signed in as the user signed
it in, as the Go build's chat host did.

## Alternatives considered

- **Keep the machine side in Go.** Smaller uploads (a Go build is 16 MB,
  6.5 MB compressed; the TypeScript build is 111–131 MiB, 48–58 MiB as
  its archive), but the chat host and its adapters would stay in Go and the
  types twice.
- **The Bun runtime and a bundle of the machine side, apart.** An update
  would upload the bundle only (a few hundred kilobytes), the runtime once
  per Bun version, but a machine would run a launcher script that keeps
  the working directory's `.env` and `bunfig.toml` out, the runtimes would
  be pinned and fetched apart, and a node would have two files to check.
- **A machine executable apart from the core.** A smaller file for
  machines (about 30 MB less: no web UI, no core), but two programs per
  platform, and a core cannot carry the digests of executables built from
  the same release without building them first. One executable per
  platform is what users run and what machines run, its release archive
  what both download.
- **Every platform's executable in each core.** About 300 MB more per core
  (and per desktop app): the release serves them, and a core carries its
  own.
- **The machine's own download of the manifest.** For a core that cannot
  reach the release, a manifest the machine downloads could not be told
  from one an attacker on the machine's path gave it (BusyBox's wget may
  not verify certificates, wget follows redirects to http), and a core that
  cannot reach the release may be one whose path is being attacked: the
  core fetches it through the machine with its own TLS instead, or not at
  all.
- **A signed manifest.** A signature over `SHA256SUMS` (a release key in a
  secret, its public half in every build) would hold the builds to the
  key rather than to the GitHub release; it means a key for the
  maintainers to keep, and nothing in the checks changes when it is
  added later.
- **Bare executables as release assets.** One more 55 MB file per platform
  beside the archive users download, without the licenses of what it
  holds.
- **JavaScript's RegExp for the detection rules.** herdr's rules are
  written for RE2's semantics, which RegExp reads otherwise (`\s`, `\b`,
  case folding, `\A`, `\x{…}`), and it backtracks: a rule on a screen the
  program draws could take long. re2js keeps Go's reading, linear in
  time, in plain JavaScript inside the compiled executable.
- **The chat host's journal on its own thread**, as the node's own
  databases are. Simpler, but a write that waits would stop every chat's
  output and every connection of the host; in a worker it holds the
  chats' stored events only, at the cost of a message per statement and
  of each chat's events waiting for their writes before they reach its
  clients.
- **The Agent SDK in the executable.** Simplest, and it runs there, but
  its license reserves all rights and the releases are MIT.
- **The SDK from the machine's own npm** (`npm install` on the machine).
  Machines have no Node or npm of their own, and the user's npm
  configuration would decide where it comes from; the pinned tarball is
  fetched by curl or wget, or uploaded, and checked instead.
- **A node_modules layout, an import map or a resolver plugin for the
  SDK.** Not needed: its entry imports Node's own modules only.
- **Claude Code's messages read beside the Agent SDK** (from the output
  framed for it, the SDK's iterator drained). Every message would be
  decoded twice and the SDK's own handing on would be unused; the SDK's
  order is kept instead, the host-only messages unmarked for it and the
  requests asked a turn of the event loop later.
- **The hand-written protocol of the Go adapter in TypeScript.** Exactly
  what the SDK is for: its control requests, answers, command line and
  environment follow Claude Code's releases.
- **The SDK's client as it is for ACP** (`client().onNotification`). It
  drops the updates its stable schema refuses and does not keep a turn's
  updates ahead of the answer that ends it; the notifications are taken
  out before it.
- **Codex's own TypeScript** (`codex app-server generate-ts`): 968 files
  of every type of the protocol (580 KB), each importing the others
  without extensions, which this backend's module settings would need
  rewritten, and nothing to check that the committed files are what a
  schema makes. The JSON schema is one file, kept verbatim and checked,
  and the types of the part the adapter uses are generated from it.
- **json-schema-to-typescript for Codex's schema.** The common generator,
  but a tree of dependencies (its own prettier, lodash, a reference
  parser) for what is a few hundred lines over the subset of JSON Schema
  that Codex's schemars writes; it names inline variants from their
  titles and adds index signatures, where the script writes the unions as
  Codex has them and fails on a keyword it does not know.
- **A JSON-RPC library for Codex** (vscode-jsonrpc, json-rpc-2.0). Codex's
  messages have no `jsonrpc` member, which they require or add;
  vscode-jsonrpc frames with headers; neither passes over a line too long
  and goes on. The framing is a few dozen lines.
- **Validating what Codex sends at run time.** The adapter reads Codex's
  messages leniently, as the Go adapter does (members and values it does
  not know passed over, an item it cannot read passed over); the schema
  validates the recordings in the tests instead.
- **The sessions' strict opens through FFI on Linux** (`openat2`,
  `openat` relative to a directory). Synchronous on the node's one thread,
  where a home on a mount that stopped answering would stall every core;
  opening in the runtime's pool and checking the descriptor's path in
  `/proc/self/fd` gives the same refusal without waiting on it.
- **A loopback listener for VS Code only.** Not needed: the tunnel works.
- **A custom scheme for the desktop's origin.** Breaks code-server's
  resources and CacheStorage.
- **The GUI capture in TypeScript.** An X11 window manager, a Wayland
  compositor, shared memory and JPEG at frame rate are native work: the
  GUI helper does them, the node decides (above; [14](14-gui-windows.md)
  has the split's alternatives).
- **The GUI helper built by every build.** CI and contributors have no
  zig; its static executables are small and change rarely, so they are
  committed with their digests, which `make check` verifies.
- **The GUI helper linked against libjpeg-turbo.** Its x86-64 SIMD is NASM
  assembly, which zig cannot assemble; the port of the Go agent's encoder,
  coding row groups on every core, gives the Go agent's bytes.

## Failure modes

- A machine Bun cannot run on: an x86-64 processor without SSE4.2 (Bun
  stops with "this CPU is missing SSE4.2 support"; a VM given QEMU's
  default model qemu64 is one), or musl without `libstdc++` and `libgcc`.
  The probe reports it and a core that deploys the TypeScript side refuses
  the machine with a code (`cpu_unsupported`, `libs_missing`) in its
  error, as an unknown platform is refused. Kernels and C libraries as old
  as CentOS 7's (3.10, glibc 2.17) run it (Testing).
- A machine that cannot download its build and a core that has it in
  neither its directory nor its cache and cannot reach the release (an
  offline site without `--agent-dir`): the machine is refused with
  `build_unavailable`, saying what each source said, which the UI
  explains (deployment.md, offline sites).
- A core that cannot reach its release, for a machine that can: the core
  fetches the manifest through the machine (`ssh -W`), its TLS its own; a
  machine whose sshd forbids forwarding fails with `build_unavailable`.
- A kernel without `openat2` (below 5.6) or a container filtering it: a
  link swapped into a directory of a path the agent resolved is followed,
  only the last name is refused (`O_NOFOLLOW`), as with the Go build.
- A chat host whose journal stops answering (a data directory on a mount
  that stopped): the chats' stored events wait for it, at most 64 MiB,
  and reach their clients once written; the host goes on reading the
  agents and serving its connections. Past the bound the chats that make
  events fail; a write the journal refuses fails its chat, without a hole.
- The Agent SDK's undeclared `cancelAsyncMessage` disappears: the
  adapter refuses to withdraw a queued message (`unsupported`), and its
  test fails at the upgrade; an SDK that hands Claude Code's messages on
  otherwise, or answers its requests otherwise, fails the replays of the
  recordings.
- A machine without the Agent SDK whose core cannot get it either (no
  route to the npm registry from the machine or the core, no
  `--seed-dir` copy, `--offline` without one): a new Claude Code chat is
  refused with `sdk_unavailable`, saying what each source said, which the
  UI explains; a chat whose agent starts without it fails with it. The
  pages showing such a chat ask again after 5 minutes, a new chat at once.
  A copy that is not the pinned one (a mirror's, a seed, a cache) is
  refused, never used.
- A Codex newer than the version pinned: the adapter reads what it sends
  leniently, and the app-server refuses a request with a member or a
  value it renamed (the turn fails with its message). Moving to it is its
  schema taken and the types generated again, which the typecheck and the
  tests then hold the adapter to (spec/codex-app-server/README.md).

## Security

The desktop's core no longer listens: other local processes cannot reach
it (SECURITY.md's residual risk of the loopback port goes), and the
desktop client is the main process's word, not a cookie of the launch: the
command line's clients are browsers only. The vault:

- its master key moves from memguard's locked memory to a non-extractable
  WebCrypto key, which unlock entries open into directly and a lock
  drops: it is not kept from swap by locking, but never leaves native
  memory as bytes; the core no longer limits its core dumps for it, and
  the answer `503 memory` (memguard failing) goes;
- Argon2id is `node:crypto`'s (native, off the event loop, in Bun and in
  Electron's Node); its output lies in a buffer only until it is imported
  as the key, then is wiped;
- adding an authenticator derives the key again from that request's
  passphrase, as an extractable copy that lives for that request only, to
  wrap it for the new entry;
- WebAuthn assertions are verified by @simplewebauthn/server, with the
  checks the Go code made beyond it kept (the trusted origin, no
  cross-origin, user presence and verification, a growing counter, PRF
  required, bounded inputs).

SECURITY.md has both.

## Testing

- `backend/**/*.test.ts` (`bun test`), ported from the Go tests package by
  package; `spec/vectors` run by both.
- While both exist, yamux is tested against hashicorp/yamux
  (`backend/shared/proto/testdata/yamuxpeer`).
- `make e2e` unchanged, against each stage's executable; with the
  desktop's packages installed it also runs the desktop app's smoke test
  (`e2e/tests/desktop.spec.ts`: Playwright's Electron, the unpackaged app
  on an isolated instance, profile and home, Chromium's mock keychain):
  the UI loads from the app's origin with no TCP listener of the core
  (lsof), the local machine gets ready, a terminal runs a command, a file
  downloads, the core comes back after it is killed with the window and
  its terminal kept, and, given a code-server release
  (`E2E_CODE_SERVER_SEED`), a VS Code window loads its workbench over
  channels.
- The bridge: `desktop/src/coreBridge.test.ts` (requests, credit, cancels,
  failures, channels, with worker_threads' MessagePorts),
  `backend/hosts/electron/host.test.ts` (through a real core),
  `web/src/__tests__/transport.test.ts` (PortSocket against the core's
  side).
- Machines: `e2e/machines` boots old kernels in KVM from official cloud
  images and old C libraries in containers, and runs a payload in each
  (its README). With the Bun runtime 1.4.5 and every system call above
  (`payloads/bun-probe`), all passed on CentOS 7 (kernel
  3.10.0-1160, glibc 2.17; also on a processor without AVX), Ubuntu
  16.04 (4.4), 18.04 (4.15), 20.04 (5.4) and 24.04 (6.8), Debian 10
  (4.19), containers of glibc 2.17 to 2.28 and Alpine (musl 1.2.5 with
  `libstdc++`), and macOS. `openat2` returns ENOSYS below 5.6, where the
  agent falls back; `renameat2` works on CentOS 7's 3.10, which has it
  backported (upstream it needs 3.15).
- The TypeScript machine side on the same machines
  (`payloads/machine-node`: the TypeScript build's executable of the machine's C
  library, its node reached with `node dial` as ssh reaches it, a
  terminal of the terminal core it installs from its own copy and starts, a
  file written and read back, links refused by the system calls and the
  files feature, peer credentials, `node stop --terminal-core`): all passed
  on CentOS 7 (3.10, glibc 2.17; also without AVX, `openat2` absent and
  the fallback taken), Ubuntu 18.04 (4.15), 20.04 (5.4) and 24.04 (6.8),
  Debian 10 (4.19), the containers of glibc 2.17 to 2.28 and Alpine with
  `libstdc++` (musl), and the host (7.0); Alpine without `libstdc++` is
  refused as the probe refuses it. On Ubuntu 16.04's VM (4.4, systemd 229)
  herdr-core 0.1.21 does not start its core: `server start` runs
  `systemd-run --collect`, which systemd before 236 does not know; the Go
  machine build fails there alike, everything else passed.
- `backend/machine/**/*.test.ts` and the features' `machine*.test.ts` run
  the machine side through the wire with the kernel's own `call` and
  `open`, so its results are checked by the core's schemas;
  `backend/kernel/machines/transport/deploy.test.ts` deploys this host's
  TypeScript build as an ssh connection does, through an ssh that runs the
  remote commands locally, from a release on loopback: the manifest
  fetched by the core and the machine's download checked against it, with
  curl and with wget alone; the core's upload when the machine has no
  tool, may not download, its download fails or was tampered with on its
  path; the bounds (a stream without end, a trickle, a gzip bomb); the
  remembered failure and its expiry; the manifest downloaded by the
  machine (an ssh -W stand-in to a TLS server whose certificate a test
  authority signed) when the release is unreachable from the core, a
  certificate the core does not trust and an HTTP answer ending there
  without asking the machine, a machine that does not forward; a manifest
  whose executable is not the archive's (nothing put in place); an offline
  site's directory; no route anywhere (`build_unavailable`); the local
  install of the core's own executable; and a working directory's `.env`
  and `bunfig.toml` and `BUN_OPTIONS` reaching neither `node dial` nor
  the node. `release.test.ts` covers the manifest's sources and the
  refusal of another build's, and the uploads' sources (tampered files of
  the directory or the cache refused, a download through a proxy checked
  and cached, one load for the machines of a platform).
- The agents feature's machine side: the manifests' cases shared with the
  Go build (`internal/agent/detect/testdata`), the detector's schedule on a
  fake clock, `detect` and `resolve` through the wire against a fake
  terminal core, the sessions' cases on temporary homes with fake process
  tables and `/proc` (also run on Linux), and, in `make it`, a fake Claude
  Code in a real herdr-core followed through `detect` with its session
  (`features/agents/integration.test.ts`); the transcript vectors and the
  bounds of a read (`backend/shared/agents/transcript`).
- VS Code's machine side (`features/vscode/machine.test.ts`), through the
  wire with a stand-in for code-server run by Bun in test releases: the
  executable a request names, an upload checked against its digest before
  anything is unpacked, a release without its executable or whose Node
  does not run, the bounds, a machine's download checked (curl or wget on
  loopback) and ended with the core's interest, archives leaving the
  release refused, code-server's arguments (its socket only, no port
  proxy), start, stop, release kept for another core's pipe, the node's
  end and a hand-over, an orphan ended and a serving one adopted, a broken
  listener replaced as the socket's peer, extensions and markers, the
  bridge's socket tunnelled to the right core and taken over by the newest
  agent, the retention, and an unpack that leaves the thread free while
  another session is answered; in `make it`, with
  `E2E_CODE_SERVER_SEED`, a real code-server release uploaded, started on
  its socket only (nothing of its process group listening on TCP) and
  stopped (`features/vscode/integration.test.ts`).
- The chat host: `backend/features/chat/machine/host/*.test.ts` (a host
  in the test's process with a fake adapter, its journal's refusal and a
  journal that waits, and a host of its own process ended by the terminal
  core's signals), `backend/features/chat/machine.test.ts` (the open
  action against a fake terminal core: hosts of other builds and
  protocols, a stuck one), the agents' processes, the ACP adapter
  against a fake agent replaying `spec/vectors/chat/acp`, its events
  compared with the Go adapter's of the same scenarios, and the Codex
  adapter against a fake app-server replaying `spec/vectors/chat/codex`
  (`codex/testdata/fakeappserver.ts`, the Go fake's directives), its
  events compared with the Go adapter's golden files of every recording,
  its scenarios the Go adapter's, and the recordings and what it sends
  validated against Codex's schema (`codex/appserver.test.ts`).
- The Claude Code adapter (`backend/features/chat/machine/claude/*.test.ts`):
  the 17 recordings of `spec/vectors/chat/claude` replayed through the
  SDK against a fake Claude Code (`testdata/fakeclaude.ts`, run by Bun),
  which checks every line the adapter writes against the recording; the
  host's events, permissions, questions and chat equal the Go adapter's
  golden files of the same recordings (`replay.test.ts`). Against scripts
  of its own: the program's end with its group, lines and messages passed
  over, the timeouts, the start's options and refusals, full access by a
  restart (also closed during it), the requests not served, prompts the
  host recorded or not, trust, another Claude Code's session, titles
  (`session.test.ts`); imports and sessions from transcripts, the
  recorded one giving the Go golden file's events (`history.test.ts`);
  the SDK's seam: its version, `cancelAsyncMessage` on a real `Query`,
  the framing, the prompts, the program as the SDK sees it
  (`sdk.test.ts`). The real Claude Code never runs; homes are temporary.
- The Agent SDK's way to the machines, with tarballs the tests make and a
  registry on loopback (the real tarball is in no test: it is
  Anthropic's): the machine's store (`machine/sdkstore.test.ts`: only the
  pinned files unpacked, a tampered tarball and another entry refused
  before anything is put in place, a link leaving the directory, the
  machine's download and a failed one, the retention, the load and an
  entry changed on disk); the core and the machine through the wire
  (`sdkprovision.test.ts`: the machine's own download, asked again an
  hour later, the core's upload from its download and then its cache,
  offline from `--seed-dir`, every
  wrong copy refused with `sdk_unavailable` saying what each source said,
  a tampered cached copy refused and removed, a FIFO in a `--seed-dir`
  refused at once, a load that does not settle dropped, a failure held
  for 5 minutes but for a retry, the audit records of each source, a
  registry with credentials refused, a machine of the Go build left
  alone); the routes (`routes.test.ts`: an `sdk_unavailable` answer and
  its audit record naming URLs by origin and path); a page's
  subscriptions (`page.test.ts`: one ask per agent session, none from a
  read-only core, a failure not asked again by the next subscription); the
  machine's downloads without the user's `.curlrc` and `.wgetrc`
  (`#machine/artifacts.test.ts`, with the real tools and with stand-ins
  recording what they are given); the pin and the lockfile
  (`claudesdk.test.ts`); the host (`hosts/machine/chathost.test.ts`:
  `sdk_unavailable` before anything runs); and the development
  dependency's files packed, installed and loaded from a data directory,
  running a recording, and loaded by a `bun build --compile` executable
  (`machine/claude/installed.test.ts`).
- Program windows' machine side: the Go tests' tiles, flow, stats and
  video decisions ported (`features/gui/machine/wm.test.ts`), two cores
  through the wire with a fake GUI helper, the display's files, numbers,
  GPUs and the helper's placement (`machine.test.ts`,
  `machine/display.test.ts`); the helper's own tests (`zig build test`:
  its JPEG byte for byte the Go agent's, every malformed message refused,
  the compositor's protocol and bounds); against a real Xvfb in `make it`
  or Docker (`scripts/gui-it.sh`); and on the machines of `e2e/machines`
  (`payloads/gui`): CentOS 7's VM (3.10, glibc 2.17), Ubuntu 18.04's,
  containers of CentOS 7 and Alpine (musl), and Ubuntu 24.04 hosts with
  the GPU display and VA-API video, and a server of four NVIDIA GPUs with
  the GPU display on one of them, NVENC and gpupick
  ([14](14-gui-windows.md#testing) has the results).
- `make e2e` builds the cores of both machine builds; `E2E_MACHINE=ts`
  runs the suite against the TypeScript build (32 passed, none skipped;
  the chats' specs run with the fake ACP agent, also on an SSH machine,
  and with a fake Codex app-server, `e2e/fakecodex`, in
  `tests/chat-codex.spec.ts`: a command allowed and rejected, a turn
  stopped, the thread resumed, and none of what the host must never ask
  Codex for; `tests/gui.spec.ts` has two cores show a program window
  through the GUI helper, one controlling and the other viewing until it
  takes control, on Alpine's Xvfb; given `E2E_CODE_SERVER_SEED`, the
  desktop app's smoke test has its VS Code window installed, started and
  served by the TypeScript machine side, its workbench loaded and the
  folder listed;
  `tests/attention.spec.ts` has a fake Claude Code in a terminal draw
  attention, its session found and confirmed for a resume), and
  `tests/nodes.spec.ts` has the newer node of the other build take a node
  over in both runs.
