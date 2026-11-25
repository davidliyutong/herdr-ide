# 09 · Air-gapped installs

## Context

Lab and robot machines often have no internet access, and some deployments
have none at all. Everything veldr installs on machines (agent,
terminal core, code-server, extensions, video encoder) must reach them
without the machines downloading anything, and downloads that do happen
must be verifiable.

## Goals / non-goals

Goals:

- machines never need to download;
- the core host can work fully offline from a prepared bundle;
- internal mirrors are supported;
- every artifact is verified.

Non-goals: offline builds from source (Go and npm dependencies and the
pinned herdr-core downloads need network access or a prepared cache).

## Design

Operator steps (`fetch-assets`, `--offline`, `--seed-dir`) are in
[deployment](../deployment.md#air-gapped-networks); flags in
[reference](../reference.md#fetch-assets-flags).

- **Embedded in the core binary**: the web UI, the machine builds for four
  platforms, herdr-core for the same platforms (pinned in `internal/hcdist`,
  archives checked against its digests when the build fetches them,
  `scripts/fetch-hc`), the video encoder for program windows when the build
  has one ([14](14-gui-windows.md)) and the bridge extension. The terminal
  core therefore needs no bundle ([21](21-terminal-core.md)). The agent
  checks the digest of every herdr-core and encoder it receives.
- **Resolved on the core host** (`backend/features/vscode/artifacts.ts`):
  code-server tarballs and extension VSIXs, in this order:
  1. `--seed-dir` directories (repeatable);
  2. the download cache;
  3. a download from the `--code-server-url` / `--extension-url` templates
     (which may name a mirror), unless `--offline`.
- **Pushed through the agent** to machines as a chunked upload, unpacked by
  the agent in Go (no `tar` needed on the machine). With
  `--code-server-install=download` machines fetch the tarball themselves
  and verify it against the core's digest; `--offline` turns this off, and a
  machine that cannot download gets the upload.
- **Fetched by machines**: only Xvfb, on Linux machines that have none, with
  `apt-get download xvfb` from the machine's own package sources, which apt
  verifies ([14](14-gui-windows.md)).
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
  herdr-core's together with `hcdist.Version`.
- Extraction rejects absolute paths, `..` and links leaving the install
  directory.
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
- `internal/agent/codeserver_test.go` (`TestCodeServerDownload`): a
  machine's own download checked against the core's digest.
- `internal/hcdist/release_test.go`, `internal/agent/hc_test.go`: pinned
  herdr-core archives and the executables a machine receives.
- `internal/agent/guivideo_test.go` (`TestInstallVideo`): a wrong digest
  installs nothing.
