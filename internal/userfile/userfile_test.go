package userfile

import (
	"os"
	"path/filepath"
	"testing"
)

// A written file is private (0600) and replaced whole: no temporary file is
// left beside it, and a reader holding the old file keeps the old content.
func TestWriteIsPrivateAndAtomic(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf", "app")
	path := filepath.Join(dir, "settings.json")
	sig, err := Write(path, []byte(`{"a":1}`))
	if err != nil || !sig.Exists || sig.Size != 7 {
		t.Fatalf("write: %+v %v", sig, err)
	}
	for p, want := range map[string]os.FileMode{path: 0o600, dir: 0o700} {
		if st, err := os.Stat(p); err != nil || st.Mode().Perm() != want {
			t.Fatalf("%s: %v %v, want %v", p, st.Mode(), err, want)
		}
	}
	old, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	os.Chmod(path, 0o644) // edited by hand with another mode
	if _, err := Write(path, []byte(`{"a":2}`)); err != nil {
		t.Fatal(err)
	}
	if b, _, err := Read(path); err != nil || string(b) != `{"a":2}` {
		t.Fatalf("read back %q %v", b, err)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Fatalf("replaced file mode %v", st.Mode())
	}
	buf := make([]byte, 16)
	if n, _ := old.Read(buf); string(buf[:n]) != `{"a":1}` {
		t.Fatalf("the old file changed in place: %q", buf[:n])
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Fatalf("left behind: %v", ents)
	}
	if b, sig, err := Read(filepath.Join(dir, "missing.json")); b != nil || sig.Exists || err != nil {
		t.Fatalf("missing file: %q %+v %v", b, sig, err)
	}
}

// A directory of the user's that others may read is made 0700 by the next
// write; a link to a directory is left as it is.
func TestWriteTightensItsDirectory(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "app")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.Chmod(dir, 0o755)
	if _, err := Write(filepath.Join(dir, "keybindings.json"), []byte("[]")); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(dir); st.Mode().Perm() != 0o700 {
		t.Fatalf("pre-existing directory %v", st.Mode())
	}

	target := filepath.Join(base, "elsewhere")
	os.Mkdir(target, 0o755)
	os.Chmod(target, 0o755)
	link := filepath.Join(base, "linked")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Write(filepath.Join(link, "machines.json"), []byte("{}")); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(target); st.Mode().Perm() != 0o755 {
		t.Fatalf("the directory behind a link changed: %v", st.Mode())
	}
	if st, _ := os.Stat(filepath.Join(target, "machines.json")); st.Mode().Perm() != 0o600 {
		t.Fatalf("file behind a link %v", st.Mode())
	}
}
