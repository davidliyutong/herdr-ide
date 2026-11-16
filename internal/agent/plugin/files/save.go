//go:build unix

package files

// Writing a file that may be there (an editor's save, an upload that
// replaces a file) as VS Code writes a user's file: the file itself is
// opened and its content rewritten in place (truncated, written, synced).
// The path keeps its file: its inode, hard links, owner, group, mode,
// extended attributes and ACLs stay, and a directory the user may not
// create files in takes the save. Nothing is ever created beside the file
// (no temporary file, no backup), so a directory others may write gives
// them nothing to swap.
//
// The text is received in full before the file is opened, so a transfer
// that breaks off changes nothing. The file opened is the one checked: the
// precondition (the file as the editor loaded it) is checked on the
// descriptor that is then written. A write that fails after the file was
// truncated (a full disk, an I/O error) leaves part of the text in it
// (partial_write); the editor keeps the text, which a new save writes.
// Through a symbolic link the link's target is written (the caller
// resolves it); the link stays.

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"herdr-ide/internal/agent/plugin"
)

const (
	// StagingRetention is how long an upload broken off by the agent's
	// end leaves the file it was received into: the agent that starts
	// after it removes it (PruneStaged).
	StagingRetention = 7 * 24 * time.Hour
	// stagingDir is the private directory (0700) in the agent's data
	// directory an upload is received into before it is written to its
	// file.
	stagingDir = "staging"
)

// copyBody writes r into w: the text into the file. Tests replace it.
var copyBody = func(w io.Writer, r io.Reader) error {
	// Only w's Write: an *os.File's ReadFrom would copy on its own.
	_, err := io.Copy(struct{ io.Writer }{w}, r)
	return err
}

// writeFile makes what src holds the content of the file p (its real path:
// the caller resolved its links), once w's precondition holds on the file
// opened (the file as loaded, unless Force). A file that is not there is
// created (createFile). The file is opened without following a link
// anywhere on its path (openNoLinks: one swapped in since it was resolved,
// for the file or a directory above it, is a conflict, also when forced),
// without blocking (a FIFO) and without becoming a controlling terminal,
// and must be a regular file.
func writeFile(p string, src io.Reader, w Params) (*Entry, error) {
	return writeIn(p, src, w, true)
}

// writeIn is writeFile; a file that is not there is created only with
// mayCreate (else it is a conflict), so that a file that comes and goes
// meanwhile ends the save.
func writeIn(p string, src io.Reader, w Params, mayCreate bool) (*Entry, error) {
	if fi, err := os.Lstat(p); err == nil && !fi.Mode().IsRegular() && fi.Mode()&fs.ModeSymlink == 0 {
		// A device or a FIFO is never opened.
		return nil, notRegular(p, fi)
	}
	f, err := openNoLinks(p, os.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_NOCTTY, 0)
	switch {
	case errors.Is(err, fs.ErrNotExist) && mayCreate:
		return createFile(p, src, w, true)
	case errors.Is(err, fs.ErrNotExist):
		return nil, conflict(p, nil)
	case errors.Is(err, syscall.ELOOP):
		// A link since the caller resolved the path: the pane says the
		// file changed.
		fi, _ := os.Lstat(p)
		return nil, conflict(p, fi)
	case errors.Is(err, syscall.EISDIR), errors.Is(err, syscall.ENXIO):
		return nil, plugin.Errorf("bad_params", "%s is not a regular file", p)
	case err != nil:
		return nil, codeOf(err)
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		f.Close()
		return nil, notRegular(p, fi)
	}
	if err := expected(p, fi, w); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Truncate(0); err != nil {
		f.Close()
		return nil, codeOf(err) // nothing changed
	}
	return finish(p, f, fill(f, src))
}

// createFile creates the file p for a save or an upload and writes what
// src holds into it: with what the umask leaves of 0666, in its directory
// resolved (no link anywhere on the path opened), failing when a file or
// a link appeared there meanwhile (a conflict; with Force and again, a
// file is written in place). A new file the write failed for is removed
// (only while its name still names it).
func createFile(p string, src io.Reader, w Params, again bool) (*Entry, error) {
	if !w.Force && w.Expect != nil && w.Expect.Exists {
		return nil, conflict(p, nil) // removed since it was loaded
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(p))
	if err != nil {
		return nil, codeOf(err)
	}
	real := filepath.Join(dir, filepath.Base(p))
	f, err := openNoLinks(real, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW|syscall.O_NOCTTY, 0o666)
	switch {
	case errors.Is(err, fs.ErrExist):
		if w.Force && again {
			e, err := writeIn(real, src, Params{Force: true}, false)
			if e != nil {
				e.Path = p
			}
			return e, err
		}
		fi, _ := os.Lstat(real)
		return nil, conflict(p, fi)
	case errors.Is(err, syscall.ELOOP):
		fi, _ := os.Lstat(real) // a directory became a link
		return nil, conflict(p, fi)
	case err != nil:
		return nil, codeOf(err)
	}
	if err := fill(f, src); err != nil {
		removeOwn(real, f)
		f.Close()
		return nil, codeOf(errors.Unwrap(err))
	}
	return finish(p, f, nil)
}

// fill writes what src holds into f from its start and syncs it; its
// failure is partial_write, with the cause.
func fill(f *os.File, src io.Reader) error {
	err := copyBody(f, src)
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		return &partialError{err}
	}
	return nil
}

// finish closes f, written by fill with the outcome err, and is the file's
// entry: from its descriptor's stat, which is the file written.
func finish(p string, f *os.File, err error) (*Entry, error) {
	var fi fs.FileInfo
	if err == nil {
		fi, err = f.Stat()
	}
	if cerr := f.Close(); err == nil && cerr != nil {
		err = &partialError{cerr} // a network file system reports late
	}
	if err != nil {
		return nil, err
	}
	return entryOf(p, fi), nil
}

// partialError is a write that failed after the file was truncated: the
// file may hold part of the text. Its code is partial_write; its message
// is the cause's code (no_space…), which the UIs show with it.
type partialError struct{ err error }

func (e *partialError) Error() string { return e.err.Error() }
func (e *partialError) Unwrap() error { return e.err }

// partial is a partialError as the plugin's error that answers it.
func partial(e *partialError) error {
	cause := "failed"
	var pe *plugin.Error
	if errors.As(codeOf(e.err), &pe) {
		cause = pe.Code
	}
	return &plugin.Error{Code: "partial_write", Err: errors.New(cause)}
}

// removeOwn removes p while it names the file f (a file the agent created
// and could not write).
func removeOwn(p string, f *os.File) {
	ofi, err := f.Stat()
	if err != nil {
		return
	}
	if lfi, err := os.Lstat(p); err == nil && os.SameFile(ofi, lfi) {
		os.Remove(p)
	}
}

// notRegular refuses a file that is not a regular one.
func notRegular(p string, fi fs.FileInfo) error {
	return plugin.Errorf("bad_params", "%s is not a regular file (%v)", p, fi.Mode().Type())
}

// saveErr is a failure of writeFile as the plugin answers it.
func saveErr(err error) error {
	var pe *partialError
	if errors.As(err, &pe) {
		return partial(pe)
	}
	return codeOf(err)
}

// receive copies a text (at most limit bytes) into w. It reads r to its end
// whatever happens (a full disk, too much text): the core sends the whole
// text before it reads the answer.
func receive(w io.Writer, r io.Reader, limit int64) error {
	n, err := io.Copy(w, io.LimitReader(r, limit+1))
	if err == nil && n > limit {
		err = plugin.Errorf("too_large", "more than %d bytes", limit)
	}
	if err != nil {
		io.Copy(io.Discard, r)
	}
	return err
}

// stagingFile is a new file (0600) in the agent's private directory for an
// upload to be received into; the caller closes and removes it.
func (g *guard) stagingFile() (*os.File, error) {
	if g.env.Base == "" {
		return nil, plugin.Errorf("denied", "no data directory")
	}
	d := filepath.Join(g.env.Base, stagingDir)
	if err := os.MkdirAll(d, 0o700); err != nil {
		return nil, err
	}
	fi, err := os.Lstat(d)
	if err != nil {
		return nil, err
	}
	if !fi.IsDir() {
		return nil, plugin.Errorf("failed", "%s is not a directory", d)
	}
	if fi.Mode().Perm() != 0o700 {
		if err := os.Chmod(d, 0o700); err != nil {
			return nil, err
		}
	}
	return createNamed(d, "upload-", 0o600)
}

// createNamed creates a new file in dir named prefix and 8 random hex
// digits.
func createNamed(dir, prefix string, perm fs.FileMode) (*os.File, error) {
	for i := 0; i < 100; i++ {
		name := filepath.Join(dir, fmt.Sprintf("%s%08x", prefix, rand.Uint32()))
		f, err := os.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, perm)
		if !errors.Is(err, fs.ErrExist) {
			return f, err
		}
	}
	return nil, plugin.Errorf("exists", "no free name in %s", dir)
}

// PruneStaged removes the files uploads were received into (in the data
// directory base) more than StagingRetention before now. They are left
// only when the agent ended during an upload (a crash, a kill). The agent
// runs it when it starts.
func PruneStaged(base string, now time.Time) {
	d := filepath.Join(base, stagingDir)
	ents, err := os.ReadDir(d)
	if err != nil {
		return
	}
	cutoff := now.Add(-StagingRetention)
	for _, e := range ents {
		p := filepath.Join(d, e.Name())
		if fi, err := os.Lstat(p); err == nil && !fi.IsDir() && !fi.ModTime().After(cutoff) {
			os.Remove(p)
		}
	}
}
