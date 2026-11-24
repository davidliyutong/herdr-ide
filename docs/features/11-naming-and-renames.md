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
- the previous version keeps running, with its terminals, until the user
  has moved what they want, one workspace or tab at a time;
- CI rejects new hardcoded names.

Non-goals: moving a running program to another terminal core; renaming
herdr-core's own identifiers (its executable, `HC_*` variables, state
directory).

## Design

- **Definitions**:
  - Go: `internal/brand/brand.go` (`Name`, `Slug`, `EnvPrefix`,
    `DataDir(instance)`, `AgentDir`, `BridgeExtID`, …);
  - web UI: `web/src/brand.ts` (`APP_NAME`, `APP_SLUG`, namespaced
    `storage`);
  - extension: `extensions/veldr-bridge/src/brand.ts`.

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
  (`<slug>[-<instance>]-<host id>`, [21](21-terminal-core.md)), the proxy-secret
  header, environment variables (`VELDR_*`), the core's configuration
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
  (`internal/brand/brand.go`) and `LEGACY_SLUGS` (`web/src/brand.ts`).
  The renamed version is a namespace of its own beside the previous one
  (`~/.<new>` and `~/.<old>` on machines, two terminal cores, two desktop
  apps), so the previous version keeps working. At runtime:
  - the core copies its configuration directory (settings, machines,
    keybindings, the vault, its databases as consistent copies) from the
    old name when the new one does not exist (`cmd/veldr/serve.go`);
    the old one stays for the previous version;
  - a machine's chat host copies its database from the previous namespace
    when it has none yet (`internal/chathost/journal.go`), so moved chat
    panes find their chats;
  - the download caches of names older than the newest previous one are
    deleted (`internal/codeserver/artifacts.go`);
  - the web UI moves `localStorage` keys from the old prefix.
- **Moving workspaces** (plugin `migrate`: `internal/plugins/migrate`,
  `internal/agent/plugin/migrate`, `web/src/plugins/migrate`). While a
  connected machine has a previous namespace, the status bar says so; its
  dialog lists the previous layout's workspaces and tabs, each pane with
  what runs in it: the coding agent the machine finds in the foreground
  (and its session, from the agent's process), another program, or a
  shell. Moving picked tabs:
  1. starts a shell in this namespace's terminal core for each of their
     terminals, in the directory its program is in;
  2. writes the previous layout without them at the version read (another
     client's change since is a conflict: nothing changes and the shells
     end), then ends their previous terminals;
  3. adds the tabs to this layout, in the workspace of the same name and
     directory or a new one; terminals on the new shells, other panes with
     new ids. A coding agent's terminal asks for its agent back (`resume`,
     [33](33-workspace-restore.md)): its session by id when the machine
     found it, else the directory's latest.

  Other programs end with their terminals; the dialog names them before.
  When nothing is left, **Stop Previous Terminal Service…** stops the
  previous terminal core and **Remove Previous Files…** removes the
  previous data directory and herdr-core's state of its session, refused
  while its core or a node of it runs (its UI connected) or, for the
  default namespace, which also holds the previous version's builds,
  while another of its namespaces runs.

  The previous namespace is read in its own layout (`run/hc.sock`, session
  `<old>[-<instance>]`), the one versions before
  [40](40-shared-homes.md) had.
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
| Moving `~/.<old>` to `~/.<new>` at the first start | The previous terminal core runs from that directory: its terminals would be lost, and the previous version could not run beside the new one. |
| The new namespace adopting the previous terminal core | Two versions would write one layout and serve one set of sockets; the per-host layout ([40](40-shared-homes.md)) could not apply to it. |
| Moving everything at once | Programs that run (builds, servers, agents mid-turn) end with their terminals; the user chooses when each tab can go. |

## Failure modes

- **The previous layout changed while the dialog was open** (its UI is
  open): the move is a conflict, nothing changes, and the dialog reads the
  layout again.
- **A move fails after the shells started**: they end; the previous
  terminals keep running.
- **A chat started in the previous version after the new one's chat host
  first ran** is not in its database; continue it from its terminal or
  import its session.

- **VS Code keybindings to the bridge's commands** (`<slug>.sendToAgent`,
  `<slug>.download`) change with the slug and must be rebound. The core's
  own command ids carry no product name, so `keybindings[-<instance>].json`
  stays valid.

## Testing

- `internal/brand/brand_test.go` (`TestBrandMirrorsAgree`).
- The brand step of `scripts/check.sh`.
- Moving: `internal/agent/plugin/migrate` (`TestScanAndRelease`,
  `TestRemove`, with a scripted previous terminal core),
  `internal/plugins/migrate` (`TestRoutes`, `TestRelease`),
  `web/src/__tests__/migratePlan.test.ts`; copies: `TestCopyDB`
  (`internal/store`).
- The imports: `TestImportFiles`, `TestImportFailureLeavesFiles`
  (`internal/agent/plugin/history`), `TestAccessLogImport`
  (`internal/plugins/vault`), `TestHistoryImport` (`internal/plugins/usage`),
  `TestCostCacheImport` (`internal/usage`), `TestImportOnce`
  (`internal/store`).
- The rename script was run on a copy of the repository: no old name
  remained outside the legacy lists, and tests and checks passed.
