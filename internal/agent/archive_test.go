package agent_test

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"herdr-ide/internal/agentproto"
)

// readZip reads every entry of a zip: regular files and symbolic links by
// content, directories as "/".
func readZip(t *testing.T, b []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		if f.Mode().IsDir() {
			out[f.Name] = "/"
			continue
		}
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		c, _ := io.ReadAll(r)
		r.Close()
		if f.Mode()&fs.ModeSymlink != 0 {
			out[f.Name] = "-> " + string(c)
		} else {
			out[f.Name] = string(c)
		}
	}
	return out
}

func TestArchive(t *testing.T) {
	s, home := dialAgent(t)
	ctx := context.Background()
	proj := filepath.Join(home, "proj")
	os.MkdirAll(filepath.Join(proj, "src", "deep"), 0o755)
	os.WriteFile(filepath.Join(proj, "a.txt"), []byte("alpha"), 0o644)
	os.WriteFile(filepath.Join(proj, "src", "run.sh"), []byte("#!/bin/sh"), 0o755)
	os.WriteFile(filepath.Join(proj, "src", "deep", "b.txt"), []byte("beta"), 0o644)
	os.Symlink("/etc", filepath.Join(proj, "src", "etc"))
	if l, err := net.Listen("unix", filepath.Join(proj, "src", "s.sock")); err == nil {
		defer l.Close()
	}
	other := filepath.Join(home, "other")
	os.MkdirAll(other, 0o755)
	os.WriteFile(filepath.Join(other, "a.txt"), []byte("second"), 0o644)
	os.Symlink(filepath.Join(proj, "src"), filepath.Join(home, "linked"))

	archive := func(paths ...string) (map[string]string, map[string]fs.FileMode) {
		t.Helper()
		conn, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpFsArchive, Paths: paths})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		b, err := io.ReadAll(conn)
		if err != nil {
			t.Fatal(err)
		}
		zr, _ := zip.NewReader(bytes.NewReader(b), int64(len(b)))
		modes := map[string]fs.FileMode{}
		for _, f := range zr.File {
			modes[f.Name] = f.Mode()
		}
		return readZip(t, b), modes
	}

	got, modes := archive(filepath.Join(proj, "src"), filepath.Join(proj, "a.txt"), "~/other/a.txt", filepath.Join(home, "linked"))
	want := map[string]string{
		"src/":              "/",
		"src/deep/":         "/",
		"src/deep/b.txt":    "beta",
		"src/etc":           "-> /etc",
		"src/run.sh":        "#!/bin/sh",
		"a.txt":             "alpha",
		"a-1.txt":           "second",
		"linked/":           "/",
		"linked/deep/":      "/",
		"linked/deep/b.txt": "beta",
		"linked/etc":        "-> /etc",
		"linked/run.sh":     "#!/bin/sh",
	}
	if len(got) != len(want) {
		var names []string
		for n := range got {
			names = append(names, n)
		}
		sort.Strings(names)
		t.Fatalf("entries = %v", names)
	}
	for n, c := range want {
		if got[n] != c {
			t.Errorf("%s = %q, want %q", n, got[n], c)
		}
	}
	if modes["src/run.sh"].Perm() != 0o755 {
		t.Errorf("mode of run.sh = %v", modes["src/run.sh"])
	}

	if _, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpFsArchive, Paths: []string{filepath.Join(home, "missing")}}); err == nil {
		t.Fatal("archive of a missing path succeeded")
	}
	if _, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpFsArchive}); err == nil {
		t.Fatal("archive without paths succeeded")
	}
}

// A reader that goes away stops the walk; the agent keeps serving.
func TestArchiveStopsWhenTheReaderLeaves(t *testing.T) {
	s, home := dialAgent(t)
	ctx := context.Background()
	big := filepath.Join(home, "big")
	os.MkdirAll(big, 0o755)
	chunk := bytes.Repeat([]byte{1, 2, 3, 4, 5, 6, 7, 8}, 1<<17) // 1 MiB, compresses poorly enough
	for i := 0; i < 8; i++ {
		os.WriteFile(filepath.Join(big, string(rune('a'+i))), chunk, 0o644)
	}
	conn, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpFsArchive, Paths: []string{big}})
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1024)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if _, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpFsStat, Path: big}); err != nil {
		t.Fatalf("agent after an abandoned archive: %v", err)
	}
}
