package server

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/machines"
)

func TestDownloadPaths(t *testing.T) {
	got, err := downloadPaths([]string{"/a/b/../c", "/a/c", "/x/"})
	if err != nil || strings.Join(got, ",") != "/a/c,/x" {
		t.Fatalf("paths = %v %v", got, err)
	}
	for _, bad := range [][]string{nil, {"relative"}, {"~/x"}, {"/a\x00b"}, make([]string, maxDownloadPaths+1)} {
		if _, err := downloadPaths(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	for _, c := range []struct {
		paths []string
		want  string
	}{
		{[]string{"/home/u/proj"}, "proj.zip"},
		{[]string{"/home/u/proj/a", "/home/u/proj/b/c"}, "proj.zip"},
		{[]string{"/home/u/proj/a", "/home/u/projx/b"}, "u.zip"},
		{[]string{"/a", "/b"}, "download.zip"},
		{[]string{"/"}, "download.zip"},
	} {
		if got := archiveName(c.paths); got != c.want {
			t.Errorf("archiveName(%v) = %q, want %q", c.paths, got, c.want)
		}
	}
}

// Through a real agent: one file comes as itself, a directory or several
// paths as a zip, both as attachments that cannot run script.
func TestDownload(t *testing.T) {
	mg, _, logger := agentMachine(t)
	var audit strings.Builder
	srv := httptest.NewServer(New(mg, Options{Logger: logger, Audit: &audit, ReadOnly: true}).Handler())
	defer srv.Close()
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "proj", "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "proj", "a.txt"), []byte("alpha"), 0o644)
	os.WriteFile(filepath.Join(dir, "proj", "sub", "b.txt"), []byte("beta"), 0o644)
	os.WriteFile(filepath.Join(dir, "notes é.md"), []byte("# notes"), 0o644)
	get := func(paths ...string) (*http.Response, []byte) {
		t.Helper()
		res, err := http.Get(srv.URL + "/api/m/x/download?" + url.Values{"path": paths}.Encode())
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, b
	}
	entries := func(b []byte) []string {
		t.Helper()
		zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
		if err != nil {
			t.Fatalf("zip: %v", err)
		}
		var out []string
		for _, f := range zr.File {
			out = append(out, f.Name)
		}
		sort.Strings(out)
		return out
	}

	// Read-only mode downloads, like it shows files.
	res, b := get(filepath.Join(dir, "notes é.md"))
	if res.StatusCode != 200 || string(b) != "# notes" || res.Header.Get("Content-Disposition") != `attachment; filename*=utf-8''notes%20%C3%A9.md` {
		t.Fatalf("file: %d %q %q", res.StatusCode, b, res.Header.Get("Content-Disposition"))
	}

	res, b = get(filepath.Join(dir, "proj"))
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/zip" ||
		res.Header.Get("Content-Disposition") != `attachment; filename=proj.zip` ||
		!strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") || res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("directory: %d %v", res.StatusCode, res.Header)
	}
	if got := strings.Join(entries(b), ","); got != "proj/,proj/a.txt,proj/sub/,proj/sub/b.txt" {
		t.Fatalf("directory entries = %s", got)
	}

	res, b = get(filepath.Join(dir, "proj", "a.txt"), filepath.Join(dir, "proj", "sub"))
	if res.Header.Get("Content-Disposition") != `attachment; filename=proj.zip` {
		t.Fatalf("several: %v", res.Header)
	}
	if got := strings.Join(entries(b), ","); got != "a.txt,sub/,sub/b.txt" {
		t.Fatalf("several entries = %s", got)
	}

	if res, _ := get(filepath.Join(dir, "missing")); res.StatusCode != 404 {
		t.Fatalf("missing file: %d", res.StatusCode)
	}
	if res, _ := get(filepath.Join(dir, "proj"), filepath.Join(dir, "missing")); res.StatusCode != 404 {
		t.Fatalf("missing path in an archive: %d", res.StatusCode)
	}
	if res, _ := get("relative/path"); res.StatusCode != 400 {
		t.Fatalf("relative path: %d", res.StatusCode)
	}
	// The page checks a path found in a pane before downloading it.
	head := func(p string) int {
		res, err := http.Head(srv.URL + "/api/m/x/download?" + url.Values{"path": {p}}.Encode())
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if head(filepath.Join(dir, "proj")) != 200 || head(filepath.Join(dir, "proj", "a.txt")) != 200 || head(filepath.Join(dir, "nope")) != 404 {
		t.Fatal("HEAD")
	}
	if !strings.Contains(audit.String(), `"event":"file.download"`) {
		t.Fatalf("no audit record: %s", audit.String())
	}
}

// Files chosen in VS Code's explorer reach the browsers as bridge.download.
func TestBridgeDownload(t *testing.T) {
	s := newTestServer()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &wsClient{s: s, ctx: ctx, cancel: cancel, send: make(chan outMsg, 8)}
	s.clients[c] = true
	mc := machines.NewManager([]machines.Spec{{ID: "m", Label: "m", Kind: machines.KindSSH}}, nil, log.New(io.Discard, "", 0)).Get("m")
	a, b := net.Pipe()
	go s.bridge.serve(mc, a)
	r := bufio.NewReader(b)
	if _, err := r.ReadString('\n'); err != nil { // the bridge's reply
		t.Fatal(err)
	}
	b.Write([]byte(`{"type":"download","paths":[]}` + "\n"))
	b.Write([]byte(`{"type":"download","paths":["/srv/a","/srv/b"]}` + "\n"))
	select {
	case m := <-c.send:
		if string(m.data) != `{"m":"m","paths":["/srv/a","/srv/b"],"t":"bridge.download"}` {
			t.Fatalf("got %s", m.data)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no bridge.download")
	}
	b.Close()
}
