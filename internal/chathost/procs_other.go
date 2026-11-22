//go:build unix && !linux && !darwin

package chathost

// children lists nothing where the host has no way to: only the sessions
// that tell their process are signalled.
func children(int) []child { return nil }
