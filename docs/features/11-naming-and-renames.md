# 11 · Naming and renames

## Context

The product name appears in binaries, the Go module path, directories on
every machine, the terminal core's session, environment variables, browser
storage, the VS Code extension's identity, the desktop app's bundle ID and
the docs. A rename must be quick, mechanical and safe for existing
installs.

## Goals / non-goals

Goals:

- one place per language defines the name;
- one command renames everything;
- existing state migrates instead of being orphaned;
- CI rejects new hardcoded names.

Non-goals: running two names side by side; renaming herdr-core's own
identifiers (its executable, `HC_*` variables, state directory).

## Design

- **Definitions**:
  - Go: `internal/brand/brand.go` (`Name`, `Slug`, `EnvPrefix`,
    `DataDir(instance)`, `AgentDir`, `BridgeExtID`, …);
  - web UI: `web/src/brand.ts` (`APP_NAME`, `APP_SLUG`, namespaced
    `storage`);
  - extension: `extensions/herdr-ide-bridge/src/brand.ts`.

  Display name and slug are separate, so the visible name can change
  without touching identifiers.
- **Consistency**: `internal/brand/brand_test.go` checks that the
  TypeScript copies and the extension's `package.json` agree with Go.
  `scripts/check.sh` fails on string literals with the slug in Go and
  TypeScript outside these files. Build scripts, the Makefile, Vite, the
  PWA manifest, the desktop launcher and electron-builder derive names from
  them.
- **Derived at runtime**: the agent's state directory
  (`~/.<slug>[-<instance>]`), the terminal core's session
  (`<slug>[-<instance>]`, [21](21-terminal-core.md)), the proxy-secret
  header, environment variables (`HERDR_IDE_*`), the core's configuration
  directory and download cache, browser storage keys, the label and name
  that hide the product's own terminals (`<slug>.hidden`,
  `<slug>-chat-host`), the notices' methods (`_<slug>/<name>`), and the
  client name chat agents are given (`CLAUDE_CODE_ENTRYPOINT=<slug>`,
  Codex's client name; [37](37-agent-chats.md)).
- **Rename**: `scripts/rename.sh NEW [--name "Display"] [--module PATH]
  [--dry-run]` replaces the slug, env prefix and module path, moves
  `cmd/<slug>` and `extensions/<slug>-bridge`, sets the display name,
  removes generated artifacts, then builds and runs the brand test.
- **Migration**: the script appends old names to the `Legacy*` lists
  (`internal/brand/brand.go`) and `LEGACY_SLUGS` (`web/src/brand.ts`). At
  runtime:
  - the agent of the default instance renames `~/.<old>` to `~/.<new>`
    when the new one does not exist (`internal/agent/housekeeping.go`);
  - the core moves its configuration directory from the old name when the
    new one does not exist (`cmd/herdr-ide/serve.go`) and deletes the old
    download cache (`internal/codeserver/artifacts.go`);
  - code-server uninstalls the old bridge extension once;
  - the web UI moves `localStorage` keys from the old prefix.

  The terminal core's session name is not migrated.
- **State moved into SQLite** ([38](38-sqlite-state.md)): a feature that
  kept its state in a file of its own imports it once into its database,
  in a transaction recorded in `store_imports`, and removes the file only
  after that committed; a failed import changes nothing and is tried
  again. The terminal history's `history/` and the cost cache's
  `usage/cost-cache.json` go into the machine's `machine-<host>.db`; the
  vault's access log and the usage history into the core's
  `core[-<instance>].db`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Search-and-replace when needed | Persisted state (remote directories, storage, extension ids) would be orphaned silently. |
| A permanent internal id separate from the name | Leaves the old name in paths forever. |
| Generating all files from one JSON | Manifests cannot import it without a generation step; the brand test gives the same guarantee. |

## Failure modes

- **Both old and new data directories exist** → the agent keeps the new
  one and leaves the old one for manual inspection.
- **The previous version is still running** → its code-server would answer
  on the moved socket with its files gone, so the agent stops whatever
  listens on the old `cs.sock` before moving. Stop the previous core before
  starting the renamed one.
- **VS Code keybindings to the bridge's commands** (`<slug>.sendToAgent`,
  `<slug>.download`) change with the slug and must be rebound. The core's
  own command ids carry no product name, so `keybindings[-<instance>].json`
  stays valid.

## Testing

- `internal/brand/brand_test.go` (`TestBrandMirrorsAgree`).
- `internal/agent/lifecycle_test.go` (`TestHousekeepingAndMigration`) and
  `internal/agent/codeserver_test.go` (`TestMigrationStopsLegacyCodeServer`).
- The brand step of `scripts/check.sh`.
- The imports: `TestImportFiles`, `TestImportFailureLeavesFiles`
  (`internal/agent/plugin/history`), `TestAccessLogImport`
  (`internal/plugins/vault`), `TestHistoryImport` (`internal/plugins/usage`),
  `TestCostCacheImport` (`internal/usage`), `TestImportOnce`
  (`internal/store`).
- The rename script was run on a copy of the repository: no old name
  remained outside the legacy lists, and tests and checks passed.
