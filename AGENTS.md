# AGENTS.md

Instructions for coding agents (and humans) changing this repository. Read
[docs/architecture.md](docs/architecture.md) and the relevant
[feature design document](docs/features/README.md) before non-trivial
changes.

## What this is

A Go server (`cmd/herdr-ide`) that serves a React terminal UI and drives
[herdr](https://herdr.dev) on several machines through a per-machine Go agent
(`cmd/herdr-ide-agent`) over ssh; code-server provides VS Code panels. One
binary embeds the UI, the agents for 4 platforms and a VS Code extension.
Release archives also contain a native herdr and its license notices, used
on the core host only when no herdr is installed; it keeps herdr's usual
configuration and state. SSH machines use their installed herdr.

## Commands

| Task | Command |
| --- | --- |
| Install JS deps | `make deps` |
| Unit tests (Go + web) | `make test` |
| All checks (gofmt, vet, tsc, prettier, brand/doc/README consistency) | `make check` |
| Integration test with a real herdr | `make it` |
| Full build into `dist/` | `make build` (or `scripts/build.sh`) |
| Run for development | `make dev-core` and `make dev-web` |

Run `make check test` before finishing a change.

## Rules

1. **Never touch the user's real herdr session or state.** Experiments,
   tests and dev servers use `herdr --session herdr-ide-dev` (or the
   integration test's `herdr-ide-it`) and `--instance dev`; against remote
   machines add `--remote-session herdr-ide-dev` (start that session there
   with `herdr --session herdr-ide-dev server`). Do not run
   `herdr server stop` without `--session`, and do not attach to panes of
   the default session in control mode.
2. **No hardcoded product name.** Use `brand.*` (Go), `APP_NAME`/`APP_SLUG`/
   `storage` from `web/src/brand.ts`, `src/brand.ts` in the extension.
   `scripts/check.sh` fails otherwise. Renames: `scripts/rename.sh`.
3. **All UI text through i18n.** Add the key to `web/src/i18n/en.ts` and the
   translation to `zh-CN.ts` (the build fails if one is missing). The server
   returns codes, not prose. Comments, logs and identifiers are English.
4. **Docs move with code.** New or changed flags → `docs/reference.md` (CI
   checks); protocol or component changes → `docs/architecture.md`; behavior
   and its reasoning → the feature's `docs/features/NN-*.md` (new features get
   a new document following `docs/features/README.md`); operations →
   `docs/deployment.md`; user-facing summary → `README.md` and
   `README.zh-CN.md` (same sections); notable changes → `CHANGELOG.md`
   (`[Unreleased]`).
   Documents describe the system as it is: no TODO, TBD or open questions in
   files or code comments. Report open items to the user so they are tracked
   in the issue tracker.
5. **Keep the security guardrails.** Loopback by default, Host/Origin checks,
   proxy secret, herdr API allowlist, read-only mode, 0700/0600 unix sockets,
   nothing listening on TCP on machines, verified downloads. Changes here need
   a test and a note in `SECURITY.md`.
6. **Bound remote resources.** Anything started on a machine must have an
   owner and a way to end (agent exit, idle timeout, explicit stop); anything
   written to disk needs a retention rule. Document it in
   `docs/deployment.md#remote-resources`.
7. **Protocol compatibility.** Core and agent ship together, but extend
   `internal/agentproto` by adding fields/ops. herdr's API is external: keep
   requests one per connection and handle `events_lost`.
8. **Tests.** Go tests beside the code (agent tests set `HOME` to a temp
   dir); web tests in `web/src/__tests__`. Don't add tests that need network
   access or real machines to `make test`.

## Agent roles

Reusable specialist roles live in [`.claude/agents/`](.claude/agents/)
(Claude Code subagents; other agents can follow the same files as
playbooks):

| Role | Use it when |
| --- | --- |
| `herdr-integration` | Changing anything that talks to herdr, or upgrading herdr. |
| `security-reviewer` | Before merging changes to guards, files, sockets, processes, ssh or downloads. |
| `docs-keeper` | After changing flags, shortcuts, protocols, layout on disk or features. |
| `i18n-translator` | After adding or changing user-visible text, or to add a locale. |
| `release-manager` | Cutting a release or bumping pinned code-server/extension versions. |
| `oss-steward` | Auditing open-source health before releases or after restructurings. |

## Gotchas

- Key events in panes go through `routeKey` (`web/src/terminal/keys.ts`),
  which cancels what it consumes; an uncancelled keydown makes xterm.js send
  the key again on keypress. Any key the UI translates or swallows needs a row
  in `web/src/__tests__/testdata/keys.json`.
- yamux streams cannot be half-closed: use `agentproto.ChunkWriter` for
  uploads that expect a reply.
- Frames from herdr are diffs against the previous frame of the same stream;
  never splice two streams into one xterm without `term.reset()`.
- `web/dist` is embedded at build time; run `pnpm -C web build` (or
  `make build`) before `go build` if the UI changed. The build keeps
  `web/dist/.gitkeep`, which `go:embed` needs in a clean checkout.
- Adding a Go dependency changes `THIRD_PARTY_NOTICES.md`; run
  `scripts/notices.sh`.
- macOS limits unix socket paths to 104 bytes; keep socket paths short.
- code-server's webviews need a secure context; test VS Code features on
  `http://localhost` or HTTPS, not a LAN IP.
