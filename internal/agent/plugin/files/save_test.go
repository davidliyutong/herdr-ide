//go:build unix

package files

import (
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"veldr/internal/agent/plugin"
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

func names(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var l []string
	for _, e := range ents {
		l = append(l, e.Name())
	}
	sort.Strings(l)
	return l
}

// nothingLeft fails when the agent's private directory holds a file an
// upload was received into.
func nothingLeft(t *testing.T, env *plugin.Env) {
	t.Helper()
	ents, _ := os.ReadDir(filepath.Join(env.Base, stagingDir))
	for _, e := range ents {
		t.Errorf("left in the private directory: %s", e.Name())
	}
}

// A save rewrites the file itself: its inode, hard links and mode stay,
// and nothing else appears in its directory.
func TestSaveInPlace(t *testing.T) {
	env := testEnv(t)
	p := filepath.Join(env.Home, "f.txt")
	other := filepath.Join(env.Home, "other.txt")
	write(t, p, "one")
	os.Chmod(p, 0o640)
	if err := os.Link(p, other); err != nil {
		t.Skip("no hard links here:", err)
	}
	ino := inode(t, p)
	before := names(t, env.Home)
	r := result(t, saveText(t, env, Params{Path: p, Expect: loaded(t, p)}, "two, longer"))
	if read(t, p) != "two, longer" || read(t, other) != "two, longer" || inode(t, p) != ino {
		t.Fatalf("not written in place: %q %q", read(t, p), read(t, other))
	}
	if now := loaded(t, p); r.Entry == nil || r.Entry.Size != now.Size || r.Entry.MTime != now.MTime || now.Size != int64(len("two, longer")) {
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
	// Through a symbolic link: its target is written in place, the link stays.
	os.Symlink("f.txt", filepath.Join(env.Home, "link"))
	result(t, saveText(t, env, Params{Path: filepath.Join(env.Home, "link"), Force: true}, "via link"))
	if l, err := os.Readlink(filepath.Join(env.Home, "link")); err != nil || l != "f.txt" {
		t.Fatalf("link %q %v", l, err)
	}
	if read(t, other) != "via link" || inode(t, p) != ino {
		t.Fatal("the link's target not written in place")
	}
	want := append(before, "link")
	sort.Strings(want)
	if got := names(t, env.Home); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("directory now %v, was %v", got, before)
	}
}

// A writable file in a directory that takes no new file is saved; a new
// file cannot be made there.
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
	result(t, saveText(t, env, Params{Path: p, Expect: loaded(t, p)}, "two"))
	if read(t, p) != "two" {
		t.Fatal("not written")
	}
	if rep := saveText(t, env, Params{Path: filepath.Join(dir, "new.txt")}, "x"); rep.Code != "denied" {
		t.Fatalf("new file: %+v", rep)
	}
	// A file the user may not write is left alone: no change of its mode.
	os.Chmod(dir, 0o755)
	os.Chmod(p, 0o444)
	if rep := saveText(t, env, Params{Path: p, Force: true}, "three"); rep.Code != "denied" || read(t, p) != "two" {
		t.Fatalf("read-only file: %+v", rep)
	}
	if fi, _ := os.Stat(p); fi.Mode().Perm() != 0o444 {
		t.Fatalf("mode changed: %v", fi.Mode())
	}
}

// A FIFO or a directory is not written, and a FIFO does not hold the save.
func TestSaveRefusesWhatIsNotAFile(t *testing.T) {
	env := testEnv(t)
	fifo := filepath.Join(env.Home, "fifo")
	if err := unix.Mkfifo(fifo, 0o600); err != nil {
		t.Skip("no FIFO:", err)
	}
	done := make(chan Entry)
	go func() {
		_, err := writeFile(fifo, strings.NewReader("x"), Params{Force: true})
		pe, _ := codeOf(err).(*plugin.Error)
		if pe == nil || pe.Code != "bad_params" {
			t.Errorf("FIFO: %v", err)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the FIFO held the save")
	}
	os.Mkdir(filepath.Join(env.Home, "dir"), 0o755)
	if rep := saveText(t, env, Params{Path: filepath.Join(env.Home, "dir"), Force: true}, "x"); rep.Code != "bad_params" {
		t.Fatalf("directory: %+v", rep)
	}
}

// The precondition holds for the file opened: one changed, removed, or
// swapped for a link after the first check is a conflict, and a link's
// target is not written.
func TestSaveChecksTheFileItOpens(t *testing.T) {
	env := testEnv(t)
	home, _ := filepath.EvalSymlinks(env.Home) // a save's path is real
	p := filepath.Join(home, "f.txt")
	write(t, p, "one")
	was := loaded(t, p)
	write(t, p, "changed meanwhile")
	if _, err := writeFile(p, strings.NewReader("two"), Params{Expect: was}); !isConflict(err) || read(t, p) != "changed meanwhile" {
		t.Fatalf("changed: %v", err)
	}
	secret := filepath.Join(home, "secret")
	write(t, secret, "secret")
	os.Remove(p)
	os.Symlink(secret, p)
	for _, w := range []Params{{Expect: was}, {Force: true}} {
		if _, err := writeFile(p, strings.NewReader("two"), w); !isConflict(err) || read(t, secret) != "secret" {
			t.Fatalf("link %+v: %v", w, err)
		}
	}
	os.Remove(p)
	if _, err := writeFile(p, strings.NewReader("two"), Params{Expect: was}); !isConflict(err) {
		t.Fatalf("removed: %v", err)
	}
	// A new file that appeared: a conflict, unless forced.
	write(t, p, "appeared")
	if _, err := writeFile(p, strings.NewReader("new"), Params{}); !isConflict(err) || read(t, p) != "appeared" {
		t.Fatalf("appeared: %v", err)
	}
	if e, err := createFile(p, strings.NewReader("new"), Params{Force: true}, true); err != nil || read(t, p) != "new" || e.Path != p {
		t.Fatalf("forced: %v %+v", err, e)
	}
}

// A directory above the file swapped for a link after the path was
// resolved does not redirect a save, forced or not, nor a new file.
func TestSaveRefusesALinkAboveTheFile(t *testing.T) {
	env := testEnv(t)
	home, _ := filepath.EvalSymlinks(env.Home)
	shared, other := filepath.Join(home, "shared"), filepath.Join(home, "other")
	os.Mkdir(shared, 0o755)
	os.Mkdir(other, 0o755)
	p := filepath.Join(shared, "notes.txt")
	write(t, p, "notes")
	write(t, filepath.Join(other, "notes.txt"), "secret")
	was := loaded(t, p)
	// Swapped after the path was resolved.
	os.Rename(shared, shared+".old")
	os.Symlink(other, shared)
	for _, w := range []Params{{Expect: was}, {Force: true}} {
		_, err := writeFile(p, strings.NewReader("mine"), w)
		if !linksRefused {
			t.Skip("this system's open cannot refuse links above the file")
		}
		if !isConflict(err) || read(t, filepath.Join(other, "notes.txt")) != "secret" {
			t.Fatalf("%+v: %v", w, err)
		}
	}
	// A new file in a folder whose path is resolved before it is made: a
	// link in a parent is followed only where the path held it already.
	n := filepath.Join(shared, "new.txt")
	if _, err := createFile(n, strings.NewReader("x"), Params{}, false); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(other, "new.txt")) != "x" {
		t.Fatal("not made in the link's directory")
	}
}

func isConflict(err error) bool {
	pe, ok := err.(*plugin.Error)
	return ok && pe.Code == "conflict"
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

// A write that fails after the file was truncated says so (partial_write,
// with the cause); a new file it failed for is removed.
func TestSaveFailureIsPartial(t *testing.T) {
	env := testEnv(t)
	p := filepath.Join(env.Home, "f.txt")
	write(t, p, "the old text")
	defer func(f func(io.Writer, io.Reader) error) { copyBody = f }(copyBody)
	copyBody = failAfter(1, syscall.ENOSPC)
	rep := saveText(t, env, Params{Path: p, Expect: loaded(t, p)}, "the new text")
	if rep.OK || rep.Code != "partial_write" || !strings.HasSuffix(rep.Error, "no_space") || read(t, p) != "the ne" {
		t.Fatalf("failed write: %+v %q", rep, read(t, p))
	}
	// Saved again, it is whole.
	result(t, saveText(t, env, Params{Path: p, Force: true}, "the new text"))
	if read(t, p) != "the new text" {
		t.Fatal("second save")
	}
	copyBody = failAfter(1, syscall.EIO)
	n := filepath.Join(env.Home, "new.txt")
	if rep := saveText(t, env, Params{Path: n}, "new"); rep.OK || rep.Code == "partial_write" {
		t.Fatalf("new file: %+v", rep)
	}
	if _, err := os.Lstat(n); err == nil {
		t.Fatal("the new file a write failed for is kept")
	}
}

// Old files of uploads broken off are removed; recent ones and other
// directories' files stay.
func TestPruneStaged(t *testing.T) {
	base := t.TempDir()
	d := filepath.Join(base, stagingDir)
	os.MkdirAll(d, 0o700)
	now := time.Now()
	old, recent := filepath.Join(d, "upload-00000001"), filepath.Join(d, "upload-00000002")
	write(t, old, "x")
	write(t, recent, "y")
	os.Chtimes(old, now.Add(-StagingRetention-time.Hour), now.Add(-StagingRetention-time.Hour))
	elsewhere := filepath.Join(base, "keep")
	write(t, elsewhere, "z")
	os.Chtimes(elsewhere, now.Add(-30*24*time.Hour), now.Add(-30*24*time.Hour))
	PruneStaged(base, now)
	if _, err := os.Stat(old); err == nil {
		t.Fatal("old staged upload kept")
	}
	if _, err := os.Stat(recent); err != nil {
		t.Fatal("recent staged upload removed")
	}
	if _, err := os.Stat(elsewhere); err != nil {
		t.Fatal("a file outside the staging directory removed")
	}
	PruneStaged(t.TempDir(), now) // no directory: nothing to do
}
