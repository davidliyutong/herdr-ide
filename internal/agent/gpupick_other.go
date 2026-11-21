//go:build unix && !(linux && (amd64 || arm64))

package agent

// pickLib: there is no gpupick for this platform.
var pickLib []byte
