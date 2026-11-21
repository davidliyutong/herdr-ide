package userfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A written file is replaced whole and read back; no temporary file is left
// beside it. The permissions are checked on Linux and macOS
// (userfile_unix_test.go).
func TestWriteReplaces(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf", "app")
	path := filepath.Join(dir, "settings.json")
	for _, body := range []string{`{"a":1}`, `{"a":22}`} {
		sig, err := Write(path, []byte(body))
		if err != nil || !sig.Exists || sig.Size != int64(len(body)) {
			t.Fatalf("write: %+v %v", sig, err)
		}
		if b, got, err := Read(path); err != nil || string(b) != body || got.Size != sig.Size {
			t.Fatalf("read back %q %+v %v", b, got, err)
		}
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Fatalf("left behind: %v", ents)
	}
	if b, sig, err := Read(filepath.Join(dir, "missing.json")); b != nil || sig.Exists || err != nil {
		t.Fatalf("missing file: %q %+v %v", b, sig, err)
	}
}

// The new content is flushed to disk before it replaces the file, and the
// directory after the rename; a content that cannot be flushed replaces
// nothing and leaves no temporary file.
func TestWriteIsDurable(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "conf")
	path := filepath.Join(dir, "vault.json")
	var order []string
	oldFile, oldDir := syncFile, syncDirOf
	t.Cleanup(func() { syncFile, syncDirOf = oldFile, oldDir })
	syncFile = func(f *os.File) error {
		if _, err := os.Stat(path); err == nil {
			if b, _ := os.ReadFile(path); string(b) != `{"a":1}` {
				t.Errorf("the file was replaced before its content was flushed: %q", b)
			}
		}
		order = append(order, "file:"+filepath.Base(f.Name()))
		return oldFile(f)
	}
	syncDirOf = func(d string) error {
		if b, _ := os.ReadFile(path); len(b) == 0 {
			t.Error("the directory was flushed before the rename")
		}
		order = append(order, "dir:"+d)
		return oldDir(d)
	}
	if _, err := Write(path, []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	if len(order) != 2 || !strings.HasPrefix(order[0], "file:.vault.json-") || order[1] != "dir:"+dir {
		t.Fatalf("flushes %v", order)
	}

	syncFile = func(*os.File) error { return os.ErrInvalid }
	if _, err := Write(path, []byte(`{"a":2}`)); err == nil {
		t.Fatal("a content that cannot be flushed was written")
	}
	if b, _, _ := Read(path); string(b) != `{"a":1}` {
		t.Fatalf("the old file changed: %q", b)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Fatalf("left behind: %v", ents)
	}
}
