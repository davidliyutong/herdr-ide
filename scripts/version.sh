# Sourced by scripts/build.sh and scripts/desktop.sh: the build's version,
# exported so that the hub executables and the desktop app around them carry
# the same one. A release passes VERSION (the tag).
#
# Local edits at the same commit need distinct versions too: the chat host
# outlives an app reinstall and only makes way for a newer build. Release
# versions stay reproducible; dirty builds are ordered by their build time.
VERSION=${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}
if [[ "$VERSION" == *-dirty ]]; then
  VERSION="$VERSION.$(date -u +%s)"
fi
export VERSION
