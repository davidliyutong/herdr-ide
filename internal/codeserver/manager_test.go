package codeserver

import (
	"io"
	"log"
	"path/filepath"
	"testing"

	"herdr-ide/internal/settings"
)

func TestInstallMode(t *testing.T) {
	mg := New(log.New(io.Discard, "", 0))
	if mode, bin := mg.install(); mode != InstallPush || bin != "" {
		t.Errorf("no settings: %s %q", mode, bin)
	}
	mg.Settings = settings.New("", SettingDefs...)
	mg.Settings.Set(SettingInstall, InstallExisting)
	if mode, bin := mg.install(); mode != InstallExisting || bin != "auto" {
		t.Errorf("existing: %s %q", mode, bin)
	}
	mg.Settings.Set(SettingPath, "~/bin/code-server")
	if _, bin := mg.install(); bin != "~/bin/code-server" {
		t.Errorf("existing with path: %q", bin)
	}
	if err := mg.Settings.Set(SettingPath, "bin/code-server"); err == nil {
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
