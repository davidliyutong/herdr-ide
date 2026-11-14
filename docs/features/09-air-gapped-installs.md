# 09 · Air-gapped installs

## Context

Lab and robot machines often have no internet access, and some deployments
have none at all. Everything herdr-ide installs on machines (agent,
terminal core, code-server, extensions, video encoder) must reach them
without the machines downloading anything, and downloads that do happen
must be verifiable.

## Goals / non-goals

Goals: machines never need to download; the core host can work fully
offline from a prepared bundle; internal mirrors are supported; every
artifact is verified.

Non-goals: offline builds from source (Go and npm dependencies, and the
pinned herdr-core downloads, need network access or a prepared cache).
The terminal core needs no bundle: the core embeds herdr-core for every
machine platform and pushes it through the agent
([21](21-terminal-core.md)).

## Design

- **Embedded**: the web UI, the agents for four platforms, herdr-core for
  the same four platforms (the release pinned in `internal/hcdist`, its
  archives checked against the SHA-256 digests there when the build
  fetches them, `scripts/fetch-hc`), the video encoder for program windows
  when the build has one ([14](14-gui-windows.md)) and the bridge
  extension are compiled into the core binary. The agent checks the
  digest of every herdr-core and encoder it receives before using it.
- **Resolved on the core host** (`internal/codeserver/artifacts.go`):
  code-server tarballs and extension VSIXs, in this order:
  1. `--seed-dir` directories (repeatable);
  2. the download cache (user cache directory);
  3. download from `--code-server-url` / `--extension-url` templates, unless
     `--offline`.
- **Pushed through the agent** to machines (chunked upload, unpacked by the
  agent in Go — no `tar` needed on the machine). With
  `--code-server-install=download` machines fetch the code-server tarball
  themselves from the same URL and verify it against the digest the core
  knows; `--offline` turns this off, and a machine that cannot download gets
  the upload.
- **Fetched by machines**: only Xvfb, for program windows on Linux
  machines that have none: `apt-get download xvfb` from the machine's own
  package sources, which apt verifies against their signed lists
  ([14](14-gui-windows.md)). A machine without Xvfb and without reachable
  package sources shows no program windows; everything else works.
- **Verification**: default versions have SHA-256 digests compiled in
  (taken from the GitHub release API's `digest` field and a verified Open VSX
  download). Other files need a `<file>.sha256` sidecar. A mismatching seed
  is refused (never silently replaced); a mismatching cached file is
  discarded and re-downloaded when online; a download with no known digest is
  accepted once, logged, and its digest recorded.
- **Bundles**: `herdr-ide fetch-assets [--platforms …] DIR` downloads (or
  copies from the cache), verifies and writes sidecars, for carrying into the
  network; then `herdr-ide --offline --seed-dir DIR`.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Machines download code-server and extensions themselves | Fails on offline machines; no central verification. |
| Bundle code-server in the core binary | ~200 MB per platform; versions tied to herdr-ide releases. |
| Trust HTTPS only | A compromised mirror or release would be installed on every machine. |

## Failure modes

- **Offline and not seeded** → the VS Code panel shows which file is missing
  and where to put it.
- **Digest mismatch** → refused with both digests in the error.
- **Platform without a code-server build** → reported; terminals and previews
  keep working.
- **A build without herdr-core for a machine's platform** → the machine's
  terminal backend reports `not_bundled` ([02](02-multi-machine-transport.md));
  files, VS Code and the rest keep working.
- **No Xvfb and no package sources on a Linux machine** → its display
  reports the install error and is tried again with a backoff; program
  windows are unavailable there ([14](14-gui-windows.md)).

## Licensing

Bundles contain third-party artifacts under their own licenses. Git Graph's
license explicitly restricts distribution of derivative works and does not
clearly grant general redistribution rights for the original package. It is
downloaded for the user's installation rather than included in application
releases. Do not publish bundles containing it without suitable permission.
herdr-core, embedded in the core at build time
([21](21-terminal-core.md)), is distributed under Apache-2.0 with its
license and notices in a release's `licenses/herdr-core/`; the agent
detection manifests ([25](25-agent-detection.md)) and the video encoder
carry theirs in `licenses/herdr-detect/` and `licenses/encoder/`.

## Security

Pinned digests must be updated together with `DefaultVersion` and
`DefaultExtensions` (see the release role in `.claude/agents/`), and
herdr-core's together with `hcdist.Version`. Extraction rejects absolute
paths, `..` and links leaving the install directory; herdr-core's archive
must hold the executable as one regular file of bounded size.

## Testing

`internal/codeserver/artifacts_test.go`: seeded and verified files, tampered
seeds (`TestSeedDirVerifiedBySidecar`), offline errors
(`TestOfflineMissing`), pinned digests rejecting mirror content
(`TestPinnedChecksumRejectsMirror`), download with sidecar recording and
`FetchAssets` (`TestDownloadRecordsSidecarAndFetchAssets`).
`internal/agent/codeserver_test.go` (`TestCodeServerDownload`: a machine's
own download checked against the core's digest). `internal/hcdist/release_test.go`
and `internal/embedded/embedded_test.go` (the pinned herdr-core archives and
the embedded executables), `internal/agent/hc_test.go` and
`internal/agent/guivideo_test.go` (`TestInstallVideo`: a wrong digest
installs nothing).
