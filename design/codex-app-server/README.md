# Codex app-server protocol, pinned

`summary.json` is the part of Codex's app-server protocol (v2, with
`experimentalApi`) the chat host's Codex adapter (`internal/chatadapter/codex`)
relies on, for **codex-cli 0.171.0**: the parameters of the requests it
sends, of the requests and notifications of the app-server it serves, and
the values and variants of the types it sends or reads (sandbox and
approval policies, decisions, item types, user input). A member marked with
a trailing `!` is required.

It is generated from the JSON schema Codex prints:

```sh
codex app-server generate-json-schema --experimental --out DIR
CODEX_SCHEMA_DIR=DIR go test ./internal/chatadapter/codex -run TestSchemaSummary -update
```

`TestSchemaPinned` checks the adapter against it: what it sends for each
permission mode, the requests it answers, the notifications and item types
it maps. To move to another Codex version, generate the summary from that
version's schema, update `version` in it, and fix what the test reports;
then record the version's conversations again in
`design/testdata/chat/codex/` when their shapes changed.

The whole schema (483 files, 6.3 MB for 0.171.0) is not kept here.
