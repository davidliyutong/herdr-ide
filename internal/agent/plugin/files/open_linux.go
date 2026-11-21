//go:build linux

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
// symbolic link is anywhere on it (openat2 with RESOLVE_NO_SYMLINKS, Linux
// 5.6), so a link swapped in for a directory of a path resolved before
// does not redirect the open. Where openat2 is missing or filtered (older
// kernels, some containers) only flag's own O_NOFOLLOW applies.
func openNoLinks(path string, flag int, perm os.FileMode) (*os.File, error) {
	how := &unix.OpenHow{Flags: uint64(flag | unix.O_CLOEXEC), Resolve: unix.RESOLVE_NO_SYMLINKS}
	if flag&os.O_CREATE != 0 {
		how.Mode = uint64(perm.Perm())
	}
	for {
		fd, err := unix.Openat2(unix.AT_FDCWD, path, how)
		switch {
		case err == nil:
			return os.NewFile(uintptr(fd), path), nil
		case errors.Is(err, syscall.EINTR):
			continue
		case errors.Is(err, syscall.ENOSYS), errors.Is(err, syscall.EPERM):
			// Missing, or filtered (seccomp answers either); a real EPERM
			// fails the plain open too.
			f, err := os.OpenFile(path, flag, perm)
			if err == nil {
				linksRefused = false
			}
			return f, err
		}
		return nil, &os.PathError{Op: "openat2", Path: path, Err: err}
	}
}
