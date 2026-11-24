//go:build unix

package store

import (
	"io"
	"os"
	"syscall"
)

// SQLite's locks of a database file (its unix VFS): the pending byte, the
// reserved byte and the range of the shared locks, 512 bytes from 1 GiB.
const (
	sqlitePendingByte = 0x40000000
	sqliteLockBytes   = 512
)

// removeUnheld removes the database at p with its journal files when it
// takes the lock SQLite's writers take on it, without waiting, and still
// reports it should go once it holds it; false when the lock is held (or
// cannot be taken) or still says no.
func removeUnheld(p string, still func() bool) (bool, error) {
	f, err := os.OpenFile(p, os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return false, nil
	}
	// Closing it releases the lock (and every lock of this process on the
	// file: openHere made sure SQLite holds none here).
	defer f.Close()
	st, err := f.Stat()
	lst, lerr := os.Lstat(p)
	if err != nil || lerr != nil || !st.Mode().IsRegular() || !os.SameFile(st, lst) {
		return false, nil
	}
	lk := syscall.Flock_t{Type: syscall.F_WRLCK, Whence: io.SeekStart, Start: sqlitePendingByte, Len: sqliteLockBytes}
	if err := syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &lk); err != nil {
		return false, nil
	}
	if !still() {
		return false, nil
	}
	if err := removeFiles(p); err != nil {
		return false, err
	}
	return true, nil
}
