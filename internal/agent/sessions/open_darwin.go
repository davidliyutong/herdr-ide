//go:build darwin

package sessions

import (
	"errors"

	"golang.org/x/sys/unix"
)

// userPrivateGroups is false: every user's primary group is staff, so a
// directory that group may write is not private.
const userPrivateGroups = false

// dirFlags open a directory of walkOpen's path.
const dirFlags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC

// openNoLinks opens p as fileFlags say, failing with ELOOP when a symbolic
// link is anywhere on it (O_NOFOLLOW_ANY, macOS 11), so a link swapped in
// for a directory of a path resolved before does not redirect the open.
// Before macOS 11, which refuses the flag, the path is walked one element
// at a time (walkOpen).
func openNoLinks(p string) (int, error) {
	fd, err := retry(func() (int, error) { return unix.Open(p, fileFlags|unix.O_NOFOLLOW_ANY, 0) })
	if errors.Is(err, unix.EINVAL) {
		return walkOpen(p)
	}
	return fd, err
}
