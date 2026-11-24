# backend

The core and the machine agent in TypeScript. Bun runs it on machines and
as the command line, built into one executable; the desktop app runs the
core inside Electron, whose runtime is Node. It replaces the Go program
(`cmd/veldr`, `internal/`) in stages
([42](../docs/features/42-typescript-backend.md)): it speaks the same wire
protocols, so either side runs with the other's build meanwhile. It is not
a translation of the Go packages: their layout is not kept.

## Layers

Each layer imports only from the layers above it in this list.

| Directory   | Runs in      | What                                                                                                                                                   |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `shared/`   | Bun and Node | wire protocols (`proto/`), libraries (`lib/`), SQLite state (`store/`), the host's directories and ids (`host/`), the coding agents' kinds (`agents/`) |
| `kernel/`   | Bun and Node | the core's machinery, no feature: HTTP routing and guards, channels, machines and their connections, settings, events, audit, the feature contract     |
| `machine/`  | Bun          | the machine's machinery: the node and its sessions, the dispatch of the agent protocol to features, system calls (`sys/`), the terminal core           |
| `features/` | per side     | everything the product does, one directory per feature (below)                                                                                         |
| `hosts/`    | Bun / Node   | composition roots: `bun/` the command line and `Bun.serve`; `electron/` the core in the desktop app's utility process                                  |

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
- `machine.ts` — the handlers of its protocol's actions on the machine.
- its own modules, tests and `testdata/`.

The web UI's side stays in `web/src/plugins/<id>`. Whether a feature can be
switched off is a property of its definition, not a different kind of
code.

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
  `hosts/bun/`, `machine.ts` files and tests.
- JSON on the wire keeps its member names. A Go field with `omitempty` is
  an optional field, left out when empty; times are written with
  `formatRFC3339` (`#shared/lib/gotime.ts`); bytes are base64.
- Streams: read headers with `Reader` (`#shared/lib/streamio.ts`) and hand
  the rest on with `release()`. Do not leave a `for await` loop over a
  stream early, or let one run to the end of a stream you still write to:
  it destroys the stream (for a yamux stream, a reset).
- Product names come from `#shared/lib/brand.ts`; comments, logs and
  identifiers are English; the server returns codes, not prose.
- Tests are `<name>.test.ts` beside the code (`bun:test`); vectors in
  `spec/vectors/` are read by both languages while both exist.

## Commands

`pnpm test` (`bun test`), `pnpm typecheck`, `pnpm format`; `make test` and
`make check` run them with the rest of the repository.
