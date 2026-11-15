//go:build unix

package userfile

import (
	"os"
	"syscall"
)

// private takes group and other access away from dir when it is a
// directory of this user; a link or another user's directory is left as it
// is.
func private(dir string) error {
	st, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !st.IsDir() || !ok || int(sys.Uid) != os.Getuid() || st.Mode().Perm()&0o077 == 0 {
		return nil
	}
	return os.Chmod(dir, st.Mode().Perm()&0o700)
}
