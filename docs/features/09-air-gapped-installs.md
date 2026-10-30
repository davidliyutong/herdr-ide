# 09 · Air-gapped installs

## Context

Lab and robot machines often have no internet access, and some deployments
have none at all. Everything herdr-ide installs on machines (agent,
code-server, extensions) must reach them without the machines downloading
anything, and downloads that do happen must be verifiable.

## Goals / non-goals

Goals: machines never download; the core host can work fully offline from a
prepared bundle; internal mirrors are supported; every artifact is verified.

Non-goals: offline builds from source (Go and npm dependencies need a module
proxy or vendoring); offline herdr installation.

## Design

- **Embedded**: the web UI, the agents for four platforms and the bridge
  extension are compiled into the core binary.
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

## Licensing

Bundles contain third-party artifacts under their own licenses. Git Graph's
license does not permit redistribution, which is why it is downloaded by each
installation instead of being embedded, and why bundles are for internal use
only.

## Security

Pinned digests must be updated together with `DefaultVersion` and
`DefaultExtensions` (see the release role in `.claude/agents/`). Extraction
rejects absolute paths, `..` and links leaving the install directory.

## Testing

`internal/codeserver/artifacts_test.go`: seeded and verified files, tampered
seeds, offline errors, pinned digests rejecting mirror content, download with
sidecar recording, `FetchAssets`.
