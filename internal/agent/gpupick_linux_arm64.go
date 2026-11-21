package agent

import _ "embed"

// pickLib is the library gpupick for this platform (scripts/gpupick, built
// by scripts/build-gpupick.sh, which records its digest).
//
//go:embed gpupick/gpupick-linux-arm64.so
var pickLib []byte
