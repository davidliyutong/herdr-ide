# 30 · Variable vault

## Context

Coding agents on every machine need the same API keys and tokens. Copying them into each machine's shell profile spreads secrets in clear text, keeps them in every process's environment and records nothing. The hub already reaches every machine and has a UI the user watches, so it keeps the secrets in one place and hands them to agents that ask, with the user deciding.

## Goals / non-goals

- One encrypted store of named variables on the hub host, edited in the UI, organized into groups and reusable presets. Values reach a browser only on an explicit, logged reveal.
- Coding agents on any machine read them through an MCP server, or run a command with them set without seeing them.
- Opt-in **workspace preset links**: new terminals and chats of a linked workspace start with the presets' variables while the vault is unlocked.
- Per-variable allowed machines; other machines ask the user, who allows once, always, or denies.
- Export files, encrypted under a passphrase of their own, move variables between vaults.
- One gate for every caller, the hub host's own programs included: a value leaves only for a machine the variable lists, an app the user exempted on a machine, a new panel of a linked workspace, or with the user's approval. Approving, revealing and changing need the passphrase or the user's biometrics, which programs on the hub host do not have; biometrics also unlock a locked vault within `vault.passphraseDays` of the passphrase.
- No value leaves without its record in the access log, written to disk first.

Accepted in exchange for the log: a variable that lists machines is open to any program there, and a linked preset's variables to the workspace's new panels and their children. Programs on the hub host can run commands on every machine, so only variables that ask every time and are in no linked preset are kept from them; the panel says so. Content on the UI's origin (VS Code's windows) can read the page's session or a passphrase typed into it ([SECURITY.md](../../SECURITY.md)).

Non-goals: injecting the vault into every terminal (every program would get every secret); protection against the user's own programs on an allowed machine or in an injected panel, a program driving the unlocked page or reading the hub's memory, a key-encryption key obtained once, offline guessing of a weak passphrase; configuring the CLIs (the panel shows how).

## Design

### Store (`backend/features/vault/store.ts`, `crypto.ts`)

`vault[-<instance>].json` beside the settings file, 0600, written atomically and durably (`backend/shared/host/userfile.ts`).

- **Key.** Argon2id of the passphrase (at least 8 characters), its parameters in the file and refused outside fixed bounds, so an edited file can neither weaken the derivation nor exhaust memory. The vault is locked after every start; a lock forgets the key, and a locked vault gives out and changes nothing (`vault_locked`). Unlocked, the key is a non-exportable WebCrypto `CryptoKey` ([42](42-typescript-backend.md#security)).
- **Values** are sealed one by one with AES-256-GCM, the additional data binding the file version, the name, the machines and the inject-only flag: a ciphertext moved to another entry, or machines widened or the flag dropped in the file, does not open (`corrupt`). **Inject-only** variables go only to `run_with_env` and linked presets, which keeps them out of the conversation by accident, not against a command written to print them.
- **The guard** (authenticators, exemptions, Verify every Allow) is sealed under the key, never in settings, which change without the gate.
- **Groups, presets, workspace links.** A preset names variables and groups; a link maps `(machine, workspace)` to presets. They are in the clear so a locked vault lists them, and also sealed under the key (`#policy`): injection and every policy write verify it first and fail closed (`corrupt`), so an offline edit can neither inject values nor be blessed by a later save.
- **Another file version** holding a passphrase does not open (`version`), nor a malformed file (`invalid`); it is never converted, since no request could show that the user chose the new passphrase.
- **A new passphrase** needs the current one, seals everything again, and ends every authenticator, unlock entry and exemption (whoever knew the old one may have added theirs). The panel shows when it was set, since a new vault's first passphrase needs no session.
- **A removed machine** leaves every list, exemption and workspace link, so one added later under the same id asks again; while locked it is held in `forgotten`, which lets nothing read.

### Hub (`backend/features/vault`: `vault.ts`, `gate.ts`, `hub.ts`)

The plugin `vault` (`plugins.vault.enabled`) opens the store at first use; a file that does not open answers `503` with its code and is tried again at the next use. Routes: [reference](../reference.md#variable-vault). Every route that changes something is refused read-only and audited, never with values or passphrases.

#### The gate

Any program on the hub host can call the hub's API; only the passphrase and the user's biometrics tell the user from a program.

- Changes, reveals, allowing a request and reading the access log need a **vault session** (`X-Vault-Session`, else `401 vault_session`); denying needs nothing. A page opens one with the passphrase, an authenticator's proof or unlock; it lives in the hub's and the page's memory only and ends after `vault.sessionIdle` unused, `vault.sessionMax` in all, and at every lock or passphrase change.
- Passphrases and unlocks are checked one at a time (`429 busy`), with a doubling wait after three wrong ones (`429 wait`). Time limits count by the wall or the monotonic clock, whichever says longer, so sleep counts and a clock set back lengthens nothing.
- **What takes the passphrase.** A proof's session may reveal, change, delete and allow. What guards the vault (authenticators, exemptions, Verify every Allow, imports, exports) takes a session the passphrase opened (`401 vault_passphrase`); what would let a value out later also takes the passphrase in its own request, since a program driving the page has its session. So biometrics never extend themselves.
- **Verify every Allow** (off unless set): allowing, revealing, widening who may read and adding variables to a linked workspace need a proof made for that action or the passphrase (`401 vault_proof`), checked inside the store's write lock against concurrent edits.

#### Authenticators (`vault.ts`, `desktop.ts`, `webauthn.ts`, `unlock.ts`)

Touch ID or Windows Hello in the desktop app, or a browser's WebAuthn credential, give a **proof** (the user is there: a session or one answer; no key) or an **unlock** (the key back from an unlock entry).

- A proof answers a nonce the hub issued for one purpose (`session`, `answer`, `reveal`, `change`, `register`), good once and briefly.
- **WebAuthn** (@simplewebauthn/server plus bounded checks of the hub's own): a credential is bound to the origin it signed, and only origins the hub vouches for count (`trustedOrigin`, `backend/kernel/http/guard.ts`): an `--allowed-origin`, or `http://localhost` on the hub's port while the hub holds it on both `127.0.0.1` and `::1` (`backend/shared/host/loopback.ts`). Adding one takes a `register` proof besides the passphrase, and a credential without PRF is refused (`prf_required`).
- **The desktop app's** shell asks the hub what a nonce is for, shows that in the system prompt, and signs nonce and purpose with a key of this launch that never leaves its main process (`desktop/src/verify.ts`), so the page can neither have one thing shown and another signed nor sign without the prompt.
- **Unlock entries** hold the master key wrapped under a key-encryption key (KEK) only the authenticator gives again, bound to the entry and the file's `check`: `enclave` (a Secure Enclave key after Touch ID) or `hello` (a Windows Hello signature), each with the shell's secret, or `prf` (WebAuthn's PRF output). Vectors: `spec/vectors/vault-unlock/`. An unlock is refused, the vault staying locked, when anything fails to open or verify (`vault_proof`), outside the passphrase's window (`passphrase_due`), or when the guard lacks the entry's authenticator (`unlock_stale`, the entry removed).
- **The passphrase's window** (when the passphrase was last checked, with `vault.passphraseDays` and `vault.autoLock` then) is sealed under the key, so a program that writes the file can only put an older window back. **Require Passphrase** (`POST lock` with `forget`, no session) removes it.
- **The desktop app** (`desktop/src/unlockStore.ts`, `enclave.ts`, `windowsHello.ts`, `relay.ts`, `keychain.ts`, `desktop/helper/`) keeps per install the shell's secret under Electron's safeStorage (no unlock without it, none on Linux) and passes what makes the KEK through the page in a relay only the hub opens; `keychain.ts` moves safeStorage's keychain item to a new macOS build.

#### The automatic lock

`vault.autoLock` locks an unused vault (uses: unlocks, actions through the gate, releases). The setting changes without the gate, so a change only shortens the current unlock, and an authenticator's unlock takes at most the time sealed with the window.

#### Exempt apps

An exemption names an app and a machine (never `*`): while unlocked, that app's requests there read every variable without asking, each recorded as `exempted`. The app is the kernel's name of the parent of the process connected to `vault.sock` (the CLI running the MCP server), never what the request says; it matches whole and may not be a shell, interpreter or launcher (`app_generic`). Any program of the user on that machine can take the name, so an exemption is as wide as listing the machine in every variable while unlocked; the settings page says so.

#### Requests from machines

Requests arrive as op `vault` streams: a header with the requesting process and its parents as the kernel names them, then one `VaultRequest {tool, names, client, terminal, cwd}` and one `VaultResponse`. The machine comes from the ssh session and the process chain from the header; the request's own claims are only shown.

- `list`: names, descriptions, `inject_only` and whether this machine needs approval; works while locked.
- `get` and `env`: variables that list the machine or `*`, or any for an exempt app, are given at once. For the others every page gets a prompt for `vault.approvalTimeout`: **Allow once**, **Always allow** (adds the machine to each variable), or **Deny**; no answer or the requester leaving deny. Waiting requests are bounded per machine and in all (`busy`); the first answer wins.

#### Workspace preset injection

`Vault.workspaceEnv` resolves a workspace's linked presets through the verified `#policy`. It releases nothing while the plugin is off for the client, the vault is locked, the policy is tampered with or the access log cannot be written; each injection is recorded as `injected` before values leave.

- **Terminals** (`backend/features/terminals/client.ts`): the client sends the hub-only `workspace` on `terminal.run`; values never override the client's or the virtual display's variables. The hub stages them in memory on the node (op `term.env`, `backend/machine/termenv.ts`, single-use and short-lived), and herdr-core runs the `term-env <token>` trampoline, which takes them once over `<run>/env.sock` (0600, same user) and `execve`s the shell. So secrets never enter `terminal.run`'s environment, herdr-core's `terminals.json` or a kept terminal's recovery. A node of an earlier release gets the terminal without them (`vault_unsupported`).
- **Chats** (`POST /api/m/{id}/p/chat/new`, `fork`, `switch`): the values go in the chat request's optional `env` (`chatproto`), which the chat host keeps in memory on the chat only (never in `chat.db` or logs); the answer's `vault` summary (`injected`, `locked`, `corrupt`, `logFailed`, `missing`) lets the UI tell the user.

#### The access log (`accesslog.ts`)

Each MCP request, injection, reveal and export is a record in the hub's database (table `vault_access`, [38](38-sqlite-state.md)) with names, result and the process chain, never a value; reading it needs a session. A record that lets values out is committed durably first, and one that cannot be written stops the release (`log_failed`). Releases and other records are bounded apart, so repeated refusals (merged into one record with a count) never push a release out. `--audit-log` audits every record too.

### Export and import (`exportfile.ts`, `hub.ts`)

An export file is sealed with AES-256-GCM under Argon2id of its own passphrase (at least 12 characters: it is attacked offline); the hub seals and opens it, the browser holds only ciphertext.

- **Export** needs a session and the vault's passphrase again, and is logged before the file is sent.
- **Import** sends file and passphrase twice, for a preview and with a choice per name, so no decrypted value waits in memory between them; it is one write that refuses as a whole.
- **Machines** map by id only to a machine of the same kind and target (the local machine: of the same label), never by label alone; unmapped ones leave the lists and ask every time.

### Settings

The plugin's page **Variable Vault**, ending with Biometrics and Import/Export (`SettingsExtra.tsx`): `vault.approvalTimeout`, `vault.autoLock`, `vault.passphraseDays`, `vault.sessionIdle`, `vault.sessionMax`, and `run_with_env`'s `vault.runTimeout`, `vault.runMaxTimeout` and `vault.runOutput` ([reference](../reference.md#settings)).

### Machines

Every node listens on `<run>/vault.sock` (0600, own user only by peer credentials; `backend/machine/vault.ts`) and asks each hub it serves ([39](39-nodes.md)): the first hub to grant answers and the others' questions are withdrawn; `list` merges every hub's variables; each hub logs what it released. The newest node of the instance serves the socket.

The MCP server is the executable's `mcp` command (`backend/features/vault/machine/mcp.ts`, `backend/hosts/machine/mcp.ts`) on the official SDK (`@modelcontextprotocol/server`, pinned), its tools handlers of the low-level `Server` so unknown arguments are refused (`-32602`) before anything runs. Agents' configurations name `<data dir>/bin/<slug>-mcp`, a script running the link of the host's platform beside it, which each agent points at its own executable, so the path survives updates and shared homes ([40](40-shared-homes.md)). A cancelled call denies its waiting approval or kills its command. Tools:

- `list_variables`;
- `get_variable {name}`: the value as text, which enters the conversation;
- `run_with_env {command, names, cwd?, timeout?}` (`machine/run.ts`): `sh -c` in its own process group with the variables set and stdin closed; returns the exit status and up to `vault.runOutput` of output with each value replaced by `***` (masking prevents accidents, not deliberate disclosure). The group is killed when the command returns or times out and when the server ends, through a watcher pipe even on SIGKILL; a program that leaves the group (`setsid`) escapes.

### Web UI (`web/src/plugins/vault`)

The panel **Variable Vault** of the right sidebar (`view.panel.vault`): the gate (`Gate.tsx`; passphrase fields keep password managers away), variables with write-only values (`Variables.tsx`), presets and their workspaces (`Presets.tsx`, `web/src/state/workspacePresets.ts`), the access log (`AccessLog.tsx`) and per machine how to connect an MCP client (`SetupGuide.tsx`). Prompts (`Approvals.tsx`) and transfer dialogs (`Transfer.tsx`) open over every page; Biometrics in Settings (`Biometrics.tsx`) hold authenticators, Verify every Allow and exempt apps.

## Alternatives considered

- **Workspace links in the machine's layout document**: unauthenticated on the machine; links under `#policy` need the key.
- **A vault or keychain on each machine**: secrets copied to every host; headless Linux has no keychain.
- **An MCP server over HTTP from the hub**: machines would need a port reaching the hub; nothing listens on TCP on machines.
- **The master key in the system keychain**: any program of the user reads it without a prompt.
- **Keeping the key while locked, or only the passphrase after every lock**: the key stays readable, or users turn the lock off; unlock entries avoid both.
- **Unlocking with credentials without PRF**: a proof holds no key, so the hub would have to keep it.
- **WebAuthn or Electron's Touch ID in the desktop app**: its page is on `127.0.0.1:<port>`, which no credential can be for, and Electron's Touch ID gives no secret to wrap under.
- **The desktop prompt's answer or text from the page**: any script would report yes, or show one request and approve another.
- **Credentials checked by host name and the request's `Origin`**: `localhost` is every port to a browser and a program writes its `Origin`; only the signed origin cannot be forged.
- **The key in locked memory (memguard, mlock)**: needs a core dump limit that everything the hub starts inherits.

## Failure modes

- **Locked**: `get` and `env` fail `vault_locked` until a page unlocks. A lost passphrase cannot be recovered: delete the file.
- **Window over or Require Passphrase**: biometric unlocks fail `403 passphrase_due` until the passphrase is typed.
- **Biometric key gone, unlock store lost, older vault file put back**: `409 unlock_stale`, the entry removed; set biometrics up again.
- **New macOS build**: one prompt for `security`; refused, that launch unlocks with the passphrase only.
- **File of another version or damaged**: `503 version` / `invalid`; move it away and Retry. **File edited**: `corrupt`, nothing released from it.
- **Agent or hub gone**: the MCP server answers `unavailable` and connects again at the next call; killed, even with SIGKILL, its commands' groups die with it.
- **Access log not writable**: no value leaves (`log_failed`).
- **Export file with a wrong passphrase or changed**: `file_passphrase` (also `bad_file`, `file_version`, `too_large`); nothing imported.
- **Hub restarted**: locked, sessions gone, the access log read back.

## Security

[SECURITY.md](../../SECURITY.md)'s vault rows are the threat model and list the residual risks. Those that shape the design:

- A KEK obtained once, with any copy of the file, gives the master key offline until the passphrase changes; removing an authenticator or Require Passphrase does not revoke against a program that kept an older file.
- `vault.passphraseDays` and `vault.autoLock` can be raised by a program on the hub host before the user next types the passphrase, which seals them into the window.
- A PRF output passes through the page's script; on Windows DPAPI gives the shell's secret to any program of the user and Hello's dialog names no purpose; a program that can rewrite an ad hoc signed app bundle can replace the enclave helper.
- With Verify every Allow, a program driving the unlocked page gets no value out, but can still make changes that release nothing (edits, deletions, fewer readers, a lock). Availability is not defended.

## Testing

- `backend/features/vault/store.test.ts`: the vectors, fixtures of files earlier releases wrote (`testdata/`), every binding of sealed content, unlock entries, presets and `#policy` tampering.
- `backend/features/vault/hub.test.ts`: the gate, requests and approvals, exemptions, authenticators, Verify every Allow under concurrent edits, the automatic lock on driven clocks, export and import, `workspaceEnv`'s record; `webauthn.test.ts`, `accesslog.test.ts`, `backend/shared/host/userfile.test.ts`.
- Injection: `backend/machine/termenv.test.ts`, `backend/features/terminals/terminals.test.ts` and `integration.test.ts`, `backend/features/chat/routes.test.ts`, `backend/features/chat/machine/host/host.test.ts`.
- The MCP server: `backend/features/vault/machine/mcp.test.ts`, `run.test.ts`, `backend/hosts/machine/mcp.test.ts` (signals, SIGKILL), `backend/machine/vault.test.ts` (the link, the socket).
- The desktop shell: `desktop/src/verify.test.ts`, `enclave.test.ts`, `relay.test.ts`, `unlockStore.test.ts`, `keychain.test.ts`, `windowsHello.test.ts`, `preload.test.ts` (the page's `verifyUser` bridge).
- `web/src/__tests__/vault.test.ts`, `vaultPresets.test.tsx`, `vault-transfer.test.ts`, `vaultProof.test.tsx`; `e2e/tests/vault.spec.ts` on a real hub.
