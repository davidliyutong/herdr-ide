# Bundled herdr

The unmodified herdr 0.9.5 executable is distributed under Apache-2.0.
Source: https://github.com/herdrdev/herdr/tree/v0.9.5
Release: https://github.com/herdrdev/herdr/releases/tag/v0.9.5

Each application archive includes only the executable for its native
Linux/macOS amd64/arm64 platform. `internal/herdrdist/release.go` records its
upstream asset name and SHA-256 digest. The herdr executable is not covered
by the application's MIT license.

- `LICENSE`: upstream Apache License 2.0, unchanged.
- `THIRD_PARTY_NOTICES.md`: license texts and attribution for the union of
  Rust dependencies reachable for the four targets, plus the vendored
  terminal library and native dependencies. Build dependencies are included
  conservatively; an entry does not imply it is linked into every binary.
- `RUST-COPYRIGHT.html`: standard-library notices from upstream's Rust
  1.96.1 toolchain.

To regenerate notices, check out upstream v0.9.5 and run
`python3 scripts/herdr-notices.py /path/to/herdr`. This maintenance command
requires Python 3, Cargo and network access. Normal builds use the committed
notices. Review dependency changes and update notices together with any
herdr version or digest change.
