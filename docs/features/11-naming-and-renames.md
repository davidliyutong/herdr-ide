# 11 · Naming and renames

## Context

The product name is in binaries, directories on machines, sessions, environment variables, browser storage, the extension's and the desktop app's ids, and the docs. A rename must be mechanical.

## Goals / non-goals

Goals: one definition of the name, copied where it cannot be imported; one rename command; CI rejects hardcoded names. Non-goals: carrying state from a previous name; renaming herdr-core's identifiers or the native submodules' upstream repositories (`backend/scripts/deps.ts`).

## Design

- **Definitions**: `backend/shared/lib/brand.ts`, `web/src/brand.ts` (with namespaced `storage`), `extensions/veldr-bridge/src/brand.ts`; display name and slug apart, so the visible name changes without touching identifiers. The reversed domain begins the desktop app's id; a new id is a new app to macOS, whose permissions are granted again.
- **Consistency**: `backend/shared/lib/brand.test.ts` checks the copies against the hub's, and `scripts/check.sh` fails on slug literals in TypeScript elsewhere. Everything else (data directories, sessions, `VELDR_*` variables, headers, storage keys, notice methods, the build's names) derives from them.
- **Rename**: `scripts/rename.sh NEW [--name "Display"] [--dry-run]` replaces slug and env prefix in tracked text files (not `CHANGELOG.md`), moves `extensions/<slug>-bridge`, sets the display name and runs the brand test. The renamed version is a namespace of its own: what the old name left is not read, moved or removed.

## Alternatives considered

- **Search-and-replace when needed**: persisted state would be orphaned silently.
- **A permanent internal id apart from the name**: the old name stays in paths forever.

## Failure modes

- **VS Code keybindings to the bridge's commands** (`<slug>.sendToAgent`, `<slug>.download`) must be rebound after a rename; the hub's command ids carry no product name.

## Testing

`backend/shared/lib/brand.test.ts` and the brand step of `scripts/check.sh`.
