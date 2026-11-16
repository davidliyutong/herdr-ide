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
- One gate for every caller, the core host's own programs included: a
  value leaves the vault only for a machine the variable lists or with the
  user's approval, and approving, revealing and changing need the vault's
  passphrase, which programs on the core host do not have. What it does
  not cover: a variable that lists machines is open to any program that
  runs on one of them, and programs on the core host can run commands on
  every machine (through the core's terminals, or ssh with the user's
  keys), so only variables that ask every time are kept from them; the
  panel says so and recommends asking every time for important secrets.
- Non-goal: putting variables into terminals' environments. Every program
  of a terminal would get them, for the terminal's whole life.
- Non-goal: protection against the user's own programs on an allowed
  machine: any process of the user there can ask as an agent does.
- Non-goal: protection against a program that drives the user's own
  browser page after the user unlocked it (browser automation), reads the
  core's memory (a debugger with the rights to), or guesses a weak
  passphrase offline from the file.
- Not yet covered: content the core serves on the UI's own origin, VS
  Code's windows (code-server, proxied from a machine below
  `/m/{id}/code/`), can reach the page that holds a session (the page
  itself reaches into those windows for keys) and so read its session or
  the passphrase typed into it. Programs that can change code-server's
  files on a machine, or VS Code extensions there, can therefore pass the
  gate once the user opens VS Code; serving code-server from an origin of
  its own closes this (SECURITY.md).
- Non-goal: configuring the CLIs. The user adds the MCP server once per
  machine; the panel shows how.

## Design

### Store (`internal/vault`)

The vault is `vault[-<instance>].json` beside the settings file (0600,
written atomically by `internal/userfile`):
`{version: 3, mode, kdf, check, passphraseSet, entries: [{name,
description, machines, injectOnly, value: {nonce, ciphertext}, created,
updated}], forgotten}`. Each value is encrypted with AES-256-GCM under the
master key; its additional data is a JSON object of the file's version, its
name, its machines (sorted) and its inject-only flag (one text per content:
machine ids with control characters are refused), so a ciphertext copied
to another entry, or an entry whose machines were widened or flag dropped
in the file (to let a machine read it without asking), does not open
(`corrupt`). Changing machines or the flag through the store seals the
value again, which needs the key. `check` is a known text sealed with the
key, which tells a wrong passphrase. A file of another version that holds
a passphrase or variables (development builds sealed differently, or kept
the key in the system keychain) does not open (`version`), nor does one
whose passphrase lacks its parameters or check, or that holds variables
without a passphrase: such a file is moved away by hand. Fields the version
does not know are kept.

The master key is derived from the user's passphrase with Argon2id (time
3, 64 MiB, 4 threads; a new 16-byte salt and the parameters in the file)
and kept only in the core's memory while the vault is unlocked; the vault
is locked after every start until the passphrase is given. A new vault
asks for its passphrase (at least 8 characters) before its first value
(`no_passphrase`). Parameters read from the file must be within bounds (a
16-byte salt, time 1–10, memory 8 MiB–1 GiB, 1–16 threads), or the vault
does not open: an edited file can neither weaken the derivation nor
exhaust the core's memory. Changing the passphrase needs the current one
and seals every value again under a key of a new salt. When the passphrase
was set or last changed (`passphraseSet`) is shown in the panel: a new
vault's first passphrase needs no session (it has no values yet), so a
passphrase set by a program instead of the user shows as one the user did
not choose.

A machine removed from the core leaves every variable's list
(`plugin.MachineForgetter`, audited as `vault.machine_forgotten`), so a
machine added later under the same id asks again. Taking it out seals the
values again: until the key is there (while locked) the machine goes into
`forgotten` instead, which no variable lets read without asking, and is
taken out of the lists at the next unlock; a value that does not open keeps
it forgotten. `forgotten` only ever narrows who may read.

Names are environment variable names (`^[A-Za-z_][A-Za-z0-9_]*$`, at most
128); values at most 64 KiB, descriptions at most 1 KiB, at most 1000
variables. `machines` lists machine ids, `*` for all. `injectOnly` variables
are only given to `run_with_env`, which does not stop a command from
printing them encoded (base64, say): it keeps them out of the
conversation by accident, not against a command written to reveal them.

### Core (`internal/plugins/vault`)

The plugin `vault` (setting `plugins.vault.enabled`, on by default) opens
the store at its first use. Its routes, below `/api/p/vault`
([reference](../reference.md#http-and-websocket-endpoints)): the list
(state and variables without values), `PUT`/`DELETE vars/{name}`,
`POST vars/{name}/reveal`, `POST vars/{name}/rename` (`{"to"}`: the value
is sealed again under the new name, its additional data; machines,
description and flag stay; a taken name is `409 exists`), `session`
(open, end), `passphrase` (set, change), `lock`, the pending `requests` and
their answers, and the access `log`. Every route that changes something is
a writing route (refused read-only) audited with the name or request id.

**The gate.** The core's API is open to any program on the core host (it
needs no `Origin` header), so the API cannot tell the user from a program.
The passphrase can: setting, changing, renaming and deleting variables,
revealing a value and allowing a request (`once`, `always`; denying needs
nothing) need a **vault session** of the page, sent as `X-Vault-Session`,
or answer `401 vault_session` (audited as `denied.vault_session`). A page
opens one with the passphrase (`POST session`, which also unlocks the
vault; setting or changing the passphrase opens one too): 32 random bytes
the core keeps in memory and the page only in its own memory, never in
storage that programs could read from disk. Only what passes the gate
counts as a session's use: loading the list says whether the session is
open without keeping it so. A session ends unused for 30 minutes, 12
hours after it began, when the vault is locked (every one) or its
passphrase changed (every other one); a session that a passphrase check
would open after such an end (the check crossed it) is not opened; at most
32 are open, the oldest going. Passphrases are checked one at a time
(`429 wait` while one is checked); three wrong ones in a row cost nothing,
each one after doubles a wait before the next try (`429 wait` with
`Retry-After`, up to 5 minutes), across pages and programs, so a program
can also make the user wait. Opening a session and changing the passphrase
are audited (`vault.unlocked`, `vault.passphrase_set`, with whether it
worked), never with the passphrase; reveals and deletions as
`vault.revealed` and `vault.deleted` once done. A machine's MCP server
reaches the vault only through its agent's socket and the same rules as
every machine: the core host's agent is the local machine's.

The MCP servers' requests arrive as streams the agent opens with op
`vault` (`plugin.Streamer`): one `VaultRequest {tool, names, client,
terminal, cwd}` line, one `VaultResponse` line. The core takes the machine
from the session the stream came on; what the request says about its
client, terminal and directory is shown to the user, not trusted.

- `list`: every variable's name, description, `inject_only` and whether
  this machine needs approval. Works while locked.
  (Approval, below, needs a page with a session: the gate.)
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
`view.panel.vault`, no default key):

- **The gate** at the top: a new vault's card to create the passphrase
  (twice, with a strength bar and the warning that it cannot be
  recovered); otherwise, without a session, a card to unlock this page with
  the passphrase, and with one a bar that says the page is unlocked until
  30 idle minutes, with Change Passphrase and Lock; both say when the
  passphrase was set. A page that the gate refuses (its session ended)
  shows the unlock card again. The passphrase fields keep password
  managers away (`autocomplete="off"` and the attributes 1Password,
  LastPass and Bitwarden honor): a passphrase saved by a browser is
  readable by programs on the computer in several browsers.
- Requests waiting for an answer.
- Three tabs. **Variables**: search, New Variable, and a row per variable
  with its name, the inject-only tag, its description and who may read it
  without asking (every time asks, the machines chosen, all machines, in
  the colors of safe to open); reveal after a confirmation, hidden again
  after 30 s, and edit, both only with a session. The editor is a dialog:
  name, description, a write-only value field (shown while typing on
  request) that sets a new value, who may read without asking (ask every
  time, chosen machines with their state, all machines), inject only as a
  switch, and Delete after a confirmation. **Access log**: the accesses
  since the core started by day, filtered by machine and outcome, each
  with its time, outcome (allowed by the list, approved, refused, listed),
  tool, names, machine, client and terminal. **Connect**: per machine,
  `claude mcp add --scope user <slug>-vault -- <data dir>/bin/<slug>-mcp`,
  Codex's `[mcp_servers.<slug>-vault]` in `~/.codex/config.toml` and the
  JSON other clients take, each with a copy button, built from the
  machine's home and data directory, and for the local machine the note
  that variables any machine may read without asking are open to its
  programs (which reach every machine through the core or ssh), so that
  important secrets ask every time. The editor's choices say the same.

The approval prompts are drawn over every page by the plugin's status
item, from its `/ws` messages and, for a page opened while one waits,
`GET requests`: the client, machine, names, terminal and directory, the
seconds left, and Deny, Always Allow and Allow Once; a page without a
session asks for the passphrase in the prompt before allowing. A list
loaded while a session started or ended says nothing about it (the page
keeps the newer state).

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Inject variables into terminals | Every program of the terminal gets them for its whole life, and agents read their environment anyway; no per-use approval or record. |
| The vault on each machine | Secrets would be copied to every host; one store on the core host is where the user is. |
| An MCP server over HTTP from the core | Machines would need a port reaching the core, or the core one per machine; the agent's yamux session already connects them, and nothing listens on TCP on machines. |
| An MCP SDK | Four methods over stdio are a small amount of JSON-RPC; an SDK would add dependencies to the agent uploaded to every machine. |
| Keychain on every machine | Headless Linux machines have none; the core host holds the key. |
| The key in the system keychain (as development builds did) | Any program of the user reads it without a prompt (on macOS through `/usr/bin/security`; the Secret Service and the Credential Manager alike) and with the file has every value: no approval stands before a program on the core host. Such files are not converted: no request can show that the user, not a program, chose the new passphrase, and none was released. |
| The loopback API or the page's origin as the user's proof | Programs on the core host call the API as pages do, and content on the core's origin passes the origin check; the passphrase is what only the user has. |
| Upgrading files sealed with less additional data | Their machine lists were not authenticated: an upgrade would seal a widened list in; none was released, so such files are refused. |
| Biometrics (Touch ID) per approval | Not available to pages in every browser, nor in the same way on every system; the passphrase works everywhere and a session spares asking for it at every approval. |
| Machines and flag in the clear, unauthenticated | A program on the core host could widen a variable's machines in the file and read it without asking; sealing them with the value makes such an edit unreadable. |
| Values in the browser for editing | A value shown in a page is in its memory, its extensions' reach and its screen; the editor only sets new values. |

## Failure modes

- Locked vault (after every start): `get` and `env` fail with
  `vault_locked` until a page unlocks it. A lost passphrase cannot be
  recovered: delete the file and start again.
- A file of another version (a development build's): the vault is
  `unavailable` and says so; move the file away to start a new one.
- The file edited (machines widened, flag dropped, values swapped): that
  value no longer opens (`corrupt`).
- A page's session ended (idle, locked, the passphrase changed): the gate
  answers `401 vault_session` and the page asks for the passphrase again.
- Wrong passphrases in a row: `429 wait` for a while that doubles.
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

- `internal/vault/vault_test.go`: a new vault's passphrase first (and when
  it was set), the value not in the clear, wrong passphrases leaving it
  locked, verify; the version, name, machines and flag binding values
  (swapped values, machines widened or added and flag dropped in the
  file), additional data with one text per content and control characters
  refused; files of other versions, of the keychain mode, without a
  passphrase's parameters or with variables but no passphrase refused;
  changing the passphrase; validation; Argon2 parameters out of bounds
  refused; file permissions; unknown fields kept; a removed machine leaving
  the lists at once or, locked, at the next unlock, and staying forgotten
  for a value that does not open.
- `internal/plugins/vault/vault_test.go`: lists without values, allowed
  machines, inject only, locked, approvals (once, always persisting, deny,
  timeout, requester gone, first answer wins), an answer racing the
  timeout, at most 4 waiting requests per machine and identical requests
  sharing one, list calls coalesced; the gate: routes refused (and
  audited) without a session, sessions opened by the passphrase or its
  setup and ended idle (lists not counting as use), old, by a lock or a
  change, not opened across a lock, wrong passphrases slowed down, one
  check at a time, approvals without a session refused and denials
  allowed; answers, saves and reveals audited without values or
  passphrases; a removed machine forgotten.
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
- `web/src/__tests__/vault.test.ts`: the panel without values; unlocking
  (a wrong passphrase, then the right one) before reveal and edit, reveal
  after confirming with the session; the editor's request (machines,
  flag) and a rename; creating the passphrase (a mismatch first); a load
  crossing a session's start; read-only; the approval prompt asking for
  the passphrase, denying without one and resolved elsewhere; the local
  machine's note; the setup snippets.
