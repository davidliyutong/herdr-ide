# 30 Variable vault

## Context

Coding agents on every machine need the same API keys and tokens (GitHub,
model providers, cloud accounts). Copying them into each machine's shell
profile spreads secrets in clear text over every host, keeps them in every
process's environment and leaves no record of who read what. The core
already reaches every machine and has a UI the user watches, so it keeps
the secrets in one place and hands them to agents that ask, with the user
deciding.

## Goals / non-goals

- One encrypted store of named variables on the core host, edited in the
  UI. Values reach a browser only on an explicit, logged reveal.
- Coding agents on any machine (Claude Code, Codex, any MCP client) read
  them through an MCP server, or run a command with them set without
  seeing them.
- Per-variable allowed machines. Other machines ask the user, who allows
  once, always, or denies.
- Variables move between vaults in files encrypted under a passphrase of
  their own, which the core builds and reads.
- One gate for every caller, the core host's own programs included. A
  value leaves the vault only for a machine the variable lists, an app the
  user exempted on a machine, or with the user's approval. Approving,
  revealing and changing need the vault's passphrase or the user's
  biometrics, which programs on the core host do not have. Biometrics also
  unlock a locked vault, within 14 days of the passphrase by default.
- Every read is logged: no value leaves without its record in the access
  log, written to disk first.

What the gate does not cover, and the user accepts in exchange for the log:

- A variable that lists machines is open to any program on those machines.
  Programs on the core host can run commands on every machine (through the
  core's terminals or ssh with the user's keys), so only variables that ask
  every time are kept from them. The panel says so and recommends asking
  every time for important secrets.
- Content served on the UI's own origin, VS Code's windows (code-server
  below `/m/{id}/code/`), can reach the page that holds a session and read
  the session or a passphrase typed into it. Programs that can change
  code-server's files on a machine, or VS Code extensions there, can
  therefore pass the gate once the user opens VS Code (SECURITY.md).

Non-goals:

- Putting variables into terminals' environments: every program of a
  terminal would get them for the terminal's whole life.
- Protection against the user's own programs on an allowed machine.
- Protection against a program that drives the user's unlocked browser
  page, reads the core's memory, obtains an authenticator's
  key-encryption key once, or guesses a weak passphrase offline from the
  file.
- Configuring the CLIs. The user adds the MCP server once per machine; the
  panel shows how.

## Design

### Store (`internal/vault`)

The vault is `vault[-<instance>].json` beside the settings file: 0600,
written atomically and durably (`internal/userfile` flushes the content
before the rename and the directory after), so a crash leaves the old file
or the new one. Fields the version does not know are kept.

- **Key.** Derived from the user's passphrase (at least 8 characters) with
  Argon2id (time 3, 64 MiB, 4 threads, a 16-byte salt; parameters stored in
  the file, and refused outside time 1–10, memory 8 MiB–1 GiB, 1–16
  threads, so an edited file can neither weaken the derivation nor exhaust
  memory). A `check` text sealed with the key tells a wrong passphrase.
  The vault is locked after every start; the passphrase, or an
  authenticator's unlock entry (below), gives the key.
- **Lock forgets the key.** A locked vault gives out and changes nothing
  (`vault_locked`), applies no exemption and has no guard to read.
- **Values.** Each value is sealed with AES-256-GCM. Its additional data
  binds the file version, the variable's name, its machines (sorted) and
  its inject-only flag. A ciphertext copied to another entry, or an entry
  whose machines were widened or flag dropped in the file, does not open
  (`corrupt`). Changing machines or the flag through the store seals the
  value again, which needs the key.
- **Other file versions.** A file of another version that holds a
  passphrase or variables (development builds sealed differently or kept
  the key in the keychain) does not open (`version`), nor does a malformed
  one (`invalid`). Such a file is moved away by hand; it is never
  converted, because no request could show that the user, not a program,
  chose the new passphrase.
- **Passphrase change.** Needs the current one, seals every value again
  under a key of a new salt, and installs the new key only once all is
  written. The same write drops every unlock entry. When the passphrase was
  set (`passphraseSet`) is shown in the panel: a new vault's first
  passphrase needs no session, so one set by a program shows as one the
  user did not choose.
- **Removed machines.** A machine removed from the core
  (`plugin.MachineForgetter`) leaves every variable's list, so a machine
  added later under the same id asks again. While locked it goes into
  `forgotten`, which no variable lets read without asking, and leaves the
  lists at the next unlock or change. `forgotten` only ever narrows.
- **Limits.** Names are environment variable names (at most 128); values
  at most 64 KiB; descriptions 1 KiB; 1000 variables. `machines` lists
  machine ids or `*`.
- **Inject-only** variables are given only to `run_with_env`. This keeps
  them out of the conversation by accident, not against a command written
  to print them encoded.

#### The key in memory (`internal/vault/key.go`)

While unlocked, the master key is in a memguard Enclave: encrypted under a
session key memguard keeps in locked, guarded pages. Each store operation
opens it into a LockedBuffer destroyed right after. A lock overwrites the
Enclave's ciphertext in place (memguard has no destroy; the store checks
memguard's layout first) and drops it; the core purges memguard at
shutdown. Memory that cannot be locked (`ulimit -l` too small) fails the
unlock with `503 memory`: the key never falls back to an ordinary slice.

Not covered: Go's AES key schedule during an operation, passphrases and
PRF outputs of requests (Go strings), Argon2's output and unwrapped keys
for the moment before they move into the Enclave, memguard's own session
key, and the desktop shell's strings. memguard sets the process's core
dump limit to 0, which everything the core starts inherits
([deployment](../deployment.md#remote-resources)); machines run the
machine build, which does not link memguard.

### Core (`internal/plugins/vault`)

The plugin `vault` (`plugins.vault.enabled`, on by default) opens the store
at first use. A file that does not open answers `503` with its code
(`version`, `invalid`, `failed`; `unavailable` without a settings file) and
is tried again at the next use, so no restart is needed. Its routes are
below `/api/p/vault` ([reference](../reference.md#http-and-websocket-endpoints)).
Every route that changes something is a writing route (refused read-only)
and audited, never with values or passphrases.

#### The gate

The core's API is open to any program on the core host, so the API cannot
tell the user from a program. The passphrase can, and so can the user's
biometrics.

- Setting, changing, renaming and deleting variables, revealing a value,
  allowing a request and reading the access log need a **vault session**,
  sent as `X-Vault-Session`, or answer `401 vault_session`. Denying needs
  nothing.
- A page opens a session with the passphrase (which also unlocks the
  vault), an authenticator's proof, or an authenticator's unlock. A session
  is 32 random bytes kept in the core's memory and the page's memory only,
  never in browser storage.
- A session ends unused for 30 minutes (`vault.sessionIdle`), 12 hours
  after it began (`vault.sessionMax`), at every lock, or when the
  passphrase changes. At most 32 are open.
- Installing or dropping the key is one step with its sessions, so the
  vault never ends unlocked after a lock, nor locked with a session open.
- Passphrases and authenticators' unlocks are checked one at a time (`429
  busy`). After three wrong ones in a row each further one doubles a wait,
  up to 5 minutes (`429 wait`), across pages and programs. An unlock whose
  key does not open counts as a wrong passphrase.
- Time limits (sessions, automatic lock, nonces) count by the wall clock
  and the monotonic clock together, whichever says longer, so sleep counts
  and a clock set back lengthens nothing.

**What takes the passphrase.** A session opened by a proof or an unlock
can reveal, change (a widening included), delete and allow. What guards
the vault takes a session the passphrase opened (`401 vault_passphrase`
otherwise): adding and removing authenticators, exempting apps, Verify
every Allow, imports and exports. Whatever would let a value out later also
takes the passphrase in its own request (adding an authenticator,
exempting an app, ending Verify every Allow, an export), because a page's
session is something a program driving the page has too. So biometrics
never extend themselves.

#### Authenticators (`proof.go`, `unlock.go`, `internal/webauthn`)

Biometrics, the desktop app's Touch ID or Windows Hello or a browser's
WebAuthn credential (a platform authenticator or a security key), stand in
for the passphrase in two ways:

- A **proof** shows the user is there. It opens a session of an unlocked
  vault or allows one request. It holds no key; the authenticators are
  sealed with the key (the store's guard), so they are read only while
  unlocked.
- An **unlock** gives a locked vault its key back. The authenticator keeps
  the master key wrapped in an unlock entry of the file, under a
  key-encryption key only it can give again, and may do so within
  `vault.passphraseDays` of the last passphrase.

Proofs:

- A proof answers a nonce the core issued (`POST proof`) for one purpose:
  `session`, `answer` (a request's id and `once`/`always`), `reveal` or
  `change` (a variable's name), or `register`. A nonce is good for one try
  and two minutes; at most 32 wait. While locked only `session` nonces are
  issued, good for an unlock only; nonces of an unlocked vault never
  unlock.
- A **WebAuthn credential** signs the nonce as its challenge. The core
  checks it with the standard library only: client data (`webauthn.get`,
  challenge, origin, not cross-origin), authenticator data (host name hash,
  user present and verified), the signature (ES256, RS256 or EdDSA) and a
  growing signature counter.
- **Bound to an origin.** A browser keeps a credential for a host name,
  whatever the port, and a program writes its requests' `Origin` as it
  likes. So the credential is bound to the origin the authenticator signed,
  and credentials are added and used only for origins the core vouches for
  (`plugin.Call.TrustedOrigin`): an `--allowed-origin`, or
  `http://localhost` on the core's port while the core holds that port on
  both `127.0.0.1` and `::1` (`internal/loopback`). A page another program
  serves on `localhost:3000` can get the user's biometrics to sign, but the
  signature names its origin and is refused. WebAuthn does not work on a
  page opened by IP address; the settings page links to `localhost`.
- **Without a session** the list shows only the ways this page can prove
  or unlock with (`desktop`, `webauthn`; while locked `unlock.ways` and
  when the passphrase is due, `unlock.due`), never ids, labels, other
  origins, the rule, exemptions or lock times. Credential ids and PRF salts
  come with a nonce for a vouched origin only; they open nothing without
  the authenticator.
- The **desktop app**'s shell asks the core what the nonce is for (`GET
  proof/{nonce}`, answered only to the desktop client), shows that in the
  system prompt (machine label and ssh address, every variable name), and
  after the user confirms signs nonce and purpose with HMAC-SHA-256 under a
  key of this launch that never leaves its main process
  (`desktop/src/verify.ts`). The page can neither have one thing shown and
  another signed nor sign without the prompt.
- **Adding** one needs a passphrase session, the passphrase again, and a
  `register` proof, and wraps the key for it in the same step. For WebAuthn
  that is the browser's `create()` answer (its public key via
  `getPublicKey()`, no attestation parsed) plus an assertion of the same
  nonce by the new credential, which proves the key is the
  authenticator's, with the PRF extension evaluated on a salt the core
  chose. A credential without PRF is refused (`400 prf_required`). For the
  desktop app it is the shell's proof with a relay of this install's new
  unlock key. At most 16 authenticators, one of them the desktop's (to
  which each install adds its own entry). A new passphrase removes them
  all: whoever knew the old one may have added theirs.
- **Verify every Allow** (off unless set) makes a session not enough to
  let a value out (`401 vault_proof`). Allowing a request, revealing, and a
  change that widens who may read (a machine added, every machine,
  inject-only removed) each need a proof made for that action, or the
  passphrase in the request. A program driving the unlocked page then gets
  no value out. The rule is kept in the sealed guard, not in settings,
  because settings change without the gate. Ending it takes the passphrase;
  a guard that does not open counts as the rule on; it outlives a new
  passphrase.

Proofs are audited as `vault.proved`, unlocks as `vault.unlocked`, removed
unlock entries as `vault.unlock_removed` (with a reason), refusals as
`denied.vault_proof` and `denied.vault_passphrase`; never with a key, a
relay's content or a PRF output.

#### Unlock entries (`internal/vault/unlock.go`)

The file keeps, outside the sealed guard, a list `unlock` of entries
`{id, authenticator, kind, created, check, <kind's parameters>, wrapped}`:
the master key sealed with AES-256-GCM under the entry's key-encryption
key (KEK). The additional data is every member of the entry, the hash of
the file's `check` included, so an entry edited in any member, or made
for another passphrase, does not open. Each KEK is HKDF-SHA256 of:

- `enclave` (desktop app, macOS): the P-256 ECDH secret between the app's
  Secure Enclave key, usable only after Touch ID with the fingerprints
  enrolled when it was made, and an ephemeral key whose private half the
  core dropped; plus the shell's secret.
- `hello` (desktop app, Windows): the Windows Hello key's signature of a
  challenge the core chose (RSA PKCS#1 v1.5, the same at every signing);
  plus the shell's secret.
- `prf` (WebAuthn): the credential's PRF output for a salt the core chose.

Vectors: `spec/vectors/vault-unlock/kek.json`, checked by the store's
and the desktop shell's tests. At most 4 desktop entries, one per install,
and one per credential. The key is not wrapped again after an unlock: it
does not change until the passphrase does, so a new wrap would protect
nothing.

An unlock (`POST session` with `{"unlock"}`) checks, under the plugin's
key lock: the nonce, the entry, the KEK opening the wrap, the key opening
the check, the guard holding the entry's authenticator (else the entry is
removed: an older copy of the file was put back), the authenticator's
proof (a PRF unlock also carries the credential's assertion; the desktop
relay is its own proof), and the passphrase's window. Only then is the key
installed and a session opened, marked as a proof's. Failures leave the
vault locked: `401 vault_proof` (does not open or verify), `403
passphrase_due` (outside the window), `409 unlock_stale` (an entry gone,
invalidated or orphaned, which is removed), `503 memory`.

**The passphrase's window.** An authenticator unlocks only within
`vault.passphraseDays` (14; 1–90) of the last time the passphrase was
checked with the key. That time, the days and the automatic lock's time
then are sealed under the key (`passphraseAt`), so a program that can
write the file can only put an older window back, which ends sooner, or
remove it. The end is also in the clear (`passphraseHint`) for what the UI
offers. **Require Passphrase** (`POST lock` with `{"forget": true}`, no
session needed) removes the window.

#### The desktop app's unlock key

(`desktop/src/verify.ts`, `enclave.ts`, `windowsHello.ts`,
`unlockStore.ts`, `keychain.ts`, `relay.ts`, `desktop/helper/`)

- **Per install** the app keeps `vault-unlock.json` in its user data
  (0600, never read through a link): an install id, which names its entry
  in the core, and the shell's secret (32 random bytes) encrypted with
  Electron's safeStorage (keychain on macOS, DPAPI on Windows), so the
  Secure Enclave blob or the Hello key alone does not make the KEK. Without
  safeStorage the app offers no unlock.
- **macOS helper**: `<APP_NAME> Enclave.app` in `Contents/Helpers`
  (`desktop/helper/Enclave.swift`), run by absolute path, one JSON line in
  and out, one prompt at a time: `available`, `create` (a P-256 key in the
  Secure Enclave with `.biometryCurrentSet`, made without a prompt) and
  `agree` (Touch ID, then ECDH). It answers `invalidated` only for errors
  documented as the key being gone, so other errors keep the entry.
- **Windows**: the user's Windows Hello key container through PowerShell's
  `KeyCredentialManager`, the key's name and challenge passed in
  environment variables. A key that is gone is `invalidated`.
- **Linux**: no unlock key; the passphrase unlocks.
- **The relay** carries what makes a KEK through the page, which cannot
  read it: AES-256-GCM under a key derived from the launch's verify key,
  bound to purpose, nonce and entry id. The core opens it only for a
  request of the desktop client (`plugin.Call.DesktopRelay`). Vectors:
  `spec/vectors/vault-unlock/relay.json`.
- **Unlocking**: `GET proof/{nonce}` lists the desktop entries; the shell
  picks its install's, prompts, and answers `{id, relay}`, or
  `{invalidated: true}` when the system no longer has the key (the core
  removes the entry; the desktop authenticator stays to approve with), or
  `none` without a prompt when it has no entry of its own.

**macOS keychain item of a new build** (`keychain.ts`). safeStorage's item
`<APP_NAME> Safe Storage` trusts only the build that made it (by Team ID,
or by cdhash for an ad hoc build, which changes every build). Once per
launch the shell compares its code identity with the one recorded in
`<APP_SLUG>-desktop-keychain.json`. On another build, one instance at a
time: with no enrolled secret anywhere the old item is deleted unread;
otherwise the shell reads its password once with `/usr/bin/security` (the
one prompt), opens every instance's secret, deletes the item, lets
safeStorage make a new one for this build, checks it, and writes the
files and the record. If anything fails before this instance's file is
written, the old item is put back with its password. A refused prompt
leaves this launch without biometric unlock and asks again next launch.
Development runs only record; Windows and Linux skip the step.

#### The automatic lock (`autolock.go`)

`vault.autoLock` (60 minutes; 0 is never) locks an unused vault and
forgets its key, ending every session and nonce. A use is an unlock, a
page action through the gate or a value released to a machine; lists and
refusals are not. The setting changes without the gate, so while unlocked
a change shortens the current unlock but never lengthens it, and an unlock
by an authenticator takes at most the time sealed with the window. No page
sets a time of its own.

#### Exempt apps

An exemption names an app and a machine. While the vault is unlocked the
app's requests there read every variable without asking; inject-only still
only via `run_with_env`.

- The app is the name of the parent of the process connected to
  `vault.sock`, from the process chain the agent read from its kernel: the
  coding agent's CLI that runs the MCP server. What the request says of its
  client is shown, never matched.
- The name matches whole and is at most 15 bytes (`app_too_long`; Linux
  keeps 15), so none is cut to match every program that begins with it. It
  may not be a shell, interpreter or launcher (`app_generic`: `sh`, `bash`,
  `env`, `sudo`, `node`, `python`…, with or without a version), which runs
  any script.
- Exemptions live in the sealed guard, not settings, so neither an edited
  file nor a settings change can add one. Adding needs a passphrase session
  and the passphrase in the request. Each names a machine this core has,
  never `*`, because a name trusted everywhere would be trusted on machines
  added later. At most 64. A removed machine's exemptions go with it; a new
  passphrase removes them all.
- Every exempted read is recorded (`exempted`) and audited.

A process names itself, so any program of the user on that machine can
take the app's name. An exemption saves prompts; against such a program it
is as wide as listing the machine in every variable while unlocked. The
settings page says so.

#### Requests from machines

The MCP servers' requests arrive as streams the agent opens with op
`vault` (`plugin.Streamer`). The header carries the process connected to
`vault.sock` (by peer credentials) and up to 7 parents, `{pid, name}` as
the kernel names them. Then one `VaultRequest {tool, names, client,
terminal, cwd}` line and one `VaultResponse` line. The core takes the
machine from the ssh session and the process chain from the header, never
from the request; the request's client, terminal and directory are only
shown.

- `list`: names, descriptions, `inject_only`, and whether this machine
  needs approval. Works while locked.
- `get` (one name) and `env` (1–64 names): names whose `machines` hold the
  machine or `*`, or any to an exempt app, are given at once. For the
  others the core sends every page a `request` message and waits up to
  60 s (`vault.approvalTimeout`). **Allow once** gives the values,
  **Always allow** adds the machine to each variable's list, **Deny**, no
  answer or the requester leaving deny.
- An identical waiting request (machine, tool, names) shares the prompt.
  Beyond 4 waiting requests of a machine, or 32 in all, a request fails
  `busy`, so one machine cannot crowd out others.
- The first answer wins; answer, timeout and requester leaving are decided
  under one lock, so a `200` answer is what the requesters get and a late
  one gets `404`. Pages then get `resolved`.

#### The access log (`accesslog.go`)

Each MCP request and each value a page takes (reveal, export) is a record
in the core's database (`core[-<instance>].db`, table `vault_access`;
[38](38-sqlite-state.md)), read back at start. A record has the time,
machine (`""` for a page), tool, names, result, the process chain, the
client, terminal and directory the request named, and a page's address
and browser; never a value. Reading it needs a session.

- Results that let values out: `allowed`, `approved`, `approved_always`,
  `exempted`, `revealed`, `exported`. Others: `listed`, `denied`,
  `expired`, `cancelled`, `log_failed` or an error code.
- A release record is committed durably before the values leave; if it
  cannot be written (also when the database is of a newer version, which
  this core reads and does not write) the values do not leave
  (`log_failed`).
- The log keeps the last 1000 releases and, separately, the last 500
  others, so refusals a program repeats never push a release out.
  Repeated lists and refusals merge into one record with a `count` and are
  audited at most once a minute per machine and result; releases are
  never merged.
- The core's database is the one beside the settings file that sits
  beside the vault's (`settings[-<instance>].json` beside
  `vault[-<instance>].json`).
- With `--audit-log` every record is audited too (`vault.access`,
  `vault.revealed`, `vault.exported`).

### Export and import (`internal/vault/export.go`, `transfer.go`)

Variables move between vaults in an **export file** encrypted under a
passphrase of its own. The core seals and opens it; the browser only holds
ciphertext.

- The file is a JSON envelope (`format` `<slug>-vault-export`, `version`
  1, `kdf` argon2id with fresh salt, `cipher` aes-256-gcm, `nonce`,
  `ciphertext`). Everything in the clear but the nonce is additional data,
  so a changed version or derivation does not open. The content holds each
  variable (name, value, description, machines, flag, times) and the
  machines its lists name with their kind, target and label.
- The file's passphrase has at least 12 characters, since a file is
  attacked offline without the vault's waits. At most 16 MiB and 1000
  variables.
- **Export** (`POST export`) needs a session, the vault's passphrase again
  (a bulk release) and an unlocked vault. It is logged (`exported`) before
  the file is sent.
- **Import** sends the file and its passphrase twice, for a preview and
  then with choices (`import`, `overwrite`, `rename`, `skip`). The core
  keeps nothing between the two calls, so no decrypted value waits in
  memory. The import is one store write: a taken name, an invalid variable
  or the 1000 bound refuses it all. Imports release nothing, so they are
  audited (`vault.imported`) but not in the access log.
- **Machine mapping.** `*` stays. An ssh machine maps by id only when this
  core's machine of that id has the same kind and target: ids of
  UI-added machines are random, but an `--ssh` machine's id is its target
  and a hand-edited machines file may hold any id, so an id alone may name
  another host. The local machine, whose id is the same everywhere, maps only when
  its label matches too. Labels alone never map. Machines that do not map
  leave the list, so they ask every time; the preview names them.

### Settings

The section **Variable Vault** (all whole numbers) is the plugin's page in
Settings; it ends with Biometrics and Import/Export (`SettingsExtra.tsx`).
The settings are `vault.approvalTimeout`, `vault.autoLock`,
`vault.passphraseDays`, `vault.sessionIdle`, `vault.sessionMax`, and
`run_with_env`'s `vault.runTimeout`, `vault.runMaxTimeout` and
`vault.runOutput`, which the core sends with an `env`'s values
(`VaultResponse.run`). Defaults and bounds are in [reference](../reference.md).

### Machines

Every node listens on `<run>/vault.sock` (0600; only its own user by peer
credentials; at most 16 connections) and asks each core it serves
([39](39-nodes.md)) as an op `vault` stream. The first core that grants a
`get` or an `env` answers, and the other cores' streams close, which
withdraws their questions; `list` answers with every core's variables, a
name once. A request every core refused fails with the most telling
refusal: `denied`, then `vault_locked`, `inject_only`, `not_found`, `busy`,
a request that is wrong, a core that could not answer. Each core logs what
it released. The newest node of the instance serves the socket (another
build's may linger); one whose socket was taken over checks every 2 s and
serves it again once free; an exiting node removes the socket only if it
is still its own (same inode).

The MCP server is the `mcp` command of the agent and of the core.
`<data dir>/bin/<slug>-mcp`, the path agents' configurations name, stays
the same across agent updates: a POSIX shell script that runs
`<slug>-mcp-$(uname -s)-$(uname -m)` beside it, and each agent keeps the
link of its own platform pointing at its running executable, so hosts of
several architectures sharing a home each run their own build
([40](40-shared-homes.md)). Started by either name, the executable runs
the MCP server without arguments and asks the vault socket in the
runtime directory, on this host, of the data directory holding it.

The server (`internal/vaultmcp`) speaks MCP over stdio (JSON-RPC 2.0, one
message per line; revisions 2025-06-18, 2025-03-26, 2024-11-05). It names
its client by its parent process and its terminal by `HC_TERMINAL_ID`. Each
tool call is one connection to `vault.sock`;
`notifications/cancelled` ends a call (a waiting approval is denied, a
command killed). Tools:

- `list_variables`;
- `get_variable {name}`: the value as text, which enters the conversation;
- `run_with_env {command, names, cwd?, timeout?}`: runs `sh -c` in its own
  process group with the variables added to its environment and stdin
  closed. It returns the exit status and up to `vault.runOutput` of
  combined output with each value replaced by `***`, captured 64 KiB
  beyond what is returned so a value at the cut is still masked. It is
  killed after the timeout. Masking misses encoded or split values: it
  prevents accidents, not deliberate disclosure.

**Cleanup.** The process group is killed when the command returns, so
background programs do not outlive the call with the values; a program
that leaves the group (`setsid`) escapes. The server kills its commands
when stdin closes or on SIGTERM, SIGINT or SIGHUP. For SIGKILL, each
command's shell starts a watcher holding a pipe whose write end only the
server has, and kills the group when the pipe closes; on Linux the shell
also gets `Pdeathsig`.

### Web UI (`web/src/plugins/vault`)

The panel **Variable Vault** of the right sidebar (`view.panel.vault`):

- **The gate** (`Gate.tsx`): creating the passphrase (twice, with a
  strength bar and that it cannot be recovered); unlocking with the
  passphrase or **Continue with** Touch ID, Windows Hello, or biometrics
  where this page can unlock or prove, with **Require Passphrase** beside
  it and until when biometrics unlock; a refused unlock says why (due, set
  biometrics up again, failed). With a session, a bar with Change
  Passphrase and Lock. Passphrase fields keep password managers away,
  since a browser-saved passphrase is readable by programs on the
  computer.
- Requests waiting for an answer.
- **Variables** (`Variables.tsx`): search, Import…, Export…, New Variable;
  multi-select for Export…, Who May Read… and Delete; per row the name
  (copyable, never the value), tags, description and who may read without
  asking; reveal after a confirmation, hidden again after 30 s. The editor
  is a dialog whose value field is write-only and whose save is one call,
  a rename included, so a failed save changed nothing.
- **Access log** (`AccessLog.tsx`): records by day, filtered by machine and
  outcome, with the process chain; only with a session.
- **Connect** (`SetupGuide.tsx`): per machine the `claude mcp add`
  command, Codex's `config.toml` entry and generic JSON, built from the
  machine's data directory, and for the local machine the note that
  variables any machine may read are open to its programs.

The approval prompts, and the export and import dialogs
(`openVaultExport`, `openVaultImport`), are drawn over every page by the
plugin's status item, so they open from anywhere. A page without a session
allows with biometrics where it can make a proof and asks for the
passphrase otherwise. When `/ws` reconnects the page loads requests and the
vault again, since the core may have restarted.

**Biometrics** in Settings (`Biometrics.tsx`, only with a session): the
desktop switch for Touch ID or Windows Hello, which enrolls this install;
WebAuthn credentials with origin and last use, Add (PRF only) and Remove;
an authenticator without an unlock entry is labeled as approving only;
Verify every Allow; and exempt apps (apps seen in the access log offered),
under the warning that any program on the machine can take an app's name.
A change that takes the passphrase asks for it beside its control, and the
field is cleared once sent or cancelled, so no field holds the passphrase
between changes.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Inject variables into terminals | Every program of the terminal gets them for its whole life; no per-use approval or record. |
| The vault on each machine | Secrets would be copied to every host. |
| An MCP server over HTTP from the core | Machines would need a port reaching the core; the agent's yamux session already connects them, and nothing listens on TCP on machines. |
| An MCP SDK | Four methods over stdio; an SDK adds dependencies to the agent uploaded everywhere. |
| Keychain on every machine | Headless Linux machines have none. |
| The master key in the system keychain | Any program of the user reads it without a prompt and with the file has every value. An unlock entry is wrapped under a KEK only the authenticator gives again; safeStorage holds only half of a desktop KEK. |
| The loopback API or the page's origin as proof of the user | Programs on the core host call the API as pages do, and content on the core's origin passes the origin check. |
| Upgrading files sealed with less additional data | Their machine lists were not authenticated; an upgrade would seal a widened list in. |
| Every lock forgetting the key with only the passphrase to unlock | The passphrase after every automatic lock is what users disable the lock to avoid. Unlock entries give biometrics the key back without the core keeping it. |
| Holding the key in memory for a bounded time and only suspending on lock | The plaintext key stayed in memory while locked. With unlock entries a lock forgets the key, and the unlocked key is in memguard's Enclave. |
| Wrapping the key again after each unlock | The key does not change until the passphrase does; a KEK captured once opens any copy of the file anyway. |
| Credentials without PRF for unlocking | A proof holds no key; the core would have to keep the key for them. |
| WebAuthn or Electron's Touch ID in the desktop app | Its page is on `http://127.0.0.1:<port>`, which no credential can be for; Electron's Touch ID needs entitlements ad hoc builds lack and gives no secret to wrap under. A Secure Enclave key used after Touch ID does. |
| The desktop prompt's result as yes/no to the page, or its text from the page | Any script would report yes, or show one request and approve another; the shell MACs the nonce and asks the core what it is for. |
| Parsing attestation | Needs CBOR and proves the make, which the vault does not ask; an immediate assertion proves the key. |
| A credential checked by host name and the request's `Origin` | `localhost` is every port to a browser and a program writes its `Origin`; the signed origin cannot be forged. |
| Vouching for `localhost` while listening on `127.0.0.1` only | Whoever takes `::1` on the same port answers under the same origin. |
| Exemptions, Verify every Allow, as settings | Settings change through the API without the gate: a program would exempt itself or turn the rule off. |
| Exempting by the client a request names | The request is the requester's word; the process chain is the kernel's. |
| Exempting an app on every machine (`*`) | It would trust the name on machines added later. |
| Verify every Allow for requests only | A session could then widen readers or reveal, the same value by another door. |
| A proof's session changing what guards the vault | Biometrics could add an authenticator, exempt an app or end the rule, after which the passphrase is never asked again. |
| A page's own automatic lock time | It was set with a page's session, which a program driving the page has too. |
| Locked memory of our own instead of memguard | mlock, guard pages, VirtualLock, canaries and an encrypted enclave are what memguard maintains; its cost is the core dump limit and a layout-dependent destroy, checked at upgrades. |
| An import session between preview and import | Decrypted values would wait in memory for the user; sending the file again costs one derivation. |
| Mapping machines by label, or ssh machines by id alone, on import | Labels may be shared and ids may name another host on another core; a match could let a different machine read without asking. |
| Exporting or editing values in the browser | Values would pass through the page, its memory and its extensions. |

## Failure modes

- **Locked** (after every start or a lock): `get` and `env` fail
  `vault_locked` until a page unlocks it, with the passphrase or, within
  the window, an authenticator with an unlock entry. A lost passphrase
  cannot be recovered: delete the file.
- **Window over or Require Passphrase**: biometrics are not offered, an
  unlock by one is `403 passphrase_due`; the passphrase starts the window
  again.
- **Biometric key gone** (fingerprints changed, Hello key removed): the
  core removes the entry (`409 unlock_stale`) and the page says to set
  biometrics up again; the desktop authenticator still approves. The app's
  `vault-unlock.json` lost or its secret undecryptable: likewise.
- **A new macOS build without a Team ID**: the first biometric unlock asks
  once to let `security` read the old keychain item; refused, that launch
  unlocks with the passphrase only.
- **An older copy of the file put back**: entries whose authenticator the
  guard no longer has are removed (`409 unlock_stale`).
- **Memory cannot be locked**: every unlock is `503 memory`; raise
  `ulimit -l` and restart the core.
- **File of another version or damaged**: `503 version` / `invalid`, said
  in the panel; move it away and Retry.
- **File edited** (machines widened, values swapped): that value is
  `corrupt`, and changing the passphrase fails until it is set again or
  deleted.
- **Session ended**: `401 vault_session`; the page asks again.
- **Wrong passphrases**: `429 wait`, doubling; concurrent checks `429
  busy`.
- **No answer**: denied after `vault.approvalTimeout`; the agent may ask
  again. Too many waiting: `busy`.
- **Agent or core gone**: the MCP server reports `unavailable` and keeps
  running; the next call connects again.
- **MCP server killed, even with SIGKILL**: the watcher kills each command
  group.
- **Plugin off**: the stream is refused with `plugin_disabled`.
- **Access log not writable** (full disk, newer database): no value leaves
  (`log_failed`); lists and refusals are answered as before.
- **Export file wrong passphrase or changed** (indistinguishable):
  `file_passphrase`; malformed `bad_file`; another version `file_version`;
  over 16 MiB `too_large`. Nothing is imported.
- **Import conflict** (a name taken since the preview): refused as a whole.
- **Core restarted**: the vault is locked and sessions gone; the access
  log is read back; a merged count may lack its last 5 s.

## Security

The rows of [SECURITY.md](../../SECURITY.md) on the vault's file and key,
values in browsers, proving the user without the passphrase, reading
variables from machines and the MCP server. Limits of the design:

- A KEK obtained once (an enclave's ECDH secret with the shell's secret, a
  Hello signature with it, a PRF output), with any copy of the file, gives
  the master key offline until the passphrase changes. Removing an
  authenticator or Require Passphrase does not revoke against a program
  that kept an older file; a new passphrase does.
- `vault.passphraseDays` and `vault.autoLock` are settings a program on
  the core host can raise (to 90 days, to never) before the user next
  types the passphrase, which seals them into the window. A change during
  a window shortens it but does not lengthen it. The window counts by the
  wall clock, so an administrator setting the clock back lengthens it.
- A program of the user cannot answer Touch ID, Windows Hello or a passkey,
  but it can cause their prompts with a reason of its choosing. On Windows
  DPAPI gives the shell's secret to any program of the user and Hello's
  dialog names no purpose. On macOS the keychain move's prompt names
  `security`; answering Always Allow there would open the old item to any
  program until the shell deletes it a moment later.
- A PRF output passes through the page's script: content on the UI's
  origin that sees it, with the file, has the master key.
- memguard does not protect what is listed under the key in memory; a
  debugger of the same user is outside the model. It sets the core's core
  dump limit to 0 for everything the core starts.
- A program that can rewrite the app bundle (one signed ad hoc in
  `/Applications`) can replace the helper and get the secrets at the next
  Touch ID.
- Availability is not defended: a program can delete the file or a Hello
  key, Require Passphrase without a session, or make the passphrase wait.
- With Verify every Allow, a program driving the unlocked page gets no
  value out, but it can still change what lets nothing out: values,
  descriptions, renames, deletions, imports, fewer readers, removing
  authenticators or exemptions, a lock.
- An exemption trusts a process name any program of the user on that
  machine can take. It never applies while locked, always leaves a record,
  takes a whole name that is no shell or interpreter, and needs the
  passphrase in its own request. Hiding exemptions from pages without a
  session keeps them from a program that only reads the core's API, not
  from one that looks at the machine.
- Biometrics never extend themselves: they cannot add an authenticator or
  exemption, start the window again, or end Verify every Allow.

## Testing

- `internal/vault`: `vault_test.go` (passphrase, binding of name, machines
  and flag, other versions and malformed files, KDF bounds, passphrase
  change, removed machines, renames), `guard_test.go` (sealed guard,
  `TestLockForgetsTheKey`, `TestMemoryFailureFailsTheUnlock`,
  `TestExemptions`, `TestCheckApp`), `unlock_test.go` (`TestKEKVectors`,
  `TestUnlockEachKind`, `TestEditedEntriesDoNotOpen`, `TestOrphanEntries`,
  `TestPassphraseWindow`, `TestOlderBuildRoundTrip`), `export_test.go`
  (round trip, tampering, bounds, one-write import).
- `internal/userfile/userfile_test.go` (`TestWriteIsDurable`).
- `internal/webauthn/webauthn_test.go`: the three algorithms and every
  check of an assertion; malformed input never panics.
- `internal/plugins/vault`: `vault_test.go` (approvals, races, bounds,
  coalescing, the gate, `TestLockDuringAPassphraseCheck`), `proof_test.go`
  (proofs, sessions they open, origins, desktop MAC,
  `TestVerifyEveryAllowCoversValuesAndGrants`, `TestListWithoutASession`),
  `unlock_test.go` (`TestDesktopUnlock`, `TestPRFUnlock`,
  `TestPassphraseDue`, `TestDeadDesktopEntry`,
  `TestRegistrationWrapsTheKey`, `TestLockDuringAnUnlock`,
  `TestMemoryError`), `accesslog_test.go`
  (`TestAccessLogSurvivesARestart`, `TestReleasesAreNeverCoalesced`,
  `TestUnloggedReleaseIsRefused`, `TestAccessLogDatabase`,
  `TestAccessLogNewerVersion`, `TestWhoAskedComesFromTheAgent`),
  `transfer_test.go` (`TestExport`, `TestImport`,
  `TestImportMapsMachinesByTarget`), `settings_test.go` (`TestAutoLock`,
  `TestAutoLockFollowsTheSetting`,
  `TestTimeLimitsCountSleep`), `exempt_test.go` (`TestExemptApps`). The
  automatic lock's tests drive their own clock.
- `internal/vaultmcp`: `mcp_test.go` (JSON-RPC, masking,
  `TestMaskAtTheCut`, `TestRunLimitsFromTheCore`, cancellation,
  `TestSocketPath`),
  `run_unix_test.go` and `signal_unix_test.go` (background programs and
  signals including SIGKILL).
- `internal/agent/vault_test.go` (`TestSocketsFollowTheNewestAgent`,
  `TestLinkMCPReplacesTheLink`);
  `internal/server`: `TestMachineRemove`, `TestPluginCallClient`,
  `TestDesktopRelay`, `TestMutatingRoutesAreGuarded`.
- `desktop/src`: `verify.test.ts` (MAC vectors, prompt text, unlock and
  enroll), `enclave.test.ts`, `relay.test.ts` (relay and KEK vectors),
  `unlockStore.test.ts`, `keychain.test.ts` (the item's move to a new
  build and its rollback), `windowsHello.test.ts`, `preload.test.ts`.
- `web/src/__tests__/vault.test.ts`, `vault-transfer.test.ts`,
  `vaultProof.test.tsx`: the panel, gate, unlocking with biometrics,
  editor, prompts, access log, transfer dialogs and the biometrics
  settings.
