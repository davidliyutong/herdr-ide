package agent

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
)

func writeExec(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho v1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// An installed code-server is found by path, "~/" path or search.
func TestCodeServerExistingBin(t *testing.T) {
	a := testAgent(t)
	c := &codeServer{a: a}
	t.Setenv("PATH", t.TempDir()) // no code-server on PATH
	if _, err := c.binFor(agentproto.Header{Version: "1", Bin: "auto"}); err == nil {
		t.Fatal("found a code-server in an empty home")
	}
	local := filepath.Join(a.home, ".local", "bin", "code-server")
	writeExec(t, local)
	for _, spec := range []string{"auto", "~/.local/bin/code-server", local} {
		got, err := c.binFor(agentproto.Header{Version: "1", Bin: spec})
		if err != nil || got != local {
			t.Errorf("binFor(%q) = %q, %v", spec, got, err)
		}
	}
	for _, spec := range []string{"relative/code-server", filepath.Join(a.home, "missing")} {
		if _, err := c.binFor(agentproto.Header{Version: "1", Bin: spec}); err == nil {
			t.Errorf("binFor(%q) accepted", spec)
		}
	}
	st := c.status(agentproto.Header{Version: "1", Bin: "auto"})
	if !st.Installed || st.Bin != local {
		t.Errorf("status = %+v", st)
	}
	// Without Bin, only the release in the agent's directory counts.
	if st := c.status(agentproto.Header{Version: "1"}); st.Installed {
		t.Errorf("release reported installed: %+v", st)
	}
}

func releaseTarball(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for _, name := range []string{"code-server-1-linux-amd64/bin/code-server", "code-server-1-linux-amd64/lib/node"} {
		body := []byte("#!/bin/sh\necho v1\n")
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
		tw.Write(body)
	}
	tw.Close()
	zw.Close()
	return buf.Bytes()
}

// A release downloaded by the machine is verified before it is installed.
func TestCodeServerDownload(t *testing.T) {
	if _, err := exec.LookPath("curl"); err != nil {
		if _, err := exec.LookPath("wget"); err != nil {
			t.Skip("neither curl nor wget installed")
		}
	}
	tarball := releaseTarball(t)
	sum := sha256.Sum256(tarball)
	digest := hex.EncodeToString(sum[:])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(tarball) }))
	defer srv.Close()

	a := testAgent(t)
	c := &codeServer{a: a}
	ctx := context.Background()
	h := agentproto.Header{Version: "1", URL: srv.URL + "/code-server.tar.gz", Digest: strings.Repeat("0", 64)}
	if _, err := c.download(ctx, h); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("mismatching digest: %v", err)
	}
	if c.status(h).Installed {
		t.Fatal("installed despite digest mismatch")
	}
	// Unknown digest: installed, digest reported for the core to record.
	h.Digest = ""
	got, err := c.download(ctx, h)
	if err != nil || got != digest {
		t.Fatalf("download = %q, %v (want %s)", got, err, digest)
	}
	if !c.status(h).Installed {
		t.Fatal("not installed")
	}
	if ents, _ := filepath.Glob(filepath.Join(c.root(), ".download-*")); len(ents) > 0 {
		t.Errorf("temporary files left: %v", ents)
	}
	for _, bad := range []string{"file:///etc/passwd", "ftp://x/y", "notaurl"} {
		if _, err := c.download(ctx, agentproto.Header{Version: "1", URL: bad}); err == nil {
			t.Errorf("URL %q accepted", bad)
		}
	}
}

// TestHelperBrokenCodeServer is not a test of its own: started by other tests
// as a subprocess, it listens on AGENT_TEST_SOCKET like a code-server whose
// installation was moved away (alive, but every page is 404).
func TestHelperBrokenCodeServer(t *testing.T) {
	path := os.Getenv("AGENT_TEST_SOCKET")
	if path == "" {
		t.Skip("helper process")
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		os.Exit(1)
	}
	http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.Write([]byte(`{"status":"alive"}`))
			return
		}
		http.NotFound(w, r)
	}))
}

// shortTempDir is a temporary directory with a short path: t.TempDir()
// includes the test name, which can exceed the unix socket path limit.
func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "cs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// startBrokenCodeServer runs the helper on path in its own process group and
// returns a channel closed when it exits.
func startBrokenCodeServer(t *testing.T, path string) <-chan struct{} {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperBrokenCodeServer$")
	cmd.Env = append(os.Environ(), "AGENT_TEST_SOCKET="+path)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill() })
	done := make(chan struct{})
	go func() { cmd.Wait(); close(done) }()
	for i := 0; ; i++ {
		if c, err := net.Dial("unix", path); err == nil {
			c.Close()
			return done
		}
		if i > 100 {
			t.Fatal("helper did not listen")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A process on the socket that does not serve VS Code is replaced, even
// without a pid file (found through the socket's peer).
func TestCodeServerReplacesBrokenListener(t *testing.T) {
	a := testAgent(t)
	a.runDir = shortTempDir(t)
	c := &codeServer{a: a}
	done := startBrokenCodeServer(t, c.socket())
	if !c.alive() || c.serves() {
		t.Fatalf("alive=%v serves=%v, want alive and not serving", c.alive(), c.serves())
	}
	c.replace()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("broken code-server still running")
	}
	if _, err := os.Stat(c.socket()); !os.IsNotExist(err) {
		t.Errorf("socket left behind: %v", err)
	}

	// A working one is left alone.
	ln, err := net.Listen("unix", c.socket())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("workbench")) }))
	if !c.serves() {
		t.Error("working code-server not recognized")
	}
}

// Migrating a data directory first stops the code-server still running from
// it, which would otherwise answer on the moved socket without its files.
func TestMigrationStopsLegacyCodeServer(t *testing.T) {
	defer brandLegacy(".old")()
	home := shortTempDir(t)
	run := filepath.Join(home, ".old", "run")
	os.MkdirAll(run, 0o700)
	done := startBrokenCodeServer(t, filepath.Join(run, "cs.sock"))
	a := testAgent(t)
	migrateLegacyDataDir(home, filepath.Join(home, ".new"), a.logger)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("legacy code-server still running")
	}
	if _, err := os.Stat(filepath.Join(home, ".new", "run")); err != nil {
		t.Errorf("not migrated: %v", err)
	}
}
