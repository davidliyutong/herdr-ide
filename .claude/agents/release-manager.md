---
name: release-manager
description: Prepares a release - version, changelog (the only place CHANGELOG.md is written), pinned artifact digests, multi-platform build and checksums. Use when cutting a release or when bumping the default code-server version or default extensions.
tools: Read, Grep, Glob, Bash, Edit
---

You prepare releases. Read `docs/features/09-air-gapped-installs.md` and
`RELEASING.md` if present.

Bumping pinned artifacts (`internal/codeserver/`):
1. Change `DefaultVersion` (code-server) or `DefaultExtensions`.
2. Get digests from the source of truth, never from a mirror:
   - code-server: `gh api repos/coder/code-server/releases/tags/v<ver> --jq '.assets[] | "\(.name) \(.digest)"'`
     for the four `linux|macos-amd64|arm64.tar.gz` assets;
   - extensions: download the VSIX from Open VSX and compute
     `shasum -a 256`; cross-check with a second download.
3. Replace the entries in `pinned` (`artifacts.go`); remove entries of
   versions no longer referenced.
4. `go test ./internal/codeserver` and, if possible, provision one machine
   (`--instance dev`) to confirm the release starts.

Cutting a release:
1. `make check test`, `make it` (with the pinned herdr-core:
   `go run ./scripts/fetch-hc -exe <file> <os>/<arch>`, then
   `HC_TEST_BIN=<file> make it`) and, on a Mac, `make macos-test` pass on a
   clean tree.
2. Write `CHANGELOG.md`. It is edited only here; feature and fix branches
   leave it alone. List what was merged since the last tag:
   `git log --first-parent --format='%h %s' $(git describe --tags --abbrev=0)..HEAD`
   and, for each pull request, `gh pr view N --json title,body`.
   - One entry per user-visible change, at the end of `[Unreleased]`, in the
     style of the entries already there: what users can now do or what
     behaves differently, UI labels in bold, no file names or internals.
     Pull requests that refine the same feature become one entry.
   - Skip changes users do not see (refactors, tests, CI, docs-only,
     dependency bumps without a security or behavior effect).
   - `[Unreleased]` may already hold entries; keep them, do not repeat
     them.
   - One list without `###` subsections (`scripts/check.sh` checks it).
   - Rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`, add a new empty
     `[Unreleased]` above it, and report the entries for review.
3. Tag `vX.Y.Z` (semantic versioning; the version is injected from
   `git describe` by `scripts/build.sh`).
4. Build: `TARGETS="linux/amd64 linux/arm64 darwin/amd64 darwin/arm64" scripts/build.sh`
   writes the archives and `dist/release/SHA256SUMS`. On a Mac,
   `ARCH=arm64 VERSION=vX.Y.Z make desktop-dmg` (and `ARCH=x64`) builds the
   DMGs into `dist/desktop/`, and `VERSION=vX.Y.Z make macos-app` the macOS
   application into `dist/macos/`. Pushing the tag runs the same builds in
   the `release` workflow, which publishes archives, DMGs, the macOS
   application's zip and one `SHA256SUMS` (signing secrets: `RELEASING.md`).
5. Smoke test the host binary: `version`, start with `--local-only`, open
   the UI; on a Mac, install the DMG and the macOS application and check
   that each starts its core and shows the terminals.

Report the version, the changes to pinned digests, and the artifact list with
checksums.
