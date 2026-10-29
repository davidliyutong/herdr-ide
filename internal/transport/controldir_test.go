package transport

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckPrivateDir(t *testing.T) {
	d := filepath.Join(t.TempDir(), "s")
	os.Mkdir(d, 0o700)
	if err := checkPrivateDir(d); err != nil {
		t.Fatalf("private dir rejected: %v", err)
	}
	os.Chmod(d, 0o777)
	if err := checkPrivateDir(d); err == nil {
		t.Fatal("world-writable dir accepted")
	}
	link := filepath.Join(t.TempDir(), "link")
	os.Symlink(d, link)
	if err := checkPrivateDir(link); err == nil {
		t.Fatal("symlink accepted")
	}
}
