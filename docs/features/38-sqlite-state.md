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

Constraints: the core builds for Linux, macOS and Windows (with Bun) and
the machines' build for Linux and macOS without a compiled addon; the files hold names,
directories and terminal output, so they are the user's alone; a home may
be shared by several hosts over NFS, where SQLite's write-ahead log works
for one host only; a downgrade must not destroy what a newer version wrote.

## Goals / non-goals

Goals: one way to open a private database with versioned schemas;
transactions for every change;
per-host files on shared homes; a database a newer program wrote is read,
not written.

Non-goals: the files the user edits (settings, keybindings, machines), the
vault's file (one encrypted document) and the layout (the terminal core's)
stay as they are ([13](13-settings-and-appearance.md)); sharing a database
between processes of different roles; replication.

## Design

### Opening (`backend/shared/store`)

The core and the machine side (the agent, the chat host) open their
databases with `backend/shared/store`, on `node:sqlite` (`DatabaseSync`,
which Bun and Electron's Node both have; its calls are synchronous, so a
statement waiting for another process's lock blocks the thread). Databases
the Go program of earlier releases wrote (with `modernc.org/sqlite`) follow
the same rules and open alike. `open(path, {migrations})`:

- **Private.** Directory 0700 and file 0600, both the user's and not links;
  SQLite's `-wal`, `-shm` and `-journal` files must not be links either
  (`UnsafeError`). On Windows the profile's ACL keeps them private.
- **Connections.** WAL, `busy_timeout` (5 s), foreign keys,
  `synchronous` NORMAL (a power loss may lose the last transactions, never
  the database), `IMMEDIATE` transactions (two writers never deadlock),
  incremental vacuum for new databases.
- **Schema.** `PRAGMA user_version` counts the migrations applied, each
  once in a transaction; released migrations never change. A database of a
  newer version is opened read-only with `NewerError`.

`DB.update` runs a transaction; `DB.durable` one that is on disk when it
returns (`synchronous` FULL), for the vault's release records and the
history's snapshots. `DB.reclaim` returns free pages once they are at least
8 MiB and a quarter of the file.

### Shared databases

The core's and a machine's database hold several features of one owner.
`openShared(path)` hands out handles of one connection pool per file
and process (reopened when the file was replaced). Each feature brings its
own prefixed tables to its own version with `DB.migrate(feature, steps)`,
recorded in `store_features`; a feature a newer program migrated further is
read, not written (`NewerError`). `store_features` is the store's own table,
versioned by the database's `user_version`; the layout's first step also
creates a table `store_imports`, unused, which its second step drops
(applied steps never change). A shared database's directory
may be a link of the user's to a directory of the user's (dotfile
managers); `open` alone refuses links.

### What lives where

| Database | Owner | Where | Holds |
| --- | --- | --- | --- |
| `core[-<instance>]-<host>[-<id>].db` | the core | beside its settings file ([reference](../reference.md#files-and-directories)) | the vault's access log, the AI usage history |
| `machine-<host>[-<id>].db` | the machine's agent | the instance's data directory on the machine (`~/.veldr[-<instance>]/`) | terminal history snapshots and their writers' lease, the AI usage cost cache |
| `chat-<host>[-<id>].db` | the chat host | the same data directory | chats, events, trusted folders, the host's settings ([37](37-agent-chats.md)); opened with `open`, not shared |

The core keeps its database open while it runs (none without a settings
file). No two processes of different roles write one database; two agents
of one instance share the machine's, and the history's writers take turns
through its lease.

### Per-host names

WAL needs every connection on one host (`-shm` is shared memory), and data
directories may be on shared homes, so each database is named after its
host (`hostFile`): `<name>-<host>[-<id>].db`, where `<host>[-<id>]`
is the host's key (`hostid.key`, which also names the host's directory,
[40](40-shared-homes.md)): `<host>` the sanitized full host name and
`<id>` 8 hex digits of a hash of the machine id
(`/etc/machine-id` and similar on Linux, the platform UUID on macOS,
`MachineGuid` on Windows). Cloned hosts or equal names on two clusters thus
get separate files. The chat host's log files are named the same way.

`pruneHostFiles` runs at each owner's start and removes other hosts'
databases unused for 30 days (use is the file's modification time, which
`open` refreshes hourly). A file of no host's name is not its business and
stays. It removes only under SQLite's writer lock taken without waiting, only this
user's regular files, never files this process holds, and nothing on
Windows; the core skips other instances' files.

## Alternatives considered

| Option | Why not |
| --- | --- |
| A native SQLite module (better-sqlite3 and the like) | A compiled addon per platform, which `bun build --compile` and Electron would each need; `node:sqlite` is built into both. |
| One database per feature | More files to keep private, prune and open; prefixes and per-feature versions keep features apart. |
| One database for core and machines | Different processes and hosts; WAL works for one host. |
| A directory per host | Same isolation, one more directory to keep private and prune. |
| The host's short name | Equal names in two domains, or clones, would share a file. |
| Rollback journal on shared homes | Readers would wait for writers that write often. |

## Failure modes

- **Newer database** → read-only: history changes answer `io`, the vault
  refuses releases (`log_failed`), usage numbers stay in memory, a chat host
  does not serve.
- **Directory or file not the user's, or a link** → `UnsafeError`; the same
  degradations as above.
- **Two agents of one instance** → SQLite's locks between them; a history
  capture that does not get the lease within 2 s answers `busy`.
- **File system without locks** → per-host names keep each database to one
  host; pruning removes nothing it cannot lock.
- **Power loss** → NORMAL may lose the last transactions, `durable` writes
  are kept.

## Security

Every database is a private file (0600 in 0700, no links) on the host it
belongs to. Contents: chat events (prompts, output, tool calls; never
answers to secret questions), terminal snapshots while `history.capture` is
on, the vault's access records (names and requesters, never values), usage
numbers, model names and project directories. See the state databases row
in [SECURITY.md](../../SECURITY.md).

## Testing

- `backend/shared/store`: `store.test.ts` (migrations, pragmas, newer
  databases, permissions, links), `shared.test.ts` (pools, per-feature
  migration, `durable`, `reclaim`), `host.test.ts` (names, pruning);
  `backend/shared/host/hostid.test.ts` (keys and ids, the machine id).
- Feature tests for newer versions and per-host files:
  `backend/features/history/machine.test.ts`,
  `backend/features/vault/accesslog.test.ts`,
  `backend/features/usage/store.test.ts`,
  `backend/features/usage/machine/databases.test.ts`,
  `backend/features/chat/machine/host/host.test.ts`.
