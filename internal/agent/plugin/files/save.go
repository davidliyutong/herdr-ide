//go:build unix

package files

// Writing a file that may be there (an editor's save), as Vim does with
// 'backupcopy' auto: a new file renamed over the old one when that loses
// nothing, else the file itself written in place after a copy of it is
// made, which brings its content back when the write fails.
//
// A rename gives the path a new file: hard links to the old one keep the
// old text, a file of another user becomes the user's, and it needs a
// directory the user may write. So a file with several links, of another
// owner, in a directory that takes no new file, or whose group the new
// file cannot have, is written in place. Through a symbolic link the
// link's target is written (the caller resolves it); the link stays.

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/brand"
)

const (
	// MethodAuto writes in place when a rename would lose something (the
	// default; setting files.saveMethod).
	MethodAuto = "auto"
	// MethodReplace always renames a new file over the old one; it fails
	// in a directory that takes no new file.
	MethodReplace = "replace"
	// BackupRetention is how long what a save broken off by the agent's
	// end left (a backup, a staged text) is kept: the agent that starts
	// after it removes it (PruneBackups).
	BackupRetention = 7 * 24 * time.Hour
	// savesDir is the private directory (0700) in the agent's data
	// directory for staged texts and backups that cannot go beside their
	// file, and for the links that record the backups beside files.
	savesDir = "saves"
	// backupTag marks backups beside files: .<name>.<slug>-backup-<hex>.
	backupTag = "-backup-"
)

// Tests replace these.
var (
	// ownedByOther reports whether the file is not the user's.
	ownedByOther = func(fi fs.FileInfo) bool {
		st, ok := fi.Sys().(*syscall.Stat_t)
		return ok && int(st.Uid) != os.Geteuid()
	}
	// copyBody writes r into w (fill): the text into the file written in
	// place, and the backup back into it when that failed.
	copyBody = func(w io.Writer, r io.Reader) error {
		// Only w's Write: an *os.File's ReadFrom would copy on its own.
		_, err := io.Copy(struct{ io.Writer }{w}, r)
		return err
	}
)

// links is the number of hard links of a file.
func links(fi fs.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Nlink)
	}
	return 1
}

// gidOf is a file's group, -1 when it is not known.
func gidOf(fi fs.FileInfo) int {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return int(st.Gid)
	}
	return -1
}

// put writes what r holds (at most limit bytes) into the file p (not a
// link), once w's precondition still holds (precondition: the file as
// loaded, unless Force). A new file is created beside it and renamed over
// it, with its mode and group (a new path gets what the umask leaves of
// 0666); with MethodAuto a file with several hard links, of another owner,
// whose group the new file cannot have, or in a directory that takes no
// new file is written in place instead (inPlace). The text is received in
// full first, so a transfer that breaks off changes nothing.
func (g *guard) put(p string, r io.Reader, w Params, limit int64) (*Entry, error) {
	fi, err := os.Stat(p)
	exists := err == nil
	switch {
	case err != nil && !errors.Is(err, fs.ErrNotExist):
		io.Copy(io.Discard, r)
		return nil, err
	case exists && !fi.Mode().IsRegular():
		io.Copy(io.Discard, r)
		return nil, plugin.Errorf("bad_params", "%s is not a regular file", p)
	}
	auto := w.Method != MethodReplace
	inPlace := exists && auto && (links(fi) > 1 || ownedByOther(fi))
	dir := filepath.Dir(p)
	var stage *os.File
	if !inPlace {
		// Private while the text is written, the file's mode after.
		perm := fs.FileMode(0o666)
		if exists {
			perm = 0o600
		}
		stage, err = createTemp(dir, perm)
		if err != nil {
			if !(exists && auto && errors.Is(err, fs.ErrPermission)) {
				io.Copy(io.Discard, r)
				return nil, err
			}
			inPlace = true // the directory takes no new file
		}
	}
	if inPlace {
		if stage, err = g.stageFile(dir); err != nil {
			io.Copy(io.Discard, r)
			return nil, err
		}
	}
	staged := stage.Name()
	defer func() {
		if staged != "" {
			os.Remove(staged)
		}
	}()
	err = receive(stage, r, limit)
	if err == nil {
		err = stage.Sync()
	}
	if cerr := stage.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	if !inPlace && exists {
		// The group first: a change of group may clear mode bits.
		if gid := gidOf(fi); gid >= 0 && os.Lchown(staged, -1, gid) != nil && auto {
			inPlace = true // the new file cannot have the file's group
		} else if err := os.Chmod(staged, fi.Mode().Perm()); err != nil {
			return nil, err
		}
	}
	if err := precondition(p, w); err != nil {
		return nil, err
	}
	if inPlace {
		if err := g.overwrite(p, staged, fi); err != nil {
			return nil, err
		}
	} else {
		if err := os.Rename(staged, p); err != nil {
			return nil, err
		}
		staged = ""
	}
	if fi, err = os.Stat(p); err != nil {
		return nil, err
	}
	return entryOf(p, fi), nil
}

// overwrite writes the content of src into the file p (as fi, put's stat,
// found it) in place: p is opened first, without following a link (a file
// the user may not write is left alone, and one swapped for another file
// or a link meanwhile is a conflict), then copied from that descriptor to
// a backup, then truncated, written and synced. When that fails the
// backup's content is written back and the failure returned; a backup
// that cannot be written back is kept and named in the failure
// (restore_failed). The backup is removed otherwise.
func (g *guard) overwrite(p, src string, fi fs.FileInfo) error {
	f, err := os.OpenFile(p, os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if errors.Is(err, syscall.ELOOP) {
		return conflict(p, nil)
	}
	if err != nil {
		return err
	}
	defer f.Close()
	ofi, err := f.Stat()
	if err != nil {
		return err
	}
	if !ofi.Mode().IsRegular() || !os.SameFile(ofi, fi) {
		return conflict(p, ofi)
	}
	b, err := g.backup(p, io.NewSectionReader(f, 0, ofi.Size()))
	if err != nil {
		return err
	}
	if err := fill(f, src); err != nil {
		if rerr := fill(f, b.path); rerr != nil {
			if g.env.Logger != nil {
				g.env.Logger.Printf("files: writing %s failed (%v), restoring it too (%v): its content is in %s", p, err, rerr, b.path)
			}
			// The message is the backup's path, which the UIs show.
			return &plugin.Error{Code: "restore_failed", Err: errors.New(b.path)}
		}
		b.remove()
		return err
	}
	b.remove()
	return nil
}

// fill makes the content of f that of the file src: truncated, written
// from the start and synced.
func fill(f *os.File, src string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := f.Truncate(0); err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := copyBody(f, in); err != nil {
		return err
	}
	return f.Sync()
}

// backupFile is a copy of a file written in place; link records it in the
// private directory when it is beside the file.
type backupFile struct{ path, link string }

func (b *backupFile) remove() {
	os.Remove(b.path)
	if b.link != "" {
		os.Remove(b.link)
	}
}

// backup copies the content of the file p, read from in (0600, synced):
// beside it when its directory takes files (.<name>.<slug>-backup-<hex>,
// recorded by a link in the private directory so that one a crash leaves
// is removed after BackupRetention), else into the private directory.
func (g *guard) backup(p string, in io.Reader) (*backupFile, error) {
	name := shortName(filepath.Base(p))
	b := &backupFile{}
	out, err := createNamed(filepath.Dir(p), "."+name+"."+brand.Slug+backupTag, 0o600)
	if errors.Is(err, fs.ErrPermission) {
		var d string
		if d, err = g.privateDir(); err == nil {
			out, err = createNamed(d, "backup-"+name+"-", 0o600)
		}
	} else if err == nil {
		if d, derr := g.privateDir(); derr == nil {
			link := filepath.Join(d, fmt.Sprintf("backup-%08x.link", rand.Uint32()))
			if os.Symlink(out.Name(), link) == nil {
				b.link = link
			}
		}
	}
	if err != nil {
		return nil, err
	}
	b.path = out.Name()
	_, err = io.Copy(struct{ io.Writer }{out}, in)
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		b.remove()
		return nil, err
	}
	return b, nil
}

// stageFile is a file for a text to be written in place: beside the file
// when its directory takes files, else in the private directory.
func (g *guard) stageFile(dir string) (*os.File, error) {
	f, err := createTemp(dir, 0o600)
	if !errors.Is(err, fs.ErrPermission) {
		return f, err
	}
	d, err := g.privateDir()
	if err != nil {
		return nil, err
	}
	return createNamed(d, "stage-", 0o600)
}

// privateDir is the agent's directory for what saves keep outside the
// file's directory: made 0700, and refused when it is not a directory.
func (g *guard) privateDir() (string, error) {
	if g.env.Base == "" {
		return "", plugin.Errorf("denied", "no data directory")
	}
	d := filepath.Join(g.env.Base, savesDir)
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", err
	}
	fi, err := os.Lstat(d)
	if err != nil {
		return "", err
	}
	if !fi.IsDir() {
		return "", plugin.Errorf("failed", "%s is not a directory", d)
	}
	if fi.Mode().Perm() != 0o700 {
		if err := os.Chmod(d, 0o700); err != nil {
			return "", err
		}
	}
	return d, nil
}

// shortName is a file's name cut to 100 bytes (at a character), so that a
// backup's name stays within the file system's limit.
func shortName(name string) string {
	if len(name) <= 100 {
		return name
	}
	cut := 100
	for cut > 0 && name[cut]&0xC0 == 0x80 {
		cut--
	}
	return name[:cut]
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

// createTemp creates a file for a save in dir (.<slug>-save-<hex>), with
// perm less the umask.
func createTemp(dir string, perm fs.FileMode) (*os.File, error) {
	return createNamed(dir, "."+brand.Slug+"-save-", perm)
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

// isBackup reports whether name is that of a backup beside a file.
func isBackup(name string) bool {
	return strings.HasPrefix(name, ".") && strings.Contains(name, "."+brand.Slug+backupTag)
}

// PruneBackups removes what saves left in the data directory base more
// than BackupRetention before now: staged texts and backups in the private
// directory, and the backups beside files its links record (only a file
// whose name is a backup's). A save leaves them only when the agent ended
// during it (a crash, a kill), or when restoring a file failed, which
// names the backup. The agent runs it when it starts.
func PruneBackups(base string, now time.Time) {
	d := filepath.Join(base, savesDir)
	ents, err := os.ReadDir(d)
	if err != nil {
		return
	}
	cutoff := now.Add(-BackupRetention)
	for _, e := range ents {
		p := filepath.Join(d, e.Name())
		fi, err := os.Lstat(p)
		if err != nil || fi.ModTime().After(cutoff) {
			continue
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			if t, err := os.Readlink(p); err == nil && filepath.IsAbs(t) && isBackup(filepath.Base(t)) {
				if tfi, err := os.Lstat(t); err == nil && tfi.Mode().IsRegular() {
					os.Remove(t)
				}
			}
		}
		if fi.IsDir() {
			continue
		}
		os.Remove(p)
	}
}
