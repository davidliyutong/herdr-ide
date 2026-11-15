package userfile

import (
	"os"
	"path/filepath"
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
