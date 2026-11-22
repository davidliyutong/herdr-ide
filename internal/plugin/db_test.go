package plugin

import (
	"io"
	"log"
	"net/http"
	"path/filepath"
	"testing"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
)

type settingsHost struct{ st *settings.Store }

func (h settingsHost) Machines() *machines.Manager                 { return nil }
func (h settingsHost) Broadcast(string, string, any)               {}
func (h settingsHost) Audit(*http.Request, string, map[string]any) {}
func (h settingsHost) ReadOnly() bool                              { return false }
func (h settingsHost) Settings() *settings.Store                   { return h.st }
func (h settingsHost) Logger() *log.Logger                         { return log.New(io.Discard, "", 0) }

// The core's database is beside the settings file, per instance; a core
// without settings keeps none.
func TestCoreDB(t *testing.T) {
	dir := t.TempDir()
	for in, want := range map[string]string{
		filepath.Join(dir, "settings.json"):     filepath.Join(dir, "core.db"),
		filepath.Join(dir, "settings-dev.json"): filepath.Join(dir, "core-dev.db"),
		"":                                      "",
	} {
		if got := CoreDBFile(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	if db, err := OpenDB(settingsHost{}); db != nil || err != nil {
		t.Errorf("without settings: %v %v", db, err)
	}
	if db, err := OpenDB(settingsHost{settings.New("")}); db != nil || err != nil {
		t.Errorf("without a settings file: %v %v", db, err)
	}
	h := settingsHost{settings.New(filepath.Join(dir, "settings-dev.json"))}
	a, err := OpenDB(h)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := OpenDB(h)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if a.DB != b.DB {
		t.Error("two pools of the core's database")
	}
}
