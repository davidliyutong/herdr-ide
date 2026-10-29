# 11 · Naming and renames

## Context

"webherdr" is a working name. The name appears in binaries, the Go module
path, directories on every machine, environment variables, browser storage,
the VS Code extension identity, protocol prefixes and documentation. A rename
should be quick, mechanical and safe for existing installs.

## Goals / non-goals

Goals: one place per language that defines the name; a single command that
renames everything; existing state migrates instead of being orphaned; CI
prevents new hardcoded names.

Non-goals: running two names side by side; renaming herdr-related
identifiers (herdr session names, herdr paths).

## Design

- **Definitions**: `internal/brand/brand.go` (Go: `Name`, `Slug`,
  `EnvPrefix`, binary and extension names, `DataDirName`, `DataDir(instance)`,
  `AgentDir`, `BridgeExtID`), `web/src/brand.ts` (`APP_NAME`, `APP_SLUG`,
  namespaced `storage`), `extensions/webherdr-bridge/src/brand.ts`
  (`SLUG`, `DATA_DIR`, `ENV_PREFIX`). Display name and slug are separate, so
  the visible name can change without touching identifiers.
- **Consistency**: `internal/brand/brand_test.go` checks that the TypeScript
  copies and the extension's `package.json` agree with Go;
  `scripts/check.sh` fails on string literals containing the slug outside
  these files (imports, comments and tests excepted). Build scripts, the
  Makefile and the Vite config derive names from these files; the PWA
  manifest and page title are generated from `brand.ts`.
- **Rename**: `scripts/rename.sh NEW [--name "Display"] [--module PATH]
  [--dry-run]` replaces the slug, the env prefix and the module path (through
  a placeholder, so an explicit `--module` is never rewritten), moves
  `cmd/<slug>`, `cmd/<slug>-agent` and `extensions/<slug>-bridge`, removes
  generated artifacts, and runs the build and brand test.
- **Migration**: the script appends the old names to the `Legacy*` lists.
  At runtime the agent renames `~/.<old>` to `~/.<new>` if the new directory
  does not exist, the core deletes the old download cache, code-server
  uninstalls the old bridge extension id once, and the web UI moves
  `localStorage` keys from the old prefix.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Search-and-replace when needed | Persisted state (remote directories, browser storage, extension ids) would be orphaned silently. |
| A permanent internal id separate from the name | Leaves the old name in paths forever; migration keeps paths meaningful. |
| Generate all files from one JSON | Manifests (VS Code `package.json`, Go constants) cannot import it without a generation step; the brand test gives the same guarantee. |

## Failure modes

- **Both old and new data directories exist** → the agent keeps the new one;
  the old one is left for manual inspection.
- **Command ids in user keybindings** (`<slug>.sendToAgent`) change with the
  slug; users rebind them.

## Testing

`internal/brand/brand_test.go`; `internal/agent/lifecycle_test.go`
(legacy directory migration); `scripts/check.sh` brand step. The rename
script was run on a copy of the repository (rename to a new slug and display
name): no old name remained outside the legacy lists, and the Go tests and
repository checks passed.
