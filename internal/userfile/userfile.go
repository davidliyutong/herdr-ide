// Package userfile reads and writes the hand-editable JSON files of the core
// host (settings, keybindings, machines, the vault): atomic, durable
// replacement with private permissions, and a signature that tells whether
// someone else changed the file since it was last read or written.
package userfile

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// Sig identifies the version of a file: its modification time and size, or
// that it does not exist.
type Sig struct {
	Exists  bool
	ModTime time.Time
	Size    int64
}

// Stat returns the file's signature; a file that cannot be read counts as
// missing.
func Stat(path string) Sig {
	st, err := os.Stat(path)
	if err != nil {
		return Sig{}
	}
	return Sig{Exists: true, ModTime: st.ModTime(), Size: st.Size()}
}

// Read returns the file's content and signature; a missing file is empty
// content without an error.
func Read(path string) ([]byte, Sig, error) {
	sig := Stat(path)
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, Sig{}, nil
	}
	return b, sig, err
}

// syncFile and syncDirOf flush a file's content and a directory's entries
// to disk (tests replace them).
var (
	syncFile  = (*os.File).Sync
	syncDirOf = syncDir
)

// Write replaces the file atomically (mode 0600) and returns its new
// signature. The new content is flushed to disk before it replaces the old
// file (a failure leaves the old file), and the directory after, so a crash
// or a power loss leaves the old file or the new one, never an empty or
// partial one (the vault's file holds the only copy of its values). Its
// directory is created with 0700; one that
// exists, is a directory (not a link) and belongs to this user is made 0700
// when others may access it. The directory is the product's own
// configuration directory, which holds nothing for other users.
func Write(path string, data []byte) (Sig, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Sig{}, err
	}
	if err := private(dir); err != nil {
		return Sig{}, err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+"-*")
	if err != nil {
		return Sig{}, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return Sig{}, err
	}
	if err := syncFile(tmp); err != nil {
		tmp.Close()
		return Sig{}, err
	}
	if err := tmp.Close(); err != nil {
		return Sig{}, err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return Sig{}, err
	}
	// The file is replaced: a failure to flush its directory's entry is not
	// one of the write (callers would take the old content for the current
	// one), only of its durability.
	_ = syncDirOf(dir)
	return Stat(path), nil
}

// Poll calls check every interval until ctx ends. Stores use it to notice
// edits made by hand: check compares the file's Sig with the one it last
// read or wrote, and reloads when they differ.
func Poll(ctx context.Context, every time.Duration, check func()) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			check()
		}
	}
}
