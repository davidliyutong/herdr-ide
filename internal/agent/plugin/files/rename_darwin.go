package files

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// renameNoReplace renames from to to, failing with fs.ErrExist when to
// exists (renamex_np RENAME_EXCL; a file system without it gets a check
// first).
func renameNoReplace(from, to string) error {
	err := unix.RenamexNp(from, to, unix.RENAME_EXCL)
	if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EINVAL) {
		return renameChecked(from, to)
	}
	if err != nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
	}
	return nil
}
