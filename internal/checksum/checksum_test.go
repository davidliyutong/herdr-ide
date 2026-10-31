package checksum

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileAndVerify(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f")
	os.WriteFile(path, []byte("abc"), 0o600)
	const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got, err := File(path); err != nil || got != abc {
		t.Fatalf("File = %q, %v", got, err)
	}
	if err := Verify(path, abc); err != nil {
		t.Fatal(err)
	}
	if err := Verify(path, strings.Repeat("0", 64)); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("mismatch accepted: %v", err)
	}
	if err := Verify(filepath.Join(t.TempDir(), "missing"), abc); err == nil {
		t.Fatal("missing file accepted")
	}
}
