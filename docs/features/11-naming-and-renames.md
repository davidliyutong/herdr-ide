# 11 · Naming and renames

## Context

The product name appears in binaries, directories on every machine, the terminal core's session, environment variables, browser storage, the VS Code extension's identity, the desktop app's bundle ID and the docs. A rename must be quick and mechanical.

## Goals / non-goals

Goals:

- one place defines the name, copied where it cannot be imported;
- one command renames everything;
- CI rejects new hardcoded names.

Non-goals: carrying state from a previous name (the renamed version starts with namespaces of its own); renaming herdr-core's own identifiers (its executable, `HC_*` variables, state directory).

## Design

- **Definitions**:
  - hub and machine side: `backend/shared/lib/brand.ts` (`NAME`, `SLUG`, `DOMAIN`, `ENV_PREFIX`, `dataDir(instance)`, `AGENT_DIR`, `BRIDGE_EXT_ID`, …);
  - web UI: `web/src/brand.ts` (`APP_NAME`, `APP_SLUG`, `APP_DOMAIN`, namespaced `storage`).

  The domain (`veldr.app`), reversed, begins the desktop app's id (`app.veldr.desktop`): macOS's bundle identifier, Windows's AppUserModelID, the Linux desktop entry. A new id is a new app to macOS: its Full Disk Access, notification permission and keychain access are granted again;
  - extension: `extensions/veldr-bridge/src/brand.ts`.

  Display name and slug are separate, so the visible name can change without touching identifiers.
- **Consistency**: `backend/shared/lib/brand.test.ts` checks that the web UI's and the extension's copies and the extension's `package.json` agree with the hub's. `scripts/check.sh` fails on string literals with the slug in TypeScript outside these files. Build scripts, the Makefile, Vite, the PWA manifest, the desktop launcher and electron-builder derive names from them.
- **Derived at runtime**: the agent's state directory (`~/.<slug>[-<instance>]`), the terminal core's session (`<slug>[-<instance>]-<host id>`, [21](21-terminal-core.md)), the proxy-secret header, environment variables (`VELDR_*`), the hub's configuration directory and download cache, browser storage keys, the label and name that hide the product's own terminals (`<slug>.hidden`, `<slug>-chat-host`), the notices' methods (`_<slug>/<name>`), and the client name chat agents are given (`CLAUDE_CODE_ENTRYPOINT=<slug>`, Codex's client name; [37](37-agent-chats.md)).
- **Rename**: `scripts/rename.sh NEW [--name "Display"] [--dry-run]` replaces the slug and env prefix, moves `extensions/<slug>-bridge`, sets the display name, removes generated artifacts, then runs the brand test.
- **No carry-over**: the renamed version is a namespace of its own (`~/.<new>` on machines, its own terminal cores, configuration directory, browser storage and desktop app id); what the previous name left is not read, moved or removed.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Search-and-replace when needed | Persisted state (remote directories, storage, extension ids) would be orphaned silently. |
| A permanent internal id separate from the name | Leaves the old name in paths forever. |
| Generating all files from one JSON | Manifests cannot import it without a generation step; the brand test gives the same guarantee. |
| Copying or moving the previous name's state at the first start | The product has no installs to carry over; such code would stay long after any user needed it. |

## Failure modes

- **VS Code keybindings to the bridge's commands** (`<slug>.sendToAgent`, `<slug>.download`) change with the slug and must be rebound. The hub's own command ids carry no product name, so `keybindings[-<instance>].json` stays valid.

## Testing

- `backend/shared/lib/brand.test.ts` (`the copies of the names agree`).
- The brand step of `scripts/check.sh`.
- The rename script was run on a copy of the repository: no old name remained, and tests and checks passed.
