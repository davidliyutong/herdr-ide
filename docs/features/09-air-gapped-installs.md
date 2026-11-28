# 09 · Air-gapped installs

## Context

Lab and robot machines often have no internet access, and some sites have none at all, yet everything installed on machines must reach them verified.

## Goals / non-goals

Goals: machines never need to download; an offline hub host works from a prepared bundle; mirrors; every artifact verified. Non-goals: offline builds from source.

## Design

Operator steps (`fetch-assets`, `--offline`, `--seed-dir`, `--agent-dir`) are in [deployment](../deployment.md#air-gapped-networks).

- **The hub's executable embeds** the web UI, the bridge extension, both Linux video encoders (pushed to Linux machines), and its platform's herdr-core (pinned in `backend/scripts/hcdist.ts`), with every platform's herdr-core digest.
- **Machine builds** come from the release, checked against its `SHA256SUMS`: downloaded by the machine, else uploaded by the hub from `--agent-dir`, its cache or its own download ([02](02-multi-machine-transport.md)).
- **code-server and extensions** are resolved on the hub host (`backend/features/vscode/artifacts.ts`) from `--seed-dir`, the cache, then the URL templates (a mirror) unless `--offline`, and uploaded with their digest, which the machine checks before unpacking.
- **Machines fetch** the Agent SDK for Claude Code's chats when they can, else the hub uploads it ([42](42-typescript-backend.md#claude-code)), and Xvfb from their own package sources ([14](14-gui-windows.md)).
- **Verification**: default versions have pinned SHA-256 digests (`PINNED`), other files a `<file>.sha256` sidecar. A mismatching seed is refused; a file with neither is used with a warning and its digest recorded (trust on first use).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Machines download code-server themselves | Fails offline; no central verification. |
| Trust HTTPS only | A compromised mirror would reach every machine. |

## Failure modes

- **Offline and not seeded**: the VS Code pane names the missing file and where to put it.
- **Digest mismatch**: refused.
- **No source has a machine's build**: `build_unavailable`, dialed again later.

## Licensing

Git Graph's license does not clearly grant redistribution, so it is downloaded for the user's installation rather than shipped in releases, and a bundle holding it is not to be published without permission. Release archives carry the embedded components' licenses under `licenses/`.

## Security

`PINNED` changes together with `DEFAULT_VERSION` and `DEFAULT_EXTENSIONS`, herdr-core's digests with `hcdist.ts`'s `VERSION`. Extraction refuses an archive with an entry leaving the install directory.

## Testing

`backend/features/vscode/artifacts.test.ts`, `machine.test.ts`, `provision.test.ts`; `backend/kernel/machines/transport/release.test.ts`; `backend/scripts/fetch-hc.test.ts`.
