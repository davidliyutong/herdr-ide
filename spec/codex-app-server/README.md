# Codex app-server protocol, pinned

The chat host's Codex adapters speak Codex's app-server protocol (v2, with `experimentalApi`) of **codex-cli 0.171.0** (`VERSION`), the version the conversations in `spec/vectors/chat/codex/` were recorded with.

- `codex_app_server_protocol.schemas.json` is the JSON schema Codex prints, verbatim: the file `codex app-server generate-json-schema --experimental --out DIR` writes into DIR, the whole protocol in one file (980 KB for 0.171.0). Codex's repository records it for each release, in `codex-rs/app-server-protocol/schema/precomputed/app-server-exports-experimental.json.zst` at the tag `rust-v<version>`.
- The TypeScript adapter (`backend/features/chat/machine/codex`) is written against types generated from it, `backend/features/chat/machine/codex/appserver.gen.ts`, by `backend/scripts/codex-schema.ts`: the types of the methods the adapter uses (the script's `REQUESTS` and `NOTIFICATIONS`), of every request of the app-server, and the names of every method. `make check` fails when they are not what the schema makes (`bun scripts/codex-schema.ts --check`); the typecheck holds the adapter to them, and its tests hold the recordings and what the adapter sends (each mode's policies, its other requests, its answers and refusals) to the schema itself, validated with zod's `fromJSONSchema` (`appserver.test.ts`, `adapter.test.ts`, `session.test.ts`).

To move to another version of Codex:

1. Take its schema, which writes `codex_app_server_protocol.schemas.json` and `VERSION` and generates the types again, without running Codex:

   ```sh
   cd backend && bun scripts/codex-schema.ts --fetch <version>
   ```

   or from what that version's `codex` prints:

   ```sh
   codex app-server generate-json-schema --experimental --out DIR
   cd backend && bun scripts/codex-schema.ts --from DIR --version <version>
   ```

2. Run `pnpm -C backend typecheck` and `bun test features/chat/machine/codex` and fix what they report. A method the adapter starts to use goes into the script's lists first.
3. Record the conversations of `spec/vectors/chat/codex/` again when their shapes changed, and name the version in that directory's README (the tests check that the recordings are of the version pinned and validate every message against the schema).
