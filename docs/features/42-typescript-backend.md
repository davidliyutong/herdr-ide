# 42 · The backend in TypeScript

## Context

The backend is TypeScript under `backend/` ([its README](../../backend/README.md)), one language with the web UI, the desktop shell and the end-to-end tests: protocol types (agentproto, chatproto, settings) are written once, and the chat host drives Claude Code and ACP agents through their official TypeScript SDKs. Bun compiles `backend/` into one executable per platform that is both the hub and that platform's machine side. A machine still running a node of an earlier release is taken over by this build's node on the same wire protocols ([below](#wire-compatibility)).

## Goals / non-goals

Goals:

- One executable per platform (`bun build --compile`), what users run and what machines run.
- The desktop app's hub serves its windows without listening on TCP.
- Official SDKs for coding agents: Claude Code through `@anthropic-ai/claude-agent-sdk`, ACP through `@agentclientprotocol/sdk`; Codex's app-server types generated from the schema Codex prints.
- Behavior held by the unit tests, the shared vectors (`spec/vectors`) and the end-to-end tests.

Non-goals: the Linux GUI windows' X client, capture and encoding in TypeScript (a native helper, [14](14-gui-windows.md)).

## Design

### Layers and features

`backend/` has layers that import only downwards: `shared/` (wire protocols, libraries, state), `kernel/` (the hub's machinery), `machine/` (the node, the agent protocol's dispatch, system calls), `features/` (one directory per feature with its typed protocol, hub side and machine side) and `hosts/` (composition roots). The README has the rules.

Mature libraries do what they do: Hono routes (the same `Request → Response` under `Bun.serve` and the desktop bridge), zod validates input, jsonc-parser edits the hand-edited JSON files keeping comments and layout, ssh-config reads the OpenSSH configuration, execa runs processes, @simplewebauthn/server verifies WebAuthn, yazl writes zips, node-tar unpacks tarballs, re2js runs the detection rules, the official MCP SDK serves the vault's MCP server. yamux is the exception: the maintained implementation is bound to libp2p's stream framework, so `backend/shared/proto/yamux.ts` speaks hashicorp/yamux's protocol over Node streams.

### One hub executable, CLI and Desktop

The executable's command line is `backend/hosts/bun/main.ts`: `serve` on the command line, `desktop` in the desktop app, `node`, `mcp` and `chat-host` on machines. Both hub modes compose the hub alike (`backend/hosts/common/compose.ts`) and differ only in how requests reach it:

- **CLI (`serve`, `backend/hosts/bun/serve.ts`)**: `Bun.serve`, WebSocket upgrades turned into channels, the guards as they are (Host/Origin, proxy secret, read-only).
- **Desktop (`desktop`, `backend/hosts/bun/desktop.ts`)**: the Electron main process (`desktop/src/hub.ts`) spawns the same compiled executable over multiplexed stdio (`backend/hosts/desktop/mux.ts`, `bridge.ts`) and restarts it after a crash. The app's windows load `https://<slug>.localhost`, which their session intercepts (`desktop/src/protocol.ts`) and hands to the hub; channels are MessagePorts piped onto the mux (`web/src/lib/portSocket.ts` in the page). The client is the desktop because the main process says so. [architecture](../architecture.md) and [16](16-desktop-packaging.md) have the bridge.

An intercepted `https:` origin rather than a custom scheme: code-server builds its resource URLs from the page's scheme (its CSP refuses a custom one), and CacheStorage needs a secure context. A handler-answered request carries no Origin or Fetch Metadata, so the main process sets the request's Origin from Electron's `initiatorOrigin`, and the hub's guard refuses every origin but the app's (SECURITY.md).

`shared/`, `kernel/`, `hosts/common`, `hosts/desktop` and the features' hub sides use Node's modules only (`tsconfig.node.json`): the Electron shell imports the bridge and multiplexer as they are. The desktop app bundles its platform's executable and all six POSIX machine archives with `SHA256SUMS` ([16](16-desktop-packaging.md)), so desktop and CLI run the same hub and deploy the same machine builds. Terminals on the hub's host (ssh sign-in) use `Bun.Terminal`; a hub on Windows has no ssh sign-in.

### The machine side

`backend/machine` and the features' machine sides run under Bun only, on Linux and macOS:

- `backend/machine`: the node (`node.ts`: one per instance per host, `node.lock` with `flock`, `node.sock`; [39](39-nodes.md)), its clients (`dial.ts`), the agent its sessions share (`agent.ts`: a yamux server per session and the hub's ops), the dispatch of `plugin` to features (`dispatch.ts`, `feature.ts`), the terminal core (`hc.ts`, `hcop.ts`), hidden terminals, housekeeping, the vault's socket, the coding agents' sessions (`agents/`) and system calls (`sys/`).
- A feature's machine side is its `machine.ts` (and `machine/`), made with `defineMachine(protocol, start)`: `start` runs once per agent and returns the handlers; params are checked by the protocol's schemas and a thrown `Fail` is the refusal's code. A feature may also serve agent ops (`Served.ops`: the agents feature's `detect`, VS Code's `code-server`), ends what it owns with the agent (`Served.close`) and hands it to a node that takes over (`Served.handOver`).
- `backend/hosts/machine`: the commands (`cli.ts`: `node`, `node dial`, `node stop [--terminal-core]`; `mcp.ts`; `chathost.ts`) and the features the node serves (`features.ts`): files, git, search, browser, monitor, history, agents, AI usage, VS Code, chat and program windows, besides the terminal core's ops. An op or plugin it does not serve is refused `unknown_plugin`, which the hub treats as a machine without that feature.

**One thread.** The node serves every hub on one thread, so nothing a user or a mount controls is waited for on it: file reads, git's reads, the agents' sessions and housekeeping are asynchronous, and a file is opened `O_NONBLOCK` and read only when it is a regular file (a FIFO swapped in waits for no writer). SQLite runs in worker threads: the node's own databases through `backend/hosts/bun/state-worker.ts` ([38](38-sqlite-state.md)), other programs' databases (OpenCode's, Antigravity's; [29](29-ai-usage.md)) in a worker started from a Blob, so a FIFO or a dead mount at a database's name holds the worker, not the node. Tarballs (code-server's releases, the Agent SDK; `backend/machine/artifacts.ts`) are gunzipped by zlib's stream and unpacked by node-tar with asynchronous writes, so no worker is needed; an entry leaving the directory, a link pointing out or an entry of another kind refuses the whole archive, modes lose setuid, setgid and others' write bits. The files feature's changes and saves are synchronous `bun:ffi` calls: one on a mount that stopped answering stalls the node until it answers.

**System calls** Node lacks go through `bun:ffi` to libc (`machine/sys`): peer credentials, `flock`, `openat2` with `RESOLVE_NO_SYMLINKS` (falling back to the last name's `O_NOFOLLOW` below Linux 5.6 or under a seccomp filter), `O_NOFOLLOW_ANY` on macOS, renames without replacing, `sysctl` for processes on macOS. No variadic C function is called (on macOS/arm64 their arguments go on the stack): opens go through `fs.openSync`, Linux's calls without a fixed-argument wrapper through `syscall(2)` with integer arguments. The coding agents' transcripts are opened without links in the runtime's pool, the descriptor checked against `/proc/self/fd` on Linux, rather than through FFI on the node's thread. Bun's unix socket server removes its path on close, so every socket is bound under a temporary name and renamed into place (`backend/machine/sockets.ts`).

**What the node runs natively.** Program windows on Linux are split between the node (displays, GPUs, the window manager's decisions) and the GUI helper, a static Zig executable per architecture for the X client, capture, encoding, the Wayland compositor and the display keeper ([14](14-gui-windows.md)). Like the other native submodules it is built in its own repository, pinned by version and SHA-256 in `backend/scripts/deps.ts` and fetched by `backend/scripts/fetch-deps.ts`; the Linux executables carry it, and the node checks its digest before each start. Agent detection's regular expressions run on re2js ([25](25-agent-detection.md)): herdr's rules are written for RE2's semantics, in linear time.

**The vault's MCP server** is the `mcp` command of every executable, also when started by its link in the data directory's `bin` (`linkMCP`, `backend/machine/vault.ts`), on the official MCP SDK's low-level `Server` so the exact tool definitions and `-32602` refusals are kept ([30](30-variable-vault.md)).

**The executable.** `backend/scripts/build.ts` builds one per platform: linux x64 and arm64, each for glibc and musl (Alpine), darwin x64 and arm64; x64 Linux targets are baseline builds (no AVX2). A Windows build is the hub alone (the desktop app's, reaching SSH machines only). Each holds the hub with the web UI, its platform's machine side and herdr-core, which its node installs when it is the copy the build recorded (`machine/hc.json` holds every platform's digest; [21](21-terminal-core.md)), both Linux video encoders and the VS Code extension; Linux builds add the GUI helper and gpupick. With Bun 1.4.5 and herdr-core 0.1.21 an executable is about 111–131 MiB (darwin arm64 the smallest, linux glibc the largest) and its release archive 47–58 MiB; the web UI is about 20 MB of each. It is compiled without loading a `.env` or `bunfig.toml`, and the variables that would make it run other code or another program (`BUN_OPTIONS`, `BUN_BE_BUN`, `BUN_INSPECT*`, `BUN_CONFIG_*`, `backend/shared/lib/bunenv.ts`) are left out of the environment the hub starts it with and dropped by the executable itself.

**Machine builds.** A release publishes each platform's archive (`<slug>-<platform>.tar.gz`, the executable with the licenses of what it holds) and `SHA256SUMS`. A machine keeps its build at `~/.<slug>/agent/<version>/<slug>` (the version a prefix of its SHA-256). No hub carries another platform's executable (`backend/kernel/machines/transport`, `release.ts`, `ssh.ts`):

1. The manifest is the first of: the operator's directory (`--agent-dir`, offline sites), the hub's cache, the release fetched over the hub's own HTTPS (through `HTTPS_PROXY`/`NO_PROXY`). When the release is unreachable from the hub, the hub fetches it through the machine with `ssh -W` carrying the hub's own TLS (`tunnel.ts`), so the machine carries bytes it can neither read nor change; a fetch that reached something else (an untrusted certificate, an HTTP answer) ends there. A manifest that does not name the hub's own executable by its digest is another release's and refused.
2. The machine downloads its archive itself with curl, else wget, without the user's configuration and bounded in size and time, unless `machines.download` (`--machine-download`) is off for it or its download failed within the last day.
3. Else the hub uploads it over ssh from its directory, its cache, its own executable (for a machine of its platform) or its download from the release.

Every source is checked against the manifest before it is used or cached; on the machine the archive's SHA-256 is checked before unpacking and the executable's before it is renamed into place. When no source has the build the machine is refused with `build_unavailable` and what each source said, and dialed again later. A build of no release (development, end-to-end tests) gets its machines' builds from `--agent-dir` or its own executable. Builds and cached archives unused for 14 days are removed. The trust is the release's: whoever can replace its assets can replace `SHA256SUMS`; the checks protect against damage and the machine's network path. [deployment](../deployment.md) has the operator's view.

### The chat host

The chat host ([37](37-agent-chats.md)) is the `chat-host` command of the same executable (`backend/hosts/machine/chathost.ts`), which the node has the terminal core run as a hidden terminal (`backend/features/chat/machine.ts`: start, hand-over to a newer build, a stuck host killed). The host (`backend/features/chat/machine/host`) runs on one thread without locks: a chat (`chat.ts`) is a state machine whose agent calls and permissions are promises, each connection (`subscriber.ts`) a bounded queue. Its wire protocol, journal tables, log, socket and lock are shared across releases, so a newer build's host takes over with the chats.

The journal is SQLite in a worker thread (`journal.ts`, which opens, migrates and serves it), because a write that waits (a dead network mount, a slow sync) would otherwise stop every chat's output and connection. Invariant: a chat's events reach its connections only once stored, in the order made, and the worker refuses an append unless the chat already has the event before it, so a failed write fails the chat and the log never has a hole. Stored events waiting for the journal are bounded (64 MiB); past that the chats that make more fail.

Every process the host and its adapters start goes through `AgentProcesses` (`features/chat/machine/agentproc.ts`): a process group of its own, the end of its standard error kept, ended gracefully (input closed, SIGTERM, then SIGKILL to the group).

The adapters implement `features/chat/machine/adapter.ts` and are given to the host by name (`chatAdapters`, `backend/hosts/machine/features.ts`):

- **ACP** (`machine/acp`) on `@agentclientprotocol/sdk`, pinned. Notifications are taken out of the stream before the SDK sees them and handed on synchronously in the agent's order: the SDK's client drops updates its stable schema refuses and dispatches asynchronously, which would let a turn's answer overtake its last updates.
- **Codex** (`machine/codex`) on the app-server's JSON-RPC, typed by `appserver.gen.ts`, generated by `backend/scripts/codex-schema.ts` from the pinned schema in `spec/codex-app-server` (its README says how to move versions; `make check` fails when the types are not what the schema makes). The framing is its own (`rpc.ts`): Codex omits the `jsonrpc` member that the general libraries require. Messages are read leniently; calls that start or steer a turn hold the session's lock, one at a time.
- **Claude Code** (`machine/claude`) on Anthropic's Agent SDK, fetched by the machines when a chat needs it ([Claude Code](#claude-code)).

### Wire compatibility

agentproto, herdr-core's protocol, the chat host's protocol and yamux (hashicorp/yamux's semantics) stay wire-compatible across releases. A machine running a node of an earlier release gets this build when a hub connects, and its node takes over on the same node protocol, socket and lock ([39](39-nodes.md)); databases and files of earlier releases (the terminal history's and chat host's databases, AI usage's cost cache, the vault's link) are read as they are.

### HTTP and file conventions

- A refused request answers JSON `{error, message}` with a code; read-only mode refuses `read_only`; a body over a route's limit answers 413 `too_large`.
- A feature that is off answers `plugin_disabled` before read-only mode answers `read_only`; an unknown machine answers 404 before either.
- Every audit record of a change carries `status` and, when it failed, `error` (the code).
- The settings and keybindings files are JSONC; a change from the UI rewrites only what changed, keeping comments and layout.
- A streamed download has no `Content-Length`: progress comes over `/ws`, and a download that breaks off fails in the browser instead of ending short.
- The hub logs only its own failures (500), not a machine's or a program's (502–504).

### Building and testing the hub

`backend/scripts/build.ts` packs the payloads (web UI, release record, herdr-core digests, encoders, extension) into one tar archive and compiles `backend/hosts/bun/main.ts` and the state workers' entry points with it embedded; the hub reads it with `Bun.Archive`. It refuses an executable that holds the Agent SDK's code. `scripts/build.sh` builds every platform into `dist/release/`; `scripts/e2e.sh` builds the host's and Docker's Linux executables into a directory with `SHA256SUMS`, which the end-to-end hubs take as `--agent-dir`. The reference and registry checks (`backend/scripts/reference.ts`, `registry.ts`) read the hub composed as `serve` composes it.

### Claude Code

The adapter runs each session as a `query()` of `@anthropic-ai/claude-agent-sdk` with the user's own `claude` (`pathToClaudeCodeExecutable`, the host's command for the kind), `import()`ed at run time from the machine's data directory. The SDK writes the command line and protocol, pairs control requests with answers and hands the program's messages on in order; the adapter gives it:

- the `claude_code` system prompt preset, `settingSources` (`project` and `local` only in a trusted folder), the permission mode, and `allowDangerouslySkipPermissions` only for full access, which restarts the program on the same session;
- the host's environment with `CLAUDE_CODE_ENTRYPOINT=<slug>` (so the sessions show in the terminal's `/resume`) and without `DEBUG` and `DEBUG_CLAUDE_AGENT_SDK`, which would start Claude Code in its debug mode;
- `spawnClaudeCodeProcess` (`sdk.ts`): the program runs through `AgentProcesses`, and its output is framed before the SDK reads it: an over-long line is passed over (the SDK's reader has no bound), and host-only `session_state_changed` messages lose their mark so the SDK hands them on in their place;
- `canUseTool` for permissions, questions and plans, asked of the host on the next turn of the event loop so the host has the tool call's event first.

`interrupt`, `setModel`, `setPermissionMode`, `applyFlagSettings` and `getContextUsage` are the SDK's, each bounded by the adapter (the SDK waits without end). Withdrawing a queued message uses the SDK's undeclared `cancelAsyncMessage` through a wrapper that refuses `unsupported` when it is gone. The adapter keeps the mapping to events (`backend/shared/agents/transcript`), turns and queues, Claude Code's folder trust, sessions and imports.

**Fetched, not shipped.** The SDK's license reserves all rights and the product is MIT, so no executable, archive or app carries it: `features/chat/claudesdk.ts` pins the registry tarball (version, URL, the lockfile's integrity, the SHA-256 of its entry `sdk.mjs`, which imports Node's modules only). `backend/package.json` has it as a development dependency for types and tests; outside tests only its types are imported (`scripts/check.sh`). Before a request that starts a Claude Code chat (and, without waiting, a page's subscription to one), the hub makes sure the machine has it (`features/chat/sdkprovision.ts`; a read-only hub asks nothing):

1. the machine side's `sdk` action reports whether the pinned version is installed and, unless the hub is `--offline`, downloads it itself (curl or wget, `backend/machine/artifacts.ts`);
2. else the hub uploads it (`sdkUpload`) from a `--seed-dir`, its cache (`~/.veldr/cache/npm`) or its own download from the registry;
3. every copy is checked against the pinned integrity before it is used, cached or unpacked; the machine unpacks only the package's four files into `<data>/claude-agent-sdk/<version>`, which counts once the entry's SHA-256 is the pinned one.

The chat host loads it from there (`machine/claude/load.ts`), checking the entry's SHA-256 again; versions unused for 14 days go. A machine that cannot get it refuses the chat `sdk_unavailable`, saying what each source said; a page's asks then hold that failure on the agent session for a while, while a new chat asks again. Each install is audited as `chat.sdk_install`. `--npm-registry` (like `--code-server-url`) may hold no credentials, since machines get the URL on their command lines; URLs in errors and logs show origin and path only (`shared/lib/urls.ts`). A node of an earlier release without the `sdk` action is left alone. Anthropic's terms govern the user's use of the SDK and their Claude account.

## Alternatives considered

- **A separate Go machine side.** Smaller uploads (about 16 MB), but the chat host and its adapters in a second language and the protocol types duplicated.
- **The Bun runtime and a bundle of the machine side apart.** Smaller updates, but a launcher script, two pinned downloads and two files to check per node.
- **A machine executable apart from the hub.** About 30 MB smaller, but two programs per platform, and a hub could not carry digests of executables built from the same release.
- **Every platform's executable in each hub.** About 300 MB more per hub and app; the release serves them.
- **The machine's own download of the manifest.** Could not be told from an attacker's on its path (BusyBox's wget may not verify certificates); the hub fetches it through the machine with its own TLS instead.
- **A signed manifest.** Would hold builds to a maintainers' key rather than the GitHub release; nothing in the checks changes if it is added.
- **Bare executables as release assets.** One more file per platform, without the licenses.
- **JavaScript's RegExp for the detection rules.** Reads RE2's rules otherwise (`\s`, case folding, `\A`) and backtracks; re2js keeps RE2's semantics in linear time.
- **The chat journal on the host's thread.** A write that waits would stop every chat; in a worker it holds stored events only.
- **The Agent SDK in the executable, or from the machine's npm.** Its license forbids the first; machines have no npm, and the user's npm configuration would choose the source.
- **A hand-written Claude Code client, or Claude Code's messages read beside the SDK.** The SDK follows Claude Code's releases; reading beside it decodes everything twice.
- **Codex's own TypeScript (`generate-ts`) or json-schema-to-typescript.** Hundreds of files needing rewriting, or a dependency tree; one schema file kept verbatim and checked is simpler.
- **A JSON-RPC library for Codex.** They require or add the `jsonrpc` member Codex omits.
- **A custom scheme for the desktop's origin.** Breaks code-server's resources and CacheStorage.
- **A loopback listener for VS Code in the desktop app.** Not needed: code-server's frames get a channel-backed WebSocket.
- **The GUI capture in TypeScript.** Native work at frame rate; the `x11` package lacks MIT-SHM and X-Resource ([14](14-gui-windows.md)).

## Failure modes

- A processor Bun cannot run on (x86-64 without SSE4.2, such as QEMU's `qemu64`) or musl without `libstdc++` and `libgcc` → refused `cpu_unsupported` or `libs_missing`. Kernels and C libraries as old as CentOS 7's (3.10, glibc 2.17) run it.
- No source has a machine's build (an offline site without `--agent-dir`) → `build_unavailable` with what each source said ([09](09-air-gapped-installs.md)).
- The release unreachable from the hub and the machine's sshd forbids forwarding (`AllowTcpForwarding no`) → `build_unavailable`; give the hub a route or use `--agent-dir`.
- No `openat2` (Linux below 5.6, or filtered) → only the last name of a path is refused as a link.
- systemd before 236 (Ubuntu 16.04) → herdr-core's `server start` fails (`systemd-run --collect`); the rest works.
- The chat journal stops answering → stored events wait (bounded), the host keeps reading agents and serving; past the bound, chats fail without a hole.
- The SDK's `cancelAsyncMessage` disappears → withdrawing a queued message answers `unsupported`, and `sdk.test.ts` fails at the upgrade.
- No Agent SDK for a machine → new Claude Code chats are refused `sdk_unavailable`; a copy that is not the pinned one is never used.
- A Codex newer than the pinned schema → read leniently; a request it renamed fails its turn with Codex's message.

## Security

The desktop's hub does not listen on TCP: other local processes cannot reach it, and the desktop client is identified by the main process rather than a launch cookie; the command line's clients are browsers only. The vault:

- its master key is a non-extractable WebCrypto key, which unlock entries open into directly and a lock drops: it is not kept from swap, but never leaves native memory as bytes, and the hub does not limit its core dumps for it;
- Argon2id is `node:crypto`'s (native, off the event loop); its output lies in a buffer only until it is imported as the key, then is wiped;
- adding an authenticator derives the key again from that request's passphrase, as an extractable copy that lives for that request only;
- WebAuthn assertions are verified by @simplewebauthn/server plus the hub's checks (trusted origin, no cross-origin, user presence and verification, a growing counter, PRF required, bounded inputs).

SECURITY.md has both.

## Testing

- `backend/**/*.test.ts` (`bun test`), with the vectors of `spec/vectors`; machine sides run through the wire with the kernel's own `call` and `open` (`#machine/testing.ts`).
- Deployment: `backend/kernel/machines/transport/deploy.test.ts` deploys this host's build through an ssh that runs commands locally, from a release on loopback (sources, bounds, tampering, the `ssh -W` manifest, offline directories, `.env`/`bunfig.toml`/`BUN_OPTIONS` kept out); `release.test.ts` the manifest's and uploads' sources.
- The desktop bridge: `desktop/src/hubBridge.test.ts`, `backend/hosts/desktop/host.test.ts`, `web/src/__tests__/transport.test.ts`; `e2e/tests/desktop.spec.ts` runs the app with no TCP listener of the hub.
- Chat: `backend/features/chat/machine/host/*.test.ts`, `machine.test.ts`; adapters replay `spec/vectors/chat/{acp,codex,claude}` against fakes and compare with `testdata/golden` (`codex/appserver.test.ts` validates against Codex's schema; `claude/replay.test.ts`, `sdk.test.ts`, `installed.test.ts` loading the SDK from a data directory and a compiled executable); the SDK's provisioning in `machine/sdkstore.test.ts` and `sdkprovision.test.ts` with tarballs the tests make.
- VS Code's machine side: `features/vscode/machine.test.ts`; with `E2E_CODE_SERVER_SEED`, `features/vscode/integration.test.ts` in `make it`.
- Program windows: `features/gui/machine/*.test.ts`, `scripts/gui-it.sh`, `e2e/tests/gui.spec.ts`.
- Old systems: `e2e/machines` ([its README](../../e2e/machines/README.md)) boots old kernels and C libraries (CentOS 7 through current, Alpine's musl) and runs `payloads/bun-probe`, `payloads/machine-node` and `payloads/gui`.
- `make e2e` (`e2e/tests/chat-codex.spec.ts`, `attention.spec.ts`), and `e2e/tests/nodes.spec.ts` has a newer node take a node over.
