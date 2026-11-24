# Contributing

Thanks for helping! Issues and pull requests are welcome in English or
Chinese (中文也可以). Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Requirements: Go (see `go.mod`), Node.js 22.12+ and pnpm (and, on
Windows, Git for Windows for its bash). The build downloads the pinned
herdr-core, the terminal core the agents install on machines, into
`dist/hc/` and embeds it.

```bash
make deps            # pnpm install for web/, the extension, desktop/ (with Electron's binary) and e2e/
make build           # web UI, extension, machine builds, core; release archives
make test            # Go, web and desktop unit tests
make check           # formatting, vet, typecheck, import cycles of the web UI, brand/doc consistency
```

Day-to-day development, without touching the state or the terminals of your
daily veldr (the dev core's terminal core is the session
`veldr-dev-<host id>`, `<host id>` a hash of the machine id):

```bash
make dev-core        # core on 127.0.0.1:7790: --instance dev --local-only
make dev-web         # Vite on http://localhost:5173, proxied to the dev core (DEV_LISTEN)
```

`make it` runs the integration tests against a real herdr-core in the
isolated sessions `veldr-it` and `veldr-it-<host id>` (the
agent's) with temporary state:
`HC_TEST_BIN=<path to herdr-core> make it` (without it, `hc` on `PATH`;
without either the tests are skipped).
`go run ./scripts/fetch-hc -exe <file> <os>/<arch>` writes the pinned,
verified executable for one platform to `<file>`, as CI does.

`make e2e` runs the end-to-end tests (`e2e/`, Playwright with Chromium;
not part of `make test`): `scripts/e2e.sh` builds the web UI, this
platform's core with the pinned herdr-core and the fake coding agent
(`e2e/fakeacp`, a scripted ACP agent installed as `kimi`) into
`dist/e2e/`, then each test starts a core of its own with a temporary
home under `/tmp/hie-*`, an instance `e2e-<random>`, a free loopback port,
`--local-only` and no network, and stops its terminal core through that
instance's API at the end. `make e2e E2E_ARGS='tests/chat.spec.ts'` runs
one file; failures leave a trace in `dist/e2e/results/`
(`pnpm -C e2e exec playwright show-trace <trace.zip>`). When you add a
test, use the fixtures of `e2e/harness/fixtures.ts`, find elements by
role and accessible name, and wait on conditions (`expect`, `waitFor`),
never on time; read what a terminal shows with the terminal protocol
client (`harness/term.ts`), since the page draws it on a canvas.

With Docker running, `tests/ssh.spec.ts` adds SSH machines: each test
starts a container of `e2e/sshd` (OpenSSH on Linux, key-only sign-in)
published on `127.0.0.1` only, with a throwaway key, `known_hosts` and ssh
configuration in the instance's home (never `~/.ssh` or an ssh agent), and
removes it at the end; a run removes the labelled containers of runs that
died. `scripts/e2e.sh` builds the Linux machine build and fake agent of
Docker's architecture and the image (cached). Without Docker these tests
skip; `E2E_REQUIRE_DOCKER=1` (CI) makes them fail instead.

Release archives are in `dist/release/`; the unpacked directories are in
`dist/packages/`. herdr-core upgrades change the version and the four
archive digests in `internal/hcdist`; its license and notices are taken
from the release archive by `scripts/fetch-hc`. Rerun the integration tests
with the new executable before distributing a release.

The desktop app builds on the system it is for. `make dev-desktop` builds
and launches Electron with the embedded UI, the same isolated session and
instance `dev` (port 7791); stop other dev cores first. On Windows that
run connects no machine (it is local-only, and the local machine has no
agent there). `make desktop-app` builds the unpacked app and
`make desktop-dist` the installers: the DMG and zip on macOS, the NSIS
setup on Windows, the AppImage and deb on Linux; `make desktop-install`
(macOS) builds the `.app` and replaces the one in `/Applications`,
quitting and reopening it if it runs. On Windows, install Git for Windows
and run `scripts/desktop.sh dev|app|dist` in Git Bash (the make targets
call the same script). `DESKTOP_OS=win` or `linux` packages another
system's unpacked app to check its packaging (`scripts/desktop.sh app`);
see [desktop deployment](docs/deployment.md#desktop-app). Branch
workspaces can live in the ignored `.worktrees/` directory.

## Pull requests

- Keep each PR focused; describe the user-visible change and how you tested
  it (the template asks for this).
- `make check test` must pass (`make check` also vets the Go code for
  linux/amd64, darwin/arm64 and windows/amd64, and fails when modules of
  the web UI import each other in a cycle: `web/scripts/cycles.mjs`
  counts the imports that exist at run time, so move what both sides
  need into a module below them); CI
  (`.github/workflows/ci.yml`) runs the same on Linux, plus
  `go test -race`, `make it` against the pinned herdr-core, the
  cross-compiled release archives and Windows core, and a `desktop` job on
  Linux, macOS and Windows: the Go tests (on macOS and Windows), the web
  and desktop tests and the packaged Electron app
  (`scripts/desktop.sh app`). POSIX-only Go tests skip on Windows.
- New Go dependencies: run `scripts/notices.sh` and commit
  `THIRD_PARTY_NOTICES.md` (checked by CI); make sure the license is
  compatible with MIT.
- Add or update tests with behavior changes. Go tests live next to the code;
  web tests in `web/src/__tests__`, desktop tests in `desktop/src/*.test.ts`.
  Vectors the web tests run, and Go's tests where the rule is in Go too
  (keys, ssh targets), live in `spec/vectors/` (`make check` fails when
  a vector file is run by no web test).
- Update the docs in the same PR: flags, endpoints and files in
  [docs/reference.md](docs/reference.md) (CI checks every flag and route is
  listed; `make tokens` regenerates its tables of settings and commands),
  components and protocols in [docs/architecture.md](docs/architecture.md),
  feature behavior and its reasoning in [docs/features/](docs/features/README.md),
  operations in [docs/deployment.md](docs/deployment.md). Leave
  [CHANGELOG.md](CHANGELOG.md) alone: it is written when a release is cut
  ([RELEASING.md](RELEASING.md)), from the pull requests' titles and
  descriptions, so describe user-visible changes there.
- Commit messages: short imperative subject (`server: stop idle code-server`),
  optional scope prefix by area (`agent:`, `web:`, `docs:`, …).

## Conventions

- **Names:** never hardcode the product name. Use `internal/brand` in Go,
  `web/src/brand.ts` in the UI and `src/brand.ts` in the extension
  (`scripts/check.sh` enforces this). Renames go through `scripts/rename.sh`.
- **Text:** user-visible strings go through i18n — `t('key')` with the key in
  `web/src/i18n/en.ts` and a translation in `zh-CN.ts` (a plugin's in its
  `web/src/plugins/<id>/i18n/`); extension strings in
  `package.nls*.json` / `l10n/`. The server sends codes, not sentences.
  Code comments, logs and identifiers are English.
- **READMEs:** `README.md` (English) is canonical; keep `README.zh-CN.md` in
  step (same sections, checked by CI). Reference material lives once in
  `docs/` (English).
- **Protocols:** core and agent always ship together; extend
  `internal/agentproto` by adding fields or ops, never by changing meanings.
- **Security:** read [SECURITY.md](SECURITY.md) before touching
  `internal/server` guards, the agent's file or socket handling, or anything
  that downloads or executes.
- **Formatting:** `gofmt`; Prettier for TypeScript (`pnpm -C web format`).

## Project layout

See [docs/architecture.md](docs/architecture.md).
