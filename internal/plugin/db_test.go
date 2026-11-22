package plugin

import (
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/store"
)

type settingsHost struct{ st *settings.Store }

func (h settingsHost) Machines() *machines.Manager                 { return nil }
func (h settingsHost) Broadcast(string, string, any)               {}
func (h settingsHost) Audit(*http.Request, string, map[string]any) {}
func (h settingsHost) ReadOnly() bool                              { return false }
func (h settingsHost) Settings() *settings.Store                   { return h.st }
func (h settingsHost) Logger() *log.Logger                         { return log.New(io.Discard, "", 0) }

// The core's database is beside the settings file, per instance and per
// host (store.HostFile); a core without settings keeps none.
func TestCoreDB(t *testing.T) {
	dir := t.TempDir()
	for in, want := range map[string]string{
		filepath.Join(dir, "settings.json"):     store.HostFile(dir, "core.db"),
		filepath.Join(dir, "settings-dev.json"): store.HostFile(dir, "core-dev.db"),
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

// A legacy core[-<instance>].db is migrated once into the per-host core
// database when opened, preserving data and removing the legacy file.
func TestCoreDBLegacyMigration(t *testing.T) {
	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings-dev.json")
	legacyPath := filepath.Join(dir, "core-dev.db")
	legacyDB, err := store.OpenShared(legacyPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacyDB.Migrate("testfeat", []string{`CREATE TABLE testfeat_items (id INTEGER PRIMARY KEY, val TEXT)`}); err != nil {
		t.Fatal(err)
	}
	if _, err := legacyDB.Exec(`INSERT INTO testfeat_items (id, val) VALUES (1, 'keep')`); err != nil {
		t.Fatal(err)
	}
	legacyDB.Close()

	db, err := OpenCoreDB(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var val string
	if err := db.QueryRow(`SELECT val FROM testfeat_items WHERE id = 1`).Scan(&val); err != nil || val != "keep" {
		t.Fatalf("migrated value = %q (%v), want keep", val, err)
	}
	if _, err := os.Lstat(legacyPath); !os.IsNotExist(err) {
		t.Errorf("legacy %s still exists after migration: %v", legacyPath, err)
	}
	if _, err := os.Lstat(CoreDBFile(settingsPath)); err != nil {
		t.Errorf("per-host core db missing: %v", err)
	}
}
