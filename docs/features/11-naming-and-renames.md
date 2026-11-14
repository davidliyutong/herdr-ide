# 11 · Naming and renames

## Context

The project started as "webherdr" and was renamed to "herdr-ide" with the
mechanism described here. The name appears in binaries, the Go module
path, directories on every machine, the terminal core's session,
environment variables, browser storage, the VS Code extension identity, the
applications' bundle IDs, protocol prefixes and documentation. A rename
should be quick, mechanical and safe for existing installs.

## Goals / non-goals

Goals: one place per language that defines the name; a single command that
renames everything; existing state migrates instead of being orphaned; CI
prevents new hardcoded names.

Non-goals: running two names side by side; renaming herdr-core's own
identifiers (its executable, `HC_*` variables and state directory).

## Design

- **Definitions**: `internal/brand/brand.go` (Go: `Name`, `Slug`,
  `EnvPrefix`, binary and extension names, `DataDirName`, `DataDir(instance)`,
  `AgentDir`, `BridgeExtID`), `web/src/brand.ts` (`APP_NAME`, `APP_SLUG`,
  namespaced `storage`), `extensions/herdr-ide-bridge/src/brand.ts`
  (`SLUG`, `DATA_DIR`, `ENV_PREFIX`), `macos/Sources/TermKit/Brand.swift`
  (`Brand.appName`, `Brand.appSlug`, `Brand.envPrefix`). Display name and
  slug are separate, so the visible name can change without touching
  identifiers.
- **Consistency**: `internal/brand/brand_test.go` checks that the
  TypeScript and Swift copies and the extension's `package.json` agree with
  Go; `scripts/check.sh` fails on string literals containing the slug in Go,
  TypeScript, Swift and `.strings` files outside these files (imports,
  comments and tests excepted). Build scripts, the Makefile and the Vite
  config derive names from these files; the PWA manifest and page title are
  generated from `brand.ts`. The desktop launcher imports the web brand
  constants; electron-builder reads the same file for its app name, bundle
  ID and bundled core path. `scripts/macos-app.sh` reads the Go constants
  for the macOS application's name, bundle ID (`dev.<slug>.mac`) and
  bundled core.
- **Derived at runtime**: the agent's state directory
  (`~/.<slug>[-<instance>]`), the terminal core's session name
  (`<slug>[-<instance>]`, [21](21-terminal-core.md)), the proxy-secret
  header, the environment variables (`HERDR_IDE_*`), the core's
  configuration directory and download cache, and browser storage keys.
- **Rename**: `scripts/rename.sh NEW [--name "Display"] [--module PATH]
  [--dry-run]` replaces the slug, the env prefix and the module path (through
  a placeholder, so an explicit `--module` is never rewritten), moves
  `cmd/<slug>`, `cmd/<slug>-agent` and `extensions/<slug>-bridge`, sets the
  display name in the Go, web and Swift brand files, removes generated
  artifacts, and runs the build and brand test.
- **Migration**: the script appends the old names to the `Legacy*` lists
  (`internal/brand/brand.go`) and `LEGACY_SLUGS` (`web/src/brand.ts`). At
  runtime the agent renames `~/.<old>` to `~/.<new>` if the new directory
  does not exist (default instance), the core moves its configuration
  directory (settings, keybindings and machines files) from the old name
  when the new one does not exist and deletes the old download cache,
  code-server uninstalls the old bridge extension id once, and the web UI
  moves `localStorage` keys from the old prefix. The terminal core's
  session name is not in these lists.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Search-and-replace when needed | Persisted state (remote directories, browser storage, extension ids) would be orphaned silently. |
| A permanent internal id separate from the name | Leaves the old name in paths forever; migration keeps paths meaningful. |
| Generate all files from one JSON | Manifests (VS Code `package.json`, Go constants) cannot import it without a generation step; the brand test gives the same guarantee. |

## Failure modes

- **Both old and new data directories exist** → the agent keeps the new one;
  the old one is left for manual inspection.
- **The previous version is still running** → its code-server would keep
  answering on the moved socket while its files are gone (every page 404),
  so the agent stops whatever listens on the old directory's `cs.sock` before
  moving it. Stop the previous core before starting the renamed one: its
  agent loses its directory.
- **The bridge extension's command ids in VS Code keybindings**
  (`<slug>.sendToAgent`, `<slug>.download`) change with the slug; users
  rebind them. The core's own commands (`tab.new`, `pane.close`…) carry no
  product name, so `keybindings[-<instance>].json` stays valid.

## Testing

`internal/brand/brand_test.go` (`TestBrandMirrorsAgree`: Go, the web UI,
the extension and the macOS application); `internal/agent/lifecycle_test.go`
(`TestHousekeepingAndMigration`: legacy directory migration),
`internal/agent/codeserver_test.go` (`TestMigrationStopsLegacyCodeServer`);
`scripts/check.sh` brand step. The rename
script was run on a copy of the repository (rename to a new slug and display
name): no old name remained outside the legacy lists, and the Go tests and
repository checks passed.
