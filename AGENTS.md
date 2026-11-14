# AGENTS.md

Instructions for coding agents (and humans) changing this repository. Read
[docs/architecture.md](docs/architecture.md) and the relevant
[feature design document](docs/features/README.md) before non-trivial
changes.

## What this is

A Go server (`cmd/herdr-ide`) that serves a React terminal UI and reaches
several machines through a per-machine Go agent (`cmd/herdr-ide-agent`) over
ssh. Every machine's terminals live in a terminal core of the agent's own
(herdr-core, `hc`, in a session apart from the user's); the browser emulates
them with Ghostty's libghostty-vt as WebAssembly, and a macOS application
(`macos/`) draws them with Ghostty's renderer, both through the core's
terminal protocol (`/api/v1/term`). code-server provides VS Code panels. One
binary embeds the UI, the agents and herdr-core for 4 platforms, and a VS
Code extension.

## Commands

| Task | Command |
| --- | --- |
| Install JS deps | `make deps` |
| Unit tests (Go + web + desktop) | `make test` |
| All checks (gofmt, vet, tsc, prettier, brand/doc/README consistency, generated tokens, the terminal emulator's digest) | `make check` |
| Regenerate the design tokens' Swift, CSS and Go after editing `design/tokens.json`, and `design/generated/registry.json` after changing settings or commands | `make tokens` |
| Rebuild the web UI's terminal emulator (Ghostty's libghostty-vt as WebAssembly; zig 0.17) | `make vt-wasm` |
| Integration test with a real terminal core (`HC_TEST_BIN=<herdr-core>`) | `make it` |
| Full build into `dist/` | `make build` (or `scripts/build.sh`) |
| macOS `.app` / DMG | `make desktop-app` / `make desktop-dmg` |
| Build the `.app` and install it into `/Applications` | `make desktop-install` |
| macOS application: unit tests / debug build / `.app` | `make macos-test` / `make macos-build` / `make macos-app` |
| Isolated desktop development | `make dev-desktop` |
| Run for development | `make dev-core` and `make dev-web` |

Run `make check test` before finishing a change.

## Rules

1. **Never touch the user's real instance or terminals.** Experiments,
   tests and dev servers use `--instance dev` (state in `~/.herdr-ide-dev`,
   terminal core session `herdr-ide-dev`) or the integration tests'
   session `herdr-ide-it`; the desktop apps' instance (`desktop`) and the
   default one are the user's. Stop a terminal core only through its own
   instance (`POST /api/m/{id}/hc/stop` of the dev core), never the user's,
   and do not attach to the user's terminals.
2. **No hardcoded product name.** Use `brand.*` (Go), `APP_NAME`/`APP_SLUG`/
   `storage` from `web/src/brand.ts`, `src/brand.ts` in the extension,
   `Brand` (`macos/Sources/TermKit/Brand.swift`) in the macOS application.
   `scripts/check.sh` fails otherwise. Renames: `scripts/rename.sh`.
3. **All UI text through i18n.** Add the key to `web/src/i18n/en.ts` and the
   translation to `zh-CN.ts` (the build fails if one is missing); in the
   macOS application to both `Localizable.strings` (`make macos-test` fails
   if one is missing or unused). The server
   returns codes, not prose. Comments, logs and identifiers are English.
4. **Docs move with code.** New or changed flags → `docs/reference.md` (CI
   checks); protocol or component changes → `docs/architecture.md`; behavior
   and its reasoning → the feature's `docs/features/NN-*.md` (new features get
   a new document following `docs/features/README.md`); operations →
   `docs/deployment.md`; user-facing summary → `README.md` and
   `README.zh-CN.md` (same sections).
   Documents describe the system as it is: no TODO, TBD or open questions in
   files or code comments. Report open items to the user so they are tracked
   in the issue tracker.
5. **Keep the security guardrails.** Loopback by default, Host/Origin checks,
   proxy secret, the terminal protocol's method allowlist, read-only mode,
   0700/0600 unix sockets, nothing listening on TCP on machines, verified
   downloads. Changes here need a test and a note in `SECURITY.md`.
6. **Bound remote resources.** Anything started on a machine must have an
   owner and a way to end (agent exit, idle timeout, explicit stop); anything
   written to disk needs a retention rule. Document it in
   `docs/deployment.md#remote-resources`.
7. **Protocol compatibility.** Core and agent ship together, but extend
   `internal/agentproto` by adding fields/ops. herdr-core's API is external:
   speak its protocol generation (`internal/hc`), honor stream credit, and
   take a `missed` notification as the subscription's new complete state.
8. **Tests.** Go tests beside the code (agent tests set `HOME` to a temp
   dir); web tests in `web/src/__tests__`; the macOS application's in
   `macos/Tests` (`make macos-test`, needs Xcode). Don't add tests that need network
   access or real machines to `make test`.
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
| `security-reviewer` | Before merging changes to guards, files, sockets, processes, ssh or downloads. |
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
- yamux streams cannot be half-closed: use `agentproto.ChunkWriter` for
  uploads that expect a reply.
- `web/dist` is embedded at build time; run `pnpm -C web build` (or
  `make build`) before `go build` if the UI changed. The build keeps
  `web/dist/.gitkeep`, which `go:embed` needs in a clean checkout.
- Adding a Go dependency changes `THIRD_PARTY_NOTICES.md`; run
  `scripts/notices.sh`.
- Files many changes touch are laid out so that parallel branches merge:
  `README.zh-CN.md` has one sentence per line, and enumerations in the docs
  that grow with features are lists with one item per line.
- macOS limits unix socket paths to 104 bytes; keep socket paths short.
- code-server's webviews need a secure context; test VS Code features on
  `http://localhost` or HTTPS, not a LAN IP.
