# 38 · State in SQLite

## Context

The chat host's journal ([37](37-agent-chats.md)) keeps hundreds of chats
with their events, evicted within bounds, read a page at a time and safe
across crashes. Before it, state that was neither configuration nor the
terminal core's lived in files each feature wrote its own way: the terminal
history ([36](36-terminal-history.md)), the vault's access log
([30](30-variable-vault.md)), the AI usage history and cost cache
([29](29-ai-usage.md)), each with its own rules for partial writes,
rotation and two writers.

Constraints: the core builds for Linux, macOS and Windows and the machines'
build for Linux and macOS, all without cgo; the files hold names,
directories and terminal output, so they are the user's alone; a home may
be shared by several hosts over NFS, where SQLite's write-ahead log works
for one host only; a downgrade must not destroy what a newer version wrote;
earlier files are taken over once, without loss.

## Goals / non-goals

Goals: one way to open a private database with versioned schemas;
transactions for every change; earlier files imported once, then removed;
per-host files on shared homes; a database a newer program wrote is read,
not written.

Non-goals: the files the user edits (settings, keybindings, machines), the
vault's file (one encrypted document) and the layout (the terminal core's)
stay as they are ([13](13-settings-and-appearance.md)); sharing a database
between processes of different roles; replication.

## Design

### Opening (`internal/store`)

The driver is `modernc.org/sqlite` (SQLite compiled to Go, no cgo, about
4.7 MB a binary). `store.Open(path, Options{Migrations})`:

- **Private.** Directory 0700 and file 0600, both the user's and not links;
  SQLite's `-wal`, `-shm` and `-journal` files must not be links either
  (`ErrUnsafe`). On Windows the profile's ACL keeps them private.
- **Connections.** WAL, `busy_timeout` (5 s), foreign keys,
  `synchronous` NORMAL (a power loss may lose the last transactions, never
  the database), `IMMEDIATE` transactions (two writers never deadlock),
  incremental vacuum for new databases.
- **Schema.** `PRAGMA user_version` counts the migrations applied, each
  once in a transaction; released migrations never change. A database of a
  newer version is opened read-only with `ErrNewer`.

`DB.Update` runs a transaction; `DB.Durable` one that is on disk when it
returns (`synchronous` FULL), for the vault's release records and the
history's snapshots. `DB.Reclaim` returns free pages once they are at least
8 MiB and a quarter of the file.

### Shared databases

The core's and a machine's database hold several features of one owner.
`store.OpenShared(path)` hands out handles of one connection pool per file
and process (reopened when the file was replaced). Each feature brings its
own prefixed tables to its own version with `DB.Migrate(feature, steps)`,
recorded in `store_features`; a feature a newer program migrated further is
read, not written (`ErrNewer`). `DB.Import(ctx, feature, name, fn)` runs a
one-time import of earlier files in a transaction recorded in
`store_imports`; a failed import changes nothing and runs again, and the
caller removes its files only after success. A shared database's directory
may be a link of the user's to a directory of the user's (dotfile
managers); `Open` alone refuses links.

### What lives where

| Database | Owner | Where | Holds |
| --- | --- | --- | --- |
| `core[-<instance>]-<host>[-<id>].db` | the core | beside its settings file ([reference](../reference.md#files-and-directories)) | the vault's access log, the AI usage history |
| `machine-<host>[-<id>].db` | the machine's agent | the instance's data directory on the machine (`~/.herdr-ide[-<instance>]/`) | terminal history snapshots and their writers' lease, the AI usage cost cache |
| `chat-<host>[-<id>].db` | the chat host | the same data directory | chats, events, trusted folders, the host's settings ([37](37-agent-chats.md)); opened with `Open`, not shared |

The core keeps its database open while it runs (none without a settings
file). No two processes of different roles write one database; two agents
of one instance share the machine's, and the history's writers take turns
through its lease.

### Per-host names

WAL needs every connection on one host (`-shm` is shared memory), and data
directories may be on shared homes, so each database is named after its
host (`store.HostFile`): `<name>-<host>[-<id>].db`, where `<host>` is the
sanitized full host name and `<id>` 8 hex digits of a hash of the machine id
(`/etc/machine-id` and similar on Linux, the platform UUID on macOS,
`MachineGuid` on Windows). Cloned hosts or equal names on two clusters thus
get separate files. The chat host's log files are named the same way.

`store.MigrateLegacy` moves an earlier un-hosted database to the per-host
name once (`VACUUM INTO`, `quick_check`, then removal of the old file).
`store.PruneHostFiles` runs at each owner's start and removes other hosts'
databases unused for 30 days (use is the file's modification time, which
`Open` refreshes hourly) and leftover un-hosted files after an hour. It
removes only under SQLite's writer lock taken without waiting, only this
user's regular files, never files this process holds, and nothing on
Windows; the core skips other instances' files.

### One-time imports

| Feature | Kept before | Notes |
| --- | --- | --- |
| Terminal history | `<data>/history/` (`.vt` and `.json` per terminal) | the directory is removed after; a link or foreign directory is neither read nor removed |
| Vault access log | `vault[-<instance>]-access.jsonl` | a file written again after a downgrade has its missing records merged and is removed |
| AI usage history | `usage-history[-<instance>].json` | a file of another version or that does not parse stays |
| AI usage cost cache | `<data>/usage/cost-cache.json` | removed after |

## Alternatives considered

| Option | Why not |
| --- | --- |
| `ncruces/go-sqlite3` (WebAssembly) | 6.0–6.5 MB a binary against 4.7–4.9 MB, same portability. |
| A driver with cgo | Machine builds and the Windows core are cross-compiled without a C toolchain. |
| One database per feature | More files to keep private, prune and open; prefixes and per-feature versions keep features apart. |
| One database for core and machines | Different processes and hosts; WAL works for one host. |
| A directory per host | Same isolation, one more directory to keep private and prune. |
| The host's short name | Equal names in two domains, or clones, would share a file. |
| Rollback journal on shared homes | Readers would wait for writers that write often. |
| Keeping the earlier files | Two copies diverge after a downgrade; one recorded import is the one source. |

## Failure modes

- **Newer database** → read-only: history changes answer `io`, the vault
  refuses releases (`log_failed`), usage numbers stay in memory, a chat host
  does not serve.
- **Directory or file not the user's, or a link** → `ErrUnsafe`; the same
  degradations as above.
- **Failed import** → nothing changes; it runs again next time.
- **Two agents of one instance** → SQLite's locks between them; a history
  capture that does not get the lease within 2 s answers `busy`.
- **File system without locks** → per-host names keep each database to one
  host; pruning removes nothing it cannot lock.
- **Power loss** → NORMAL may lose the last transactions, `Durable` writes
  are kept.

## Security

Every database is a private file (0600 in 0700, no links) on the host it
belongs to. Contents: chat events (prompts, output, tool calls; never
answers to secret questions), terminal snapshots while `history.capture` is
on, the vault's access records (names and requesters, never values), usage
numbers, model names and project directories. See the state databases row
in [SECURITY.md](../../SECURITY.md).

## Testing

- `internal/store`: `store_test.go` (migrations, pragmas, newer databases,
  permissions, links), `shared_test.go` (pools, per-feature migration,
  imports, `Durable`, `Reclaim`), `host_test.go`/`host_unix_test.go`
  (names, pruning, machine ids).
- Feature tests for imports, newer versions and per-host files:
  `internal/agent/plugin/history/history_test.go`,
  `internal/plugins/vault/accesslog_test.go`,
  `internal/plugins/usage/history_test.go`,
  `internal/usage/cost_cache_test.go`, `internal/chathost`
  (`TestOtherHostsJournalsGo`, `TestLogFile`).
