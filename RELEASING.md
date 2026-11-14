# Releasing

The version comes from the git tag: `scripts/build.sh` injects
`git describe --tags` (or `$VERSION`) into the core and the agents
(`internal/agentproto.Version`). The `version` fields of `web/package.json`
and the extension's `package.json` are not published and do not need to
match; the bridge extension is reinstalled whenever its content changes.

1. Start from a clean `main` with green CI. Run `make check test`,
   `make it` with the pinned terminal core
   (`go run ./scripts/fetch-hc -exe /tmp/hc/herdr-core <os>/<arch>`, then
   `HC_TEST_BIN=/tmp/hc/herdr-core make it`) and, on a Mac,
   `make macos-test` locally.
2. If the default code-server version or extensions changed, make sure the
   pinned digests in `internal/codeserver/artifacts.go` were updated from the
   upstream source (see `.claude/agents/release-manager.md`); the same for
   herdr-core (`internal/hcdist`), the macOS application's renderer
   (`scripts/fetch-ghostty.sh`) and the web UI's terminal emulator
   (`make vt-wasm`).
3. If Go dependencies changed, `scripts/notices.sh` (CI checks it).
4. Write the changelog. Feature and fix pull requests do not touch
   `CHANGELOG.md`; a `release-manager` subagent
   (`.claude/agents/release-manager.md`) adds an entry to `[Unreleased]`
   for each user-visible change merged since the last tag, then renames
   `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD` and starts a new empty
   `[Unreleased]` section. Read its entries, then commit as
   `release: vX.Y.Z`.
5. Tag and push: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
6. The `release` workflow (`.github/workflows/release.yml`) builds the
   video encoders of Linux machines (`encoder.yml`), then the four
   platforms: each core embeds the agents, the pinned herdr-core of every
   agent platform and the encoders, and is packaged with `LICENSE`,
   `THIRD_PARTY_NOTICES.md`, the web UI's `licenses.md` and `licenses/`
   (`herdr-core/`, `herdr-detect/`, `encoder/`). No herdr is built or
   shipped. On macOS runners it builds the Electron app's DMGs for arm64
   and x64 (`make desktop-dmg` with the tag as `VERSION`; ad-hoc signed,
   not notarized) and the macOS application for arm64 (`make macos-test`,
   `make macos-app`, zipped as `<name>-X.Y.Z-mac-native-arm64.zip`). The
   macOS application is signed ad hoc unless the repository has the
   optional secrets `MACOS_SIGN_CERTIFICATE` (a Developer ID Application
   certificate as base64 `.p12`), `MACOS_SIGN_CERTIFICATE_PASSWORD` and
   `MACOS_SIGN_IDENTITY` (the certificate's name, `SIGN_IDENTITY` of
   `scripts/macos-app.sh`); with `MACOS_NOTARY_APPLE_ID`,
   `MACOS_NOTARY_TEAM_ID` and `MACOS_NOTARY_PASSWORD` (an app-specific
   password) as well, it is notarized and stapled (`NOTARY_PROFILE`). The
   workflow then writes `SHA256SUMS` over the archives, DMGs and the zip,
   attests build provenance for them (only while the repository is public:
   GitHub stores no attestations for private repositories outside
   Enterprise Cloud) and creates the GitHub release with the changelog
   section as notes. Nothing is published unless every build succeeds.
7. Smoke test a downloaded archive: `sha256sum -c SHA256SUMS`, `version`,
   then start with `--local-only` and open the UI. On a Mac, open the DMG,
   drag the app to Applications, allow it once under System Settings →
   Privacy & Security, and check that it starts its core and loads the UI;
   do the same with the macOS application from its zip.

Builds are reproducible for a given commit and toolchain (fixed timestamps in
gzip and the VSIX, `-trimpath`), so a local
`VERSION=vX.Y.Z TARGETS="…" scripts/build.sh` can be compared with the
release.

Version numbers follow semantic versioning. Changes that require users to
act (flags removed or renamed, data directories moved without migration,
protocol changes between browser and core) are breaking.
