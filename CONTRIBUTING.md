# Contributing

Thanks for helping! Issues and pull requests are welcome in English or Chinese (中文也可以). Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Requirements: Bun 1.4.5 (the hub, its machine side and the build's tools in `backend/scripts`), Node.js 22.12+ and pnpm (and, on Windows, Git for Windows for its bash). The build downloads the pinned herdr-core, the terminal core the agents install on machines, into `dist/machines-hc/` and embeds it.

```bash
make deps            # pnpm install for web/, the extension, desktop/ (with Electron's binary), e2e/ and backend/
make build           # web UI, extension, each platform's executable (hub and machine side, Bun); release archives
make test            # hub, web and desktop unit tests
make test-slow       # the hub's tests that wait on real time (CI runs them too)
make check           # formatting, vet, typecheck, import cycles of the web UI, brand/doc consistency
```

Day-to-day development, without touching the state or the terminals of your daily veldr (the dev hub's terminal core is the session `veldr-dev-<host id>`, `<host id>` a hash of the machine id):

```bash
make dev-hub         # hub on 127.0.0.1:7790: --instance dev --local-only
make dev-web         # Vite on http://localhost:5173, proxied to the dev hub (DEV_LISTEN)
```

`make dev-hub` fetches this host's herdr-core once into `dist/machines-hc/`, builds this host's executable into `dist/dev/` and stages it in `dist/payload/` (`machine/veldr-<os>-<arch>.gz` with the build's record, as the desktop app carries it), then runs the hub from its sources (`bun backend/hosts/bun/main.ts`, without `--agent-dir`), which reads its payloads there (the VS Code extension too, once `make build` staged it).

`make it` runs the integration tests against a real herdr-core in the isolated sessions `veldr-it` and `veldr-it-<host id>` (the agent's), and the hub's terminals test on the instance `ts-term`, with temporary state: `HC_TEST_BIN=<path to herdr-core> make it` (without it, `hc` on `PATH`; without either the tests are skipped). `bun backend/scripts/fetch-hc.ts --exe <file> <os>/<arch>` writes the pinned, verified executable for one platform to `<file>`, as CI does.

`make e2e` runs the end-to-end tests (`e2e/`, Playwright with Chromium; not part of `make test`): `scripts/e2e.sh` builds the web UI, this platform's hub with the pinned herdr-core and the fake coding agent (`e2e/fakes/acp.ts`, a scripted ACP agent installed as `kimi`, compiled by Bun) into `dist/e2e/`, then each test starts a hub of its own with a temporary home under `/tmp/hie-*`, an instance `e2e-<random>`, a free loopback port, `--local-only` and no network, and stops its terminal core through that instance's API at the end. `make e2e E2E_ARGS='tests/chat.spec.ts'` runs one file; failures leave a trace in `dist/e2e/results/` (`pnpm -C e2e exec playwright show-trace <trace.zip>`). When you add a test, use the fixtures of `e2e/harness/fixtures.ts`, find elements by role and accessible name, and wait on conditions (`expect`, `waitFor`), never on time; read what a terminal shows with the terminal protocol client (`harness/term.ts`), since the page draws it on a canvas.

The fixtures are built from parts a new kind of test reuses:

- `harness/home.ts`: an isolated home (instance name, settings, an environment built from scratch, offline) and its cleanup, also of the homes of a run that was killed;
- `harness/instance.ts`: the command line's hub on such a home (the `instance` fixture);
- `harness/desktop.ts`: the desktop app on such a home with its own Chromium profile and the mock keychain, its hub reached through the app's window (the `desktop` fixture, `test.use({ desktopOptions })`);
- `harness/sshd.ts`: an SSH machine in a Docker container (the `sshd` fixture);
- `e2e/machines/`: KVM guests from cloud images and containers of old distributions for runs on old kernels and C libraries (its README; on a Linux host, not part of `make e2e`).

With Docker running, `tests/ssh.spec.ts` adds SSH machines: each test starts a container of `e2e/sshd` (OpenSSH on Linux, key-only sign-in) published on `127.0.0.1` only, with a throwaway key, `known_hosts` and ssh configuration in the instance's home (never `~/.ssh` or an ssh agent), and removes it at the end; a run removes the labelled containers of runs that died. `scripts/e2e.sh` builds the Linux machine builds, fake agent and X program of Docker's architecture and the image (cached). Without Docker these tests skip; `E2E_REQUIRE_DOCKER=1` (CI) makes them fail instead.

Release archives are in `dist/release/`; the unpacked directories are in `dist/packages/`. herdr-core upgrades change the version and the four archive digests in `backend/scripts/hcdist.ts`; its license and notices are taken from the release archive by `backend/scripts/fetch-hc.ts`. Rerun the integration tests with the new executable before distributing a release.

The desktop app builds on the system it is for. `make dev-desktop` builds and launches Electron with the embedded UI, the same isolated session and instance `dev` (its hub runs inside the app); stop other dev hubs first. On Windows that run connects no machine (it is local-only, and the local machine has no agent there). `make desktop-app` builds the unpacked app and `make desktop-dist` the installers: the DMG and zip on macOS, the NSIS setup on Windows, the AppImage and deb on Linux; `make desktop-install` (macOS) builds the `.app` and replaces the one in `/Applications`, quitting and reopening it if it runs. On Windows, install Git for Windows and run `scripts/desktop.sh dev|app|dist` in Git Bash (the make targets call the same script). `DESKTOP_OS=win` or `linux` packages another system's unpacked app to check its packaging (`scripts/desktop.sh app`); see [desktop deployment](docs/deployment.md#desktop-app). Branch workspaces can live in the ignored `.worktrees/` directory.

## Pull requests

- Keep each PR focused; describe the user-visible change and how you tested it (the template asks for this).
- `make check test` must pass (`make check` also fails when modules of the web UI import each other in a cycle: `web/scripts/cycles.mjs` counts the imports that exist at run time, so move what both sides need into a module below them); CI (`.github/workflows/ci.yml`) runs the same on Linux, with the hub's slow tests, plus `make it` against the pinned herdr-core, the cross-compiled release archives and Windows hub, and a `desktop` job on Linux, macOS and Windows: the web and desktop tests and the packaged Electron app (`scripts/desktop.sh app`), and the hub's tests on macOS.
- New npm packages of the hub: run `scripts/notices.sh` and commit `THIRD_PARTY_NOTICES.md` (checked by CI); make sure the license is compatible with MIT.
- Add or update tests with behavior changes. The hub's live as `<name>.test.ts` beside its modules in `backend/`; web tests in `web/src/__tests__`, desktop tests in `desktop/src/*.test.ts`. Vectors the web tests run, and the hub's tests where the rule is theirs too (keys, ssh targets, transcripts), live in `spec/vectors/` (`make check` fails when a vector file is run by no web test).
- Update the docs in the same PR: flags, endpoints and files in [docs/reference.md](docs/reference.md) (CI checks every flag and route is listed; `make tokens` regenerates its tables of settings and commands), components and protocols in [docs/architecture.md](docs/architecture.md), feature behavior and its reasoning in [docs/features/](docs/features/README.md), operations in [docs/deployment.md](docs/deployment.md). Leave [CHANGELOG.md](CHANGELOG.md) alone: it is written when a release is cut ([RELEASING.md](RELEASING.md)), from the pull requests' titles and descriptions, so describe user-visible changes there.
- Commit messages: short imperative subject (`server: stop idle code-server`), optional scope prefix by area (`agent:`, `web:`, `docs:`, …).

## Conventions

- **Names:** never hardcode the product name. Use `backend/shared/lib/brand.ts` in the hub, `web/src/brand.ts` in the UI and `src/brand.ts` in the extension (`scripts/check.sh` enforces this). Renames go through `scripts/rename.sh`.
- **Text:** user-visible strings go through i18n — `t('key')` with the key in `web/src/i18n/en.ts` and a translation in `zh-CN.ts` (a plugin's in its `web/src/plugins/<id>/i18n/`); extension strings in `package.nls*.json` / `l10n/`. The server sends codes, not sentences. Code comments, logs and identifiers are English.
- **READMEs:** `README.md` (English) is canonical; keep `README.zh-CN.md` in step (same sections, checked by CI). Reference material lives once in `docs/` (English).
- **Protocols:** hub and agent always ship together; extend `backend/shared/proto/agentproto` by adding fields or ops, never by changing meanings.
- **Security:** read [SECURITY.md](SECURITY.md) before touching the hub's guards (`backend/kernel/http/guard.ts`), the agent's file or socket handling, or anything that downloads or executes.
- **Formatting:** Prettier for TypeScript (`pnpm -C web format`, `pnpm -C backend format`).

## Project layout

See [docs/architecture.md](docs/architecture.md).
