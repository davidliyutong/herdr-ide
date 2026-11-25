#!/bin/sh
# run.sh with the Go machine build (go/<slug>, build.sh --go) instead of
# the TypeScript machine side: what a machine does whichever build runs.
here=$(cd "$(dirname "$0")" && pwd)
exe=$(ls "$here"/go/* 2>/dev/null | head -1)
[ -x "$exe" ] || { echo "no Go machine build in $here/go (build.sh --go)"; exit 2; }
MACHINE_EXE=$exe exec sh "$here/run.sh"
