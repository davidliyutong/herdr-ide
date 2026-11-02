# Contributing

Thanks for helping! Issues and pull requests are welcome in English or
Chinese (中文也可以). Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Requirements: Go (see `go.mod`), Node.js 22.12+, pnpm, and
[herdr](https://herdr.dev) for running the app. The build downloads the pinned
herdr for release archives into `dist/herdr/`; without an installed herdr, use
that file as `herdr` below and set `HERDR_BIN` to it for `make dev-core`.

```bash
make deps            # pnpm install for web/, the extension and desktop/
make build           # web UI, extension, agents, core; release archives with herdr
make test            # Go, web and desktop unit tests
make check           # formatting, vet, typecheck, brand/doc consistency
```

Day-to-day development, without touching your real herdr session or the
state of your daily herdr-ide:

```bash
herdr --session herdr-ide-dev server &
make dev-core        # core on 127.0.0.1:7790: --instance dev --local-only --local-session herdr-ide-dev
make dev-web         # Vite on http://localhost:5173, proxied to the dev core (DEV_LISTEN)
```

`make it` runs the integration test against a real herdr in an isolated
session (`herdr-ide-it`), which it deletes before and after the run. To test the bundled executable, run
`HERDR_TEST_BIN="$PWD/dist/packages/herdr-ide-$(go env GOOS)-$(go env GOARCH)/herdr" make it`.

Release archives are in `dist/release/`; the unpacked directories are in
`dist/packages/`. Keep each core beside its `herdr` and licenses.
herdr upgrades require reviewing the pinned digests in `internal/herdrdist`,
regenerating `licenses/herdr/` with `scripts/herdr-notices.py`, and rerunning
integration tests before distributing the new release.

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
- `make check test` must pass; CI runs the same (plus `go test -race` and a
  macOS job).
- New Go dependencies: run `scripts/notices.sh` and commit
  `THIRD_PARTY_NOTICES.md` (checked by CI); make sure the license is
  compatible with MIT.
- Add or update tests with behavior changes. Go tests live next to the code;
  web tests in `web/src/__tests__`, desktop tests in `desktop/src/*.test.ts`.
- Update the docs in the same PR: flags and shortcuts in
  [docs/reference.md](docs/reference.md) (CI checks every flag is listed),
  components and protocols in [docs/architecture.md](docs/architecture.md),
  feature behavior and its reasoning in [docs/features/](docs/features/README.md),
  operations in [docs/deployment.md](docs/deployment.md), notable changes in
  [CHANGELOG.md](CHANGELOG.md).
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
