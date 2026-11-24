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
node-pty gives the desktop's core a terminal for an ssh login. yamux is
the exception: the maintained implementation (`@chainsafe/libp2p-yamux`)
is bound to libp2p's stream framework; ours is a few hundred lines over
Node streams, tested against hashicorp/yamux.

### One core, two hosts

`backend/shared` and `backend/kernel`, and the core side of every feature,
use Node's modules only, so the same core runs under Bun (the command
line) and in Electron's Node (the desktop app); `tsconfig.node.json`
typechecks them with Node's types only. Requests are handled as
`Request → Response`; WebSockets are `Channel`s of text and binary
messages.

- **Bun** (`backend/hosts/bun`): `Bun.serve`, its WebSocket upgrades
  turned into channels; the guards stay as they are (Host/Origin, proxy
  secret, read-only).
- **Electron** (`backend/hosts/electron`): the core runs in a
  `utilityProcess` (a crash leaves the window, heavy work does not block
  it). The window's partition intercepts the origin
  `https://<slug>.localhost` with `protocol.handle('https')` and hands each
  request to the utility process over a `MessageChannelMain`, bodies
  streamed in chunks with credit both ways; requests to other hosts pass
  through. WebSockets are MessagePorts the main process brokers
  (`desktopShell.openChannel`). The client is the desktop because the main
  process says so, not by a cookie.

The intercepted `https:` origin rather than a custom scheme: code-server
builds its resource URLs from the page's scheme, and on a custom one its
own CSP refuses them (no grammars, icons or themes); CacheStorage and
cookies need it too. code-server's frames get a WebSocket that tunnels
over a MessagePort, installed into their main world by the preload
(`contextBridge.executeInMainWorld`), so VS Code needs no listener either.
Uploads from the desktop use `fetch` with a streamed body (an XHR's body is
buffered and reports no progress through a protocol handler). The
handler's responses are not decoded by Chromium, so proxied requests ask
for `identity`.

### The machine side

`backend/machine` and the machine side of features run under Bun only, on
Linux and macOS. System calls
Node lacks go through `bun:ffi` to libc: peer credentials of unix sockets
(`SO_PEERCRED`; `LOCAL_PEERCRED`, `LOCAL_PEERPID`), `flock`, `openat2`
with `RESOLVE_NO_SYMLINKS` (falling back as before on ENOSYS),
`renameat2`/`renamex_np`, `unlinkat`, `sysctl` for processes on macOS.
Variadic C functions are not called through FFI (on macOS/arm64 their
arguments go on the stack): files are opened with `fs.openSync`, which
passes flags such as `O_NOFOLLOW_ANY` through, and a database is known to
be unheld when a connection in `locking_mode = EXCLUSIVE` gets its lock
without waiting, instead of a byte-range lock (`BEGIN EXCLUSIVE` alone
takes only the write-ahead log's lock and misses an idle reader). SQLite's
calls are synchronous in both runtimes: a database's busy timeout blocks
the thread that waits, so the core keeps them short. A new session for a child is `detached: true`; a group
is killed with `process.kill(-pgid)`.

A machine gets two files: the Bun runtime, kept by its digest under the
data directory and uploaded once, and the bundle of the machine side, a
few megabytes per build; a launcher script runs one with the other, so
command lines (`node dial`, `chat-host`, `mcp`) stay as they are. The core
embeds the runtimes of linux x64 (baseline), linux arm64, darwin x64 and
darwin arm64; the musl runtimes are fetched when a machine needs one and
checked against pinned digests (they need `libstdc++` and `libgcc`, which
the probe reports when missing). Runtimes unused for 14 days are removed,
as builds are.

### Wire compatibility while both exist

yamux (`backend/shared/proto/yamux.ts`) speaks hashicorp/yamux's protocol with
its semantics (a close is a half-close; window, keepalive and backlog as
`agentproto.YamuxConfig`), and agentproto, herdr-core's protocol and the
chat host's protocol keep their wire forms, so a TypeScript core serves Go
machine builds and the other way round. The stages: shared libraries;
the core in TypeScript with the Go machine builds; the desktop app's core
in process; the machine side in TypeScript; the Go program removed.

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
builds, herdr-core, the VS Code extension) into one tar archive and
compiles `backend/hosts/bun/main.ts` with it embedded (`bun build
--compile`); the core reads it with `Bun.Archive`, keeping the UI's files
in memory and reading a machine build when a machine needs one.
`E2E_CORE=ts scripts/e2e.sh` runs the end-to-end tests against that
executable, with the Go machine builds while machines run them.

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
  6.5 MB compressed; a Bun runtime 89–107 MB, about 40 MB with zstd), but
  the chat host and its adapters would stay in Go and the types twice.
  The runtime uploaded once per Bun version keeps updates small.
- **A loopback listener for VS Code only.** Not needed: the tunnel works.
- **A custom scheme for the desktop's origin.** Breaks code-server's
  resources and CacheStorage.
- **The GUI capture in TypeScript.** An X11 window manager, a Wayland
  compositor, shared memory and JPEG at frame rate are native work.

## Failure modes

- A machine Bun cannot run on: an x86-64 processor without SSE4.2 (Bun
  stops with "this CPU is missing SSE4.2 support"; a VM given QEMU's
  default model qemu64 is one), or musl without `libstdc++` and `libgcc`.
  The probe reports it and the machine is refused with a code, as an
  unknown platform is today. Kernels and C libraries as old as CentOS 7's
  (3.10, glibc 2.17) run it (Testing).
- A Bun runtime missing on the core's host for a platform (a musl machine
  without network on the core's host): the machine is refused with a code.
- The SDK's undeclared `cancelAsyncMessage` disappears: its test fails at
  the upgrade.

## Security

The desktop's core no longer listens: other local processes cannot reach
it (SECURITY.md's residual risk of the loopback port goes). The vault:

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

These go into SECURITY.md with the stage that makes the TypeScript core
the one that ships.

## Testing

- `backend/**/*.test.ts` (`bun test`), ported from the Go tests package by
  package; `spec/vectors` run by both.
- While both exist, yamux is tested against hashicorp/yamux
  (`backend/shared/proto/testdata/yamuxpeer`).
- `make e2e` unchanged, against each stage's executable; a Playwright
  smoke test of the desktop app.
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
