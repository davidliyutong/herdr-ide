# 38 · State in SQLite

## Context

The chat host's journal ([37](37-agent-chats.md)) keeps hundreds of
chats with their events, rewritten as bounds evict them and read a page
at a time, safely across crashes. Before it, the product's state that was
neither configuration nor the terminal core's lived in files each feature
wrote in its own way: the terminal history's two generations of files per
terminal with a lock file ([36](36-terminal-history.md)), the vault's
access log as appended JSON lines ([30](30-variable-vault.md)), the AI
usage plugin's history and each machine's cost cache as whole JSON files
rewritten at each save ([29](29-ai-usage.md)). Each had its own rules for
partial writes, rotation and two writers.

Constraints: the core builds for Linux, macOS and Windows and the
machines' build for Linux and macOS, all without cgo; the files hold
names, directories and what terminals showed, so they are the user's
alone; a home may be shared by several hosts over NFS, where SQLite's
write-ahead log (a shared-memory file) works for one host only; a
downgrade must not destroy what a newer version wrote; earlier files are
taken over once, without loss.

## Goals / non-goals

Goals: one way to open a private database with versioned schemas;
transactions for every change; the earlier files imported once and then
removed; per-host files on shared homes, the others' removed once unused;
a database a newer program wrote is read and not written.

Non-goals: the configuration files the user edits (settings, keybindings,
machines), the vault's file (one encrypted document) and the layout (the
terminal core's), which stay what they are
([13](13-settings-and-appearance.md)); sharing a database between
processes of different roles; replication.

## Design

### Opening (`internal/store`)

The driver is `modernc.org/sqlite` (SQLite compiled to Go): every system
the core and the machines build for has it without cgo, for about 4.7 MB
a binary.

`store.Open(path, Options{Migrations})` takes an absolute path:

- **Private.** Its directory is created 0700, or must be a directory of
  this user that is no link, and is made 0700; the file is created 0600,
  or must be a regular file of this user that is no link, and is made
  0600; SQLite's `-wal`, `-shm` and `-journal` files must not be links
  either (`ErrUnsafe`). On Windows the profile's access control list keeps
  them the user's, and modes and owners are not looked at.
- **Connections.** Write-ahead logging (set when the database is opened
  for writing, retried while another program opens it), `busy_timeout`
  (5 s by default), foreign keys enforced, `synchronous` NORMAL (a power
  loss may lose the last transactions, never the database), transactions
  `IMMEDIATE` (a writer takes the lock when it begins, so two writers
  never deadlock upgrading theirs), and for a database it creates
  incremental vacuuming.
- **Schema.** `PRAGMA user_version` counts the migrations applied, each
  once, in one transaction; a released migration never changes, a change
  is a new one at the end. A database of a version above the code's is
  opened read-only and returned with `ErrNewer`.

`DB.Update` runs a transaction; `DB.Durable` runs one that is on disk
when it returns (`synchronous` FULL on its connection): the vault's
records that let values out and the history's snapshots. `DB.Reclaim`
gives free pages back to the file system once they are at least 8 MiB
and a quarter of the file.

### Shared databases

The core's database and a machine's hold the state of several features
of one owner. `store.OpenShared(path)` opens one with the store's own
layout (`store_features`: each feature's schema version;
`store_imports`: the one-time imports that ran) and hands out handles of
one connection pool per file and process; the pool closes with its last
handle, and a file removed or replaced since is opened anew. A feature
brings its tables, named with its name as prefix, to its own version
with `DB.Migrate(feature, steps)`, independently of the others; tables a
newer program migrated further are read and not written
(`ErrNewer` from `Migrate`), and so is every feature of a database whose
layout is newer. A shared database in a directory that is a link of the
user's to a directory of the user's (a dotfile manager's) is opened in
the link's target; `Open` alone refuses links.

`DB.Import(ctx, feature, name, fn)` runs a feature's import of what it
kept before in a transaction that records it: once committed, it never
runs again for that database, in any process. A failing import changes
nothing and runs again next time; the caller removes the files it read
only after `Import` returned without an error.

### What lives where

| Database | Owner | Where | Features |
| --- | --- | --- | --- |
| `core.db` (`core-<instance>.db`) | the core | beside its settings file on the core host ([reference](../reference.md#files-and-directories)) | the vault's access log (`vault_access`), the AI usage history (`usage_windows`, `usage_accounts`, `usage_alerts`) |
| `machine-<host>.db` | the machine's agent | the instance's data directory on the machine (`~/.herdr-ide[-<instance>]/`) | the terminal history's snapshots and the lease of their writers (`history_snapshots`, `history_lease`), the AI usage plugin's cost cache (`usage_cost_files`, `usage_cost_state`) |
| `chat-<host>.db` | the chat host | the same data directory | the chats, their events, the trusted folders, the host's settings ([37](37-agent-chats.md)); opened with `Open`, not shared |

The core keeps `core.db` open while it runs, so the plugins' uses take
the open pool; a core without a settings file keeps no database. No two
processes of different roles write one database; two agents of one
instance (two cores that reach a machine) share the machine's, and the
history's writers take turns through its lease.

### Per-host names

SQLite's write-ahead logging needs every connection of a database on one
host (its `-shm` file is shared memory). A data directory may be on a
home several hosts share, so the databases a machine's processes own are
named after the host they run on (`store.HostFile`):
`<name>-<host>[-<id>].db`, where `<host>` is the host's whole name,
lower case, with what is not a letter, a digit, `-`, `_` or `.` replaced
by `_`, at most 128 bytes (`localhost` for none), and `<id>` the first 8
hexadecimal digits of the SHA-256 of the machine's own id (with a prefix
of the store's own): `/etc/machine-id`, `/var/lib/dbus/machine-id` or
`/etc/hostid` on Linux, the platform UUID (`ioreg`, 5 s) on macOS, the
installation's `MachineGuid` on Windows; none in a container without one.
Two hosts of one name (cloned machines, `node01` of two clusters sharing
a home) thus have two databases. The chat host's log files are named the
same way.

`store.PruneHostFiles(dir, name, retention)` removes the databases of
other hosts of that name (and the one of no host's name, from before they
were named per host) that nobody opened for 30 days, with their journal
files: the agent at its start (`machine`), the chat host at its start
(`chat`, its log files). A database counts as used by its file's
modification time, which `Open` sets at most once an hour and keeps
setting hourly while it is open. A removal takes, without waiting, the
lock SQLite's writers take and removes the files while it holds it, so
no connection, also another host's as far as the file system's locks
reach, reads the database meanwhile; a lock it cannot take (held, or no
locks on the file system) keeps the database, and so do a file or journal
file that is not this user's regular file and one this process has open.
On Windows nothing is removed. A host renamed starts afresh; its old
database goes once unused for the retention.

### The one-time imports

| Feature | Kept before | Imported |
| --- | --- | --- |
| Terminal history | `~/.herdr-ide[-<instance>]/history/` (`<address>.vt` and `.json`, two generations) | the whole generations, when the database is opened; the directory is removed after, also one an older agent left again later; a directory that is a link or not the user's is neither read nor removed |
| Vault access log | `vault[-<instance>]-access.jsonl` beside the vault's file | its records (the end, at most what the bounds keep); removed after. One there again later (a core of an earlier version wrote it after a downgrade) has the records the table lacks added after the table's, in the order of their times, and is removed |
| AI usage history | `usage-history[-<instance>].json` beside the settings | its points, accounts and alerts; removed after. A file of another version, or one that does not parse, is not imported and stays |
| AI usage cost cache | `~/.herdr-ide[-<instance>]/usage/cost-cache.json` | its entries; removed after |

The settings, keybindings, machines and vault files stay files: the user
edits the first three by hand, and the vault is one encrypted document.

## Alternatives considered

| Option | Why not |
| --- | --- |
| `ncruces/go-sqlite3` (SQLite in WebAssembly) | 6.0–6.5 MB a binary against 4.7–4.9 MB, with the same portability. |
| A database driver with cgo | The machine builds and the Windows core are cross-compiled without a C toolchain. |
| One database per feature | More files to keep private, prune and open; features of one owner share a pool and keep apart by table prefixes and versions. |
| One database for the core and the machines | Different processes and hosts; WAL works for one host. |
| A directory per host (`<host>/machine.db`) | The same isolation, and a directory more to keep private and prune; a suffix keeps the data directory flat. |
| The host's first name label | Two hosts named alike in two domains, or cloned machines, would share one; the whole name with the machine id's hash tells them apart. |
| Rollback journal (no WAL) on shared homes | Readers would wait for writers; the history's captures and the chat host's events write often while pages read. |
| Keeping the earlier files beside the database | Two copies diverge after a downgrade; an import once, recorded in the database, and the file removed after it committed, is the one source. |

## Failure modes

- **A database of a newer version** → opened read-only. The history
  answers its changes with `io` ("newer version"); the vault refuses
  releases (`log_failed`) and keeps refusals in memory; the usage history
  and the cost cache stay in memory; a chat host does not serve
  ([37](37-agent-chats.md)).
- **A directory or file that is not the user's own, or a link** →
  `ErrUnsafe`, and nothing is created through the link: the history's
  actions fail with `io` (without a path), the vault refuses what needs a
  record (`log_failed`), the usage numbers stay in memory.
- **An import that fails** → nothing changes, the files stay and the
  import runs again next time.
- **Two agents of one instance** → one pool each, the database's locks
  between them; the history's lease says who writes, and a capture that
  does not get it within 2 s answers `busy`.
- **Two hosts on one shared home** → a database each; their files stay
  apart, and the other hosts' go once unused for 30 days.
- **A file system without locks** (some NFS setups) → SQLite's locks do
  not hold across hosts; per-host names keep each database to one host,
  and pruning removes nothing it cannot lock.
- **A power loss** → the last transactions of `synchronous` NORMAL may be
  lost, never the database; `Durable` writes are not.
- **A data directory moved under a running process** → the shared pool
  opens the file anew when its identity changed.

## Security

Every database is a private file of the user (0600 in a 0700 directory,
not a link, the journal files neither), on the machine or core host it
belongs to. What each holds: the chats' events (prompts, the agents'
output, tool calls and diffs, never answers to secret questions nor the
agents' standard error), the terminal history's snapshots (what terminals
showed, which may hold secrets, only while `history.capture` is on), the
vault's access records (names and who asked, never values), the AI usage
numbers, model names and project directories. Pruning removes only this
user's regular files of the database's name, under SQLite's writers'
lock. See the row on state databases in [SECURITY.md](../../SECURITY.md).

## Testing

- `internal/store/store_test.go`: migrations once, pragmas, a newer
  database opened read-only, concurrent opens, permissions, links
  refused, paths quoted. `shared_test.go`: one pool, a replaced file,
  features migrating independently, a newer feature or layout, imports
  once, `Durable` and `Update`, permissions, a linked directory,
  `Reclaim`. `host_test.go`, `host_unix_test.go`: host names, pruning (a
  recent journal file kept, a held database kept), marking used, machine
  ids.
- `internal/agent/plugin/history/history_test.go`: the database private,
  the files imported and kept when the import fails, a newer import kept,
  two agents capturing, the lease, a newer version, per-host databases.
- `internal/plugins/vault/accesslog_test.go`: the log across a restart,
  the import, after a downgrade, a newer version, the database beside the
  settings. `internal/plugins/usage/history_test.go`: the import, a file
  of another version, a failed read, a newer version.
  `internal/usage/cost_cache_test.go`: the import, saves of what changed,
  two agents, a newer version, per host.
- `internal/chathost`: other hosts' journals removed
  (`TestOtherHostsJournalsGo`), the log file (`TestLogFile`).
- The driver's size and cross-compilation for Linux, macOS (amd64,
  arm64) and Windows (amd64) were measured with `CGO_ENABLED=0` builds.
