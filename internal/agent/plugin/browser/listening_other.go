//go:build unix && !linux && !darwin

package browser

import "context"

// listening is not known on this system: ports are typed, not offered.
func listening(context.Context) []Port { return nil }
