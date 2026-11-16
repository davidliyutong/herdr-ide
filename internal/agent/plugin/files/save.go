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
	// BackupRetention is how long what a save or an upload broken off by
	// the agent's end left (a backup, a staged text) is kept: the agent
	// that starts after it removes it (PruneBackups).
	BackupRetention = 7 * 24 * time.Hour
	// savesDir is the private directory (0700) in the agent's data
	// directory for staged texts and backups that cannot go beside their
	// file, and for the links that record those beside files.
	savesDir = "saves"
	// backupTag marks backups beside files: .<name>.<slug>-backup-<hex>.
	backupTag = "-backup-"
	// stageTag marks staged texts beside files: .<slug>-save-<hex>.
	stageTag = "-save-"
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
	// made runs with the name of each file a save or an upload makes for
	// itself (its staged text once received, a backup once written)
	// before the agent uses it: tests swap it for a link there.
	made = func(name string) {}
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
	var stage *stagedFile
	if !inPlace {
		// Private while the text is written, the file's mode after.
		perm := fs.FileMode(0o666)
		if exists {
			perm = 0o600
		}
		stage, err = g.createTemp(dir, perm)
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
	defer stage.discard()
	err = receive(stage, r, limit)
	if err == nil {
		err = stage.Sync()
	}
	if err != nil {
		return nil, err
	}
	made(stage.name)
	if !inPlace && exists {
		// Through the descriptor, never the name. The group first: a
		// change of group may clear mode bits.
		if gid := gidOf(fi); gid >= 0 && stage.Chown(-1, gid) != nil && auto {
			inPlace = true // the new file cannot have the file's group
		} else if err := stage.Chmod(fi.Mode().Perm()); err != nil {
			return nil, err
		}
	}
	if err := precondition(p, w); err != nil {
		return nil, err
	}
	if inPlace {
		if err := g.overwrite(p, stage, fi); err != nil {
			return nil, err
		}
		if fi, err = os.Stat(p); err != nil {
			return nil, err
		}
		return entryOf(p, fi), nil
	}
	fi, err = stage.renameTo(p, os.Rename)
	if errors.Is(err, errSwapped) {
		now, _ := os.Lstat(p)
		return nil, conflict(p, now)
	}
	if err != nil {
		return nil, err
	}
	return entryOf(p, fi), nil
}

// errSwapped is the failure of a rename whose staged file's name no longer
// names the file the agent wrote, or whose new name names another file
// right after: someone who may rename entries of the directory swapped
// them meanwhile.
var errSwapped = errors.New("replaced by another file meanwhile")

// stagedFile is a file a save or an upload receives its text into, used
// only through the descriptor the agent created it with: written, given
// its group and mode, copied from, and renamed only while its name still
// names that file. A file another user swapped for it by name (one who may
// rename entries of its directory) is never read, changed or given the
// target's name, so it cannot make the agent copy one of the user's files
// into a file they can read, or change the mode of one.
type stagedFile struct {
	*os.File
	name string // its path; "" once renamed
	link string // its record in the private directory (createTemp)
}

// ours is the file's stat, and whether its name still names it.
func (s *stagedFile) ours() (fs.FileInfo, bool) {
	ofi, err := s.Stat()
	if err != nil || s.name == "" {
		return ofi, false
	}
	lfi, err := os.Lstat(s.name)
	return ofi, err == nil && os.SameFile(ofi, lfi)
}

// renameTo gives the file the name to with rename (os.Rename, or one that
// replaces nothing) while its name still names it, and is its stat there;
// errSwapped when its name or, right after the rename, to names another
// file.
func (s *stagedFile) renameTo(to string, rename func(from, to string) error) (fs.FileInfo, error) {
	ofi, ok := s.ours()
	if !ok {
		return nil, errSwapped
	}
	if err := rename(s.name, to); err != nil {
		return nil, err
	}
	s.name = ""
	lfi, err := os.Lstat(to)
	if err != nil || !os.SameFile(ofi, lfi) {
		return nil, errSwapped
	}
	return lfi, nil
}

// discard closes the file and removes it unless it was renamed (only while
// its name still names it), and its record.
func (s *stagedFile) discard() {
	if _, ok := s.ours(); ok {
		os.Remove(s.name)
	}
	s.Close()
	if s.link != "" {
		os.Remove(s.link)
	}
}

// overwrite writes the content of src (put's staged text) into the file p
// (as fi, put's stat, found it) in place: p is opened first, without
// following a link (a file the user may not write is left alone, and one
// swapped for another file or a link meanwhile is a conflict), then copied
// from that descriptor to a backup, then truncated, written from src's
// descriptor and synced. When that fails the backup's content is written
// back from the backup's descriptor and the failure returned; a backup
// that cannot be written back is kept and named in the failure
// (restore_failed). The backup is removed otherwise.
func (g *guard) overwrite(p string, src *stagedFile, fi fs.FileInfo) error {
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
	made(b.path)
	if err := fill(f, src.File); err != nil {
		if rerr := fill(f, b.File); rerr != nil {
			b.Close() // kept, with its record
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

// fill makes the content of f that of src, read through its descriptor
// from its start: truncated, written from the start and synced.
func fill(f, src *os.File) error {
	sfi, err := src.Stat()
	if err != nil {
		return err
	}
	if err := f.Truncate(0); err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := copyBody(f, io.NewSectionReader(src, 0, sfi.Size())); err != nil {
		return err
	}
	return f.Sync()
}

// backupFile is a copy of a file written in place, kept open: its content
// is written back from this descriptor, never from its name. link records
// it in the private directory when it is beside the file.
type backupFile struct {
	*os.File
	path, link string
}

// remove closes the backup and removes it (its name only while that still
// names the backup) and its record.
func (b *backupFile) remove() {
	if ofi, err := b.Stat(); err == nil {
		if lfi, err := os.Lstat(b.path); err == nil && os.SameFile(ofi, lfi) {
			os.Remove(b.path)
		}
	}
	b.Close()
	if b.link != "" {
		os.Remove(b.link)
	}
}

// backup copies the content of the file p, read from in (0600, synced):
// beside it when its directory takes files and nobody else may rename
// entries there (.<name>.<slug>-backup-<hex>, recorded by a link in the
// private directory so that one a crash leaves is removed after
// BackupRetention), else into the private directory.
func (g *guard) backup(p string, in io.Reader) (*backupFile, error) {
	name := shortName(filepath.Base(p))
	dir := filepath.Dir(p)
	b := &backupFile{}
	var out *os.File
	err := fs.ErrPermission
	if !othersMayRename(dir) {
		out, err = createNamed(dir, "."+name+"."+brand.Slug+backupTag, 0o600)
	}
	if errors.Is(err, fs.ErrPermission) {
		var d string
		if d, err = g.privateDir(); err == nil {
			out, err = createNamed(d, "backup-"+name+"-", 0o600)
		}
	} else if err == nil {
		b.link = g.record(out.Name(), "backup")
	}
	if err != nil {
		return nil, err
	}
	b.File, b.path = out, out.Name()
	_, err = io.Copy(struct{ io.Writer }{out}, in)
	if err == nil {
		err = out.Sync()
	}
	if err != nil {
		b.remove()
		return nil, err
	}
	return b, nil
}

// stageFile is a file for a text to be written in place: beside the file
// when its directory takes files and nobody else may rename entries
// there, else in the private directory.
func (g *guard) stageFile(dir string) (*stagedFile, error) {
	var f *stagedFile
	err := fs.ErrPermission
	if !othersMayRename(dir) {
		f, err = g.createTemp(dir, 0o600)
	}
	if !errors.Is(err, fs.ErrPermission) {
		return f, err
	}
	d, err := g.privateDir()
	if err != nil {
		return nil, err
	}
	of, err := createNamed(d, "stage-", 0o600)
	if err != nil {
		return nil, err
	}
	return &stagedFile{File: of, name: of.Name()}, nil
}

// othersMayRename reports whether someone but the user and root may rename
// or remove the entries of the directory dir: it is another user's, or
// its group or others may write it and it is not sticky. A save in place
// keeps its staged text and its backup out of such a directory, although
// it uses them only through their descriptors.
func othersMayRename(dir string) bool {
	fi, err := os.Stat(dir)
	if err != nil {
		return true
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		if uid := int(st.Uid); uid != os.Geteuid() && uid != 0 {
			return true
		}
	}
	return fi.Mode().Perm()&0o022 != 0 && fi.Mode()&fs.ModeSticky == 0
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

// createTemp creates a file for a save or an upload in dir
// (.<slug>-save-<hex>), with perm less the umask, recorded by a link in
// the private directory so that one the agent's end leaves (killed, a
// crash) is removed after BackupRetention.
func (g *guard) createTemp(dir string, perm fs.FileMode) (*stagedFile, error) {
	f, err := createNamed(dir, "."+brand.Slug+stageTag, perm)
	if err != nil {
		return nil, err
	}
	return &stagedFile{File: f, name: f.Name(), link: g.record(f.Name(), "save")}, nil
}

// record links the file p, which a save or an upload made beside a file,
// from the private directory (<kind>-<hex>.link), so that PruneBackups
// finds it should the agent end before it is removed or renamed; the link,
// "" when it could not be made (the file then has no retention, as before
// it was recorded).
func (g *guard) record(p, kind string) string {
	d, err := g.privateDir()
	if err != nil {
		return ""
	}
	link := filepath.Join(d, fmt.Sprintf("%s-%08x.link", kind, rand.Uint32()))
	if os.Symlink(p, link) != nil {
		return ""
	}
	return link
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

// isBackup reports whether name is that of a backup beside a file:
// .<name>.<slug>-backup-<8 hex digits>.
func isBackup(name string) bool {
	tag := "." + brand.Slug + backupTag
	i := strings.LastIndex(name, tag)
	return i > 0 && strings.HasPrefix(name, ".") && isHex8(name[i+len(tag):])
}

// isStaged reports whether name is that of a staged text beside a file:
// .<slug>-save-<8 hex digits>.
func isStaged(name string) bool {
	prefix := "." + brand.Slug + stageTag
	return strings.HasPrefix(name, prefix) && isHex8(name[len(prefix):])
}

func isHex8(s string) bool {
	if len(s) != 8 {
		return false
	}
	for _, c := range s {
		if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f') {
			return false
		}
	}
	return true
}

// PruneBackups removes what saves and uploads left in the data directory
// base more than BackupRetention before now: staged texts and backups in
// the private directory, and the staged texts and backups beside files its
// links record. A recorded file is removed only when its own name is a
// backup's or a staged text's (isBackup, isStaged), it is a regular file
// of the user (the link's last element is never followed) and it is older
// than the retention too. They are left only when the agent ended during a
// save or an upload (a crash, a kill), or when restoring a file failed,
// which names the backup. The agent runs it when it starts.
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
			if t, err := os.Readlink(p); err == nil && filepath.IsAbs(t) && (isBackup(filepath.Base(t)) || isStaged(filepath.Base(t))) {
				if tfi, err := os.Lstat(t); err == nil && tfi.Mode().IsRegular() && !ownedByOther(tfi) && !tfi.ModTime().After(cutoff) {
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
