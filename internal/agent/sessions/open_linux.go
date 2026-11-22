//go:build linux

package sessions

import (
	"errors"

	"golang.org/x/sys/unix"
)

// userPrivateGroups: a user's primary group is the user's own (user
// private groups), so a directory it may write is still private.
const userPrivateGroups = true

// dirFlags open a directory of walkOpen's path: O_PATH, which needs no
// permission to read the directory, only to search it, as resolving the
// path in one call does.
const dirFlags = unix.O_PATH | unix.O_DIRECTORY | unix.O_CLOEXEC

// openNoLinks opens p as fileFlags say, failing when a symbolic link is
// anywhere on it: openat2 with RESOLVE_NO_SYMLINKS (Linux 5.6), so a link
// swapped in for a directory of a path resolved before does not redirect
// the open. Where openat2 is missing or filtered (older kernels, some
// containers) the path is walked one element at a time (walkOpen).
func openNoLinks(p string) (int, error) {
	how := &unix.OpenHow{Flags: uint64(fileFlags | unix.O_NOFOLLOW), Resolve: unix.RESOLVE_NO_SYMLINKS}
	fd, err := retry(func() (int, error) { return unix.Openat2(unix.AT_FDCWD, p, how) })
	if errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.EPERM) {
		// Missing, or filtered (seccomp answers either); a real EPERM
		// fails the walk too.
		return walkOpen(p)
	}
	return fd, err
}
