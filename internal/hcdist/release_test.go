package hcdist

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type member struct {
	name string
	kind byte
	body string
	link string
}

// archive writes a tar.gz of members and returns its path and an Artifact
// pinned to it.
func archive(t *testing.T, members ...member) (string, Artifact) {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for _, m := range members {
		h := &tar.Header{Name: m.name, Typeflag: m.kind, Mode: 0o755, Size: int64(len(m.body)), Linkname: m.link}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(m.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "a.tar.gz")
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buf.Bytes())
	return path, Artifact{Name: "a.tar.gz", SHA256: hex.EncodeToString(sum[:])}
}

func TestPlatformMappingAndVerification(t *testing.T) {
	for platform, name := range map[string]string{
		"linux/amd64":  "herdr-core-linux-x86_64.tar.gz",
		"linux/arm64":  "herdr-core-linux-aarch64.tar.gz",
		"darwin/amd64": "herdr-core-macos-x86_64.tar.gz",
		"darwin/arm64": "herdr-core-macos-aarch64.tar.gz",
	} {
		a, err := ForPlatform(platform)
		if err != nil || a.Name != name || len(a.SHA256) != 64 {
			t.Fatalf("%s: %+v %v", platform, a, err)
		}
		if want := "https://releases.herdr.dev/core/" + Version + "/" + name; a.URL() != want {
			t.Fatalf("%s: URL %s, want %s", platform, a.URL(), want)
		}
	}
	if _, err := ForPlatform("windows/amd64"); err == nil {
		t.Fatal("unsupported platform accepted")
	}
	path, a := archive(t, member{name: Executable, kind: tar.TypeReg, body: "bin"})
	if err := a.Verify(path); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte("tampered"), 0o600)
	if err := a.Verify(path); err == nil {
		t.Fatal("corrupt archive accepted")
	}
	if _, err := a.Extract(path, Executable, MaxExecutable); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("corrupt archive unpacked: %v", err)
	}
}

func TestExtract(t *testing.T) {
	// The layout of a macOS release: the application bundle has a second
	// executable of the same base name, which is not the member at the root.
	path, a := archive(t,
		member{name: "Herdr Core.app/", kind: tar.TypeDir},
		member{name: "Herdr Core.app/Contents/MacOS/herdr-core", kind: tar.TypeReg, body: "bundle"},
		member{name: "./herdr-core", kind: tar.TypeReg, body: "executable"},
		member{name: License, kind: tar.TypeReg, body: "license"},
		member{name: Notices, kind: tar.TypeReg, body: "notices"},
	)
	for name, want := range map[string]string{Executable: "executable", License: "license", Notices: "notices"} {
		got, err := a.Extract(path, name, 64)
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v", name, got, err)
		}
	}
	if _, err := a.Extract(path, Executable, 9); err == nil || !strings.Contains(err.Error(), "larger") {
		t.Fatalf("oversized member accepted: %v", err)
	}

	for name, tc := range map[string]struct {
		members []member
		want    string
	}{
		"symlink":   {[]member{{name: Executable, kind: tar.TypeSymlink, link: "/bin/sh"}}, "not a regular file"},
		"hardlink":  {[]member{{name: License, kind: tar.TypeReg, body: "x"}, {name: Executable, kind: tar.TypeLink, link: License}}, "not a regular file"},
		"directory": {[]member{{name: Executable + "/", kind: tar.TypeDir}}, "not a regular file"},
		"twice":     {[]member{{name: Executable, kind: tar.TypeReg, body: "a"}, {name: Executable, kind: tar.TypeReg, body: "b"}}, "more than one"},
		"link then file": {[]member{{name: Executable, kind: tar.TypeSymlink, link: "x"}, {name: Executable, kind: tar.TypeReg, body: "b"}},
			"not a regular file"},
		"missing": {[]member{{name: "bin/" + Executable, kind: tar.TypeReg, body: "a"}}, "no " + Executable},
		"empty":   {[]member{{name: Executable, kind: tar.TypeReg}}, "empty"},
	} {
		path, a := archive(t, tc.members...)
		if got, err := a.Extract(path, Executable, MaxExecutable); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: %q, %v", name, got, err)
		}
	}

	path, a = archive(t, member{name: Executable, kind: tar.TypeReg, body: "bin"})
	data, _ := os.ReadFile(path)
	cut := filepath.Join(t.TempDir(), "cut.tar.gz")
	os.WriteFile(cut, data[:len(data)/2], 0o600)
	sum := sha256.Sum256(data[:len(data)/2])
	if _, err := (Artifact{Name: "cut", SHA256: hex.EncodeToString(sum[:])}).Extract(cut, Executable, MaxExecutable); err == nil {
		t.Fatal("truncated archive accepted")
	}
}
