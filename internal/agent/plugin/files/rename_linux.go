package files

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// renameNoReplace renames from to to, failing with fs.ErrExist when to
// exists (renameat2 RENAME_NOREPLACE; a file system without it gets a
// check first).
func renameNoReplace(from, to string) error {
	err := unix.Renameat2(unix.AT_FDCWD, from, unix.AT_FDCWD, to, unix.RENAME_NOREPLACE)
	if errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.ENOTSUP) {
		return renameChecked(from, to)
	}
	if err != nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
	}
	return nil
}
