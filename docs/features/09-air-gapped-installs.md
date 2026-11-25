# 09 · Air-gapped installs

## Context

Lab and robot machines often have no internet access, and some deployments
have none at all. Everything veldr installs on machines (agent,
terminal core, code-server, extensions, video encoder) must be able to
reach them without the machines downloading anything, and downloads that
do happen must be verifiable.

## Goals / non-goals

Goals:

- machines never need to download;
- the core host can work fully offline from a prepared bundle;
- internal mirrors are supported;
- every artifact is verified.

Non-goals: offline builds from source (npm dependencies and the
pinned herdr-core downloads need network access or a prepared cache).

## Design

Operator steps (`fetch-assets`, `--offline`, `--seed-dir`) are in
[deployment](../deployment.md#air-gapped-networks); flags in
[reference](../reference.md#fetch-assets-flags).

- **Embedded in the core binary**: the web UI, the machine build of its
  own platform (the executable is that build too,
  [42](42-typescript-backend.md#the-machine-side)) with that platform's
  herdr-core (pinned in `backend/scripts/hcdist.ts`, archives checked
  against its digests when the build fetches them,
  `backend/scripts/fetch-hc.ts`; the executable records every platform's
  digest), the video encoder for program windows when the build has one
  ([14](14-gui-windows.md)) and the bridge extension. Each executable carries its
  platform's herdr-core, so the terminal core needs no bundle
  ([21](21-terminal-core.md)). The agent checks the digest of every
  herdr-core and encoder it receives.
- **Machine builds of other platforms** come from the core's release,
  checked against its `SHA256SUMS`: the machine downloads its platform's
  archive when it can, else the core uploads it from `--agent-dir` (an
  offline site's copy of the release), its cache or its own download
  ([42](42-typescript-backend.md#the-machine-side),
  [deployment](../deployment.md#air-gapped-networks)).
- **Resolved on the core host** (`backend/features/vscode/artifacts.ts`):
  code-server tarballs and extension VSIXs, in this order:
  1. `--seed-dir` directories (repeatable);
  2. the download cache;
  3. a download from the `--code-server-url` / `--extension-url` templates
     (which may name a mirror), unless `--offline`.
- **Pushed through the agent** to machines as a chunked upload with the
  digest the core verified it by, unpacked by the agent (no `tar` needed on
  the machine: node-tar, after the digest is checked). With
  `--code-server-install=download` machines fetch the tarball themselves
  and verify it against the core's digest; `--offline` turns this off, and a
  machine that cannot download gets the upload.
- **Fetched by machines**: their machine build (above) and the Agent SDK of
  Claude Code's chats when they can, which the core uploads otherwise
  ([42](42-typescript-backend.md#claude-code)), and Xvfb, on Linux machines
  that have none, with `apt-get download xvfb` from the machine's own
  package sources, which apt verifies ([14](14-gui-windows.md)).
- **Verification**: default versions have SHA-256 digests compiled in;
  other files are checked against a `<file>.sha256` sidecar
  (`fetch-assets` writes them).
  - A seed that mismatches is refused, never replaced.
  - A cached file that mismatches is discarded and downloaded again when
    online.
  - A file with neither a pinned digest nor a sidecar is used with a
    warning; a download of one has its digest recorded as a sidecar (trust
    on first use).

## Alternatives considered

| Option | Why not |
| --- | --- |
| Machines download code-server and extensions themselves | Fails on offline machines; no central verification. |
| Bundle code-server in the core binary | ~200 MB per platform; versions tied to veldr releases. |
| Trust HTTPS only | A compromised mirror or release would be installed on every machine. |

## Failure modes

- **Offline and not seeded** → the VS Code pane names the missing file and
  where to put it.
- **Digest mismatch** → refused with both digests in the error.
- **Platform without a code-server build** → reported; terminals and
  previews keep working.
- **No source has a machine's build** (no download, no `--agent-dir`, an
  unreachable release) → the machine shows `build_unavailable` with what
  each source said, and is dialed again later
  ([42](42-typescript-backend.md#the-machine-side)).
- **A build without herdr-core for a machine's platform** → the terminal
  backend reports `not_bundled` ([02](02-multi-machine-transport.md)); the
  rest keeps working.
- **No Xvfb and no package sources** → no program windows on that machine;
  the display reports the error and retries with a backoff
  ([14](14-gui-windows.md)).

## Licensing

Bundles contain third-party artifacts under their own licenses. Git Graph's
license restricts distribution of derivative works and does not clearly
grant redistribution of the original, so it is downloaded for the user's
installation rather than shipped in releases; do not publish bundles
containing it without permission.

A release carries the licenses of embedded components:
`licenses/herdr-core/` (Apache-2.0, [21](21-terminal-core.md)),
`licenses/herdr-detect/` (agent detection manifests,
[25](25-agent-detection.md)) and `licenses/encoder/`.

## Security

- Pinned digests (`PINNED`) are updated together with `DEFAULT_VERSION`
  and `DEFAULT_EXTENSIONS` (the release role in `.claude/agents/`), and
  herdr-core's together with `VERSION` of `backend/scripts/hcdist.ts`.
- Extraction rejects absolute paths, `..` and links leaving the install
  directory (the machine side refuses the whole archive).
- herdr-core's archive must hold the executable as one regular file of
  bounded size.

## Testing

- `backend/features/vscode/artifacts.test.ts`: seeds verified by sidecar
  and tampered (`a seed is verified by its sidecar`), offline errors
  (`offline, a missing file is named with where to put it`), pinned
  digests rejecting mirror content (`a pinned digest refuses what a mirror
  sends`), sidecar recording and `fetch-assets` (`downloads record their
  digest, fetch-assets copies with sidecars`, `the fetch-assets
  command`).
- `backend/features/vscode/machine.test.ts` (`releases`, `archives that
  would leave the release`, `downloads made by the machine`): an upload and
  a machine's own download checked against the core's digest before anything is
  unpacked, archives refused, bounds; `provision.test.ts`: the core sends
  the digest of what it uploads.
- `backend/scripts/fetch-hc.test.ts`, `backend/machine/agent.test.ts`:
  pinned herdr-core archives and the executables a machine receives.
- `backend/kernel/machines/transport/release.test.ts`: the release's
  manifest (the operator's directory first, one of another build refused,
  fetched through the machine when the release is unreachable) and what
  the core uploads, each checked against it.
- `backend/features/gui/machine.test.ts` (`the encoder is installed only
  as its digest says`): a wrong digest installs nothing.
