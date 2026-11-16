# 30 Variable vault

## Context

Coding agents on every machine need the same API keys and tokens (GitHub,
model providers, cloud accounts). Copying them into each machine's shell
profile spreads secrets in clear text over every host, keeps them in every
process's environment and leaves no record of who read what. The core
already reaches every machine and has a UI the user watches; it can keep
the secrets in one place and hand them to agents that ask, with the user
deciding.

## Goals / non-goals

- One encrypted store of named variables on the core host, edited in the UI;
  values never sent to browsers except on an explicit, audited reveal.
- Coding agents on any machine (Claude Code, Codex, any MCP client) read
  them through an MCP server, or run a command with them set without seeing
  them.
- Per-variable allowed machines; other machines ask the user, who allows
  once, always or denies.
- Non-goal: putting variables into terminals' environments. Every program
  of a terminal would get them, for the terminal's whole life.
- Non-goal: protection against the user's own programs on an allowed
  machine: any process of the user there can ask as an agent does.
- Non-goal: protection against the user's own programs on the core host.
  There approval is advisory: a local process can call the core's loopback
  API (no `Origin` header needed) to answer its own request or reveal a
  value, content the core serves on its own origin (code-server's webviews,
  VS Code extensions) passes the origin check, and on macOS the keychain
  item, created with `/usr/bin/security`, can be read by any process of the
  user. The panel says so for the local machine.
- Non-goal: configuring the CLIs. The user adds the MCP server once per
  machine; the panel shows how.

## Design

### Store (`internal/vault`)

The vault is `vault[-<instance>].json` beside the settings file (0600,
written atomically by `internal/userfile`):
`{version, mode, kdf, check, entries: [{name, description, machines,
injectOnly, value: {nonce, ciphertext}, created, updated}]}`. Each value is
encrypted with AES-256-GCM under the master key, with the variable's name
as additional data, so a ciphertext copied to another entry does not open.
`check` is a known text sealed with the key, which tells a wrong key or
passphrase. Fields the version does not know are kept.

The master key is 32 random bytes, created when the first value is stored
and kept in the system keychain (`github.com/zalando/go-keyring`: macOS
Keychain, Windows Credential Manager, the Secret Service on Linux; service
`<slug>-vault`, account the file's name, so instances have keys of their
own). The vault is then unlocked at every start by reading the key. Where
no keychain answers (a headless Linux host), the vault turns to passphrase
mode: the key is derived with Argon2id (time 3, 64 MiB, 4 threads; salt and
parameters in the file), set the first time it is entered, and the vault is
locked after every start until the passphrase is entered in the panel.
Parameters read from the file must be within bounds (a 16-byte salt, time
1–10, memory 8 MiB–1 GiB, 1–16 threads), or the vault does not open: an
edited file can neither weaken the derivation nor exhaust the core's
memory. A
keychain vault whose key is gone or unreadable stays locked and says why
(`key_missing`, `keychain_unavailable`); its names can still be listed and
deleted.

Names are environment variable names (`^[A-Za-z_][A-Za-z0-9_]*$`, at most
128); values at most 64 KiB, descriptions at most 1 KiB, at most 1000
variables. `machines` lists machine ids, `*` for all; removing a machine
from the core removes its id from every variable's list
(`plugin.MachineForgetter`, audited as `vault.machine_forgotten`), so a
machine added later under the same id asks again. `injectOnly` variables
are only given to `run_with_env`, which does not stop a command from
printing them encoded (base64, say): it keeps them out of the
conversation by accident, not against a command written to reveal them.

### Core (`internal/plugins/vault`)

The plugin `vault` (setting `plugins.vault.enabled`, on by default) opens
the store at its first use. Its routes, below `/api/p/vault`
([reference](../reference.md#http-and-websocket-endpoints)): the list
(state and variables without values), `PUT`/`DELETE vars/{name}`,
`POST vars/{name}/reveal`, `POST vars/{name}/rename` (`{"to"}`: the value
is sealed again under the new name, its additional data, so the vault must
be unlocked; machines, description and flag stay; a taken name is
`409 exists`), `unlock`, `lock`, the pending `requests` and their answers,
and the access `log`. Every route that changes something is
a writing route (refused read-only) audited with the name or request id.

The MCP servers' requests arrive as streams the agent opens with op
`vault` (`plugin.Streamer`): one `VaultRequest {tool, names, client,
terminal, cwd}` line, one `VaultResponse` line. The core takes the machine
from the session the stream came on; what the request says about its
client, terminal and directory is shown to the user, not trusted.

- `list`: every variable's name, description, `inject_only` and whether
  this machine needs approval. Works while locked.
- `get` (one name) and `env` (1–64 names): unknown names fail with
  `not_found`, an inject-only variable with `inject_only` for `get`, a
  locked vault with `vault_locked`. Names whose `machines` hold the machine
  or `*` are given at once. For the others the core sends every page
  `plugin {plugin: vault, m, data: {type: request, request}}` and waits up
  to 60 s: **Allow once** gives the values this time, **Always allow** adds
  the machine to each variable's list and gives them, **Deny**, no answer
  or the requester going away deny. A request identical to one waiting
  (machine, tool, names) waits for that one's answer instead of prompting
  again; beyond 4 waiting requests of the machine, or 32 in all, a request
  fails with `busy`, so one machine cannot crowd out another's prompts.
  The first answer wins; the answer, the timeout and the last requester's
  leaving are decided under one lock, so a page's answer that the core
  takes (`200`) is the answer the requesters get, and one that comes too
  late gets `404`. The core then sends `{type: resolved, id, answer}`,
  which closes the prompt on every page.

Each request is recorded with names only: in the audit log
(`vault.access`; results `allowed`, `approved` (once), `approved_always`,
`listed` or the error's code) and in a log of the last 500 kept in memory,
shown in the panel. List calls and `busy` refusals, which a program can
repeat at will, are merged into the previous record when they repeat it
(`count`), audited at most once a minute per machine (with the number
skipped) and do not make the pages reload. Answers are audited as
`vault.answered` (machine, tool, names, answer), saved variables as
`vault.saved` (allowed machines, `inject_only`, whether the value changed),
never with values. Other changes send `{type: changed}`, on which pages
load the vault again.

### Machines

Every agent listens on `<run>/vault.sock` (0600; connections only from its
own user, by peer credentials; at most 16 at once) and relays each
connection to the core over a stream with op `vault`, as the VS Code
bridge's socket does. It ends with the agent; a socket another agent of the
instance serves is left to it.

The MCP server is the `mcp` command of the agent and of the core (the local
machine's agent runs in the core's process). The agent keeps
`<data dir>/bin/<slug>-mcp` a link to its running executable: agents are
uploaded under their build's hash, so the link is the path that stays the
same across updates. Started by that name, the executable runs the MCP
server for the data directory the link is in, without arguments.

The server (`internal/vaultmcp`) speaks MCP over stdio (JSON-RPC 2.0, one
message per line; revisions 2025-06-18, 2025-03-26 and 2024-11-05):
`initialize`, `ping`, `tools/list`, `tools/call`; notifications get no
answer. It identifies its client by its parent process's name
(`/proc/<ppid>/comm` on Linux, `/bin/ps` on macOS) and its terminal by
`HC_TERMINAL_ID`, which terminals of the terminal core carry. Each tool
call is one connection to `vault.sock`. Its tools:

- `list_variables`;
- `get_variable {name}`: the value, as the tool's text: it enters the
  agent's conversation;
- `run_with_env {command, names, cwd?, timeout?}`: runs `sh -c command` in
  its own process group with the variables added to the server's
  environment and stdin closed, and returns the exit status and up to
  64 KiB of combined output, in which each value as it appears is replaced
  with `***`; killed after `timeout` seconds (default 120, at most 600).
  The process group is killed when the command returns too, so programs it
  left in the background (`sleep 999 &`) do not outlive the call with the
  values in their environment; Wait gives up after 2 s on output such a
  program still holds. A program that leaves the group (`setsid`, a
  daemon) escapes it.
  Masking misses values that are encoded, split or transformed: it keeps
  values out of the conversation by accident, not against a command
  written to reveal them.

The server exits when its stdin closes, killing the commands it still runs.

### Web UI (`web/src/plugins/vault`)

The panel **Variable Vault** of the right sidebar (command
`view.panel.vault`, no default key): the lock state with Lock/Unlock and
the passphrase form, requests waiting, the variables with search, an editor
(name, description, a write-only value field that sets a new value, inject
only, the machines allowed without asking), reveal after a confirmation
(disabled read-only), delete after a confirmation, the access log, and per
machine the setup (for the local machine with the note that approval
there is advisory, also on its approval prompts): `claude mcp add --scope user <slug>-vault -- <data
dir>/bin/<slug>-mcp`, Codex's `[mcp_servers.<slug>-vault]` in
`~/.codex/config.toml`, and the JSON other clients take, each with a copy
button, built from the machine's home and data directory. The approval
prompts are drawn over every page by the plugin's status item, from its
`/ws` messages and, for a page opened while one waits, `GET requests`.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Inject variables into terminals | Every program of the terminal gets them for its whole life, and agents read their environment anyway; no per-use approval or record. |
| The vault on each machine | Secrets would be copied to every host; one store on the core host is where the user is. |
| An MCP server over HTTP from the core | Machines would need a port reaching the core, or the core one per machine; the agent's yamux session already connects them, and nothing listens on TCP on machines. |
| An MCP SDK | Four methods over stdio are a small amount of JSON-RPC; an SDK would add dependencies to the agent uploaded to every machine. |
| Keychain on every machine | Headless Linux machines have none; the core host's keychain is enough, as the core holds the key. |
| Values in the browser for editing | A value shown in a page is in its memory, its extensions' reach and its screen; the editor only sets new values. |

## Failure modes

- Locked vault: `get` and `env` fail with `vault_locked`; the panel shows
  the lock and, in passphrase mode, the form. A lost passphrase cannot be
  recovered: delete the variables (allowed while locked) or the file.
- Keychain entry removed: the vault stays locked with `key_missing`; the
  values cannot be decrypted.
- Nobody answers: the request is denied after 60 s; the agent gets
  `denied` and can ask again.
- Too many requests waiting: past 4 of the machine (or 32 in all) the
  agent gets `busy`, says so to the model, and can ask again once the user
  answered.
- The agent or the core gone: the MCP server reports `unavailable` for the
  call and keeps running; the next call connects again.
- The plugin off: the core refuses the stream with `plugin_disabled`,
  which the agent passes to the MCP server.
- The core keeps no settings file: the vault is `unavailable` (503).

## Security

The rows of [SECURITY.md](../../SECURITY.md) on the vault's file and key,
values in browsers, reading variables from machines and what the MCP
server exposes.

## Testing

- `internal/vault/vault_test.go`: round trips with a key store in memory
  (never the system keychain), the name binding values, passphrase mode
  (setup, wrong passphrase, lock), validation, Argon2 parameters out of
  bounds refused, file permissions, unknown fields kept, a removed
  machine leaving the lists.
- `internal/plugins/vault/vault_test.go`: lists without values, allowed
  machines, inject only, locked, approvals (once, always persisting, deny,
  timeout, requester gone, first answer wins), an answer racing the
  timeout, at most 4 waiting requests per machine and identical requests
  sharing one, list calls coalesced, answers and saves audited, a removed
  machine forgotten, routes, audit without values.
- `internal/vaultmcp/mcp_test.go`: JSON-RPC over pipes (initialize and
  version negotiation, notifications, tools), masking, truncation,
  timeouts that kill the process group, errors reaching the model, the
  socket's path from the link; `run_unix_test.go`: programs left in the
  background killed when the command returns.
- `internal/agent/vault_test.go`: `vault.sock` (0600) relayed to the core as
  op `vault`, the link to the executable.
- `internal/server/machines_test.go`: removing a machine tells the plugins
  (`TestMachineRemove`).
- `internal/server/plugins_test.go`: agents' streams of a plugin's op, refused
  while the plugin is off; `TestMutatingRoutesAreGuarded` covers the
  vault's routes.
- `web/src/__tests__/vault.test.ts`: the panel without values, reveal after
  confirming, the editor's request, read-only, the approval prompt answered
  and resolved elsewhere, the local machine's note, the setup snippets.
