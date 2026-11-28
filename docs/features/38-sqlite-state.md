# 38 · State in SQLite

## Context

Chats ([37](37-agent-chats.md)), terminal history ([36](36-terminal-history.md)), the vault's access log ([30](30-variable-vault.md)) and AI usage ([29](29-ai-usage.md)) need transactions and crash safety without a compiled addon, on homes several hosts may share over NFS, where SQLite's write-ahead log works for one host only.

## Goals / non-goals

Goals: private databases with versioned schemas, per-host files on shared homes, a newer program's database read and never written. Non-goals: the files the user edits ([13](13-settings-and-appearance.md)); a database shared by processes of different roles; replication.

## Design

`open(path, {migrations})` (`backend/shared/store`, on `node:sqlite`):

- **Private.** Directory 0700, file 0600, the user's and not links, SQLite's `-wal`, `-shm` and `-journal` included (`UnsafeError`); on Windows the profile's ACL.
- **Connections.** WAL, a busy timeout, `synchronous` NORMAL (a power loss may lose the last transactions, never the database), `IMMEDIATE` transactions; `DB.durable` syncs on return (the vault's release records, history snapshots).
- **Schema.** `PRAGMA user_version` counts migrations, each applied once; released ones never change. A newer database opens read-only (`NewerError`). Several features of one owner share a database through `openShared`, each versioning its prefixed tables with `DB.migrate`.

`node:sqlite` is synchronous, so statements run in worker threads (`backend/hosts/bun/state-worker.ts` on machines, `backend/hosts/common/hub-state-worker.ts` in the hub). The databases: the hub's `hub[-<instance>]-<host>[-<id>].db` beside its settings file (access log, usage history; [reference](../reference.md#files-and-directories)); in a machine's data directory `machine-<host>[-<id>].db` (terminal history, usage cost cache) and the chat host's `chat-<host>[-<id>].db`. A hub without a settings file keeps its state in memory.

### Per-host names

Each database is named after its host's key (`hostFile`, [40](40-shared-homes.md)): the sanitized full host name and 8 hex digits of a hash of the machine id (`/etc/machine-id`, macOS's platform UUID, Windows's `MachineGuid`), so clones and equal names on two clusters get separate files; the chat host's logs alike. `pruneHostFiles` removes, at each owner's start, other hosts' databases unused for 30 days, only under SQLite's writer lock taken without waiting, never another instance's, nothing on Windows. The hub also removes this host's database of the old name `core[-<instance>]-<host>[-<id>].db` unread, unless a process holds it (`tidyHubDBs`).

## Alternatives considered

- **A native SQLite module**: a compiled addon per platform; `node:sqlite` is built in.
- **The host's short name**: clones and equal names in two domains would share a file.
- **Rollback journal on shared homes**: readers would wait for frequent writers.

## Failure modes

- **Newer database or unsafe file** → history changes answer `io`, the vault refuses releases (`log_failed`), usage stays in memory, a chat host does not serve.
- **Two agents of one instance** → SQLite's locks; history writers take turns through a lease, a capture without it answers `busy`.
- **File system without locks** → per-host names keep each database to one host; pruning removes nothing it cannot lock.

## Security

Every database is private on its own host. It holds chat events (never answers to secret questions), terminal snapshots while `history.capture` is on, access records (never values), usage numbers and project directories: the state databases row of [SECURITY.md](../../SECURITY.md).

## Testing

`backend/shared/store/*.test.ts`, `backend/shared/host/hostid.test.ts`, and each owner's tests for newer and per-host files (`backend/features/history/machine.test.ts`, `backend/features/vault/accesslog.test.ts`, `backend/features/usage/store.test.ts`, `backend/features/chat/machine/host/host.test.ts`).
