# 15 · Bundled herdr

## Context

herdr-ide drives herdr on every machine, so a host without herdr could not use
its local terminals until the user installed herdr separately. Release
archives therefore carry herdr. Bundling only replaces that installation step:
herdr keeps its own configuration, state, sessions, machine catalog, server
lifecycle and updates, exactly as if the user had installed it.

## Goals / non-goals

Goals: ship the matching native herdr for Linux/macOS on amd64/arm64; verify
upstream downloads at build time; let a host without herdr use the bundled one.

Non-goals: separate herdr configuration, state or machine catalogs; starting,
stopping or upgrading herdr servers; installing herdr on SSH machines; Windows.

## Design

- `internal/herdrdist` pins herdr 0.9.5 and the SHA-256 digests of the four
  upstream release assets. `scripts/fetch-herdr` maps Go platforms to upstream
  names (`darwin` → `macos`, `amd64` → `x86_64`, `arm64` → `aarch64`),
  downloads into a temporary file, verifies it and only then renames it into
  `dist/herdr/`. A cached file that fails verification is downloaded again.
  Hashing is shared with code-server downloads (`internal/checksum`).
- `scripts/build.sh` builds the agents and the core, then `scripts/package.sh`
  creates `dist/release/<slug>-<os>-<arch>.tar.gz` (unpacked copies in
  `dist/packages/`). Each archive contains the core, only its native `herdr`,
  and the application and herdr license notices (`licenses/herdr/`, generated
  by `scripts/herdr-notices.py`). The four remote agents stay embedded in the
  core without herdr. No upstream binary is executed while cross-compiling.
- The bundled executable is the `herdr` beside the real core executable
  (symlinks to the core are resolved). The core does not verify it at runtime:
  once extracted it is the user's herdr installation like any other, and
  `herdr update` may replace it.
- The local agent searches for herdr as on any machine (`HERDR_BIN`, `PATH`,
  `~/.local/bin`, `~/.cargo/bin`, package-manager locations, the login shell)
  and uses the bundled one only when none is found (`agent.Options.BundledHerdr`,
  `internal/agent/herdr.go`). An installed herdr wins, so the CLI the agent runs
  matches the server the user starts with it.
- herdr uses its usual locations: configuration and sockets under
  `~/.config/herdr`, the machine catalog in
  `~/.local/state/herdr/client/endpoints.json`, both following
  `XDG_CONFIG_HOME` and `XDG_STATE_HOME`. The core sets no herdr-specific
  environment.
- The local herdr server belongs to the user: herdr-ide connects to a running
  session and neither starts nor stops it. Opening the herdr TUI starts it.
- `herdr-ide herdr [args]` replaces the core process with the bundled herdr and
  passes arguments, environment, stdio, signals and exit status through
  unchanged (`cmd/herdr-ide/main.go`). Hosts without herdr on `PATH` use it
  for `herdr-ide herdr machine add …` or to open the TUI.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Install the bundled herdr on SSH machines | Embedding herdr for four platforms grows the core by about 100 MB, and users already manage remote installations with herdr itself. |
| A separate herdr profile (private XDG directories, machine catalog, keymap, auto-started server) | Panes inherit herdr's environment, so the private XDG directories leaked into the user's shells and tools. It also hid the user's machines and keybindings, and made herdr-ide own a server lifecycle that herdr already manages. |
| Prefer the bundled herdr over an installed one | The agent's CLI could then differ in version from the server the user started with the installed herdr. |
| Verify the bundled herdr's digest on every start | Hashes about 25 MB per start and fails after herdr's own self-update; the download is verified before packaging. |

## Failure modes

- Unsupported platform or failed checksum during the build → the build fails
  before packaging.
- The core is moved out of its release directory → there is no bundled
  fallback; without an installed herdr the local machine reports that herdr
  was not found, and `herdr-ide herdr` names the missing path.
- No local herdr session is running → the local machine shows an error until
  the user starts herdr.
- Installed and bundled herdr differ in version → the installed one is used;
  herdr reports protocol mismatches itself.

## Security

Build-time downloads are verified against the pinned digests. At runtime the
bundled herdr is trusted like an installed one. herdr-ide never downloads herdr
at runtime and never uploads it to SSH machines.

## Testing

`internal/herdrdist/release_test.go` covers platform mapping and corrupt
downloads, `internal/checksum` the shared hashing, and
`internal/agent/herdr_test.go` that an installed herdr wins over the bundled
one and the bundled one is used when nothing is installed.
`HERDR_TEST_BIN=<path to the bundled herdr> make it` runs the integration test
with the bundled executable in the isolated `herdr-ide-it` session.
