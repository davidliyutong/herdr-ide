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
  revealing and changing need the vault's passphrase, or the user's
  biometrics (which also unlock a locked vault, for 14 days after the
  passphrase by default), which programs on the core host do not have.
  What it does
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
  core's memory (a debugger with the rights to: while the vault is
  unlocked the key is there, encrypted by memguard under a key that is
  there too), obtains an authenticator's key-encryption key once (which,
  with a copy of the file, opens the vault until the passphrase changes),
  or guesses a weak passphrase offline from the file.
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
updated}], forgotten, guard, unlock, passphraseAt, passphraseHint}` (the
last four: the sealed guard and the authenticators' unlock entries with
the passphrase's window, below). Each value is encrypted with AES-256-GCM under the
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
and kept only in the core's memory while the vault is unlocked, in a
memguard Enclave (the key in memory, below); the vault is locked after
every start until the passphrase, or an authenticator that wraps the key
(unlock entries, below), gives it. `Lock` always forgets the key: a locked
vault gives no value out and changes none (`vault_locked`), applies no
exemption and has no guard to read, whatever authenticators it has. A new vault
asks for its passphrase (at least 8 characters) before its first value
(`no_passphrase`). Parameters read from the file must be within bounds (a
16-byte salt, time 1–10, memory 8 MiB–1 GiB, 1–16 threads), or the vault
does not open: an edited file can neither weaken the derivation nor
exhaust the core's memory. Changing the passphrase needs the current one
and seals every value again under a key of a new salt; the new key is
installed only once all is written, so a change that fails (a value that
does not open: `corrupt`) leaves the vault as it was, locked if it was;
the same write drops every unlock entry (they wrap the old key) and seals
a new passphrase's window.
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
The passphrase can, and the user's biometrics: setting, changing, renaming and deleting variables, revealing a value
and allowing a request (`once`, `always`; denying needs nothing) need a
**vault session** of the page, sent as `X-Vault-Session`, or answer `401
vault_session` (audited as `denied.vault_session`). A page opens one with
the passphrase (`POST session`, which also unlocks the vault; setting or
changing the passphrase opens one too), an authenticator's proof of an
unlocked vault or an authenticator's unlock of a locked one (below): 32
random bytes
the core keeps in memory and the page only in its own memory, never in
storage that programs could read from disk. Only what passes the gate
counts as a session's use: loading the list says whether the session is
open without keeping it so. A session ends unused for 30 minutes
(`vault.sessionIdle`), 12 hours after it began (`vault.sessionMax`),
when the vault is locked (every one: by Lock or the auto-lock) or its
passphrase changed (every other one); a session that a passphrase check
would open after such an end (the check crossed it) is not opened; at most
32 are open, the oldest going. A session's times, the automatic lock's
and the nonces' count by the wall clock and the monotonic
clock together, whichever says longer (`stamp`): the computer's sleep,
which stops the monotonic clock on macOS and Linux, counts, and a wall
clock set back lengthens nothing. Installing or dropping the key is one step
with its sessions (one lock of the plugin): an unlock (by the passphrase or
an authenticator) and the session it opens, a lock and the end of every
session and nonce, a new passphrase and its session, an authenticator and
its unlock entry. A lock asked for while a passphrase is checked, or an
authenticator's unlock runs, comes after the check and its session, so the
vault never ends unlocked after a lock, nor locked with a session open.
Passphrases are checked one at a time, and authenticators' unlocks with
them (`429 busy` while one is checked); three wrong ones in a row cost
nothing, each one after doubles a wait before the next try (`429 wait` with
`Retry-After`, up to 5 minutes), across pages and programs, so a program
can also make the user wait. An authenticator's unlock whose key does not
open or verify counts as a wrong passphrase; one that guesses nothing (a
nonce expired or of another purpose, a vault already unlocked, a desktop
relay that does not open) is refused without counting, and a right one
ends the count as the passphrase does. Opening a session and changing the passphrase
are audited (`vault.unlocked`, `vault.passphrase_set`, with whether it
worked), never with the passphrase; reveals and deletions as
`vault.revealed` and `vault.deleted` once done. A machine's MCP server
reaches the vault only through its agent's socket and the same rules as
every machine: the core host's agent is the local machine's.

**Authenticators** (`proof.go`, `unlock.go`, `internal/webauthn`).
Biometrics (the desktop app's Touch ID or Windows Hello, or a browser's
WebAuthn credential: a platform authenticator or a security key) stand in
for the passphrase in two ways. A **proof** shows that the user is there:
it opens a session of an unlocked vault, or allows one request; it holds
no key, and the authenticators are sealed with the key (the store's
guard), so they are read only while the vault is unlocked. An **unlock**
gives a locked vault its key back: the authenticator keeps the master key
wrapped in an unlock entry of the file, under a key-encryption key only it
can give again, and it may do so within `vault.passphraseDays` of the last
passphrase (the passphrase's window, below).

- A **proof** answers a nonce the core issued (`POST proof`) for one
  purpose: `session`, `answer` with a request's id and `once` or `always`,
  `reveal` or `change` with a variable's name, or `register`. A nonce is
  32 random bytes, good for one try and two
  minutes; at most 32 wait, the oldest giving way; they end with the
  sessions (a lock, a new passphrase). While the vault is locked only a
  `session` nonce is issued, and it is good for an unlock only; a nonce
  issued while the vault is unlocked is never good for an unlock, and those
  issued while it was locked end once it is unlocked. The vault's state and
  the nonce are taken under the plugin's key lock, so no lock or unlock
  comes between them.
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
  tells the page whether to offer biometrics (`webauthn`, the
  authenticators it can prove with, and the ways it can unlock with), the
  page's word that the request is its own (`Sec-Fetch-Site: same-origin`)
  and the request's Host stand for it; that decides what is offered, never
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
  other pages or times, nor the rule, the exempt apps or `lockAt`; a
  session sees all of it (`full`), and for each authenticator whether it
  has an unlock entry (`unlock`). A locked vault has no guard to read:
  the list says instead how this client can unlock it (`unlock.ways`:
  `enclave` or `hello` for the desktop client where the desktop app has
  an entry of that kind, the shell telling its own install's apart; `prf`
  for a page whose origin, vouched for, has a credential's entry) and when
  the passphrase's window ends (`unlock.due`, from the hint in the clear,
  below), with no ids, labels or times. WebAuthn's
  `allowCredentials` takes the credentials' ids, which come with each nonce
  (`POST proof`, which needs no session) for the origin the core vouches
  for only; while the vault is locked those of this origin's unlock
  entries, each with its PRF salt (`prf`). A program that writes that
  origin in its headers learns that a credential exists, its id and its
  salt, which open nothing without the authenticator.
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
  nonce, and wraps the key for it: for WebAuthn what the browser's
  `create()` answered (its public key as the browser gives it,
  `getPublicKey()`, so no attestation is parsed) and an assertion the new
  credential made of the same nonce, which shows that the key stored is
  the authenticator's, with the PRF extension evaluated on the salt the
  nonce came with (`prfSalt`, 32 random bytes): its output (`prf`) is what
  the credential's unlock entry is wrapped under, and a credential without
  PRF is not added (`400 prf_required`); for the desktop app the shell's
  proof with its relay of a new key of this install (the desktop app's
  unlock key, below), so its prompt was answered once. At most 16; one
  desktop authenticator, to which each install of the app adds its own
  entry. The authenticator and its entry are one step for a lock (the
  plugin's key lock): one whose entry cannot be made is not added, and a
  lock does not fall between them. A new passphrase removes them all:
  whoever knew the old one may have added theirs.
- A **session a proof or an unlock opened** is marked. It answers requests
  and changes and shows variables as any session; what guards the vault
  takes a session the passphrase opened (`401 vault_passphrase`
  otherwise): adding and removing authenticators, exempting apps and
  ending exemptions, the rule below, imports and exports.
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
  vault, and an unlock by an authenticator takes the shorter of the
  setting's and the time sealed in the passphrase's window). No page sets
  a time of its own for an unlock.
- Proofs are audited as `vault.proved` (`ok`, `for`, the authenticator's
  kind), unlocks as `vault.unlocked` (`ok`, the entry's `kind`), the
  removal of an unlock entry as `vault.unlock_removed` (`id`, `kind`,
  `reason`: `invalidated`, `stale` (replaced by its install's new entry,
  or ended by a new passphrase), `orphan` (its authenticator gone), `wrap`
  (the desktop relay did not open its wrap)), refusals as
  `denied.vault_proof` and `denied.vault_passphrase`; never with a key, a
  relay's content or a PRF output.

**Unlock entries** (`internal/vault/unlock.go`). The file keeps, outside
the sealed guard (which needs the key to be read), a list `unlock` of
`{id, authenticator, kind, created, check, enclave | hello | prf, wrapped}`:
`id` 16 random bytes; `authenticator` the guard's authenticator the entry
belongs to (the desktop authenticator for `enclave` and `hello`, the
WebAuthn credential for `prf`); `check` the SHA-256 of the file's `check`
when the entry was made; `wrapped` the master key sealed with AES-256-GCM
under the entry's key-encryption key (KEK), whose additional data is the
canonical JSON of the file's version, `"t": "unlock"`, the id, the
authenticator, the kind, the check and every parameter of the kind, so an
entry edited in any member does not open. Each KEK is HKDF-SHA256 (32
bytes):

- `enclave` (the desktop app on macOS): input the P-256 ECDH secret `Z` ‖
  the shell's secret, salt `ephPub` ‖ `sePub`, info `vault-unlock enclave`.
  `Z` is agreed between the app's Secure Enclave key, which the enclave
  uses only after Touch ID with the fingerprints enrolled when it was made,
  and an ephemeral key the core made as it added the entry and of which it
  kept only the public half (`ephPub`). The entry keeps the install, the
  key's blob (which only that Mac's Secure Enclave opens) and its public
  key (`sePub`), both X9.63.
- `hello` (the desktop app on Windows): input the Windows Hello key's
  signature of the entry's challenge (32 bytes the core chose; RSA
  PKCS#1 v1.5 over SHA-256, the same at every signing) ‖ the shell's
  secret, salt the challenge, info `vault-unlock hello`. The entry keeps
  the install, the key's name (`<slug>-vault-<install>`) and its public
  key, which is bound into the additional data to tell the key apart but
  verifies nothing: only that key's signature opens the wrap.
- `prf` (a WebAuthn credential): input the credential's PRF output for
  the entry's salt (32 random bytes the core chose, also the PRF's
  input), salt that salt, info `vault-unlock prf`. The entry keeps the
  credential's origin, RP id and id.

The vectors of `design/testdata/vault-unlock/kek.json` (made with Node's
crypto) are checked by the store's and the desktop shell's tests. A vault
has at most 4 entries of the desktop app, one per install (adding from an
install replaces its entry), and one per credential. Open drops the
entries that are malformed, made for another check (a passphrase changed
since, also by an older build, which keeps the members it does not know),
of an id, install or credential already seen, or over these bounds; a new
passphrase drops every entry, and removing an authenticator drops its
entries in the same write. The key is not wrapped again after an unlock:
it does not change until the passphrase does, so a new wrap would protect
nothing.

An unlock (`POST session` with `{"unlock"}`) runs under the plugin's key
lock, slowed down with the passphrase's checks, and checks in this order:
the nonce (a `session` nonce issued while locked, used once), the entry,
the KEK opening the wrap, the key opening the check, the guard the key
opens holding the entry's authenticator (else the entry is removed: an
older copy of the file was put back), the authenticator's proof (for PRF
the credential's assertion of the nonce, verified with the key the guard
keeps and a counter that grows; the desktop app's relay is its own proof),
and the passphrase's window. Only then is the key installed, the
authenticator's use recorded (a use that cannot be written fails the
unlock) and a session opened, marked as a proof's. Any failure leaves the
vault locked: `401 vault_proof` for what does not open or verify, `403
passphrase_due` outside the window, `409 unlock_stale` for an entry gone,
invalidated or without its authenticator (the entry is removed), `503
memory` for a key that cannot be kept in locked memory. On the desktop
path a relay that opened (only the shell has its key) but whose wrap does
not open is a dead entry, which a re-enrollment that made the Hello key or
the shell's secret again and that the core then refused leaves behind: it
is removed (`409 unlock_stale`, audited with `reason: wrap`) and not
counted as a guess. A PRF output that opens the wrap with an assertion
that does not verify has left its authenticator: audited as
`denied.vault_proof` with `reason: prf_signature` (`prf_counter` for a
counter that did not grow).

**The desktop app's unlock key** (`desktop/src/verify.ts`, `enclave.ts`,
`windowsHello.ts`, `unlockStore.ts`, `relay.ts`, `desktop/helper/`).

- Each install of the app keeps `vault-unlock.json` in the app's user
  data (0600, written beside it and renamed over it, read only as a
  regular file of at most 4 KiB and never through a link): an install id
  (`^[A-Za-z0-9_-]{16,64}$`), which names its entry in the core, and the
  shell's secret (`shellSecret`, 32 random bytes), encrypted with
  Electron's safeStorage (the keychain item `<APP_NAME> Safe Storage` on
  macOS, DPAPI on Windows), so the Secure Enclave key's blob or the Hello
  key alone does not make the KEK. Without safeStorage the app offers no
  unlock (`canUnlock`). A secret that no longer decrypts is made again at
  the next enrollment, the install id kept; entries made with the old one
  then no longer open.
- macOS: the Secure Enclave helper, `<APP_NAME> Enclave.app` in the app's
  `Contents/Helpers` (`desktop/helper/Enclave.swift`, one universal
  executable for arm64 and x86_64 from macOS 12, signed with the app; the
  Touch ID sheet names it). The shell runs it by its absolute path with
  one JSON line in and one out, at most 64 KiB, within 2 minutes, one
  prompt at a time: `available` (a Secure Enclave, and Touch ID with
  fingerprints), `create` (a P-256 key-agreement key in the Secure
  Enclave, usable only with `.privateKeyUsage` and `.biometryCurrentSet`,
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, made without a prompt:
  its blob and public key) and `agree` (a Touch ID prompt with the
  shell's text, "open the variable vault", no reuse of an earlier
  authentication, then the ECDH secret with the peer). It holds no
  state. It answers `invalidated` only for the
  errors whose documented meaning is that the key is gone or the blob
  unreadable (CryptoTokenKit's `objectNotFound` and `corruptedData`, the
  Security framework's `errSecItemNotFound` and `errSecDecode`), so any
  other error keeps the entry. A Mac without a Secure Enclave or Touch ID
  offers no unlock.
- Windows: the user's Windows Hello key container through PowerShell's
  `KeyCredentialManager` (`IsSupportedAsync`; `RequestCreateAsync`
  replacing a key of the same name; `OpenAsync` and `RequestSignAsync`),
  the key's name and the challenge in environment variables, never in the
  script. Enrolling shows two Hello prompts (making the key, signing the
  challenge); Hello's dialogs take no text of the purpose. A key that is
  gone (`NotFound`) is `invalidated`.
- Linux: no unlock key; the app's page unlocks with the passphrase.
- **Enrolling** (the desktop switch): the page asks the shell to enroll a
  `register` nonce; the shell fetches its purpose, which carries a
  challenge for a Hello key (`register.challenge`), on macOS prompts
  Touch ID first and then makes the Secure Enclave key, on Windows makes
  the Hello key and has it sign the challenge, makes its install id and
  secret where it has none, and answers the nonce's MAC and a relay of
  `{kind, install, sePub, blob, shellSecret}` (enclave) or `{kind,
  install, keyName, publicKey, signature, shellSecret}` (hello). The core
  adds the desktop authenticator (a new one needs the relay) or this
  install's entry to it.
- **Unlocking**: for a `session` nonce issued while locked, `GET
  proof/{nonce}` lists the desktop app's entries (`unlock: [{id, kind,
  install, enclave: {blob, ephPub}} | {id, kind, install, hello: {keyName,
  challenge}}]`); the shell picks its own install's, prompts, and answers
  the page `{id, relay}`, the relay carrying `{z, shellSecret}` or
  `{signature, shellSecret}`, or `{invalidated: true}` when the system no
  longer has the key (fingerprints changed, the Hello key removed), on
  which the core removes the entry and the desktop authenticator stays to
  approve with. Without an entry of its own (its file lost, or only other
  installs' entries; Windows with entries of macOS only) it answers
  `none` without a prompt, and the page says to set biometrics up again
  with the passphrase; a cancel or a failure answers nothing.
- **The relay** carries what makes a KEK through the page, which cannot
  read or make one: AES-256-GCM under HKDF-SHA256 of the launch's verify
  key's text (no salt, info `vault-relay v1`), base64url of iv (12 bytes)
  ‖ ciphertext ‖ tag, with additional data `vault-relay`, the purpose
  (`session`, `register`), the nonce and the entry's id (empty for
  `register`), one line each. The core opens it only for a request of the
  desktop client (`plugin.Call.DesktopRelay`, none in a core the shell did
  not start) and only for the nonce, purpose and entry of that request.
  Vectors: `design/testdata/vault-unlock/relay.json`.

A WebAuthn credential unlocks a locked vault from a page of its own
origin: the list offers `prf`, `POST proof` names the credentials of this
origin's entries with their salts, the page's `get()` evaluates the PRF
with them (`evalByCredential`), and `POST session` carries `{"unlock":
{"nonce", "prf": {"credential", "output"}, "assertion"}}`. A credential
added before unlock entries, or a desktop authenticator of an older build,
has no entry: it approves only, and is labeled so until it is added again.

**The passphrase's window.** An authenticator unlocks the vault only
within `vault.passphraseDays` (14 by default, 1–90) of the last time the
passphrase was checked with the key: an unlock or a session with it, a new
passphrase, or the passphrase brought again with a request of an unlocked
vault (adding an authenticator, exempting an app, an export, a request of
Verify every Allow). When that was, and the window then, are sealed under
the key (`passphraseAt`: `{at, days, autoLock}`, additional data
`#passphraseAt`), so a program that can write the file cannot move,
lengthen or lift it: it can only put an older one back, which ends sooner,
or remove it. Its end is also in the clear (`passphraseHint`), from which
the list's `due` comes, for what the UI offers only. An unlock is allowed
while less than the lesser of the setting now and the days sealed have
passed since `at`, by the wall clock (the computer's sleep counts); a
window missing, that does not open, that begins in the future or that has
ended is `passphrase_due`. `autoLock` is the automatic lock's time then
(the setting's for a passphrase that unlocked the vault or set a new
one, the current unlock's for one checked while unlocked; 0: never), which an unlock by an
authenticator takes as its most. **Require Passphrase** (`POST lock` with
`{"forget": true}`, which works on a locked vault and needs no session)
removes the window, so the next unlock needs the passphrase.

**The key in memory** (`internal/vault/key.go`). While the vault is
unlocked the master key is in a memguard Enclave (memguard v0.23.0):
encrypted under a session key that memguard keeps in locked (mlock),
guarded pages and replaces every 500 ms from a goroutine of its own. Each
operation of the store (a value opened or sealed, the guard read and
written, every value of a passphrase change) opens it into a LockedBuffer
(locked, read-only pages between guard pages) that is destroyed (wiped and
released) right after. A lock forgets the key: memguard has no way to
destroy an Enclave, so the store overwrites its ciphertext in place after
checking memguard's layout (an upgrade of memguard must keep it, or the
Enclave is left to the garbage collector) and drops it. The core purges
memguard as the last step of its shutdown (`vault.Purge`); memguard's
interrupt handler is not used. Memory that cannot be locked (`ulimit -l`
too small; [deployment](../deployment.md#remote-resources)) fails the
unlock with `503 memory`: the key never falls back to an ordinary slice.
What memguard does not cover: Go's AES key schedule on the heap during
each operation; the passphrase and PRF output of a request (Go strings,
which cannot be wiped); Argon2's output, an unwrapped key and a relay's
content for the moment before they move into the Enclave or are wiped;
the ephemeral private key while an entry is made; the launch's verify key;
memguard's session key itself, which is in the process's memory too; and
in the desktop shell the strings of `Z`, the signature, the shell's secret
and the helper's answer. memguard's initialization sets the core dump
limit of the whole process to 0 (`RLIMIT_CORE {0, 0}` on Linux and macOS,
nothing on Windows), which the processes the core starts inherit and a
process that is not root cannot raise again; machines run the machine
build, which does not link memguard
([deployment](../deployment.md#remote-resources)).

What needs the passphrase: the first unlock after a start without an
authenticator's entry, and every unlock outside the window or after
Require Passphrase; changing the passphrase (the current one);
what guards the vault, which takes a session the passphrase opened
(adding and removing authenticators, with the passphrase again to add
one; exempting apps, with the passphrase again, and ending exemptions;
Verify every Allow, with the passphrase again to end it); and values in
bulk, imports and exports (an export takes the passphrase again too).
Whatever would let a value out later, then, takes the passphrase in its
own request, so a page's session, which a program driving the page has
too, decides none of it. Biometrics, an unlock's session, a proof's
session or a proof made for the action, are enough to reveal a value, to
add, change (a widening included), rename and delete variables and to
allow a request (once or always); where every Allow is verified, each of
those that lets a value out takes a proof made for it or the passphrase,
as before.

**Exempt apps.** An exemption names an app and a machine: the app's
requests there read every variable without asking (an inject-only one
still only for `run_with_env`) while the vault is unlocked, never while it
is locked; each is recorded in the access log as
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
it, at once while the vault is unlocked, else as a forgotten machine at
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
The log is kept in the core's database (`core[-<instance>].db` beside
the settings file, table `vault_access`, a row a record;
[38](38-sqlite-state.md)) and read back at the core's start, so the panel
shows what happened before a restart. A record that lets values out is
committed to disk (`store.Durable`) before they leave; when it cannot be
written the values do not leave (`log_failed`, to the MCP server and as a
reveal's `500`), also when the database is of a newer version, which this
core reads and does not write. A record gets its id in the transaction
that writes it, after every row's, so it never replaces another; the log
is read again at each use until a read succeeded. The log keeps the last
1000 records that let values out and, apart, the last 500 others, so
lists and refusals, which a program can repeat at will, never push a
release out. The file it was kept in before,
`vault[-<instance>]-access.jsonl` beside the vault's, is imported once and
removed; one an earlier version wrote again after a downgrade has the
records the table lacks added and is removed. Every record is
audited too (`vault.access`, a page's as `vault.revealed` and
`vault.exported`) when the core writes an audit log (`--audit-log`).
Reading the log (`GET log`) needs an open vault session (`401
vault_session` otherwise, audited as `denied.vault_session`): it tells
what was read, by whom, and which apps are exempt. Reading it is no use
of the session, so a page that shows the log does not keep its session
open; a locked vault, which ends every session, shows it to nobody.

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
  gate (a change, a reveal, an approval, an export or import) or a value
  released to a machine; lists and refusals are not. The lock is the
  route's (every session and nonce ends, after a passphrase check or an
  authenticator's unlock that runs) and forgets the key, audited as
  `vault.locked` with `reason: idle` and its `minutes`. While the vault is
  unlocked a timer looks at least every minute, so a change of the setting
  counts within one. A change shortens the current unlock's time but does
  not lengthen it, and an unlock by an authenticator takes at most the
  time sealed with the passphrase's window; the next unlock with the
  passphrase follows the setting again. The time is the setting's only: no
  page sets one of its own for an unlock;
- `vault.passphraseDays`: days after the passphrase was last checked
  within which an authenticator unlocks a locked vault (14; 1–90), by the
  wall clock (sleep counts); then only the passphrase unlocks it, once,
  and starts the window again (the passphrase's window, above). The days
  sealed with the window cap it, so a change shortens the current window
  and lengthens only the next one. It replaced `vault.passphraseHours`
  (the hours the core held the key), which settings files drop;
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
  otherwise, without a session, a card to unlock with the passphrase and:
  on a locked vault this page can unlock without it (the list's
  `unlock.ways`: the desktop app's key where the app can keep one, or a
  credential's PRF in a browser with WebAuthn; none once `unlock.due` has
  passed), **Continue with** Touch ID, Windows Hello, or biometrics or a
  security key, beside it **Require Passphrase** (the next unlock needs
  the passphrase) and below them until when biometrics unlock the vault
  (`unlock.due`); on a vault another page unlocked, where this page can
  make a proof (the desktop app's authenticator is on, or a WebAuthn
  credential was added from this origin), **Continue with** as well. A
  refused unlock says why: the passphrase is due (and the passphrase
  field takes the focus), biometrics are to be set up again
  (`unlock_stale`, or the desktop app having no entry of its own), or the
  check failed; a cancelled prompt says nothing. With a session, a bar
  that says the page is unlocked, with Change Passphrase (which says that
  biometrics and exempt apps are removed, when there are any) and Lock.
  Both have Settings, which opens the vault's page of Settings, and say on
  hover when the passphrase was set. The bar shows no countdown; the page
  loads the vault again a moment after `autoLock.lockAt`, should the
  core's message that it locked not reach it. A page that the gate refuses (its session ended)
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
  asking process first), and for a page its address; without a session
  the tab says the vault is to be unlocked and the page does not ask for
  it. **Connect**: per
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
app, where it can keep an unlock key (the Secure Enclave with Touch ID, or
Windows Hello keys, and safeStorage), a switch to approve and unlock with
Touch ID or Windows Hello, which turned on enrolls this install; **In
browsers** (in the desktop app, whose page has no WebAuthn, only while it
lists some), the WebAuthn credentials with their origin and when they
were added and last used, each with Remove (and the desktop app's
authenticator, to remove it from a browser or from an app that cannot
keep an unlock key), and Add for a credential of this page's origin (a
label and the passphrase; with PRF only: a browser that says the
credential has none, an assertion without a PRF output or a core that
gave no salt refuse it before anything is added, as the core's
`prf_required` does; on a page opened by a loopback IP address a link to
the same page under `localhost`; where the core does not vouch for the
origin, why none is offered). An authenticator without an unlock entry
(added before them, or a credential without PRF) is labeled **Approvals
only; add it again to unlock with it**. Then **Verify every Allow**; and **Exempt
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
| Biometrics only on an unlocked vault, every lock forgetting the key and the passphrase after each | The passphrase after every automatic lock, an hour without use by default, is what users disable the lock to avoid. An unlock entry gives biometrics the key back without the core keeping it, so the lock can forget it. |
| The key held in the core's memory for a day after the passphrase, a lock only suspending the vault (as an earlier build did) | The key stayed in plaintext in memory, also while the vault was locked, for as long as the hold lasted, and a user without biometrics had to type the passphrase again whenever the hold ended. With unlock entries a lock forgets the key, a user without biometrics types the passphrase to unlock only, never because a hold ended, and the key held while unlocked is in memguard's Enclave. |
| The master key in a system keychain item | A keychain item is readable by the user's programs without a prompt (the row above), and it would hold the key itself. An unlock entry is wrapped under a key-encryption key that only the authenticator gives again; the one thing kept with safeStorage (the keychain on macOS) is the desktop shell's secret, half of a desktop KEK. |
| Exemptions as a setting | Settings are changed through the API without the gate: a program would exempt itself. In the sealed guard they change only in a passphrase's session. |
| Exempting by the client a request names | The request is the requester's word; the process chain is what the machine's kernel says, which a program can still shape by naming itself, as the Security section says. |
| Exempting an app on every machine (`*`) | A name trusted on one machine would be trusted on every machine, those added later included; each exemption names a machine this core has. |
| WebAuthn with PRF in the desktop app, or Electron's own Touch ID prompt for its unlock | Its page is on `http://127.0.0.1:<port>`, an address no credential can be for, and Electron's Touch ID authenticator needs a keychain access group and a provisioning profile that builds signed ad hoc do not have. Electron's `promptTouchID` proves presence and gives no secret, so nothing can be wrapped under it. A Secure Enclave key that the app's helper uses only after Touch ID gives a secret, and needs no keychain item: its blob is kept in the vault's file. The shell's own prompt still makes the proofs, which hold no key. |
| The desktop shell's prompt answered to the page as yes or no | Any script of the page would report yes; a MAC with a key only the shell's main process holds is what the core can check. |
| The prompt's text from the page | A page could show the user one request and have another approved; the shell asks the core what the nonce is for. |
| Reading the attestation of a new credential | It needs a CBOR parser and proves the authenticator's make, which the vault does not ask; the browser hands the public key itself, and an assertion made at once proves the key. |
| Verify every Allow as a setting | Settings are changed through the API without the gate, so a program would turn the rule off before allowing. |
| A WebAuthn credential checked by its host name and the request's `Origin` | `localhost` is every port of the computer to a browser, and a program writes its request's `Origin`: a page it serves on another port would have the user's biometrics open the vault. The origin the authenticator signed is what cannot be forged, so the credential is bound to it. |
| Vouching for `localhost` while the core listens on `127.0.0.1` only | Whoever takes `::1` on the same port answers under the same origin in a browser that tries it first. |
| The rule for requests only | A session could then add the asking machine to a variable's readers, or show the value, which is the same value out by another door. |
| A proof's or an unlock's session changing what guards the vault | Biometrics would then widen what biometrics may do: add another authenticator, exempt an app or end Verify every Allow. |
| Machines and flag in the clear, unauthenticated | A program on the core host could widen a variable's machines in the file and read it without asking; sealing them with the value makes such an edit unreadable. |
| An import session on the core between the preview and the import | The decrypted values would wait in the core's memory for the user's answer, with an expiry and a bound of their own; sending the file and its passphrase again costs one more derivation and leaves nothing behind. |
| Mapping machines by label on import | Labels are names the user gives and two machines may share one: a match could let another machine read without asking. Ids are random for machines added in the UI; the local machine's id is the same everywhere, so its label must match too. |
| Mapping ssh machines by id alone on import | An `--ssh` machine's id is its target and a record imported from herdr's catalog keeps herdr's id, so another core may have a machine of that id that is another host: the file records each machine's kind and target, and an id maps only to a machine with both the same. |
| Exporting values to the browser (a JSON file the page builds) | Values would pass through the page, its memory and its extensions; the core builds the file, and the page gets ciphertext. |
| Values in the browser for editing | A value shown in a page is in its memory, its extensions' reach and its screen; the editor only sets new values. |
| Wrapping the key again after each unlock (a new entry, a new salt or challenge) | The master key does not change until the passphrase does: a key-encryption key or PRF output captured once, with any copy of the file that has the old entry, gives the key whatever wraps came after. Only a new passphrase changes the key, and it drops every entry. |
| Keeping WebAuthn credentials without PRF for unlocking | A proof holds no key, and without one the core would have to keep the key in memory for them, which is what unlock entries replace. Credentials added before stay, labeled to approve only; new ones need PRF (`prf_required`). |
| A time of the page's own for the current unlock (the session bar's countdown, `POST autolock`) | It was set with a page's session, which a program driving the page has too, and needed the passphrase again to lengthen it. The automatic lock follows the setting only, which a change while unlocked shortens and never lengthens. |
| An own implementation of locked memory instead of memguard | It would need mmap, mlock and guard pages on Linux and macOS and VirtualLock on Windows, canaries and an encrypted enclave, which memguard has and maintains; what memguard costs is the core dump limit below and a destroy that depends on its layout, checked at each upgrade. |
| A vendored copy of memguard without its line that disables core dumps | Rejected by the user, who accepted the limit: without it a core dump of the core could hold the key, and a fork would have to follow every fix upstream. The limit, which the core's children inherit, is accepted and documented ([deployment](../deployment.md#remote-resources)). |

## Failure modes

- Locked vault (after every start or a lock): `get` and `env` fail with
  `vault_locked` until a page unlocks it, with the passphrase or, within
  the passphrase's window, an authenticator that has an unlock entry. A
  lost passphrase cannot be recovered: delete the file and start again.
- The passphrase's window over (`vault.passphraseDays` after the last
  passphrase, or Require Passphrase): the list's hint stops offering
  biometrics, an unlock by one is `403 passphrase_due`, and the passphrase
  unlocks the vault and starts the window again.
- The window cannot be written at an unlock with the passphrase (a full
  disk): the unlock still opens, and the previous window stays.
- The fingerprints changed on the Mac, or the Windows Hello key was
  removed: the shell relays that its key is gone, the core removes the
  entry (`409 unlock_stale`, audited `invalidated`) and the page says to
  set biometrics up again; the desktop authenticator stays to approve with,
  and turning its switch off and on again (with the passphrase) makes a
  new entry. An error of the helper that does not say so keeps the entry
  and fails that unlock only.
- The app's `vault-unlock.json` lost, or its secret no longer decrypting
  (safeStorage's key gone): the shell has no entry of its own and the page
  says to set biometrics up again; enrolling again makes a new secret,
  under the same install id when the file still names it.
- A re-enrollment that replaced the Hello key or the shell's secret but
  that the core refused (a wrong passphrase, an expired nonce): the old
  entry no longer opens; the next unlock with it removes it (`409
  unlock_stale`, audited `wrap`) without counting a guess.
- An older copy of the file put back with entries whose authenticator the
  guard no longer has: such an entry is refused and removed (`409
  unlock_stale`, audited `orphan`).
- An authenticator without an unlock entry (a credential without PRF, or
  one added by an older build): it approves but does not unlock, labeled
  so in Settings until it is added again.
- memguard cannot lock memory for the key (`ulimit -l` too small, a
  container's limit): every unlock answers `503 memory` and the vault stays
  locked; raise the limit and restart the core.
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
- The vault unused for the minutes of `vault.autoLock`: it locks and
  forgets the key, every page's session and every nonce end, and machines
  get `vault_locked` until a page unlocks it again (with biometrics within
  the passphrase's window, where an authenticator has an unlock entry).
- A machine removed while the vault is locked: its exemptions exempt
  nothing, and leave the guard at the next unlock.
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
- The access log cannot be written (a full disk, the core's database not
  writable or of a newer version):
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
- The core restarted: the access log is read back from the core's
  database; a
  repeated refusal's count may lack the calls of its last 5 s.

## Security

The rows of [SECURITY.md](../../SECURITY.md) on the vault's file and key,
values in browsers, proving the user without the passphrase, reading
variables from machines and what the MCP server exposes. What unlock
entries, the key in memory and exempt apps do not guarantee:

- A key-encryption key once obtained (an enclave's `Z` with the shell's
  secret, a Hello signature with it, a PRF output), with any copy of the
  vault's file, gives the master key offline until the passphrase
  changes: the passphrase's window bounds only the unlocks that go
  through the core. Removing an authenticator and Require Passphrase are
  no revocation against a program that kept an older copy of the file
  and writes it back (the core reads the file at its start, and nothing
  in the file can count against a rollback): revocation is a new
  passphrase, which changes the key and drops every entry.
- `vault.passphraseDays` and `vault.autoLock` are settings, changed
  without the gate: a program of the core host can raise them (to 90
  days, to never) before the user next types the passphrase on a locked
  vault, which seals them into the window. That is bounded by 90 days; a
  change while a window runs shortens it but does not lengthen it.
- A program of the user cannot answer Touch ID, Windows Hello or a
  passkey, but it can cause their prompts: it can run the helper (or a
  program of its own) with an entry's blob, which the file holds, and a
  reason text of its choosing. On macOS the other half of a desktop KEK,
  the shell's secret, is in the keychain under the app's access list
  (another program gets the keychain's prompt). On Windows DPAPI gives
  the shell's secret to any program of the user, and a Hello key can be
  opened by name and asked to sign, with a dialog that names no purpose:
  there only the Hello prompt stands, and a PowerShell transcript, if the
  user turned transcription on, could record the signature.
- A PRF output is a secret for as long as the passphrase lasts, and it
  passes through the page's script and the request's body: content on the
  UI's origin that sees it once (VS Code's windows, while on), with the
  vault's file, has the master key.
- memguard keeps the key encrypted in memory while the vault is unlocked,
  but not what is listed under the key in memory above (Go strings of
  passphrases and PRF outputs, AES key schedules, the ephemeral private
  key while an entry is made, the verify key, and in the desktop shell
  the strings of `Z`, the signature, the shell's secret and the helper's
  answer). A debugger of the same user (ptrace, or a process with the
  rights to read the core's memory) is outside the model.
- memguard sets the core's core dump limit to 0 for the whole process,
  which everything the core starts inherits and cannot raise (accepted:
  [deployment](../deployment.md#remote-resources)), and it needs locked
  memory: a limit too small fails the unlock (`503 memory`).
- The app bundle is only as safe as its folder: a program that can
  rewrite the `.app` (notably one `make desktop-install` put in
  `/Applications`, signed ad hoc) can replace the helper or the shell's
  code and get the secrets the next time the user answers Touch ID.
- Availability is not defended: a program can delete the file or a Hello
  key, call `POST lock` with `{"forget": true}` without a session, or
  make the passphrase wait with failed unlocks, as with wrong passphrases.
- The window counts by the wall clock: an administrator who sets the
  clock back after the passphrase lengthens it.
- Where every Allow is verified, a program driving the user's unlocked
  page, with its session, gets no value out: what would let one out now
  or later (an Allow, a reveal, a widening, an export, an authenticator,
  an exemption) takes a proof made for it or the passphrase in its
  request. It can still change what lets nothing out: values and
  descriptions (its own token under a variable's name, words for the
  agents in a description), variables added, renamed, deleted or imported
  over, fewer readers, authenticators and exemptions removed, a lock, or
  Require Passphrase.
- An exemption trusts a process name, which any program of the user on
  that machine can take: against such a program it is as wide as the
  machine in every variable's list while the vault is unlocked. It never
  applies while the vault is locked, always leaves a record, takes a name
  kept whole and no shell or interpreter, and only the passphrase in its
  own request adds one. The access log and the machine's process table
  show who asks, so hiding the exemptions from pages without a session
  keeps them from a program that only reads the core's API, not from one
  that looks at the machine.
- Biometrics unlock a locked vault within the window. Everything that
  guards the vault, values in bulk, and every unlock outside the window
  still take the passphrase, so biometrics never extend themselves: they
  cannot add an authenticator or an exemption, start the window again, or
  end Verify every Allow.

## Testing

- `internal/webauthn/webauthn_test.go`: assertions of the three algorithms;
  a wrong challenge, origin, host name, ceremony, cross-origin, the user not
  verified or not present; changed data and signatures, another key; keys
  that do not fit their algorithm, short or of another curve; inputs over
  their bounds; registrations and their credential id; random bytes never
  panicking. `internal/vault/guard_test.go`: the guard sealed, read only
  unlocked, another vault's or an edited one not opening, a new passphrase
  ending the authenticators and keeping the rule; a lock destroying the
  key's Enclave (it no longer opens), nothing read or sealed and the guard
  unreadable until an unlock (`TestLockForgetsTheKey`); key material that
  cannot be locked in memory failing the unlock with the vault locked
  (`TestMemoryFailureFailsTheUnlock`); exemptions sealed,
  bounded and checked, for one app on one machine, none while locked, a
  removed machine's going at once or at the next unlock, a new passphrase
  ending them (`TestExemptions`).
  `internal/plugins/vault/proof_test.go`: adding an authenticator (the
  passphrase again, a key that is not the authenticator's refused), a
  proof opening a marked session and what that session may not do (exempt
  apps included), a proof used twice, for another purpose, from another
  origin or host, by another key, with a counter that went back, after its
  time; a lock forgetting the key (machines refused, sessions and nonces
  ended), no proof unlocking a locked vault, a locked vault's nonce good
  for no proof and ended by the passphrase's unlock
  (`TestProofOpensASession`); a
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
  token does not make; `internal/server/client_test.go`
  (`TestDesktopRelay`): the relays of the vectors opening with the key of
  the launch's verify key for their own additional data only.
  `desktop/src/verify.test.ts`: the MAC's test vectors, the prompt's text
  per purpose with labels cleaned, and every malformed nonce or purpose
  and cancelled prompt giving nothing; `canUnlock` (the Secure Enclave with
  Touch ID, or Hello keys, each with safeStorage and the key), unlocking on
  macOS and Windows with this install's entry chosen by the shell, a key
  the system no longer has relayed as such, a cancel or failure giving
  nothing, `none` without a prompt for no entry of this install, only a
  locked vault's session nonce with entries of exactly the core's shape;
  enrolling on macOS (Touch ID first, then the key) and Windows (two
  prompts), null for a refusal, a key not made or a purpose without its
  challenge; one prompt at a time across prove, unlock and enroll.
  `desktop/src/enclave.test.ts`: the helper's path in `Contents/Helpers`
  or the development build, only exact answers taken, peers and blobs
  checked before a run, one prompt at a time, runs bounded by an absolute
  path, output and time. `desktop/src/relay.test.ts`: the relay key, the
  vectors opening for their purpose, nonce and entry only and sealing to
  the same bytes, the enclave vector's `Z` both ways, the vectors' KEKs,
  base64url read strictly. `desktop/src/unlockStore.test.ts`: the install
  id and secret made once, 0600 with the secret encrypted; nothing without
  safeStorage; a secret that no longer decrypts made again with the
  install id kept; a file of another shape not read; only a small regular
  file, never through a link. `windowsHello.test.ts` (also the key
  operations' results and the key's name and challenge in the
  environment, never in the script), `preload.test.ts` (also the unlock
  key's answers of their forms only), `core.test.ts`.
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
  a write that fails refusing its release and leaving nothing, the next
  release read back after a restart (`TestAccessLogAfterAFailedWrite`),
  and after a read that failed (`TestAccessLogAfterAFailedRead`); the log
  refused without a session, its reads no use of one, nothing shown
  while locked (`TestAccessLogNeedsASession`);
  the bounds (`TestAccessLogBounds`); the earlier file imported once, and
  merged after a downgrade (`TestAccessLogImport`,
  `TestAccessLogImportAfterDowngrade`); a database of a newer version read
  and its releases refused (`TestAccessLogNewerVersion`); the database
  beside the settings (`TestAccessLogDatabase`); a merged count written
  once the while is over; the process chain taken from the
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
  every session, is audited and forgets the key; 0 never locks it:
  `TestAutoLock`; the list saying when it locks to a session, the lock
  then, and no route for a page's own time: `TestAutoLockFollowsTheSetting`),
  the old `vault.passphraseHours` dropped from a settings file that has it
  (`TestPassphraseHoursDropped`)
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
  a sleep past a session's time and the automatic lock's (the monotonic
  clock stopped) has the session ended at the first request after it and
  the vault locked by the timer's late look; a wall clock set back
  lengthens nothing.
- `internal/plugins/vault/proof_test.go` (`TestListWithoutASession`):
  without a session the list names no authenticator's id, label or use,
  no exemption, rule or `lockAt`, and only the way this origin can prove
  with (none for an origin not vouched for); the nonce names the
  credential; a locked vault's list has no guard, only the ways to unlock
  and the hint of when the passphrase is due, none for an origin not
  vouched for.
- `internal/vault/guard_test.go`: `TestCheckApp` (names up to 15 bytes, no
  shells or interpreters, versions included, their codes).
- `internal/vault/unlock_test.go`: the KEKs of the vectors, `Z` from
  either private key (`TestKEKVectors`); each kind unlocking after a lock
  and after another start, the window sealed with the passphrase coming
  back, the authenticator's use recorded, the KEK given wiped
  (`TestUnlockEachKind`); an edit of any member of an entry (each
  parameter, the authenticator, the kind, the check, the wrapped bytes)
  dropped at Open or not opening, the vault locked either way
  (`TestEditedEntriesDoNotOpen`); a new passphrase dropping every entry,
  one changed by an older build leaving entries of another check that
  Open drops (`TestNewPassphraseEndsTheEntries`); an entry whose
  authenticator is gone (an older copy put back) refused and removed, a
  removed authenticator's entries going in the same write
  (`TestOrphanEntries`); the authenticator's proof checked after the key
  opened and before it is installed, its counter recorded, a KEK that does
  not open never reaching it (`TestUnlockVerifies`); the window: allowed
  within the lesser of the days, refused with none, in the future or
  ended, an older window put back ending sooner, `ForgetPassphrase` also
  while locked, a passphrase checked while locked refreshing nothing
  (`TestPassphraseWindow`); the new members kept by a build that does not
  know them, a removed entry not coming back (`TestOlderBuildRoundTrip`);
  the input and bounds of adding (the authenticator of the right kind,
  one per install and per credential, at most 4 of the desktop app, the
  vault unlocked: `TestAddUnlockBounds`); a purge leaving no key that
  opens (`TestPurge`).
- `internal/plugins/vault/unlock_test.go`: the desktop app unlocking with
  its install's Secure Enclave or Hello key, only for the desktop client,
  with a relay of this very nonce, purpose and entry, once, its session a
  proof's, no secret in the audit, relays refused without counting a
  guess (`TestDesktopUnlock`); PRF outputs that do not open slowed down as
  wrong passphrases, what guesses nothing not counted
  (`TestFailedUnlocksAreSlowedDown`); a dead entry after a refused
  re-enrollment removed as `unlock_stale`, audited, not counted, and
  biometrics set up again with the passphrase (`TestDeadDesktopEntry`);
  the shell's word that its key is gone ending the entry, the desktop
  authenticator kept (`TestDesktopUnlockInvalidated`); a credential with
  PRF unlocking at its own origin with its assertion verified and its
  counter grown, a leaked output audited, an unknown credential and an
  unlocked vault refused (`TestPRFUnlock`); `403 passphrase_due` outside
  the window, after which the passphrase works, and Require Passphrase
  ending it while locked (`TestPassphraseDue`); the automatic lock after an
  unlock by an authenticator at most the time sealed with the window,
  whatever the setting said before or after
  (`TestAutoLockAfterAnUnlockByAnAuthenticator`); registration wrapping the
  key (`400 prf_required` without PRF, a new desktop authenticator refused
  without its relay, a relay of another nonce or key name refused, a
  second install's entry added to the one desktop authenticator, removing
  an authenticator or a new passphrase removing its entries, audited:
  `TestRegistrationWrapsTheKey`); a lock during an unlock coming after it
  and its session (`TestLockDuringAnUnlock`) and during an add after the
  authenticator and its entry (`TestLockDuringAnAdd`); `503 memory`
  (`TestMemoryError`).
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
  not asked for without a session, then with a page's reveal, a count, the directory and the process chain, and
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
- `web/src/__tests__/vaultProof.test.tsx` also covers the gate
  (continuing with biometrics where the page can prove; unlocking a locked
  vault with the desktop app's key, the relay posted as the app answered,
  and with a credential's PRF of the entry's salt and its assertion;
  nothing sent without a PRF output and nothing said of a cancel; the
  desktop app's key offered only where the app can keep one and nothing
  once the passphrase is due; why an unlock was refused (due, stale,
  failed), and the app's having no key of this install; Require
  Passphrase beside biometrics only; locking from the session bar; nothing
  offered where the page cannot prove) and the settings page's biometrics
  (the authenticators listed and removed, adding a credential and not
  adding one without PRF, the label of one that only approves, the desktop
  switch with the app's enrollment, none in a browser or an app that
  cannot keep an unlock key, Verify every Allow and ending it, the
  passphrase asked in a proof's session, exempting an app on the machines
  chosen with the apps seen offered and the passphrase (a wrong one said)
  and ending it, nothing of the guard shown to a page without a session,
  and the passphrase that unlocks a locked vault), and the prompt of a
  page without a session opening one and sending the passphrase with the
  answer where every Allow is verified.
  `web/src/__tests__/vault.test.ts` also shows no auto-lock countdown or
  time of the page's own in the session bar.
