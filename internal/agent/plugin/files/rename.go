//go:build unix

package files

import (
	"errors"
	"io/fs"
	"os"
)

// renameChecked renames from to to after checking that to is free, for
// file systems that cannot refuse to replace in the rename itself.
func renameChecked(from, to string) error {
	if _, err := os.Lstat(to); err == nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: fs.ErrExist}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Rename(from, to)
}
