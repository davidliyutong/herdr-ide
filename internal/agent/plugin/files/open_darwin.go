//go:build darwin

package files

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// linksRefused reports whether openNoLinks refuses links in every
// directory of the path (tests skip what needs it otherwise).
var linksRefused = true

// openNoLinks opens path as os.OpenFile does, failing with ELOOP when a
// symbolic link is anywhere on it (O_NOFOLLOW_ANY, macOS 11), so a link
// swapped in for a directory of a path resolved before does not redirect
// the open. Before macOS 11, which refuses the flag, only flag's own
// O_NOFOLLOW applies.
func openNoLinks(path string, flag int, perm os.FileMode) (*os.File, error) {
	f, err := os.OpenFile(path, flag|unix.O_NOFOLLOW_ANY, perm)
	if errors.Is(err, syscall.EINVAL) {
		linksRefused = false
		return os.OpenFile(path, flag, perm)
	}
	return f, err
}
