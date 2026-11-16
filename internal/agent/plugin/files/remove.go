//go:build unix

package files

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// ctxReader is r ending with ctx's error once ctx ends: a copy stops
// between chunks.
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// removeTree removes p and, for a directory, everything below it, as
// os.RemoveAll does: each directory is opened relative to its parent
// without following a link, and links are removed, never followed, so a
// link swapped in meanwhile leads nowhere outside the tree. It checks ctx
// before each entry: a removal the core gave up on stops, leaving what it
// has not reached.
func removeTree(ctx context.Context, p string) error {
	dir := filepath.Dir(p)
	parent, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return &fs.PathError{Op: "open", Path: dir, Err: err}
	}
	defer unix.Close(parent)
	return removeAt(ctx, parent, filepath.Base(p), p)
}

// removeAt removes name in the directory parent (path is its path, for
// errors).
func removeAt(ctx context.Context, parent int, name, path string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	err := unix.Unlinkat(parent, name, 0)
	if err == nil || errors.Is(err, unix.ENOENT) {
		return nil
	}
	// A directory: EISDIR on Linux, EPERM on macOS; EACCES when the parent
	// is not writable, which removing the directory reports below.
	if !errors.Is(err, unix.EISDIR) && !errors.Is(err, unix.EPERM) && !errors.Is(err, unix.EACCES) {
		return &fs.PathError{Op: "unlinkat", Path: path, Err: err}
	}
	unlinkErr := err
	for {
		const batch = 1024
		fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			if errors.Is(err, unix.ENOENT) {
				return nil
			}
			if errors.Is(err, unix.ENOTDIR) || errors.Is(err, unix.ELOOP) {
				// Not a directory (a link): the unlink's error stands.
				return &fs.PathError{Op: "unlinkat", Path: path, Err: unlinkErr}
			}
			return &fs.PathError{Op: "openat", Path: path, Err: err}
		}
		d := os.NewFile(uintptr(fd), path)
		names, err := d.Readdirnames(batch)
		if err != nil && err != io.EOF {
			d.Close()
			return err
		}
		for _, n := range names {
			if err := removeAt(ctx, fd, n, filepath.Join(path, n)); err != nil {
				d.Close()
				return err
			}
		}
		// Removing entries may reorder the directory: it is read again from
		// its start until a read finds less than a batch.
		d.Close()
		if len(names) < batch {
			break
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	err = unix.Unlinkat(parent, name, unix.AT_REMOVEDIR)
	if err == nil || errors.Is(err, unix.ENOENT) {
		return nil
	}
	return &fs.PathError{Op: "unlinkat", Path: path, Err: err}
}
