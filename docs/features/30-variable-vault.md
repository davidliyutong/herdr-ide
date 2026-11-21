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
- Variables moved between vaults in files encrypted under a passphrase of
  their own, which the core builds and reads.
- One gate for every caller, the core host's own programs included: a
  value leaves the vault only for a machine the variable lists, an app the
  user exempted on a machine, or with the user's approval, and approving,
  revealing and changing need the vault's passphrase, or biometrics while
  the core holds the key (for a day after the passphrase by default),
  which programs on the core host do not have. What it does
  not cover: a variable that lists machines is open to any program that
  runs on one of them, and programs on the core host can run commands on
  every machine (through the core's terminals, or ssh with the user's
  keys), so only variables that ask every time are kept from them; the
  panel says so and recommends asking every time for important secrets.
  The user accepts this as long as every read is logged: no value leaves
  the vault without its record in the access log, written to disk first.
- Non-goal: putting variables into terminals' environments. Every program
  of a terminal would get them, for the terminal's whole life.
- Non-goal: protection against the user's own programs on an allowed
  machine: any process of the user there can ask as an agent does.
- Non-goal: protection against a program that drives the user's own
  browser page after the user unlocked it (browser automation), reads the
  core's memory (a debugger with the rights to; the core holds the key for
  the key's hold, also while the vault is locked), or guesses a weak
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
written atomically and durably by `internal/userfile`: the new content is
flushed to disk before it replaces the file, and the directory after, so a
crash or a power loss leaves the old file or the new one):
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
whose passphrase lacks its parameters or check, that holds variables
without a passphrase or that is not JSON (`invalid`): such a file is moved
away by hand. Fields the version does not know are kept.

The master key is derived from the user's passphrase with Argon2id (time
3, 64 MiB, 4 threads; a new 16-byte salt and the parameters in the file)
and kept only in the core's memory while the core holds it (the key's
hold, below); the vault is locked after every start until the passphrase
is given. The store can be **suspended**: locked with the key kept, so no
value is given out or changed (`vault_locked`), no exemption applies and
the user's changes of the guard are refused, but the guard can be read, an
authenticator's proof checked and recorded (`RecordProof`: its time and
counter), and values opened and sealed again only to take a removed
machine out of their lists (a narrowing; nothing leaves the core);
`Resume` or the passphrase unlocks it, `Lock` forgets the key. A new vault
asks for its passphrase (at least 8 characters) before its first value
(`no_passphrase`). Parameters read from the file must be within bounds (a
16-byte salt, time 1–10, memory 8 MiB–1 GiB, 1–16 threads), or the vault
does not open: an edited file can neither weaken the derivation nor
exhaust the core's memory. Changing the passphrase needs the current one
and seals every value again under a key of a new salt; the new key is
installed only once all is written, so a change that fails (a value that
does not open: `corrupt`) leaves the vault as it was, locked if it was.
When the passphrase
was set or last changed (`passphraseSet`) is shown in the panel (on
hover over its unlock card and its bar): a new
vault's first passphrase needs no session (it has no values yet), so a
passphrase set by a program instead of the user shows as one the user did
not choose.

A machine removed from the core leaves every variable's list
(`plugin.MachineForgetter`, audited as `vault.machine_forgotten`), so a
machine added later under the same id asks again. Taking it out seals the
values again: until the key is there (while locked) the machine goes into
`forgotten` instead, which no variable lets read without asking, and is
taken out of the lists at the next unlock, of values that do not open too
(they stay unreadable: taking machines out never lets more read), so the
list is then empty. Should writing that fail, the next change (a save, an
allow, a deletion) does it first, so a machine the user then allows or
chooses (one added again under the same id) is not hidden by an old
`forgotten`. `forgotten` only ever narrows who may read.

Names are environment variable names (`^[A-Za-z_][A-Za-z0-9_]*$`, at most
128); values at most 64 KiB, descriptions at most 1 KiB, at most 1000
variables. `machines` lists machine ids, `*` for all. `injectOnly` variables
are only given to `run_with_env`, which does not stop a command from
printing them encoded (base64, say): it keeps them out of the
conversation by accident, not against a command written to reveal them.

### Core (`internal/plugins/vault`)

The plugin `vault` (setting `plugins.vault.enabled`, on by default) opens
the store at its first use; a file that does not open answers `503` with
why (`version`, `invalid`, `failed`; `unavailable` without a settings
file) and is opened again at the next use, so a file moved away or put
back needs no restart. Its routes, below `/api/p/vault`
([reference](../reference.md#http-and-websocket-endpoints)): the list
(state and variables without values), `PUT`/`DELETE vars/{name}` (`PUT`
with `{"to"}` renames the variable in the same write as its other changes,
so a refusal changes nothing: the value is sealed again under the new
name, its additional data; a taken name is `409 exists`),
`POST vars/{name}/reveal`, `session` (open, end), `passphrase` (set,
change), `lock`, the pending `requests` and their answers, and the access
`log`. Every route that changes something is a writing route (refused
read-only) audited with the name or request id.

**The gate.** The core's API is open to any program on the core host (it
needs no `Origin` header), so the API cannot tell the user from a program.
The passphrase can, and the user's biometrics while the core holds the
key: setting, changing, renaming and deleting variables, revealing a value
and allowing a request (`once`, `always`; denying needs nothing) need a
**vault session** of the page, sent as `X-Vault-Session`, or answer `401
vault_session` (audited as `denied.vault_session`). A page opens one with
the passphrase (`POST session`, which also unlocks the vault; setting or
changing the passphrase opens one too) or an authenticator's proof
(below): 32 random bytes
the core keeps in memory and the page only in its own memory, never in
storage that programs could read from disk. Only what passes the gate
counts as a session's use: loading the list says whether the session is
open without keeping it so. A session ends unused for 30 minutes
(`vault.sessionIdle`), 12 hours after it began (`vault.sessionMax`),
when the vault is locked (every one: by Lock or the auto-lock) or its
passphrase changed (every other one); a session that a passphrase check
would open after such an end (the check crossed it) is not opened; at most
32 are open, the oldest going. A session's times, the automatic lock's,
the key's hold and the nonces' count by the wall clock and the monotonic
clock together, whichever says longer (`stamp`): the computer's sleep,
which stops the monotonic clock on macOS and Linux, counts, and a wall
clock set back lengthens nothing. Installing or dropping the key is one step
with its sessions (one lock of the plugin): an unlock and the session it
opens, a lock and the end of every session, a new passphrase and its
session. A lock asked for while a passphrase is checked comes after the
check and its session, so the vault never ends unlocked after a lock, nor
locked with a session open. Passphrases are checked one at a time
(`429 busy` while one is checked); three wrong ones in a row cost nothing,
each one after doubles a wait before the next try (`429 wait` with
`Retry-After`, up to 5 minutes), across pages and programs, so a program
can also make the user wait. Opening a session and changing the passphrase
are audited (`vault.unlocked`, `vault.passphrase_set`, with whether it
worked), never with the passphrase; reveals and deletions as
`vault.revealed` and `vault.deleted` once done. A machine's MCP server
reaches the vault only through its agent's socket and the same rules as
every machine: the core host's agent is the local machine's.

**Authenticators** (`proof.go`, `internal/webauthn`). Biometrics (the
desktop app's Touch ID or Windows Hello, or a browser's WebAuthn
credential: a platform authenticator or a security key) stand in for the
passphrase while the core holds the key: a proof opens a session, which
unlocks a vault locked within the key's hold, or allows one request. A
proof never brings a forgotten key back: the authenticators are sealed
with the key (the store's guard), so they are read only while the core
holds it, and after a start or once the hold is over the passphrase is
needed once.

- A **proof** answers a nonce the core issued (`POST proof`) for one
  purpose: `session`, `answer` with a request's id and `once` or `always`,
  `reveal` or `change` with a variable's name, or `register`. A nonce is
  32 random bytes, good for one try and two
  minutes; at most 32 wait, the oldest giving way; they end with the
  sessions (a lock, a new passphrase).
- A **WebAuthn credential** (a browser's platform authenticator such as
  Touch ID or Windows Hello, or a security key) signs the nonce as its
  challenge. The core checks, with the standard library only: the client
  data (`webauthn.get`, the challenge, the page's origin, which is the
  request's `Origin`, not cross-origin), the authenticator data (the hash
  of the host name the credential is for, the user present and verified),
  the signature (ES256, RS256 or EdDSA) with the key it stored, and a
  signature counter that grows where the authenticator counts.
- A browser keeps a credential for a **host name**, whatever the port, and
  a program of the core host writes its requests' headers as it likes. So
  the credential is bound to the **origin** it was added from, which is
  the one the authenticator must have signed, and credentials are added
  and taken only for origins the core vouches for
  (`plugin.Call.TrustedOrigin`): an `--allowed-origin` (the reverse
  proxy's), or `http://localhost` on the core's own port while the core
  holds that port on both loopback addresses (it takes `::1` beside
  `127.0.0.1` at its start, `internal/loopback`; when another program
  holds it, the core says so and vouches for no loopback origin). A
  browser sends no `Origin` with a page's own GET, so for the list, which
  tells the page whether to offer biometrics (`webauthn`, and the
  authenticators it can prove with), the page's
  word that the request is its own (`Sec-Fetch-Site: same-origin`) and
  the request's Host stand for it; that decides what is offered, never
  what is taken. A page
  that another program serves on `localhost:3000` can ask the user's
  biometrics to sign a nonce; what it signs names that page's origin and
  is refused. WebAuthn does not work on a page opened by IP address
  (`http://127.0.0.1:…`), where the settings page offers the same page
  under `localhost`.
- **Without a session** the list shows of the guard only what offering
  biometrics needs: the kinds this page can prove with (`desktop` for the
  desktop client with the desktop authenticator on, `webauthn` with this
  origin for a credential added from it), never ids, labels, origins of
  other pages or times, nor the rule, the exempt apps, `lockAt` or
  `keyUntil`; a session sees all of it (`full`). WebAuthn's
  `allowCredentials` takes the credentials' ids, which come with each nonce
  (`POST proof`, which needs no session) for the origin the core vouches
  for only. A program that writes that origin in its headers learns that
  a credential exists and its id, which proves nothing without the
  authenticator.
- The **desktop app** prompts with the system (Touch ID on macOS, Windows
  Hello on Windows): its page hands the shell's main process the nonce, the
  shell asks the core what the nonce is for (`GET proof/{nonce}`, answered
  only to the desktop app) and shows that in the prompt ("allow <machine>
  (<its address>) to read <names> once": the machine by its label, which
  programs can change, and its ssh address; every name, or as many as fit
  and how many more, never a list cut short), and after the user confirmed
  signs the nonce
  with its purpose (HMAC-SHA-256) with a key of this launch, which it gave
  the core in its hello and which never leaves its main process
  (`desktop/src/verify.ts`). The core takes such a proof only from the
  desktop client. The page thus cannot have one thing shown and another
  signed, nor sign anything without the prompt.
- **Adding** one needs a session the passphrase opened, the passphrase
  again (checked and slowed down as any), and the proof of a `register`
  nonce: for WebAuthn what the browser's `create()` answered (its public
  key as the browser gives it, `getPublicKey()`, so no attestation is
  parsed) and an assertion the new credential made of the same nonce,
  which shows that the key stored is the authenticator's; for the desktop
  app the shell's proof, so its prompt was answered once. At most 16; one
  desktop authenticator. A new passphrase removes them all: whoever knew
  the old one may have added theirs.
- A **session a proof opened** is marked. It answers requests and changes
  and shows variables as any session; what guards the vault takes a
  session the passphrase opened (`401 vault_passphrase` otherwise): adding
  and removing authenticators, exempting apps and ending exemptions, the
  rule below, the automatic lock's time, imports and exports.
- **Verify every Allow** (the guard's rule, off unless set): a session is
  then not enough to let a value out (`401 vault_proof`). Allowing a
  request (`once`, `always`) needs a proof made for that request and
  answer; showing a value to the page (`reveal`) and a change that lets a
  variable go where it did not (a machine added to those that read without
  asking, every machine, or inject-only taken off) need a proof made for
  that variable and purpose; each can bring the passphrase instead
  (`passphrase` in the request). Other changes, and a new variable, whose
  value the page brings itself, take the session. A program that drives
  the user's unlocked page, or content on the page's origin, can then no
  longer get at a value. The rule is in the vault, not a setting: settings
  are changed without the gate, by the very programs the rule is for.
  Ending it takes the passphrase with the request, not the session that
  set it. A guard that does not open counts as the rule on. It outlives a
  new passphrase.
- **The automatic lock** is a setting, changed without the gate: while the
  vault is unlocked a change shortens its time but does not lengthen it
  (the time is capped at the setting's when the passphrase unlocked the
  vault, and stays so across a lock and a proof's unlock within the hold);
  a page's own time for the unlock (`POST autolock`, a passphrase's
  session) is not capped, but a time longer than the current one, or
  never, takes the passphrase again in the request (`403
  passphrase_required` without it): the session alone is what a program
  driving the page has too, and never keeps the vault unlocked until the
  key's hold ends.
- Proofs are audited as `vault.proved` (`ok`, `for`, the authenticator's
  kind), refusals as `denied.vault_proof` and `denied.vault_passphrase`.

**The key's hold** (`autolock.go`). The passphrase gives the core the key,
which the core then holds in its memory for `vault.passphraseHours` hours
(24 by default, 1–168) from the last time the passphrase was given: an
unlock, a session opened with it, a new passphrase; by the wall clock, so
the computer's sleep counts (a laptop closed for a day finds the key
forgotten at the first request after it wakes, which looks at the hold
before anything else, as the timer does when it fires late). Within that
time:

- a lock, by Lock or by the automatic lock, of a vault that has an
  authenticator **suspends** it: every session and nonce ends, machines
  get `vault_locked`, no value is read or sealed and no exemption applies,
  but the key stays, so the authenticator's proof of a `session` nonce
  unlocks the vault again (audited as `vault.unlocked` with the
  authenticator's `kind`), as the passphrase does;
- a vault without an authenticator has its key forgotten at a lock, as
  before: only the passphrase would open it, so keeping the key would
  expose it for nothing;
- a Lock with `forget` (the panel's Require Passphrase on a locked vault)
  forgets the key at once.

Once the hold is over the core forgets the key, whatever the vault's state
(audited as `vault.locked` with `reason: passphrase`): every session ends,
biometrics unlock nothing and only the passphrase unlocks the vault. Every
route and machine request looks at the hold first, a proof's unlock looks
again with the key's lock held, and the auto-lock's timer runs while the
key is held, so the key is not used past its hold. Locked or not, the key
held is in the core's memory only, never written anywhere: the lock within
the hold is the core's refusal, not the key's absence. The hold's time is
a setting, changed without the gate: a change shortens the current hold
but does not lengthen it; a longer time counts from the next passphrase,
and is at most a week. Without an authenticator the vault behaves as
before but for this bound: a vault in use, or whose automatic lock is
never, locks once the hold is over.

What needs the passphrase, whatever the hold: the first unlock after a
start or once the hold is over; changing the passphrase (the current one);
what guards the vault, which takes a session the passphrase opened
(adding and removing authenticators, with the passphrase again to add
one; exempting apps, with the passphrase again, and ending exemptions;
Verify every Allow, with the passphrase again to end it; the automatic
lock's time for this unlock, with the passphrase again for a longer time
or never); and values in bulk, imports and exports (an export takes the
passphrase again too). Whatever would let a value out later, then, takes
the passphrase in its own request, so a page's session, which a program
driving the page has too, decides none of it. Biometrics, a proof's session or a proof made for the action,
are enough to reveal a value, to add, change (a widening included), rename
and delete variables and to allow a request (once or always); where every
Allow is verified, each of those that lets a value out takes a proof made
for it or the passphrase, as before.

**Exempt apps.** An exemption names an app and a machine: the app's
requests there read every variable without asking (an inject-only one
still only for `run_with_env`) while the vault is unlocked, never while it
is locked, suspended included; each is recorded in the access log as
`exempted` (a release: written and flushed before the values leave, never
merged) and audited as `vault.access`. The app is the name of the process
that started the one connected to `vault.sock`, from the process chain the
machine's agent read from its kernel (`process[1]`): the coding agent's
CLI that runs the MCP server (`claude`, `codex`, `node`…). What the
request says of its client is shown, never matched. The name matches
whole: it is at most 15 bytes (`app_too_long`), as Linux keeps a process's
name (macOS 16), so a longer one never matches and none is cut to match
every program that begins with it (a 15-byte name still matches, on
Linux, a longer one that begins with it); and it is no shell, interpreter
or launcher (`app_generic`: `sh`, `bash`, `zsh`, `fish`, `dash`, `env`,
`sudo`, `node`, `bun`, `deno`, `python`, `ruby`, `perl`, `php`, `npx`…,
with a version after the name or not), which runs any script. Exemptions
are kept in the sealed guard, so a file edited without the key carries
none, and are added only in a session the passphrase opened with the
passphrase again in the request (`POST exempt` with the app, machines and
passphrase, `403 passphrase_required` without it; `DELETE exempt/{id}`
ends one in such a session): an exemption is a lasting grant across every
variable, wider than Always Allow, which names one. At most 64; machines
this core has, never `*`. A removed machine's exemptions go with
it, at once while the core holds the key, else as a forgotten machine at
the next unlock (the guard cannot be read before); a new passphrase
removes them all, as it removes the authenticators.

A process names itself (its executable's name, `prctl`), so any program of
the user on that machine can start the MCP server, or connect to
`vault.sock`, from a parent of the app's name, and read every variable
while the vault is unlocked, as if the machine were in every variable's
list; a process the app started that asks itself has the app as its
parent too. An exemption spares the user prompts for the app's requests:
it does not tell programs apart, and it is only as strong as the user's
account on that machine. The settings page says so where apps are
exempted.

The MCP servers' requests arrive as streams the agent opens with op
`vault` (`plugin.Streamer`): a header whose `process` is the process
connected to `vault.sock` (by its peer credentials) and up to 7 of its
parents, `{pid, name}` each as the agent read them from the kernel
(`/proc/<pid>/stat` on Linux, `kern.proc.pid` on macOS), then one
`VaultRequest {tool, names, client, terminal, cwd}` line and one
`VaultResponse` line. The core takes the machine from the session the
stream came on and the process chain from the header, never from the
request; what the request says about its client, terminal and directory
is shown to the user, not trusted. A process can name itself as it likes
(its name, not its pid), so the chain says who asked as far as the
machine's kernel knows, not what the program is.

- `list`: every variable's name, description, `inject_only` and whether
  this machine needs approval (an exempt app's request needs none while
  the vault is unlocked). Works while locked.
  (Approval, below, needs a page with a session or a proof: the gate.)
- `get` (one name) and `env` (1–64 names): unknown names fail with
  `not_found`, an inject-only variable with `inject_only` for `get`, a
  locked vault with `vault_locked`. Names whose `machines` hold the machine
  or `*` are given at once, and all of them to an exempt app. For the
  others the core sends every page
  `plugin {plugin: vault, m, data: {type: request, request}}` and waits up
  to 60 s (`vault.approvalTimeout`): **Allow once** gives the values this
  time, **Always allow** adds
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

**Every read is logged.** A variable that lists machines can be read by
any program on them, and the core host's programs reach every machine
(through the core's terminals or ssh): the user accepts that, as long as
every value that leaves the vault is recorded. Each request of an MCP
server and each value a page takes (a reveal, an export) is a record of
the **access log**, with its time, machine (`""` for a page), tool,
names, result, the process chain the agent saw, the client, terminal and
directory the request named, and a page's address and browser; never a
value. Results: `allowed` (by the variables' machines), `approved`
(once), `approved_always`, `exempted` (to an exempt app), `revealed`,
`exported` (these let values out), `listed`, `denied` (by the user), `expired` (no answer in time),
`cancelled` (the requester went away), `log_failed` or the error's code.
The log is kept in `vault[-<instance>]-access.jsonl` beside the vault's
file (0600, a JSON record a line) and read back at the core's start, so
the panel shows what happened before a restart. A record that lets values
out is appended and flushed to disk before they leave; when it cannot be
written the values do not leave (`log_failed`, to the MCP server and as a
reveal's `500`). A write that fails partway is cut back to the last whole
record, and a line a crash left half written is ended before the next
record is appended, so no later record is glued to it and lost when the
file is read back. The log keeps the last 1000 records that let values out
and, apart, the last 500 others, so lists and refusals, which a program
can repeat at will, never push a release out; the file is written again
with what is kept once it holds twice as many lines. Every record is
audited too (`vault.access`, a page's as `vault.revealed` and
`vault.exported`) when the core writes an audit log (`--audit-log`).

List calls and refusals (`busy`, `not_found`, `vault_locked`,
`inject_only`, `bad_request`, `cancelled`: every result but those that
let values out, `denied`, `expired` and `log_failed`) are merged into the
previous record when they repeat it (`count`, written again at most every
5 s), audited at most once a minute per machine and result (with the
number skipped; the last of a burst is written when the minute is over,
so every call is accounted for) and do not make the pages reload. A
release is never merged: each one is a record of its own, in the access
log and the audit log. The other records make the pages reload at most
once a second, the last one included.
Answers are audited as `vault.answered` (machine, tool, names, answer),
saved variables as `vault.saved` (allowed machines, `inject_only`, whether
the value changed, `from` when renamed), never with values. Other changes
send `{type: changed}`, on which pages load the vault again.

### Export and import

Variables move between vaults (another computer, a new core, a backup) in
an **export file** encrypted under a passphrase of its own
(`internal/vault/export.go`). The core opens the vault's values and seals
them into the file, and opens a file and saves its values: no value
reaches a browser, which holds only the file (ciphertext).

The file is a JSON envelope: `format` (`<slug>-vault-export`, after the
product), `version` (1), `kdf` (`argon2id` with its salt, time, memory
and threads: new files take the vault's parameters, time 3, 64 MiB, 4
threads, and a new 16-byte salt), `cipher` (`aes-256-gcm`), `nonce` and
`ciphertext`. Everything in the clear but the nonce is the ciphertext's
additional data, so a file whose version or derivation was changed does
not open. The content holds when it was exported, each variable's name,
value, description, machines (`*` or ids), inject-only flag and times, and
the machines its lists name with their ids, labels and whether each was
the core's own computer. The file's passphrase has at least 12
characters: unlike the vault's file, an export is attacked offline
without the vault's waits, and it is only as strong as its passphrase.
Files are at most 16 MiB and hold at most 1000 variables.

**Export** (`POST export`, a writing route behind the gate): the
variables chosen, or all; it needs the page's session and the vault's
passphrase again (a bulk release; checked one at a time and slowed down
as a session's), and the vault unlocked. It is recorded in the access
log (`exported`, with the names) and audited (`vault.exported`) before
the file is sent, and not sent when that record cannot be written. One
file is derived at a time (`429 busy`).

**Import** sends the file's text and its passphrase twice: once for a
preview (`POST import/preview`), once with the choices (`POST import`);
the core keeps nothing of a file between the two, so no decrypted value
waits in its memory for an answer, and the second call checks the vault
as it then is. The preview names each variable with its description,
flag, whether the vault has one of that name, why it cannot be imported
(`invalid_name`: only under another name; `invalid`: a value, description
or machine list the vault refuses) and its machines as they map here:
`*` stays; an ssh machine is kept by its id only when the file names it
with the same kind and target as the machine of that id here (the file
seals each machine's kind and target with the variables): machines added
in the UI get random ids, so the same id and target are the same machine
record, as when importing into the core that exported, but an id alone
need not be (an `--ssh` machine's id is its target, a record imported
from herdr's catalog keeps herdr's id), so a file naming `devbox` does
not let this core's `devbox` of another target read without asking; a
file written before targets were recorded maps no ssh machine. A target
is compared as written: an ssh alias this core's ssh configuration
resolves to another host counts as the same. The local machine, whose id
is the same on every core, maps only when its label (the host's name)
matches too; labels alone map nothing, as two machines may share one. Machines that do not
map leave the list, so they ask every time; the preview names them. The
choices say per variable `import` (its name must be free), `overwrite`,
`rename` (`as`, validated as any name) or `skip`; the import is one write
of the store (`Store.Import`): a taken name, an invalid variable or more
than 1000 variables refuse it all and change nothing. Imported values are
sealed under the vault's key with their name, machines and flag; a new
variable keeps the file's creation time. Imports are audited as
`vault.imported` with the names, those overwritten and those renamed,
never values; they release nothing, so the access log has none of them.

### Settings

The section **Variable Vault** of the settings (`internal/plugins/vault`'s
module, all whole numbers, for the whole core) is the plugin's page in
Settings, listed under the plugins (`Section.plugin`). The page ends with
the plugin's `settings.extra` (`SettingsExtra.tsx`): **Biometrics** (the
Web UI, below), then **Files**: Import… and Export…, which open the
panel's dialogs (`openVaultImport`, `openVaultExport`), which ask for the
vault's passphrase and so unlock a locked vault; they are disabled in
read-only mode and for a vault without a passphrase yet, which is said.

- `vault.approvalTimeout`: seconds a request waits for an answer (60;
  10–600);
- `vault.autoLock`: minutes after which the vault locks when unused (60;
  0, never; up to 1440). A use is an unlock, a page's action through the
  gate (a change, a reveal, an approval, an export or import, setting the
  countdown) or a value released to a machine; lists and refusals are not.
  The lock is the route's (every session ends, after a passphrase check
  that runs; the key kept or forgotten as the key's hold says), audited as
  `vault.locked` with `reason: idle` and `keyHeld`. While the core holds
  the key a timer looks at least every minute, so a change of the setting
  counts within one. The panel shows the countdown and may set another
  time for the current unlock (`POST autolock`, below), which holds until
  the vault locks: the next unlock follows the setting again;
- `vault.passphraseHours`: hours after the passphrase was last given (by
  the wall clock: sleep counts) that the core holds the key (24; 1–168),
  so that biometrics unlock a locked
  vault; then the vault locks and only the passphrase unlocks it (the
  key's hold, above);
- `vault.sessionIdle` and `vault.sessionMax`: a page's session ends unused
  for those minutes (30; 1–240) or those hours after it began (12; 1–24);
- `vault.runTimeout`, `vault.runMaxTimeout` and `vault.runOutput`:
  `run_with_env`'s default and longest timeouts in seconds (120 and 600;
  5–3600; a default above the longest takes the longest) and the KiB of
  output it returns (64; 4–1024). The core sends them with an `env`'s
  values; the MCP server applies them to that command.

### Machines

Every agent listens on `<run>/vault.sock` (0600; connections only from its
own user, by peer credentials; at most 16 at once) and relays each
connection to the core over a stream with op `vault`, opened once the
connection sent its request, as the VS Code bridge's socket does. One agent
of the instance serves it at a time, the newest: after a reconnect the old
session's agent may linger until it notices, and the socket must lead to
the session that works. An agent that starts takes the socket over; one
whose socket was taken over checks every 2 s and serves it again once it
is free (the newer agent gone, or killed and its socket left); an agent
removes the socket when it exits only while it is its own (the same
inode). So it is served while any agent of the instance runs, and none is
left after the last.

The MCP server is the `mcp` command of the agent and of the core (the local
machine's agent runs in the core's process). The agent keeps
`<data dir>/bin/<slug>-mcp` a link to its running executable: agents are
uploaded under their build's hash, so the link is the path that stays the
same across updates. Started by that name, the executable runs the MCP
server for the data directory the link is in, without arguments.

The server (`internal/vaultmcp`) speaks MCP over stdio (JSON-RPC 2.0, one
message per line; revisions 2025-06-18, 2025-03-26 and 2024-11-05):
`initialize`, `ping`, `tools/list`, `tools/call`; notifications get no
answer. `notifications/cancelled` ends the call it names, which then gets
no response: its request to the core goes away (a request waiting for the
user's approval is then denied) and its command is killed. It identifies
its client by its parent process's name (`/proc/<ppid>/comm` on Linux,
`/bin/ps` on macOS) and its terminal by `HC_TERMINAL_ID`, which terminals
of the terminal core carry. Each tool call is one connection to
`vault.sock`. Its tools:

- `list_variables`;
- `get_variable {name}`: the value, as the tool's text: it enters the
  agent's conversation;
- `run_with_env {command, names, cwd?, timeout?}`: runs `sh -c command` in
  its own process group with the variables added to the server's
  environment and stdin closed, and returns the exit status and up to
  64 KiB of combined output (`vault.runOutput`), in which each value as it
  appears is replaced with `***`; killed after `timeout` seconds (by
  default 120, `vault.runTimeout`; at most 600, `vault.runMaxTimeout`):
  the core sends these settings with the values (`VaultResponse.run`).
  Output is captured 64 KiB (the longest value) beyond what is returned,
  so a value cut by the limit is still masked; when even the capture is
  cut, its last bytes that could be the beginning of a value (fewer than
  the longest value's length), which no occurrence matches and which
  masking the rest (`***` is shorter) would bring within the returned
  part, are dropped.
  The process group is killed when the command returns too, so programs it
  left in the background (`sleep 999 &`) do not outlive the call with the
  values in their environment; Wait gives up after 2 s on output such a
  program still holds. A program that leaves the group (`setsid`, a
  daemon) escapes it.
  Masking misses values that are encoded, split or transformed: it keeps
  values out of the conversation by accident, not against a command
  written to reveal them.

The server exits when its stdin closes, or on SIGTERM, SIGINT or SIGHUP,
killing the commands it still runs first. Killed outright (SIGKILL), it
cannot: each command's shell first starts a watcher in the command's group
that holds the read end of a pipe whose write end only the server has, and
kills the group when the pipe closes, which it does when the server is gone
however it ended; on Linux the shell also gets SIGKILL when the server
dies (`Pdeathsig`).

### Web UI (`web/src/plugins/vault`)

The panel **Variable Vault** of the right sidebar (command
`view.panel.vault`, no default key):

- **The gate** (`Gate.tsx`) at the top: a new vault's card to create the
  passphrase (twice, with a strength bar and that it cannot be recovered);
  otherwise, without a session, a card to unlock with the passphrase and,
  where this page can make a proof (the core holds the key, and the
  desktop app's authenticator is on or a WebAuthn credential was added from
  this origin), **Continue with** Touch ID, Windows Hello, or biometrics or
  a security key; on a vault locked within the key's hold also **Require
  Passphrase** (a Lock that forgets the key). With a session, a bar that
  says the page is unlocked, with Change Passphrase (which says that
  biometrics and exempt apps are removed, when there are any), the
  auto-lock's countdown and Lock. Both have Settings, which opens the
  vault's page of Settings, and say on hover when the passphrase was set.
  The countdown (`AutoLock.tsx`) shows the time left before the vault
  locks unless something uses it (`autoLock.lockAt` of the list, ticking
  every second; at zero, or when a use elsewhere moved it, the list is
  loaded again), or **No auto-lock**; on hover it also says when the
  passphrase is needed again (`autoLock.keyUntil`).
  A click opens a picker: **As in Settings** (the setting's time), 15 and
  30 minutes, 1, 2, 4 and 8 hours, **Never**, or a time typed (`90`,
  `90m`, `2h`, `1.5h`, `1h30m`, `2小时`; 1 minute to a day). The choice
  holds for this unlock on every page (the core keeps it, and tells the
  pages), is shown in the accent while it does, and counts as a use, so
  the countdown starts again from it. A longer time than the current one,
  or Never, asks for the passphrase below the bar first. A page that the gate refuses (its session ended)
  shows the unlock card again. The passphrase fields keep password
  managers away (`autocomplete="off"` and the attributes 1Password,
  LastPass and Bitwarden honor): a passphrase saved by a browser is
  readable by programs on the computer in several browsers.
- Requests waiting for an answer.
- Three tabs (`Variables.tsx`, `AccessLog.tsx`, `SetupGuide.tsx`). **Variables**: search, Import…, Export…, New Variable, a bar
  to choose all variables shown (and, with some chosen, Export…, Who May
  Read… and Delete for them together, the last two only with a session:
  one call per variable, the ones that failed named), and a row per
  variable with a checkbox (Shift chooses a range), its name with a button
  that copies the name (never the value), the inject-only tag, its
  description and who may read it
  without asking (every time asks, the machines chosen, all machines, in
  the colors of safe to open); reveal after a confirmation, hidden again
  after 30 s, and edit, both only with a session. The editor is a dialog:
  name, description, a write-only value field (shown while typing on
  request) that sets a new value, who may read without asking (ask every
  time, chosen machines, all machines: the machines a searchable choice,
  `components/Picker.tsx`, with their state, the same in Who May Read…),
  inject only as a
  switch, and Delete after a confirmation. Saving is one call, a new name
  included (`to`), so a save that fails changed nothing and can be tried
  again as it is. **Access log**: the records
  the log keeps, by day, filtered by machine (or pages; a searchable choice)
  and outcome, each
  with its time, outcome (values let out: allowed by the list, shown or
  exported by a page; approved; refused; listed), tool, names, machine,
  client, terminal and directory, the process chain the agent saw (the
  asking process first), and for a page its address. **Connect**: per
  machine (a searchable choice),
  `claude mcp add --scope user <slug>-vault -- <data dir>/bin/<slug>-mcp`,
  Codex's `[mcp_servers.<slug>-vault]` in `~/.codex/config.toml` and the
  JSON other clients take, each with a copy button, built from the
  machine's home and data directory, and for the local machine the note
  that variables any machine may read without asking are open to its
  programs (which reach every machine through the core or ssh), so that
  important secrets ask every time. The editor's choices say the same.

A vault that does not load says why in the panel (its file of another
version, or damaged; the core unreachable) with Retry; a core that keeps
no settings file says so.

The approval prompts are drawn over every page by the plugin's status
item, from its `/ws` messages and, for a page opened while one waits,
`GET requests`: the client, machine, names, terminal and directory, the
process chain, the seconds left, and Deny, Always Allow and Allow Once; a
page without a session allows with biometrics where it can make a proof
(Use the Passphrase swaps in the field) and asks for the passphrase in the
prompt otherwise, which opens a session and, where every Allow is verified
(which the page learns once it has a session), goes with the answer too.
An answer
that fails (the gate, the network, the core) leaves the prompt and says
why; one the core no longer has (answered elsewhere or expired, `404`)
closes it. A list loaded while a session started or ended says nothing
about it (the page keeps the newer state). Whenever the page's connection
to the core (`/ws`) comes back, the status item loads the requests, and the
vault if it was loaded, again: the core may have restarted (its requests
and sessions gone, the vault locked) or changed meanwhile.

The export and import dialogs are drawn over every page by the plugin's
status item, so `openVaultExport(names?)` and `openVaultImport()` (exported
by `web/src/plugins/vault`) open them from anywhere, a settings page
included. **Export**: the variables chosen or all, the vault's passphrase
(a page without a session opens one with it first), the file's passphrase
twice with a strength bar and the warning that the file is only as strong
as it; the file is saved by the browser as
`<slug>-vault-<date>.json`. **Import**: the file and its passphrase (and
the vault's, on a page without a session), then the preview: per variable
its tags (exists, inject only, invalid), the machines it maps to and those
that will ask, and what to do with it (import, skip, overwrite, import
under a new name, checked against the vault's names and the other
choices), with one choice for every name that exists; Import sends them.

**Biometrics** in the vault's page of Settings (`Biometrics.tsx`, to a page
with a session; else a passphrase field and Unlock, the core showing none
of it without one): in the desktop
app a switch to approve with Touch ID or Windows Hello; **In browsers**
(in the desktop app, whose page has no WebAuthn, only while it lists
some), the WebAuthn credentials with their origin and when they were added and
last used, each with Remove (and the desktop app's authenticator, to
remove it from a browser), and Add for a credential of this page's origin
(a label and the passphrase; on a page opened by a loopback IP address a
link to the same page under `localhost`; where the core does not vouch for
the origin, why none is offered); **Verify every Allow**; and **Exempt
apps**: each app with its machine and when it was exempted, with Remove,
and a name (the apps seen asking on the machines chosen, from the access
log's process chains, are offered) with the machines to exempt it on and
the passphrase, under the line that any program on that machine can take
an app's name; a name too long or of a shell or interpreter is refused
with why. The page has no passphrase field of its own: a change that
takes the passphrase (turning the desktop switch on, adding a credential,
ending the rule, exempting an app, and every change when the page's
session is not the passphrase's) asks for it beside the control it is of,
with Cancel and the button that makes the change, when that change is
made; what was typed is dropped once it was sent, whatever came of it, and
when the question is cancelled or another one is asked, so no field holds
the passphrase between changes.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| Inject variables into terminals | Every program of the terminal gets them for its whole life, and agents read their environment anyway; no per-use approval or record. |
| The vault on each machine | Secrets would be copied to every host; one store on the core host is where the user is. |
| An MCP server over HTTP from the core | Machines would need a port reaching the core, or the core one per machine; the agent's yamux session already connects them, and nothing listens on TCP on machines. |
| An MCP SDK | Four methods over stdio are a small amount of JSON-RPC; an SDK would add dependencies to the agent uploaded to every machine. |
| Keychain on every machine | Headless Linux machines have none; the core host holds the key. |
| The key in the system keychain (as development builds did) | Any program of the user reads it without a prompt (on macOS through `/usr/bin/security`; the Secret Service and the Credential Manager alike) and with the file has every value: no approval stands before a program on the core host. Such files are not converted: no request can show that the user, not a program, chose the new passphrase, and none was released. |
| The loopback API or the page's origin as the user's proof | Programs on the core host call the API as pages do, and content on the core's origin passes the origin check; the passphrase is what only the user has, and an authenticator's proof what only the user makes. |
| Upgrading files sealed with less additional data | Their machine lists were not authenticated: an upgrade would seal a widened list in; none was released, so such files are refused. |
| Biometrics only on an unlocked vault, every lock forgetting the key (as before) | The passphrase after every automatic lock, an hour without use by default, is what users disable the lock to avoid. Holding the key in the core's memory for a bounded time after the passphrase, as password managers do, keeps it off the disk; the lock within the hold is the core's refusal, which the gate enforces as it enforces sessions. |
| The key, while held, in a system keychain or wrapped by an authenticator's secret | A keychain item is readable by the user's programs without a prompt (the row above); a secret from the authenticator (WebAuthn's PRF) few platform authenticators give, and the desktop shell's key is given to the core at its start. Neither keeps the key from a program that reads the core's memory, which the hold does not claim either. |
| Exemptions as a setting | Settings are changed through the API without the gate: a program would exempt itself. In the sealed guard they change only in a passphrase's session. |
| Exempting by the client a request names | The request is the requester's word; the process chain is what the machine's kernel says, which a program can still shape by naming itself, as the Security section says. |
| Exempting an app on every machine (`*`) | A name trusted on one machine would be trusted on every machine, those added later included; each exemption names a machine this core has. |
| WebAuthn in the desktop app | Its page is on `http://127.0.0.1:<port>`, an address no credential can be for, and Electron's Touch ID authenticator needs a keychain access group and a provisioning profile that builds signed ad hoc do not have. The shell's own prompt works in every build. |
| The desktop shell's prompt answered to the page as yes or no | Any script of the page would report yes; a MAC with a key only the shell's main process holds is what the core can check. |
| The prompt's text from the page | A page could show the user one request and have another approved; the shell asks the core what the nonce is for. |
| Reading the attestation of a new credential | It needs a CBOR parser and proves the authenticator's make, which the vault does not ask; the browser hands the public key itself, and an assertion made at once proves the key. |
| Verify every Allow as a setting | Settings are changed through the API without the gate, so a program would turn the rule off before allowing. |
| A WebAuthn credential checked by its host name and the request's `Origin` | `localhost` is every port of the computer to a browser, and a program writes its request's `Origin`: a page it serves on another port would have the user's biometrics open the vault. The origin the authenticator signed is what cannot be forged, so the credential is bound to it. |
| Vouching for `localhost` while the core listens on `127.0.0.1` only | Whoever takes `::1` on the same port answers under the same origin in a browser that tries it first. |
| The rule for requests only | A session could then add the asking machine to a variable's readers, or show the value, which is the same value out by another door. |
| A proof's session changing what guards the vault | Biometrics would then add another authenticator, exempt an app, or put the automatic lock off, after which the passphrase is never asked again. |
| Machines and flag in the clear, unauthenticated | A program on the core host could widen a variable's machines in the file and read it without asking; sealing them with the value makes such an edit unreadable. |
| An import session on the core between the preview and the import | The decrypted values would wait in the core's memory for the user's answer, with an expiry and a bound of their own; sending the file and its passphrase again costs one more derivation and leaves nothing behind. |
| Mapping machines by label on import | Labels are names the user gives and two machines may share one: a match could let another machine read without asking. Ids are random for machines added in the UI; the local machine's id is the same everywhere, so its label must match too. |
| Mapping ssh machines by id alone on import | An `--ssh` machine's id is its target and a record imported from herdr's catalog keeps herdr's id, so another core may have a machine of that id that is another host: the file records each machine's kind and target, and an id maps only to a machine with both the same. |
| Exporting values to the browser (a JSON file the page builds) | Values would pass through the page, its memory and its extensions; the core builds the file, and the page gets ciphertext. |
| Values in the browser for editing | A value shown in a page is in its memory, its extensions' reach and its screen; the editor only sets new values. |

## Failure modes

- Locked vault (after every start): `get` and `env` fail with
  `vault_locked` until a page unlocks it. A lost passphrase cannot be
  recovered: delete the file and start again.
- A vault locked within the key's hold (Lock, or unused for the automatic
  lock's time, with an authenticator): machines get `vault_locked`; a
  page unlocks it with biometrics or the passphrase; Require Passphrase
  forgets the key.
- The key's hold over (`vault.passphraseHours` after the passphrase): the
  vault locks and the core forgets the key, every session ends, biometrics
  are not offered and only the passphrase unlocks it.
- A file of another version (a development build's): the vault does not
  open (`503 version`) and the panel says so; move the file away to start
  a new one, then Retry. A damaged file (not JSON, a passphrase without its
  parameters) likewise (`503 invalid`).
- The file edited (machines widened, flag dropped, values swapped): that
  value no longer opens (`corrupt`); changing the passphrase fails until
  it is set again or deleted.
- The core killed while writing the file: the file is the old one or the
  new one (it is flushed before it replaces the old).
- A page's session ended (idle, locked, the passphrase changed): the gate
  answers `401 vault_session` and the page asks for the passphrase again.
- The core restarted or the page's connection to it lost: once it is back,
  the page loads the vault and the requests again and finds the vault
  locked and its session gone.
- Wrong passphrases in a row: `429 wait` for a while that doubles; a check
  while another runs: `429 busy`.
- Nobody answers: the request is denied after 60 s
  (`vault.approvalTimeout`); the agent gets `denied` and can ask again.
- The vault unused for the minutes of `vault.autoLock` (or the time the
  panel set for this unlock): it locks, every page's session ends, the
  time set is forgotten and machines get `vault_locked` until a page
  unlocks it again (with biometrics within the key's hold, where it has an
  authenticator).
- A machine removed while the core does not hold the key: its exemptions
  exempt nothing, and leave the guard at the next unlock.
- Too many requests waiting: past 4 of the machine (or 32 in all) the
  agent gets `busy`, says so to the model, and can ask again once the user
  answered.
- The agent or the core gone: the MCP server reports `unavailable` for the
  call and keeps running; the next call connects again.
- A reconnect while the old session's agent lingers: the new agent takes
  `vault.sock` over at once; the old one, exiting, leaves it in place.
- The MCP server killed, also with SIGKILL: the watcher in each command's
  group kills it, with what it left in the background.
- The client cancels a call (`notifications/cancelled`): a request
  waiting for approval is denied, a command killed; the call gets no
  response.
- The plugin off: the core refuses the stream with `plugin_disabled`,
  which the agent passes to the MCP server.
- The core keeps no settings file: the vault is `unavailable` (503).
- Many refusals in a row (a program repeating a call): one record in the
  log with their count, one audit record a minute per machine and result,
  the last of a burst written when the minute is over.
- The access log cannot be written (a full disk, its file not writable):
  no value leaves; the MCP server gets `log_failed`, a reveal `500
  log_failed`; list calls and refusals are answered as before.
- An export file with a wrong passphrase, or changed: `file_passphrase`
  (the two cannot be told apart); not an export file, or derivation
  parameters out of bounds: `bad_file`; another version: `file_version`;
  over 16 MiB: `too_large`. Nothing is imported.
- An import that meets a taken name (one created since the preview), an
  invalid variable or the bound of 1000 variables: refused as a whole,
  the vault unchanged; the dialog says which variable.
- One change of several chosen fails (Who May Read…, Delete): the others
  are done; the panel names the ones that failed and why.
- The core restarted: the access log is read back from its file; a
  repeated refusal's count may lack the calls of its last 5 s.

## Security

The rows of [SECURITY.md](../../SECURITY.md) on the vault's file and key,
values in browsers, proving the user without the passphrase, reading
variables from machines and what the MCP server exposes. What the key's
hold and exempt apps do not guarantee:

- Within the key's hold a locked vault's key is in the core's memory: the
  lock is the core's refusal (no value given out or changed, every session
  ended, a proof or the passphrase needed to unlock), not the key's
  absence. A program that reads the core's memory gets the key for as
  long as the hold lasts (a day by default, at most a week, by the wall
  clock), not only while the vault is unlocked as before; Require
  Passphrase, or a shorter `vault.passphraseHours`, shortens that.
- A program of the core host can set `vault.passphraseHours` to a week
  before the user's next passphrase; the panel shows when the passphrase
  is needed again (on hover over the countdown).
- Where every Allow is verified, a program driving the user's unlocked
  page, with its session, gets no value out: what would let one out now
  or later (an Allow, a reveal, a widening, an export, an authenticator,
  an exemption, a longer automatic lock) takes a proof made for it or the
  passphrase in its request. It can still change what lets nothing out:
  values and descriptions (its own token under a variable's name, words
  for the agents in a description), variables added, renamed, deleted or
  imported over, fewer readers, authenticators and exemptions removed, a
  lock or a shorter automatic lock.
- An exemption trusts a process name, which any program of the user on
  that machine can take: against such a program it is as wide as the
  machine in every variable's list while the vault is unlocked. It never
  applies while the vault is locked, always leaves a record, takes a name
  kept whole and no shell or interpreter, and only the passphrase in its
  own request adds one. The access log and the machine's process table
  show who asks, so hiding the exemptions from pages without a session
  keeps them from a program that only reads the core's API, not from one
  that looks at the machine.
- Biometrics unlock a vault locked within the hold. Everything that guards
  the vault, values in bulk, and the first unlock after a start or the
  hold still take the passphrase, so biometrics never extend themselves:
  they cannot add an authenticator or an exemption, lengthen the hold or
  the automatic lock, or end Verify every Allow.

## Testing

- `internal/webauthn/webauthn_test.go`: assertions of the three algorithms;
  a wrong challenge, origin, host name, ceremony, cross-origin, the user not
  verified or not present; changed data and signatures, another key; keys
  that do not fit their algorithm, short or of another curve; inputs over
  their bounds; registrations and their credential id; random bytes never
  panicking. `internal/vault/guard_test.go`: the guard sealed, read only
  unlocked, another vault's or an edited one not opening, a new passphrase
  ending the authenticators and keeping the rule; a suspended vault
  refusing values, changes, allows, exports, imports and exemptions while
  its guard is read, unlocked by Resume or the passphrase, not by a wrong
  one, and not resumed once locked (`TestSuspend`); exemptions sealed,
  bounded and checked, for one app on one machine, none while locked, a
  removed machine's going at once or at the next unlock, a new passphrase
  ending them (`TestExemptions`).
  `internal/plugins/vault/proof_test.go`: adding an authenticator (the
  passphrase again, a key that is not the authenticator's refused), a
  proof opening a marked session and what that session may not do (exempt
  apps included), a proof used twice, for another purpose, from another
  origin or host, by another key, with a counter that went back, after its
  time; a lock keeping the key of a vault with an authenticator (machines
  refused, sessions and nonces ended) and its proof unlocking it, the key
  forgotten once its hold is over and by a lock that forgets, after which
  no proof holds (`TestProofOpensASession`); a
  proof allowing its request and answer only; Verify every Allow against a
  session, with the passphrase, and deny; a credential offered and taken
  only at its own origin, a page of another port refused, also when its
  assertion is posted as the UI's; the rule covering reveals and grants
  and ended only with the passphrase
  (`TestVerifyEveryAllowCoversValuesAndGrants`); a setting not lengthening
  an unlock (`TestAutoLockSettingDoesNotLengthenAnUnlock`); the desktop shell's proof (only
  the desktop client, only once on, only for the nonce's purpose, none
  without a key) and what the shell learns of a nonce; the bound of
  waiting nonces. `internal/server/plugins_test.go`
  (`TestPluginCallClient`): a call's client and the shell's MAC, which the
  token does not make. `desktop/src/verify.test.ts`: the MAC's test
  vectors, the prompt's text per purpose with labels cleaned, and every
  malformed nonce or purpose and cancelled prompt giving nothing;
  `windowsHello.test.ts`, `preload.test.ts`, `core.test.ts`.
  `web/src/__tests__/vaultProof.test.tsx`: the ways a page has, the
  ceremonies' options and what is posted, the card, the gate and the
  settings page.
- `internal/vault/vault_test.go`: a new vault's passphrase first (and when
  it was set), the value not in the clear, wrong passphrases leaving it
  locked, verify; the version, name, machines and flag binding values
  (swapped values, machines widened or added and flag dropped in the
  file), additional data with one text per content and control characters
  refused; files of other versions, of the keychain mode, without a
  passphrase's parameters, with variables but no passphrase or not JSON
  refused with their codes; changing the passphrase, and a change that
  fails leaving a locked vault locked; validation; Argon2 parameters out
  of bounds refused; file permissions; unknown fields kept; a removed
  machine leaving the lists at once or, locked, at the next unlock, values
  that do not open included, and allowed again afterwards; a removal that
  could not be written at the unlock applied by the next allow or
  deletion (`TestForgottenAppliedAtTheNextChange`); renaming with other
  changes in one write, a refusal changing nothing (`TestSetRenames`).
- `internal/vault/export_test.go`: a file's round trip, with only its
  format, version, derivation and cipher in the clear and a salt and nonce
  of its own; a short file passphrase, a wrong one, a changed ciphertext
  or derivation, a nonce of another size, derivation parameters out of
  bounds, another version, format or cipher, not JSON and too large, each
  with its code; more than 1000 variables; the store's export (unlocked,
  names that are not there named) and import in one write, refused as a
  whole for a taken name, a name twice, an invalid one, a value too long
  or a machine with a control character, the creation time kept, more
  than 1000 variables refused.
- `internal/userfile/userfile_test.go`: the content flushed before the
  rename and the directory after, a content that cannot be flushed
  replacing nothing (`TestWriteIsDurable`).
- `internal/plugins/vault/vault_test.go`: lists without values, allowed
  machines, inject only, locked, approvals (once, always persisting, deny,
  timeout, requester gone, first answer wins), an answer racing the
  timeout, at most 4 waiting requests per machine and identical requests
  sharing one, list calls coalesced; refusals coalesced and audited once a
  while with the end of a burst written, reloads of the pages throttled
  (`TestRefusalsAreCoalesced`); a file that does not open answered with
  its code and opened again once moved away (`TestOpenErrors`); a rename
  saved with the other changes (`TestSaveRenames`); the gate: routes
  refused (and audited) without a session, sessions opened by the
  passphrase or its setup and ended idle (lists not counting as use), old,
  by a lock or a change, not opened across a lock, a lock asked for during
  a check or a change coming after it (`TestLockDuringAPassphraseCheck`),
  wrong passphrases slowed down, one check at a time (`busy`), approvals
  without a session refused and denials allowed; answers, saves and
  reveals audited without values or passphrases; a removed machine
  forgotten.
- `internal/plugins/vault/accesslog_test.go`: the access log read back
  after a restart with releases, counts and who asked, 0600 and without
  values (`TestAccessLogSurvivesARestart`); releases never merged and
  never pushed out by refusals (`TestReleasesAreNeverCoalesced`); a
  release whose record cannot be written refused (`TestUnloggedReleaseIsRefused`);
  a release after a write that failed partway, and after a half line a
  crash left, read back (`TestAccessLogAfterAFailedWrite`);
  the file written again past its bound and read back the same; a merged
  count written once the while is over; the process chain taken from the
  header, never the request (`TestWhoAskedComesFromTheAgent`); cancelled
  and expired requests.
- `internal/plugins/vault/transfer_test.go`: an export needs the session
  and the vault's passphrase, a file passphrase of 12 characters, a
  choice, names that exist and an unlocked vault; its file opens with its
  passphrase, names the machines with their labels, is recorded as
  `exported` and audited without values or passphrases
  (`TestExport`); an import's preview without values, with the names that
  exist and the machines unknown here (the local machine of another label
  among them), a conflict refusing it all, bad choices refused, then
  import, overwrite, skip and rename in one write, machines mapped by id,
  audited without values (`TestImport`); an id mapped only with the same
  kind and target, never from a file without targets
  (`TestImportMapsMachinesByTarget`); the local machine kept when its
  label matches, a wrong passphrase, a changed file, another version, not
  a file and too large refused by both routes (`TestImportFailures`).
  `internal/server`'s `TestMutatingRoutesAreGuarded` refuses export and
  import read-only and from other origins.
- `internal/plugins/vault/settings_test.go`: the settings' defaults are
  the values before them and out-of-bounds values are refused
  (`TestSettingsDefs`); the approval's wait, a session's idle and longest
  life, the auto-lock (uses keep the vault unlocked, then it locks, ends
  every session and is audited, without an authenticator forgetting the
  key; 0 never locks it but the key's hold still ends: `TestAutoLock`;
  with an authenticator the key kept, `keyUntil` in the list, the
  passphrase beginning the hold again and the hold ending while locked:
  `TestAutoLockKeepsTheKeyForAProof`; a time a page sets behind the gate,
  its bounds, `lockAt` in the list, the lock at that time and the setting
  again after it: `TestAutoLockSetByPage`), the hold's setting shortening
  but not lengthening a hold (`TestPassphraseHoldSettingDoesNotLengthenIt`)
  and `run_with_env`'s limits sent with an env's values, not a get's. The
  automatic lock's tests move a clock of their own and make the timer's
  looks themselves, so they do not depend on how fast the machine runs.
- `internal/plugins/vault/exempt_test.go` (`TestExemptApps`): exempting
  takes a passphrase's session and the passphrase again in the request
  (none and a wrong one refused, audited), a name kept whole and no shell
  or interpreter, and machines this core has;
  the file does not name the app; an exempt app reads without a prompt,
  recorded as `exempted` with its process chain, and its list needs no
  approval; inject-only stays so; another app, a request that only names
  the app, the app on another machine and a process the app started that
  asks itself each ask; a locked vault gives nothing; an exemption ended,
  a removed machine (also while the key is not held) and a new passphrase
  end it; where every Allow is verified a session of the passphrase can
  neither reveal nor exempt
  (`TestExemptingTakesThePassphraseWhereEveryAllowIsVerified`).
- `internal/plugins/vault/settings_test.go` (`TestTimeLimitsCountSleep`):
  a sleep past the key's hold (the monotonic clock stopped) has the key
  forgotten and the session ended at the first request after it, and by
  the timer's late look; a wall clock set back does not lengthen the hold;
  a session's idle time counts the sleep. `TestAutoLockSetByPage` also
  refuses a longer time, never and the setting's longer time without the
  passphrase in the request and with a wrong one, and takes a shorter one
  with the session.
- `internal/plugins/vault/proof_test.go` (`TestListWithoutASession`):
  without a session the list names no authenticator's id, label or use,
  no exemption, rule, `lockAt` or `keyUntil`, and only the way this origin
  can prove with (none for an origin not vouched for), also while the vault
  is suspended; the nonce names the credential.
- `internal/vault/guard_test.go`: `TestCheckApp` (names up to 15 bytes, no
  shells or interpreters, versions included, their codes); `TestSuspend`
  also refuses the user's change of a suspended vault's guard while
  recording a proof's time and counter.
- `internal/vaultmcp/mcp_test.go`: JSON-RPC over pipes (initialize and
  version negotiation, notifications, tools), masking, truncation, masking
  where the capture is cut (`TestMaskAtTheCut`), the core's limits on
  output and timeouts (`TestRunLimitsFromTheCore`), timeouts that kill the
  process group, errors reaching the model, a cancelled call's request
  leaving the core without a response, the socket's path from the link;
  `run_unix_test.go`: programs left in the background killed when the
  command returns; `signal_unix_test.go`: commands and what they left in
  the background killed when the server gets SIGTERM, SIGHUP or SIGKILL
  (the test binary started again as the server), and when the client
  cancels the call.
- `internal/agent/vault_test.go`: `vault.sock` (0600) relayed to the core as
  op `vault` with the connecting process and its parent in the header, the
  link to the executable; `vault.sock` and `bridge.sock`
  served by the newest of two agents of one instance, kept when the older
  exits, served by the other again when the newest exits first, removed
  with the last (`TestSocketsFollowTheNewestAgent`).
- `internal/server/machines_test.go`: removing a machine tells the plugins
  (`TestMachineRemove`).
- `internal/server/plugins_test.go`: agents' streams of a plugin's op, refused
  while the plugin is off; `TestMutatingRoutesAreGuarded` covers the
  vault's routes.
- `web/src/__tests__/vault.test.ts`: the panel without values; unlocking
  (a wrong passphrase, then the right one) before reveal and edit, reveal
  after confirming with the session; the editor's request (machines,
  flag) and a rename in one call, tried again after a failure; creating
  the passphrase (a mismatch first); a load crossing a session's start;
  why the vault did not load, with Retry; the requests and the vault loaded
  again when the connection to the core comes back; read-only; the
  approval prompt asking for the passphrase, denying without one and
  resolved elsewhere, kept with the reason when an answer fails and closed
  when the core no longer has it; `busy` told from `wait`; the access log
  with a page's reveal, a count, the directory and the process chain, and
  the chain in the prompt; the local machine's note; the setup snippets.
- `web/src/__tests__/vault-transfer.test.ts`: exporting the chosen
  variables (a file passphrase under 12 characters and a mismatch
  refused, a session opened first with the vault's passphrase, the file
  saved under its name), all of them and a wrong passphrase said; an
  import's preview (a wrong file passphrase said), its defaults, the
  choice for every existing name, a new name checked before anything is
  sent and the choices in one call; choosing all, a range with Shift,
  exporting the chosen, giving them all machines and deleting them, one
  failure named; the settings page's Import and Export (open the dialogs,
  disabled read-only and without a passphrase, the locked vault said).
- `web/src/__tests__/vault.test.ts` also chooses the editor's machines
  and the log's machine filter with the searchable choice, copies a
  variable's name (not its value) and shows the local machine's note in
  its setup, not in its prompts.
- `web/src/__tests__/vaultProof.test.tsx` also covers the gate (continuing
  with biometrics, unlocking a vault locked within the hold with them,
  Require Passphrase, nothing offered where the page cannot prove) and
  the settings page's biometrics (the authenticators listed and removed,
  adding a credential, the desktop switch, Verify every Allow and ending
  it, the passphrase asked in a proof's session, exempting an app on the
  machines chosen with the apps seen offered and the passphrase (a wrong
  one said) and ending it, nothing of the guard shown to a page without a
  session, and the passphrase that unlocks when the core does not hold the
  key), and the prompt of a page without a session opening one and sending
  the passphrase with the answer where every Allow is verified.
  `web/src/__tests__/vault.test.ts` also asks for the passphrase before a
  longer automatic lock or never (a wrong one said), not before a shorter
  one.
