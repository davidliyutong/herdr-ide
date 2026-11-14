package server

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
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
	"sync/atomic"
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

// A download the page gave an id reports its progress and how it ended to
// the pages, and can be cancelled from the downloads panel.
func TestDownloadProgress(t *testing.T) {
	mg, _, logger := agentMachine(t)
	s := New(mg, Options{Logger: logger})
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &wsClient{s: s, ctx: ctx, cancel: cancel, send: make(chan outMsg, 4096)}
	s.clients[c] = true

	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "proj"), 0o755)
	os.WriteFile(filepath.Join(dir, "proj", "a.txt"), []byte("alpha"), 0o644)
	big := filepath.Join(dir, "big.bin")
	f, _ := os.Create(big)
	f.Truncate(256 << 20) // sparse: more than the connection buffers hold
	f.Close()

	type event struct {
		ID    string `json:"id"`
		State string `json:"state"`
		Sent  int64  `json:"sent"`
		Total *int64 `json:"total"`
		Name  string `json:"name"`
		Error string `json:"error"`
	}
	// events returns the events of id up to its last one.
	events := func(id string) []event {
		t.Helper()
		var out []event
		for {
			select {
			case m := <-c.send:
				var e event
				if json.Unmarshal(m.data, &e) != nil || e.ID != id {
					continue
				}
				out = append(out, e)
				if e.State != "running" {
					return out
				}
			case <-time.After(10 * time.Second):
				t.Fatalf("%s: events so far %+v", id, out)
			}
		}
	}
	get := func(id string, paths ...string) *http.Response {
		t.Helper()
		q := url.Values{"path": paths}
		if id != "" {
			q.Set("dl", id)
		}
		res, err := http.Get(srv.URL + "/api/m/x/download?" + q.Encode())
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	fetch := func(id string, paths ...string) {
		t.Helper()
		res := get(id, paths...)
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}

	// One file: its name and size, then done with every byte.
	fetch("file-0001", filepath.Join(dir, "proj", "a.txt"))
	ev := events("file-0001")
	last := ev[len(ev)-1]
	if ev[0].State != "running" || last.State != "done" || last.Sent != 5 || last.Total == nil || *last.Total != 5 || last.Name != "a.txt" {
		t.Fatalf("file: %+v", ev)
	}
	// An archive has no size in advance.
	fetch("dir-00001", filepath.Join(dir, "proj"))
	ev = events("dir-00001")
	last = ev[len(ev)-1]
	if last.State != "done" || last.Total != nil || last.Name != "proj.zip" || last.Sent == 0 {
		t.Fatalf("archive: %+v", ev)
	}
	// Failures carry a code the page translates.
	fetch("missing01", filepath.Join(dir, "missing"))
	if last := events("missing01"); last[len(last)-1].State != "failed" || last[len(last)-1].Error != "not_found" {
		t.Fatalf("missing: %+v", last)
	}
	fetch("invalid01", "relative")
	if last := events("invalid01"); last[len(last)-1].State != "failed" || last[len(last)-1].Error != "invalid" {
		t.Fatalf("invalid: %+v", last)
	}

	// Cancelled from the panel while the browser keeps reading: the
	// download breaks off, without the rest of the file.
	res := get("cancel-01", big)
	read := make(chan error, 1)
	var got atomic.Int64
	go func() {
		buf := make([]byte, 64<<10)
		for {
			n, err := res.Body.Read(buf)
			got.Add(int64(n))
			if err != nil {
				read <- err
				return
			}
			time.Sleep(time.Millisecond) // a slower reader than the agent
		}
	}()
	for got.Load() < 1<<20 {
		time.Sleep(10 * time.Millisecond)
	}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/downloads/cancel-01/cancel", nil)
	if r, err := http.DefaultClient.Do(req); err != nil || r.StatusCode != http.StatusNoContent {
		t.Fatalf("cancel: %v %v", r, err)
	}
	select {
	case err := <-read:
		if err == io.EOF || got.Load() >= res.ContentLength {
			t.Fatalf("a cancelled download ended like a complete one (%d of %d bytes)", got.Load(), res.ContentLength)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("the download went on after cancelling (%d of %d bytes)", got.Load(), res.ContentLength)
	}
	res.Body.Close()
	if ev := events("cancel-01"); ev[len(ev)-1].State != "cancelled" {
		t.Fatalf("cancelled: %+v", ev[len(ev)-1])
	}
	if r, err := http.DefaultClient.Do(req); err != nil || r.StatusCode != http.StatusNotFound {
		t.Fatalf("cancel of a finished download: %v %v", r, err)
	}

	// Cancelled in the browser.
	res = get("browser-1", big)
	io.ReadFull(res.Body, make([]byte, 1<<20))
	res.Body.Close()
	if ev := events("browser-1"); ev[len(ev)-1].State != "cancelled" {
		t.Fatalf("closed by the browser: %+v", ev[len(ev)-1])
	}

	// Without an id, with a malformed one, or a HEAD check: no events.
	fetch("", filepath.Join(dir, "proj", "a.txt"))
	fetch("bad id!", filepath.Join(dir, "proj", "a.txt"))
	h, _ := http.Head(srv.URL + "/api/m/x/download?" + url.Values{"path": {filepath.Join(dir, "proj")}, "dl": {"head-0001"}}.Encode())
	h.Body.Close()
	select {
	case m := <-c.send:
		if strings.Contains(string(m.data), `"t":"download"`) {
			t.Fatalf("untracked download reported: %s", m.data)
		}
	case <-time.After(200 * time.Millisecond):
	}
	if n := len(s.downloads.running); n != 0 {
		t.Fatalf("%d downloads still followed", n)
	}
}
