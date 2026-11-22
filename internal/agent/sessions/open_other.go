//go:build unix && !darwin && !linux

package sessions

import "golang.org/x/sys/unix"

// userPrivateGroups is false: a primary group is not known to be the
// user's own, so a directory it may write is not private.
const userPrivateGroups = false

// dirFlags open a directory of walkOpen's path.
const dirFlags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_CLOEXEC

// openNoLinks opens p as fileFlags say, walking it one element at a time
// so that no symbolic link on it is followed (walkOpen).
func openNoLinks(p string) (int, error) { return walkOpen(p) }
