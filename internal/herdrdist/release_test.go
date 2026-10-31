package herdrdist

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestPlatformMappingAndVerification(t *testing.T) {
	for platform, name := range map[string]string{"linux/amd64": "herdr-linux-x86_64", "linux/arm64": "herdr-linux-aarch64", "darwin/amd64": "herdr-macos-x86_64", "darwin/arm64": "herdr-macos-aarch64"} {
		a, err := ForPlatform(platform)
		if err != nil || a.Name != name || len(a.SHA256) != 64 {
			t.Fatalf("%s: %+v %v", platform, a, err)
		}
	}
	if _, err := ForPlatform("windows/amd64"); err == nil {
		t.Fatal("unsupported platform accepted")
	}
	path := filepath.Join(t.TempDir(), "herdr")
	os.WriteFile(path, []byte("original"), 0o700)
	a := Artifact{SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte("original")))}
	if err := a.Verify(path); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte("tampered"), 0o700)
	if err := a.Verify(path); err == nil {
		t.Fatal("corrupt executable accepted")
	}
}
