# Releasing

The version comes from the git tag: `scripts/build.sh` injects
`git describe --tags` (or `$VERSION`) into the core and the agents
(`internal/agentproto.Version`). The `version` fields of `web/package.json`
and the extension's `package.json` are not published and do not need to
match; the bridge extension is reinstalled whenever its content changes.

1. Start from a clean `main` with green CI. Run `make check test` and
   `make it` locally.
2. If the default code-server version or extensions changed, make sure the
   pinned digests in `internal/codeserver/artifacts.go` were updated from the
   upstream source (see `.claude/agents/release-manager.md`).
3. If Go dependencies changed, `scripts/notices.sh` (CI checks it).
4. In `CHANGELOG.md`, rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD` and
   start a new empty `[Unreleased]` section. Commit as `release: vX.Y.Z`.
5. Tag and push: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
6. The `release` workflow (`.github/workflows/release.yml`) builds the four
   platforms, packages each binary with `LICENSE`, `THIRD_PARTY_NOTICES.md`
   and the web UI's `licenses.md`, writes `SHA256SUMS`, attests build
   provenance (only while the repository is public: GitHub stores no
   attestations for private repositories outside Enterprise Cloud) and
   creates the GitHub release with the changelog section as notes.
7. Smoke test a downloaded archive: `sha256sum -c SHA256SUMS`, `version`,
   then start with `--local-only` and open the UI.

Builds are reproducible for a given commit and toolchain (fixed timestamps in
gzip and the VSIX, `-trimpath`), so a local
`VERSION=vX.Y.Z TARGETS="…" scripts/build.sh` can be compared with the
release.

Version numbers follow semantic versioning. Changes that require users to
act (flags removed or renamed, data directories moved without migration,
protocol changes between browser and core) are breaking.
