package codeserver

import (
	"io"
	"log"
	"path/filepath"
	"testing"

	"veldr/internal/settings"
)

func TestInstallMode(t *testing.T) {
	mg := New(log.New(io.Discard, "", 0))
	if mode, bin := mg.install("m1"); mode != InstallPush || bin != "" {
		t.Errorf("no settings: %s %q", mode, bin)
	}
	mg.Settings = settings.New("", Settings)
	mg.Settings.Set(SettingInstall, "", InstallExisting)
	if mode, bin := mg.install("m1"); mode != InstallExisting || bin != "auto" {
		t.Errorf("existing: %s %q", mode, bin)
	}
	mg.Settings.Set(SettingPath, "", "~/bin/code-server")
	if _, bin := mg.install("m1"); bin != "~/bin/code-server" {
		t.Errorf("existing with path: %q", bin)
	}
	// A machine's own values win over the global ones.
	mg.Settings.Set(SettingInstall, "m2", InstallDownload)
	mg.Settings.Set(SettingPath, "m1", "/opt/cs/bin/code-server")
	if mode, bin := mg.install("m2"); mode != InstallDownload || bin != "" {
		t.Errorf("m2: %s %q", mode, bin)
	}
	if mode, bin := mg.install("m1"); mode != InstallExisting || bin != "/opt/cs/bin/code-server" {
		t.Errorf("m1: %s %q", mode, bin)
	}
	if err := mg.Settings.Set(SettingPath, "", "bin/code-server"); err == nil {
		t.Error("relative path accepted")
	}
}

// A digest learnt from a machine's download is used for later verification.
func TestRecordDigest(t *testing.T) {
	mg := New(log.New(io.Discard, "", 0))
	mg.CacheDir = filepath.Join(t.TempDir(), "cache")
	file := TarballFile("9.9.9", "linux-amd64")
	if d := mg.knownDigest(file); d != "" {
		t.Fatalf("unknown file has digest %q", d)
	}
	mg.recordDigest(file, "abc123")
	if d := mg.knownDigest(file); d != "abc123" {
		t.Errorf("recorded digest = %q", d)
	}
	if d := mg.knownDigest(TarballFile(DefaultVersion, "linux-amd64")); d != pinned[TarballFile(DefaultVersion, "linux-amd64")] {
		t.Errorf("pinned digest = %q", d)
	}
}

// A removed machine's state is dropped, and a preparation still running
// for it changes nothing (it does not bring the state back or fail).
func TestForget(t *testing.T) {
	mg := New(log.New(io.Discard, "", 0))
	mg.state("gpu")
	mg.setStatus("gpu", func(s *Status) { s.Ready = true })
	if got := mg.Running(); len(got) != 1 {
		t.Fatalf("running %v", got)
	}
	mg.Forget("gpu")
	mg.setStatus("gpu", func(s *Status) { s.Ready = true })
	mg.mu.Lock()
	n := len(mg.states)
	mg.mu.Unlock()
	if n != 0 || len(mg.Running()) != 0 {
		t.Fatalf("kept %d states", n)
	}
}
