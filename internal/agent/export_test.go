//go:build unix

package agent

// SetPrivacyOS makes op privacy check as on goos.
func SetPrivacyOS(goos string) (restore func()) {
	old := privacyOS
	privacyOS = goos
	return func() { privacyOS = old }
}
