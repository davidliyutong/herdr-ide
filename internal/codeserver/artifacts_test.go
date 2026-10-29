package codeserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testManager(t *testing.T) *Manager {
	mg := New(log.New(io.Discard, "", 0))
	mg.CacheDir = t.TempDir()
	mg.Version = "9.9.9" // not pinned
	mg.Extensions = nil
	return mg
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func TestSeedDirVerifiedBySidecar(t *testing.T) {
	mg := testManager(t)
	seed := t.TempDir()
	mg.SeedDirs = []string{seed}
	mg.Offline = true
	file := TarballFile("9.9.9", "linux-amd64")
	os.WriteFile(filepath.Join(seed, file), []byte("tarball"), 0o644)
	os.WriteFile(filepath.Join(seed, file+".sha256"), []byte(sum([]byte("tarball"))+"  "+file+"\n"), 0o644)
	p, err := mg.tarball(context.Background(), "linux-amd64", nil)
	if err != nil || p != filepath.Join(seed, file) {
		t.Fatalf("p=%s err=%v", p, err)
	}
	// A tampered seed is rejected, never silently replaced.
	os.WriteFile(filepath.Join(seed, file), []byte("evil"), 0o644)
	if _, err := mg.tarball(context.Background(), "linux-amd64", nil); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("tampered seed accepted: %v", err)
	}
}

func TestOfflineMissing(t *testing.T) {
	mg := testManager(t)
	mg.Offline = true
	_, err := mg.tarball(context.Background(), "linux-arm64", nil)
	if !errors.Is(err, ErrMissingArtifact) || !strings.Contains(err.Error(), "code-server-9.9.9-linux-arm64.tar.gz") {
		t.Fatalf("err = %v", err)
	}
}

func TestPinnedChecksumRejectsMirror(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "not the real tarball")
	}))
	defer srv.Close()
	mg := testManager(t)
	mg.Version = DefaultVersion // pinned
	mg.TarballURL = srv.URL + "/{file}"
	if _, err := mg.tarball(context.Background(), "linux-amd64", nil); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("mirror content with wrong digest accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(mg.CacheDir, TarballFile(DefaultVersion, "linux-amd64"))); err == nil {
		t.Fatal("rejected download left in cache")
	}
}

func TestDownloadRecordsSidecarAndFetchAssets(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		io.WriteString(w, "content of "+r.URL.Path)
	}))
	defer srv.Close()
	mg := testManager(t)
	mg.TarballURL = srv.URL + "/cs/v{version}/{file}"
	mg.ExtensionURL = srv.URL + "/ext/{publisher}/{name}/{version}/{file}"
	mg.Extensions = []Extension{{ID: "pub.thing", Version: "1.0.0"}}
	out := t.TempDir()
	files, err := mg.FetchAssets(context.Background(), out, []string{"linux-amd64"})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || paths[0] != "/cs/v9.9.9/code-server-9.9.9-linux-amd64.tar.gz" || paths[1] != "/ext/pub/thing/1.0.0/pub.thing-1.0.0.vsix" {
		t.Fatalf("files=%v paths=%v", files, paths)
	}
	for _, f := range files {
		b, _ := os.ReadFile(filepath.Join(out, f))
		side, err := os.ReadFile(filepath.Join(out, f+".sha256"))
		if err != nil || !strings.HasPrefix(string(side), sum(b)) {
			t.Fatalf("sidecar for %s = %q %v", f, side, err)
		}
	}
	// A second resolution uses the cache (no new request).
	if _, err := mg.tarball(context.Background(), "linux-amd64", nil); err != nil || len(paths) != 2 {
		t.Fatalf("cache not used: %v %v", err, paths)
	}
}
