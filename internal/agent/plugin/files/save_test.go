//go:build unix

package files

import (
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"herdr-ide/internal/agent/plugin"
)

func inode(t *testing.T, p string) uint64 {
	t.Helper()
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	return uint64(fi.Sys().(*syscall.Stat_t).Ino)
}

func loaded(t *testing.T, p string) *Entry {
	t.Helper()
	fi, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	return entryOf(p, fi)
}

// nothingLeft fails when a save left a temporary file or a backup in dir
// or in the agent's private directory.
func nothingLeft(t *testing.T, env *plugin.Env, dir string) {
	t.Helper()
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.Contains(e.Name(), "-save-") || isBackup(e.Name()) {
			t.Errorf("left in %s: %s", dir, e.Name())
		}
	}
	ents, _ = os.ReadDir(filepath.Join(env.Base, savesDir))
	for _, e := range ents {
		t.Errorf("left in the private directory: %s", e.Name())
	}
}

// A file with several hard links is written in place: every name sees the
// new text, the inode and the mode stay.
func TestSaveKeepsHardLinks(t *testing.T) {
	env := testEnv(t)
	p := filepath.Join(env.Home, "f.txt")
	other := filepath.Join(env.Home, "other.txt")
	write(t, p, "one")
	os.Chmod(p, 0o640)
	if err := os.Link(p, other); err != nil {
		t.Skip("no hard links here:", err)
	}
	ino := inode(t, p)
	r := result(t, saveText(t, env, Params{Path: p, Expect: loaded(t, p)}, "two, longer"))
	if read(t, p) != "two, longer" || read(t, other) != "two, longer" || inode(t, p) != ino {
		t.Fatalf("not written in place: %q %q", read(t, p), read(t, other))
	}
	if r.Entry == nil || r.Entry.Size != int64(len("two, longer")) {
		t.Fatalf("entry %+v", r.Entry)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v", fi.Mode())
	}
	// Shorter text: the rest is cut.
	result(t, saveText(t, env, Params{Path: p, Force: true}, "3"))
	if read(t, other) != "3" {
		t.Fatalf("truncated: %q", read(t, other))
	}
	nothingLeft(t, env, env.Home)

	// Through a symbolic link: its target is written in place, the link stays.
	os.Symlink("f.txt", filepath.Join(env.Home, "link"))
	result(t, saveText(t, env, Params{Path: filepath.Join(env.Home, "link"), Force: true}, "via link"))
	if l, err := os.Readlink(filepath.Join(env.Home, "link")); err != nil || l != "f.txt" {
		t.Fatalf("link %q %v", l, err)
	}
	if read(t, other) != "via link" || inode(t, p) != ino {
		t.Fatal("the link's target not written in place")
	}

	// Always replacing: a new file, the other name keeps the old text.
	result(t, saveText(t, env, Params{Path: p, Force: true, Method: MethodReplace}, "replaced"))
	if read(t, p) != "replaced" || read(t, other) != "via link" || inode(t, p) == ino {
		t.Fatal("replace did not make a new file")
	}
	nothingLeft(t, env, env.Home)
}

// A file of another user (the check replaced: tests do not run as root) is
// written in place, so it keeps its owner.
func TestSaveOtherOwnersFile(t *testing.T) {
	env := testEnv(t)
	p := filepath.Join(env.Home, "theirs.txt")
	write(t, p, "theirs")
	ino := inode(t, p)
	defer func(f func(fs.FileInfo) bool) { ownedByOther = f }(ownedByOther)
	ownedByOther = func(fs.FileInfo) bool { return true }
	result(t, saveText(t, env, Params{Path: p, Expect: loaded(t, p)}, "mine now"))
	if read(t, p) != "mine now" || inode(t, p) != ino {
		t.Fatal("not written in place")
	}
	nothingLeft(t, env, env.Home)
	// The user's own file is replaced by a rename.
	ownedByOther = func(fs.FileInfo) bool { return false }
	result(t, saveText(t, env, Params{Path: p, Force: true}, "again"))
	if read(t, p) != "again" || inode(t, p) == ino {
		t.Fatal("own file not replaced")
	}
}

// A writable file in a directory that takes no new file is written in
// place; its text and backup wait in the private directory, which is
// emptied after. Always replacing fails there.
func TestSaveInUnwritableDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes any directory")
	}
	env := testEnv(t)
	dir := filepath.Join(env.Home, "ro")
	os.Mkdir(dir, 0o755)
	p := filepath.Join(dir, "f.txt")
	write(t, p, "one")
	os.Chmod(dir, 0o555)
	defer os.Chmod(dir, 0o755)
	ino := inode(t, p)
	result(t, saveText(t, env, Params{Path: p, Expect: loaded(t, p)}, "two"))
	if read(t, p) != "two" || inode(t, p) != ino {
		t.Fatal("not written in place")
	}
	nothingLeft(t, env, dir)
	if fi, err := os.Stat(filepath.Join(env.Base, savesDir)); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("private directory: %v %v", fi, err)
	}
	rep := saveText(t, env, Params{Path: p, Force: true, Method: MethodReplace}, "three")
	if rep.OK || rep.Code != "denied" || read(t, p) != "two" {
		t.Fatalf("replace in an unwritable directory: %+v", rep)
	}
	// A new file cannot be made there either way.
	if rep := saveText(t, env, Params{Path: filepath.Join(dir, "new.txt")}, "x"); rep.Code != "denied" {
		t.Fatalf("new file: %+v", rep)
	}
}

// failAfter is a copyBody that writes half of what it reads and fails, the
// first n calls.
func failAfter(n int, err error) func(io.Writer, io.Reader) error {
	real := copyBody
	return func(w io.Writer, r io.Reader) error {
		if n <= 0 {
			return real(w, r)
		}
		n--
		b, _ := io.ReadAll(r)
		w.Write(b[:len(b)/2])
		return err
	}
}

// A write in place that fails midway brings the file's content back from
// the backup and fails with the code of what went wrong.
func TestSaveInPlaceFailureRestores(t *testing.T) {
	env := testEnv(t)
	p := filepath.Join(env.Home, "f.txt")
	write(t, p, "the original text")
	if err := os.Link(p, filepath.Join(env.Home, "g.txt")); err != nil {
		t.Skip("no hard links here:", err)
	}
	defer func(f func(io.Writer, io.Reader) error) { copyBody = f }(copyBody)
	copyBody = failAfter(1, syscall.ENOSPC)
	rep := saveText(t, env, Params{Path: p, Expect: loaded(t, p)}, "a new text that does not fit")
	if rep.OK || rep.Code != "no_space" {
		t.Fatalf("reply %+v", rep)
	}
	if read(t, p) != "the original text" {
		t.Fatalf("not restored: %q", read(t, p))
	}
	nothingLeft(t, env, env.Home)

	// Restoring fails too: the backup stays, and the failure names it.
	copyBody = failAfter(2, syscall.EIO)
	rep = saveText(t, env, Params{Path: p, Force: true}, "another text")
	if rep.OK || rep.Code != "restore_failed" {
		t.Fatalf("reply %+v", rep)
	}
	var backup string
	ents, _ := os.ReadDir(env.Home)
	for _, e := range ents {
		if isBackup(e.Name()) {
			backup = filepath.Join(env.Home, e.Name())
		}
	}
	if backup == "" || read(t, backup) != "the original text" || !strings.Contains(rep.Error, backup) {
		t.Fatalf("backup %q, error %q", backup, rep.Error)
	}
}

// A file swapped for a link or another file after it was checked is not
// written through: the save is a conflict and nothing is written.
func TestSaveInPlaceRefusesASwap(t *testing.T) {
	env := testEnv(t)
	g := &guard{env: env}
	p := filepath.Join(env.Home, "f.txt")
	secret := filepath.Join(env.Home, "secret")
	src := filepath.Join(env.Home, "src")
	write(t, p, "checked")
	write(t, secret, "secret")
	write(t, src, "new text")
	fi, _ := os.Stat(p)
	os.Remove(p)
	os.Symlink(secret, p)
	if err := g.overwrite(p, src, fi); err == nil || !strings.Contains(err.Error(), "conflict") || read(t, secret) != "secret" {
		t.Fatalf("through a link: %v %q", err, read(t, secret))
	}
	os.Remove(p)
	write(t, p, "another file")
	if err := g.overwrite(p, src, fi); err == nil || !strings.Contains(err.Error(), "conflict") || read(t, p) != "another file" {
		t.Fatalf("another file: %v", err)
	}
	nothingLeft(t, env, env.Home)
}

// A backup goes beside the file, recorded by a link in the private
// directory; PruneBackups removes those older than BackupRetention (and
// the backups their links name), never a file that is not a backup.
func TestPruneBackups(t *testing.T) {
	env := testEnv(t)
	g := &guard{env: env}
	p := filepath.Join(env.Home, "f.txt")
	write(t, p, "content")
	b, err := g.backup(p, strings.NewReader("content"))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(b.path) != env.Home || !isBackup(filepath.Base(b.path)) || read(t, b.path) != "content" || b.link == "" {
		t.Fatalf("backup %+v", b)
	}
	if fi, _ := os.Stat(b.path); fi.Mode().Perm() != 0o600 {
		t.Fatalf("backup's mode %v", fi.Mode())
	}
	d := filepath.Join(env.Base, savesDir)
	stale := filepath.Join(d, "stage-0000abcd")
	write(t, stale, "x")
	fresh := filepath.Join(d, "backup-new-0000abcd")
	write(t, fresh, "y")
	// A link to a file that is no backup: only the link goes.
	notBackup := filepath.Join(env.Home, "keep.txt")
	write(t, notBackup, "z")
	odd := filepath.Join(d, "backup-0000abcd.link")
	os.Symlink(notBackup, odd)

	old := time.Now().Add(-BackupRetention - time.Hour)
	tv := []unix.Timeval{unix.NsecToTimeval(old.UnixNano()), unix.NsecToTimeval(old.UnixNano())}
	for _, q := range []string{b.link, odd} {
		if err := unix.Lutimes(q, tv); err != nil {
			t.Fatal(err)
		}
	}
	os.Chtimes(stale, old, old)

	PruneBackups(env.Base, time.Now())
	for _, gone := range []string{b.path, b.link, stale, odd} {
		if _, err := os.Lstat(gone); err == nil {
			t.Errorf("%s not removed", gone)
		}
	}
	for _, kept := range []string{fresh, notBackup, p} {
		if _, err := os.Lstat(kept); err != nil {
			t.Errorf("%s removed", kept)
		}
	}
}
