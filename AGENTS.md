# AGENTS.md

Instructions for coding agents (and humans) changing this repository. Read
[docs/architecture.md](docs/architecture.md) and the relevant
[feature design document](docs/features/README.md) before non-trivial
changes.

## What this is

The core (`backend/`, TypeScript, built with Bun into one executable per
platform; [its README](backend/README.md)) serves a React terminal UI and
reaches several machines over ssh through a per-machine agent: the machine
side in TypeScript ([42](docs/features/42-typescript-backend.md):
`backend/machine`, `backend/hosts/machine` and the features' `machine.ts`),
its command `node` serving the core's protocol. Each platform's executable
is the core and that platform's machine side (the machine build); a machine
downloads its platform's release archive from GitHub
(`<slug>-<platform>.tar.gz`, checked against the release's `SHA256SUMS`), or
the core uploads it. Every machine's terminals live in a terminal core of
the agent's own (herdr-core, `hc`, in a session apart from the user's); the
browser emulates them with Ghostty's libghostty-vt as WebAssembly through
the core's terminal protocol (`/api/v1/term`), and an Electron desktop app
(`desktop/`) wraps the same UI and a core of its own on macOS, Windows and
Linux. The agent runs on Linux and macOS only, so a core on Windows reaches
SSH machines only. code-server provides VS Code panels. A chat host on each
machine (the command `chat-host`, a hidden terminal of that terminal core)
runs coding agents headless for the chat panes, its state in SQLite
(`backend/shared/store`). The core's executable embeds the UI, its
platform's herdr-core (with the digests of every platform's) and, on Linux,
video encoder, and a VS Code extension. Earlier releases had a machine
side in Go; it was removed, and a node of this build takes over from a Go
node still running on a machine
([42](docs/features/42-typescript-backend.md)).

## Commands

| Task | Command |
| --- | --- |
| Install JS deps | `make deps` |
| Unit tests (the core's `bun test`, web, desktop) | `make test` |
| The core's tests that wait on real time for what runs in the background (marked `slow`/`slowDescribe` from `backend/shared/testdata/slow.ts`, skipped by `make test`; CI runs them) | `make test-slow` |
| All checks (tsc, prettier, no import cycles among the web UI's modules, brand/doc/README consistency, the core's flags and routes in `docs/reference.md` (`backend/scripts/reference.ts`), generated tokens and registry, the terminal emulator's digest, the GPU selection library's digests, shared test vectors run by the web tests) | `make check` |
| Regenerate the design tokens' CSS after editing `spec/tokens.json` (`backend/scripts/tokens.ts`), and `spec/generated/registry.json` with the settings and commands tables of `docs/reference.md` (`backend/scripts/registry.ts`) after changing settings, commands or agent kinds (`backend/shared/agents`) | `make tokens` |
| Rebuild the web UI's terminal emulator (Ghostty's libghostty-vt as WebAssembly; zig 0.17) | `make vt-wasm` |
| Rebuild the library machines preload to show a program only the GPUs of its `CUDA_VISIBLE_DEVICES` (`scripts/gpupick`, into `scripts/gpupick/bin`; zig 0.17) | `make gpupick` |
| Test and rebuild the GUI helper of Linux machines (`scripts/gui-helper`: the program windows' X client and capture, compositor and keeper of the machine side; zig 0.17) | `make gui-helper` |
| Program windows' integration test against a real Xvfb in Docker, from any host (`make it` runs it on a Linux host with Xvfb) | `scripts/gui-it.sh` |
| Integration tests with a real terminal core, the machine side's and the core's terminals (`HC_TEST_BIN=<herdr-core>`; the pinned one: `bun backend/scripts/fetch-hc.ts --exe <file> <os>/<arch>`), and VS Code's machine side with a real code-server release (`E2E_CODE_SERVER_SEED=<dir>` holding `code-server-<version>-<os>-<arch>.tar.gz`; skipped without) | `make it` |
| Old kernels and C libraries: KVM guests from official cloud images and containers of old distributions, a payload run in each (on a Linux host with KVM and Docker; not part of any make target) | `e2e/machines/machines.py run-matrix <script>` ([its README](e2e/machines/README.md)) |
| End-to-end tests: the real core on isolated instances (`e2e-<random>`, temporary home, no network) with a fake coding agent, driven through Chromium, SSH machines in Docker containers (skipped without Docker; `E2E_REQUIRE_DOCKER=1` fails instead), and the desktop app with its core in process (skipped without `desktop`'s packages; `E2E_CODE_SERVER_SEED=<dir with a code-server release>` adds its VS Code window); builds into `dist/e2e` (not part of `make test`); (`SKIP_BUILD=1` reuses the build) | `make e2e` (`E2E_ARGS='tests/chat.spec.ts'` for one file) |
| Full build into `dist/`: everything the core embeds staged in `dist/payload` (herdr-core in `dist/machines-hc`), the executable of each `TARGETS` platform, the core and that platform's machine side (`bun backend/scripts/build.ts`), and the release archives; the pinned herdr-core comes from `backend/scripts/fetch-hc.ts` (`backend/scripts/hcdist.ts`) | `make build` (or `scripts/build.sh`) |
| Desktop app of this system (macOS, Windows, Linux): unpacked / installers (DMG and zip, NSIS setup, AppImage and deb) | `make desktop-app` / `make desktop-dist` (`scripts/desktop.sh app` / `dist` in Git Bash on Windows) |
| macOS: build the `.app` and install it into `/Applications` | `make desktop-install` |
| Isolated desktop development | `make dev-desktop` |
| Run for development: the core from its sources (`bun`, instance `dev`, the payloads of `dist/payload`, where it stages this host's executable, built into `dist/dev` with the herdr-core it fetches once into `dist/machines-hc`) and Vite | `make dev-hub` and `make dev-web` |

## Tests: fast and slow, by area

Tests are grouped by area: the core's beside its sources
(`backend/features/<feature>`, `backend/kernel/<part>`, `backend/machine`,
`backend/shared/<part>`, `backend/scripts`), the web UI's by file name in `web/src/__tests__`, the desktop shell's in `desktop/src`.

- **A small change** (one feature, one module): run `make check` and the
  tests of the areas it touches only, e.g. `cd backend && bun test
  features/git`, `pnpm -C web test -- git`. Do not run the whole suite after each edit.
- **Fast tests** (`make test`): every area, without the slow tests. Run
  them before merging a branch or opening a pull request, and after a
  change that crosses areas (a protocol, a shared module).
- **Slow tests**: the core's tests marked `slow`
  (`backend/shared/testdata/slow.ts`: they wait on real time, programs
  or compiles; `make test-slow`), `make it`, `make e2e` and the machine
  matrix. They cost minutes and load the machine: run one only when the
  change touches what it covers (one file: `SLOW_TESTS=1 bun test
  <file>`, `make e2e E2E_ARGS='tests/<spec>'`), the whole set before a
  release. CI runs the slow tests of the core.
- Never add load (stress tools, busy loops) to the user's machine to
  provoke a failure.

## Rules

1. **Never touch the user's real instance or terminals.** Experiments,
   tests and dev servers use `--instance dev` (state in `~/.veldr-dev`,
   terminal core session `veldr-dev-<host id>`), the integration tests'
   sessions `veldr-it` and `veldr-it-<host id>` or the end-to-end
   tests' instances `e2e-<random>`
   (homes in `/tmp/hie-*`, SSH machines in Docker containers labelled
   `veldr.e2e`); the desktop app's instance (`desktop`) and the
   default one are the user's. Stop a terminal core only through its own
   instance (`POST /api/m/{id}/hc/stop` of the dev core), never the user's,
   and do not attach to the user's terminals.
2. **No hardcoded product name.** Use
   `backend/shared/lib/brand.ts` (the core), `APP_NAME`/`APP_SLUG`/
   `storage` from `web/src/brand.ts`, `src/brand.ts` in the extension.
   `scripts/check.sh` fails otherwise. Renames: `scripts/rename.sh`.
3. **All UI text through i18n.** Add the key to `web/src/i18n/en.ts` and the
   translation to `zh-CN.ts` (the build fails if one is missing); a plugin's
   messages are in its own `web/src/plugins/<id>/i18n/` instead. The server
   returns codes, not prose. Comments, logs and identifiers are English.
4. **Docs move with code.** New or changed flags and endpoints →
   `docs/reference.md` (CI checks with `backend/scripts/reference.ts`; its
   settings and commands tables are generated by `make tokens`); protocol or component changes →
   `docs/architecture.md`; behavior
   and its reasoning → the feature's `docs/features/NN-*.md` (new features get
   a new document following `docs/features/README.md`); operations →
   `docs/deployment.md`; user-facing summary → `README.md` and
   `README.zh-CN.md` (same sections).
   Documents on `main` describe the system as it is: no TODO, TBD or open
   questions in files or code comments. A design for work done in stages
   may describe its goal on its branch; the branch merges into `main` once
   the code matches the document. Report open items to the user so they are
   tracked in the issue tracker.
5. **Keep the security guardrails.** Loopback by default, Host/Origin checks,
   proxy secret, the terminal protocol's method allowlist, read-only mode,
   0700/0600 unix sockets, nothing listening on TCP on machines, verified
   downloads. Changes here need a test and a note in `SECURITY.md`.
6. **Bound remote resources.** Anything started on a machine must have an
   owner and a way to end (agent exit, idle timeout, explicit stop); anything
   written to disk needs a retention rule. Document it in
   `docs/deployment.md#remote-resources`.
7. **Protocol compatibility.** Core and agent ship together, but extend
   the agent protocol (`backend/shared/proto/agentproto`) by adding
   fields/ops: nodes of earlier releases, Go ones too, speak it until a
   node of this build takes over. herdr-core's API is external: speak its
   protocol generation (`backend/shared/proto/hc`), honor stream credit, and
   take a `missed` notification as the subscription's new complete state.
8. **Tests.** The core's beside its sources in `backend/`
   (`<name>.test.ts`, `bun test`; machine-side tests use a temporary
   `HOME`); web tests in `web/src/__tests__`; the desktop shell's
   beside its sources in `desktop/src`. Don't add tests that need network access or
   real machines to `make test`. A test that waits on real time for what runs
   in the background (a timer, a program, a worker) waits generously and is
   marked `slow` (`backend/shared/testdata/slow.ts`): `make test` skips it,
   `make test-slow` and CI run it.
9. **`CHANGELOG.md` changes only in a release.** Feature and fix branches
   do not touch it. When a release is cut, a `release-manager` subagent
   writes the version's entries from the pull requests merged since the
   last tag ([RELEASING.md](RELEASING.md)).

## Agent roles

Reusable specialist roles live in [`.claude/agents/`](.claude/agents/)
(Claude Code subagents; other agents can follow the same files as
playbooks):

| Role | Use it when |
| --- | --- |
| `hc-integration` | Changing anything that talks to the terminal core (herdr-core), or upgrading it. |
| `security-reviewer` | Only when a code review is asked for, or before merging a branch that changes guards, files, sockets, processes, ssh or downloads; not after every change. |
| `docs-keeper` | After changing flags, shortcuts, protocols, layout on disk or features. |
| `i18n-translator` | After adding or changing user-visible text, or to add a locale. |
| `release-manager` | Cutting a release (it writes `CHANGELOG.md`) or bumping pinned code-server/extension versions. |
| `oss-steward` | Auditing open-source health before releases or after restructurings. |

## Gotchas

- Key events in the browser's terminals are encoded by Ghostty's encoder
  (`web/src/vt/input.ts`, `vt/pane.ts`), and a keydown that sent bytes is
  cancelled; an uncancelled keydown is followed by a keypress and an input
  event that would send the text again. Any key the UI translates or leaves
  to the browser needs a row in `web/src/__tests__/testdata/vt-keys.json`
  with its bytes in each mode.
- `web/src/vt/ghostty-vt.wasm` is a build artifact with a recorded digest:
  change it only with `make vt-wasm` (zig 0.17), which rewrites the digest;
  libghostty-vt's functions read and write wasm memory, whose buffer may
  change after any call, so take views again after each one.
- `scripts/gpupick/bin/*.so` are build artifacts of
  `scripts/gpupick/gpupick.c` with recorded digests, of the source too:
  after changing the source run `make gpupick` (zig 0.17) and commit the
  libraries with it. Its test runs on Linux only
  (`backend/features/gui/machine/pick.test.ts`, slow).
- `scripts/gui-helper/bin/*` are build artifacts of
  `scripts/gui-helper` with recorded digests, of the sources too: after
  changing a source run `make gui-helper` (zig 0.17), which runs its tests,
  and commit the executables with it. Its messages with the node are
  `src/proto.zig` and `backend/features/gui/machine/helper.ts`, changed
  together; its JPEG must stay the bytes of Go's image/jpeg encoder it
  was ported from (`src/testdata`, kept as that encoder wrote them).
- yamux streams cannot be half-closed: use `ChunkWriter` (agentproto) for
  uploads that expect a reply.
- A coding agent kind is a row of `backend/shared/agents/kinds.ts` with a
  detector manifest of the same id
  (`backend/features/agents/machine/detect/manifests`, which
  `MANIFEST_FILES` of `manifests.ts` beside it lists; `kinds.test.ts`
  compares the registry with them and the settings, and
  `UPDATE_TESTDATA=1 bun test features/agents/machine/detect` in
  `backend/` rewrites what the detector's tests expect them to parse to),
  then `make tokens`. Finding its sessions needs `backend/machine/agents`.
  Claude Code's transcripts are mapped to events by
  `backend/shared/agents/transcript` (the chat host's imports and its
  Claude Code adapter), specified by the vectors in
  `spec/vectors/transcript/`, which the core's and the web tests run;
  `UPDATE_TESTDATA=1 bun test shared/agents/transcript` in `backend/`
  rewrites a vector's expected events after a deliberate change of the
  mapping (review the diff). A chat with it (the chat host running it
  headless) also needs a `chat` spec in its row, whose `adapter` is one of
  `ADAPTERS`, the protocols of the adapters behind
  `backend/features/chat/machine` (`kinds.test.ts`, "chat kinds"); its
  argv, environment and session metadata stay on the machine's side, never
  in the registry's JSON. The adapters' protocol recordings are in
  `spec/vectors/chat/` (sanitized; its README says what each shows and
  which version made it), what the adapters make of them in each
  adapter's `testdata/golden`.
- Chat adapters follow the rules in
  `backend/features/chat/machine/adapter.ts`'s header comment: never write
  the agents' configuration (a Codex thread starts and resumes read-only
  and gets its policy per turn; a writable one adds the directory to
  `~/.codex/config.toml`), end an agent gracefully before any SIGKILL
  (Codex killed outright leaves its shell snapshots), answer requests they
  do not serve with "method not found". The app-server schema of Codex
  the adapter speaks is pinned in `spec/codex-app-server` (the schema Codex
  prints, the types `backend/scripts/codex-schema.ts` makes of it, checked
  by `make check`, and `appserver.test.ts`, which holds the recordings and
  what the adapter sends to it; its README says how to move to another
  version).
- The TypeScript build's Claude Code adapter runs on Anthropic's Agent SDK,
  which no executable may carry (all rights reserved): outside tests import
  only its types (`scripts/check.sh`; `backend/scripts/build.ts` refuses
  an executable that holds it). Machines fetch the npm tarball pinned in
  `backend/features/chat/claudesdk.ts`; moving to another version changes
  the pin (version, integrity, the entry's SHA-256) and the development
  dependency together (`sdk.test.ts`, `installed.test.ts`).
- A terminal the product runs for itself (the chat host) is hidden by its
  reserved name and label together (`agentproto.Hidden`, `hidden` of
  `backend/shared/proto/agentproto`): anything that
  walks a terminal core's terminals (the core's terminal protocol, agent
  detection, terminal history) skips it with that function, never by the
  label alone, which any program can set.
- Never call herdr-core's `terminal.read` with `lines` above 0 for a
  read-only client or from a background task: with history lines the core
  scrolls a program on the alternate screen, which every viewer sees.
- `web/dist` is embedded into the core's executable when it is built
  (`backend/scripts/build.ts --web`); `make build` builds the UI first, and
  `make dev-hub` serves `web/dist` as it is (`--web-dir`).
- Adding an npm dependency of `backend/` changes
  `THIRD_PARTY_NOTICES.md`; run `scripts/notices.sh`.
- Files many changes touch are laid out so that parallel branches merge:
  `README.zh-CN.md` has one sentence per line, and enumerations in the docs
  that grow with features are lists with one item per line.
- macOS limits unix socket paths to 104 bytes; keep socket paths short.
- The core builds for Windows, the agent does not: the core's code runs
  in Bun and in Electron's Node (`shared/`, `kernel/` and the features'
  `hub.ts` use Node's modules only, `tsconfig.node.json`; the machine
  side is Bun on Linux and macOS, backend/README.md's rules); POSIX-only
  tests skip on Windows. Paths on machines are POSIX: use `node:path`'s
  `posix` for them. `.gitattributes` keeps LF line endings on Windows checkouts.
- The binary a machine gets is its platform's executable from the
  release's archive, checked against the release's `SHA256SUMS`: the machine
  downloads it, else the core uploads it from `--agent-dir`, its cache, its
  own executable or the release
  (`backend/kernel/machines/transport/release.ts`, `ssh.ts`), checked by its
  SHA-256 on the machine. Its command line is `backend/hosts/bun/main.ts`
  (`node` from `backend/hosts/machine/cli.ts`; the node's features in
  `backend/hosts/machine/features.ts`).
- Bun's unix socket server removes the path it bound when it closes: the
  machine side binds every socket under a temporary name and renames it
  into place (`backend/machine/sockets.ts` `listenUnix`); use it, or a
  closing server removes a socket another node put there.
- The machine side calls no variadic C function through `bun:ffi` (on
  macOS/arm64 their arguments go on the stack): `fs.openSync` passes
  `open`'s flags (`O_NOFOLLOW_ANY` without `O_NOFOLLOW`, which macOS
  refuses beside it), and Linux's system calls without a fixed-argument
  wrapper go through `syscall(2)` with integer arguments only
  (`backend/machine/sys`).
- code-server's webviews need a secure context; test VS Code features on
  `http://localhost` or HTTPS, not a LAN IP.
