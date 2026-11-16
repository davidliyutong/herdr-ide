//go:build unix

package agent

import "time"

// SetSocketWatch makes agents check their sockets every d.
func SetSocketWatch(d time.Duration) (restore func()) {
	old := socketWatchEvery.Swap(int64(d))
	return func() { socketWatchEvery.Store(old) }
}
