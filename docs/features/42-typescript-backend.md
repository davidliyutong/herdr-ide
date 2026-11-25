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
- The Linux GUI windows' capture in TypeScript: it becomes a native helper
  (Zig/C, like the video encoder), driven over stdio by the agent.

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
the agent detection rules' regular expressions on machines (below). yamux
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
  per session, the core's ops `hello`, `fs.*`, `fs.archive`, `dial-unix`,
  `hc`, `hc-api`, `privacy` and `plugin`), the dispatch of `plugin` to the
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
  which the core opens as an op of its own); an op no feature serves is
  refused as an unknown plugin.
- `backend/hosts/machine`: the machine side's commands (`cli.ts`: `node`,
  `node dial`, `node stop [--terminal-core]`, with the Go build's flags),
  which the one command line (`backend/hosts/bun/main.ts`) runs, and the
  features its node serves (`features.ts`). The executable is the core's
  too; the layers keep apart what runs where (Bun's APIs only on the
  machine side and the command line's host, Node's modules only in what
  the desktop app's core runs: backend/README.md).

It serves the machine sides of the terminals (the terminal core and hidden
terminals), files, git, search, monitor, history, browser, AI usage and
agents (detection and the agents' sessions) features. The ops and plugins
of the features it does not serve yet (chat, gui, vscode: `code-server`,
`gui`) are refused as an unknown plugin is (`unknown_plugin`); the core
treats them as a machine without that feature. AI usage's `session`
action finds a session's transcripts with the coding agents' sessions
(`backend/machine/agents`), as the Go build's does
([29](29-ai-usage.md#one-sessions-usage)).

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
which the chat host will use, against the shared vectors.

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

(without the video encoder, about 2 MB more on Linux; the web UI is about
20 MB of each)

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
the specs of the features it does not serve yet skipped with the reason,
and `tests/nodes.spec.ts` has a newer node of the other build take a node
over.

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

The adapter calls `query()` of `@anthropic-ai/claude-agent-sdk`, pinned
exactly, with the user's own `claude` (`pathToClaudeCodeExecutable`):

- `systemPrompt: {type: 'preset', preset: 'claude_code'}` (without it the
  SDK replaces Claude Code's prompt with an empty one);
- `settingSources` and `permissionMode` always given; the environment
  keeps `CLAUDE_CODE_ENTRYPOINT=<slug>` so the sessions show in the
  terminal's `/resume`;
- `spawnClaudeCodeProcess` starts the process in a group of its own, kills
  the group, keeps the tail of its standard error and reads the
  `session_state_changed` frames the SDK does not pass on;
- `canUseTool` answers permissions, questions and plan approvals;
  `interrupt`, `setModel`, `setPermissionMode`, `applyFlagSettings`,
  `getContextUsage` are the SDK's; withdrawing one queued message uses the
  SDK's `cancelAsyncMessage`, which its types do not declare, behind a
  wrapper whose test fails when it disappears.

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
- **The sessions' strict opens through FFI on Linux** (`openat2`,
  `openat` relative to a directory). Synchronous on the node's one thread,
  where a home on a mount that stopped answering would stall every core;
  opening in the runtime's pool and checking the descriptor's path in
  `/proc/self/fd` gives the same refusal without waiting on it.
- **A loopback listener for VS Code only.** Not needed: the tunnel works.
- **A custom scheme for the desktop's origin.** Breaks code-server's
  resources and CacheStorage.
- **The GUI capture in TypeScript.** An X11 window manager, a Wayland
  compositor, shared memory and JPEG at frame rate are native work.

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
- The SDK's undeclared `cancelAsyncMessage` disappears: its test fails at
  the upgrade.

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
- `make e2e` builds the cores of both machine builds; `E2E_MACHINE=ts`
  runs the suite against the TypeScript build (22 passed, the specs of
  chats and program windows skipped with the reason;
  `tests/attention.spec.ts` has a fake Claude Code in a terminal draw
  attention, its session found and confirmed for a resume), and
  `tests/nodes.spec.ts` has the newer node of the other build take a node
  over in both runs.
