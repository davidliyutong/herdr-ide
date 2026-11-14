# Contributing

Thanks for helping! Issues and pull requests are welcome in English or
Chinese (中文也可以). Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Requirements: Go (see `go.mod`), Node.js 22.12+ and pnpm. The build
downloads the pinned herdr-core, the terminal core the agents install on
machines, into `dist/hc/` and embeds it.

The macOS application (`macos/`) additionally needs Xcode 26 or later for
`make macos-build` and `make macos-test`, and XcodeGen (`brew install
xcodegen`) for `make macos-app`.

```bash
make deps            # pnpm install for web/, the extension and desktop/
make build           # web UI, extension, agents, core; release archives
make test            # Go, web and desktop unit tests
make check           # formatting, vet, typecheck, brand/doc consistency
```

Day-to-day development, without touching the state or the terminals of your
daily herdr-ide (the dev core's terminal core is the session
`herdr-ide-dev`):

```bash
make dev-core        # core on 127.0.0.1:7790: --instance dev --local-only
make dev-web         # Vite on http://localhost:5173, proxied to the dev core (DEV_LISTEN)
```

`make it` runs the integration tests against a real herdr-core in the
isolated session `herdr-ide-it` with temporary state:
`HC_TEST_BIN=<path to herdr-core> make it` (without it, `hc` on `PATH`;
without either the tests are skipped).
`go run ./scripts/fetch-hc -exe <file> <os>/<arch>` writes the pinned,
verified executable for one platform to `<file>`, as CI does.

Release archives are in `dist/release/`; the unpacked directories are in
`dist/packages/`. herdr-core upgrades change the version and the four
archive digests in `internal/hcdist`; its license and notices are taken
from the release archive by `scripts/fetch-hc`. Rerun the integration tests
with the new executable before distributing a release.

On macOS, `make dev-desktop` builds and launches Electron with the embedded
UI, the same isolated session and instance `dev` (port 7791). Stop other dev
cores first. `make desktop-app` / `make desktop-dmg` build the `.app` / DMG;
`make desktop-install` builds the `.app` and replaces the one in
`/Applications`, quitting and reopening it if it runs; see
[desktop deployment](docs/deployment.md#macos-desktop-app). Branch
workspaces can live in the ignored `.worktrees/` directory.

## Pull requests

- Keep each PR focused; describe the user-visible change and how you tested
  it (the template asks for this).
- `make check test` must pass; CI (`.github/workflows/ci.yml`) runs the
  same, plus `go test -race`, `make it` against the pinned herdr-core, the
  cross-compiled release archives and, on macOS, the Go tests, the
  Electron app, `make macos-test` and the ad-hoc signed `make macos-app`.
- New Go dependencies: run `scripts/notices.sh` and commit
  `THIRD_PARTY_NOTICES.md` (checked by CI); make sure the license is
  compatible with MIT.
- Add or update tests with behavior changes. Go tests live next to the code;
  web tests in `web/src/__tests__`, desktop tests in `desktop/src/*.test.ts`,
  the macOS application's in `macos/Tests`. Vectors both clients run live
  in `design/testdata/` (`make check` fails when a vector file is run by no
  web or no Swift test).
- Update the docs in the same PR: flags and shortcuts in
  [docs/reference.md](docs/reference.md) (CI checks every flag is listed),
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
  `web/src/i18n/en.ts` and a translation in `zh-CN.ts`; extension strings in
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
