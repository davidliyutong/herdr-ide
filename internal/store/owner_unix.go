//go:build unix

package store

import (
	"os"
	"syscall"
)

// modeBits: the files' mode bits keep other users out.
const modeBits = true

// noFollow makes an open of a link fail.
const noFollow = syscall.O_NOFOLLOW

// owned reports whether st is of a file of this user.
func owned(st os.FileInfo) bool {
	sys, ok := st.Sys().(*syscall.Stat_t)
	return ok && int(sys.Uid) == os.Getuid()
}
