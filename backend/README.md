# backend

The core and the machine agent in TypeScript. Bun runs it on machines and
as the command line, built into one executable; the desktop app runs the
core inside Electron, whose runtime is Node. It replaced the Go program of
earlier releases ([42](../docs/features/42-typescript-backend.md)):
machines run the machine side here (`machine/`, `hosts/machine`, the
features' `machine.ts`), which serves every feature
(terminals, files, git, search, monitor, history, browser,
agents, AI usage, VS Code, chats: the chat host, `chat-host`, with its
adapters' interface, the ACP adapter, Codex's and Claude Code's, on
Anthropic's Agent SDK, which machines fetch on use and no executable
carries, program windows with the native GUI helper of `scripts/gui-helper`)
and the vault's MCP server (`mcp`, which every executable serves).
It speaks the Go program's wire protocols, and a node of this build takes
over from a Go node still running on a machine. It is not a translation
of the Go packages: their layout was not kept.

## Layers

Each layer imports only from the layers above it in this list.

| Directory   | Runs in      | What                                                                                                                                                                                                                                                                                                                            |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`   | Bun and Node | wire protocols (`proto/`), libraries (`lib/`), SQLite state (`store/`), the host's directories and ids (`host/`), the coding agents' kinds and Claude Code's transcripts (`agents/`)                                                                                                                                            |
| `kernel/`   | Bun and Node | the core's machinery, no feature: HTTP routing and guards, channels, machines and their connections, settings, events, audit, the feature contract                                                                                                                                                                              |
| `machine/`  | Bun          | the machine's machinery: the node and its sessions, the dispatch of the agent protocol to features, system calls (`sys/`), the terminal core, the coding agents' sessions (`agents/`)                                                                                                                                           |
| `features/` | per side     | everything the product does, one directory per feature (below)                                                                                                                                                                                                                                                                  |
| `hosts/`    | Bun / Node   | composition roots: `common/` what both compose; `bun/` the command line and `Bun.serve`; `electron/` the core in the desktop app's utility process, served over MessagePorts; `machine/` the machine side's commands (`cli.ts`: `node`; `mcp.ts`: `mcp`; run by `bun/main.ts`) and the features its node serves (`features.ts`) |

`tsconfig.node.json` typechecks what runs in Node with Node's types only,
so a Bun API there does not compile; `tsconfig.bun.json` typechecks the
rest. Imports across directories use the package's aliases (`#shared/…`,
`#kernel/…`, `#machine/…`, `#features/…`); within a directory, relative
paths.

## Features

A feature is a vertical slice: terminals, files, VS Code, program windows,
git, search, the system monitor, terminal history, AI usage, the vault,
chats, agent detection, the browser pane. Its directory holds

- `protocol.ts` — the actions its machine side serves, typed: names,
  parameters, results, whether they stream (`defineProtocol`); both sides
  import it. On the wire an action is the agent protocol's `plugin` op, as
  before.
- `core.ts` — `defineFeature`: its routes, channels, background services,
  settings, the streams agents open towards the core; it gets a
  `FeatureContext` with what it may use (machines, settings, broadcast to
  the pages, audit, logger, read-only), never the whole core.
- `machine.ts` — the handlers of its protocol's actions on the machine:
  `defineMachine(protocol, start)` (`#machine/feature.ts`), where `start`
  runs once per agent and returns the handlers, which keep what the
  feature shares between requests (a limit on searches at once), and the
  ops of the agent protocol it serves besides (`ops`: the agents feature's
  `detect`, VS Code's `code-server`), what it ends with the agent
  (`close`) and hands to a node that takes over (`handOver`); it sees the
  agent's sessions (`env.sessions()`, an action's own `ctx.session`: their
  pipes per socket, a stream towards their core);
  params come checked by the protocol's schemas, a `Fail` thrown is the
  refusal's code, an action that does not stream ends with the core's
  interest (`ctx.signal`); its own modules in `machine/`. Exported as a
  factory (`gitMachine(opts)`) whose options are timeouts and limits with
  defaults that tests override. `hosts/machine/features.ts` lists the ones
  the machine build serves; tests run them through the wire with the
  kernel's own `call` and `open` (`#machine/testing.ts` `rig`, `machineOf`).
- its own modules, tests and `testdata/`.

The web UI's side stays in `web/src/plugins/<id>`. Whether a feature can be
switched off is a property of its definition, not a different kind of
code.

A feature is exported as a factory (`machinesFeature(opts)`) whose options
are what it needs from outside the kernel: the host's capabilities (a
terminal on the core's host, `kernel/pty.ts`), paths, another feature's
hook. The host composes them; features do not import each other.

## The kernel

- `core.ts` — `createCore` sets the features up and gives the host
  `fetch(Request, Peer) → Response` and `run(signal)`. A feature's routes
  are registered one by one behind its switch (404 `plugin_disabled` while
  it is off for the requesting client) and, under `:id`, the machine's
  resolution; prefixes are shared, so a feature's middleware never reaches
  another's routes.
- `http/` — Hono with the guards (`guard.ts`: Host/Origin, proxy secret,
  CSP), `Fail` → `{error, message}`, `mutating(event)` (read-only refusal,
  then an audit record with the path's parameters, what the handler put in
  `c.var.audit`, the status and the error code), `jsonBody(schema)`, the
  web UI's files (`static.ts`). `env.ts` is what a host hands in (`Peer`:
  the remote address, whether the request is the desktop app's, how to
  upgrade it to a channel) and what the middleware works out (`client`,
  `sameHost`, `trustedOrigin`, `who`).
- `channel.ts` — a WebSocket as the core sees it: text and binary
  messages, `buffered` for backpressure; Bun's WebSocket or a MessagePort.
- `pages.ts` — the pages on `/ws`: what each gets when it connects
  (`onOpen`), messages dispatched by type (`on`), `broadcast`.
- `machines/` — the machines file (`registry.ts`), one machine's
  connection loop (`machine.ts`), the manager, the transports that reach
  the agents (`transport/`).
- `agent.ts` — calling a feature's action on a machine: params and result
  validated by the protocol's schemas, large ones as bodies.
- `payloads.ts` — what the core carries for others (the UI, machine
  builds, herdr-core, the VS Code extension); `hosts/bun` reads them from
  a tar archive embedded in its executable (`scripts/build.ts`).

## Rules

- Errors are thrown as `Fail(code, status?, message?)`; the router answers
  `{error: code, message}` and audits the code. Handlers do not write error
  responses themselves.
- Input is validated where it enters (an HTTP body, an agent's params, a
  file a user edits) by the schema next to its type; past that, types are
  trusted.
- No module-level mutable state for configuration: timeouts, paths and
  clocks are parameters with defaults, which tests override.
- Everything started has an owner and an end: services take an
  `AbortSignal`, and what they start ends with it (rule 6 of AGENTS.md).
- Code under `shared/`, `kernel/` and the `core.ts` of features uses
  Node's modules only (`node:fs`, `node:net`, `node:child_process`,
  `node:sqlite`, `node:crypto`); `Bun.*` and `bun:*` only in `machine/`,
  `hosts/bun/`, `hosts/machine/`, the features' `machine.ts` and
  `machine/`, and tests (`scripts/check.sh` fails otherwise).
- System calls Node lacks go through `machine/sys` (`bun:ffi`), never a
  variadic C function (on macOS/arm64 their arguments go on the stack);
  on Linux, `syscall(2)` with integer arguments only.
- JSON on the wire keeps its member names. A field the Go program wrote
  with `omitempty` is an optional field, left out when empty; times are written with
  `formatRFC3339` (`#shared/lib/gotime.ts`); bytes are base64.
- Streams: read headers with `Reader` (`#shared/lib/streamio.ts`) and hand
  the rest on with `release()`. Do not leave a `for await` loop over a
  stream early, or let one run to the end of a stream you still write to:
  it destroys the stream (for a yamux stream, a reset).
- Product names come from `#shared/lib/brand.ts`; comments, logs and
  identifiers are English; the server returns codes, not prose.
- Tests are `<name>.test.ts` beside the code (`bun:test`); vectors in
  `spec/vectors/` are read by the web UI's tests too.

## Commands

`pnpm test` (`bun test`), `pnpm typecheck`, `pnpm format`; `make test` and
`make check` run them with the rest of the repository.

`bun scripts/build.ts --out FILE --web ../web/dist --hc DIR --ext DIR
--encoder DIR [--release-url URL] [--target bun-linux-x64-baseline]
[--version V]` builds the core's executable: the core and the machine side of its platform (`hosts/machine/cli.ts`'s `node`
commands), with that platform's herdr-core of `--hc` embedded and the
digests of all of them recorded, and the release's download URL from which
machines get their platform's archive
(`kernel/machines/transport/release.ts`). `--hc` holds the pinned
herdr-core of each platform (`scripts/fetch-hc.ts`, `scripts/hcdist.ts`).
`scripts/build.sh` (`make build`)
runs it for each platform with everything it embeds staged in
`dist/payload`, and `scripts/e2e.sh` (`make e2e`) runs the end-to-end
tests against it. `make dev-core` builds this host's
executable, stages it in `dist/payload` and runs the core from its sources
(`bun hosts/bun/main.ts`), which reads the payloads from `dist/payload`.
