package usage

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"veldr/internal/plugin"
	"veldr/internal/settings"
	"veldr/internal/store"
)

// legacyHistory is a history file as the core wrote it before the
// history moved into the core's database.
const legacyHistory = `{"version":1,"windows":{"claude:acc-1":{"weekly|":[[1799996400,10],[1800000000,15]]}},` +
	`"accounts":[{"provider":"claude","id":"acc-1","status":"ok","windows":[{"kind":"weekly","usedPct":15,"resetsAt":1800259200,"windowSec":604800,"id":""}],` +
	`"key":"claude:acc-1","machines":["local"],"fetchedAt":1800000000,"seenAt":1800000000}],` +
	`"alerts":{"claude:acc-1|weekly||604800|80":{"end":1800259200}}}`

// historyPlugin is a plugin of the core whose settings file is in dir, at
// now.
func historyPlugin(t *testing.T, dir string, now time.Time) *Plugin {
	t.Helper()
	p := New()
	p.host = &fakeHost{st: settings.New(filepath.Join(dir, "settings-dev.json"), Settings)}
	p.now = func() time.Time { return now }
	return p
}

// historyRowsIn counts the history's rows in the core's database in dir.
func historyRowsIn(t *testing.T, dir string) (windows, accounts, alerts int) {
	t.Helper()
	db, err := store.OpenShared(plugin.CoreDBFile(filepath.Join(dir, "settings-dev.json")))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.QueryRow("SELECT count(*) FROM usage_windows").Scan(&windows)
	db.QueryRow("SELECT count(*) FROM usage_accounts").Scan(&accounts)
	db.QueryRow("SELECT count(*) FROM usage_alerts").Scan(&alerts)
	return windows, accounts, alerts
}

// The history file kept before is imported once into the core's database
// and removed: the accounts, their points and the alerts fired are there
// after the restart, and a file left again is not imported again.
func TestHistoryImport(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_800_000_000, 0)
	p := historyPlugin(t, dir, now)
	path := p.historyPath()
	if err := os.WriteFile(path, []byte(legacyHistory), 0o600); err != nil {
		t.Fatal(err)
	}
	p.loadHistory(path)
	if _, err := os.Lstat(path); err == nil {
		t.Fatal("the file stayed")
	}
	check := func(p *Plugin) {
		t.Helper()
		s := p.Snapshot()
		if len(s.Accounts) != 1 || s.Accounts[0].Key != "claude:acc-1" || len(s.Accounts[0].Windows) != 1 {
			t.Fatalf("accounts %+v", s.Accounts)
		}
		if pts := p.history.Windows["claude:acc-1"]["weekly|"]; len(pts) != 2 || pts[1] != [2]float64{1800000000, 15} {
			t.Errorf("points %v", pts)
		}
		if r, ok := p.history.Alerts["claude:acc-1|weekly||604800|80"]; !ok || r.End != 1800259200 {
			t.Errorf("alerts %v", p.history.Alerts)
		}
	}
	check(p)
	if w, a, al := historyRowsIn(t, dir); w != 1 || a != 1 || al != 1 {
		t.Fatalf("rows %d %d %d", w, a, al)
	}
	// Again, with a file left again: read from the database alone.
	os.WriteFile(path, []byte(`{"version":1,"windows":{"x:y":{"weekly|":[[1800000000,99]]}}}`), 0o600)
	q := historyPlugin(t, dir, now)
	q.loadHistory(path)
	check(q)
	if _, ok := q.history.Windows["x:y"]; ok {
		t.Error("imported again")
	}
	if _, err := os.Lstat(path); err == nil {
		t.Error("the file left again stayed")
	}
}

// A file of another version, or that does not parse, is not this
// version's to import: nothing is imported, the file stays and the import
// is not recorded (a valid file there later is imported).
func TestHistoryImportOtherVersion(t *testing.T) {
	for _, content := range []string{`{"version":2,"windows":{"claude:acc-1":{"weekly|":[[1800000000,15]]}}}`, `{"version":1,"windows":`} {
		dir := t.TempDir()
		p := historyPlugin(t, dir, time.Unix(1_800_000_000, 0))
		path := p.historyPath()
		os.WriteFile(path, []byte(content), 0o600)
		p.loadHistory(path)
		if len(p.history.Windows) != 0 || len(p.Snapshot().Accounts) != 0 {
			t.Errorf("imported %+v", p.history.Windows)
		}
		if b, err := os.ReadFile(path); err != nil || string(b) != content {
			t.Fatalf("the file went or changed: %q %v", b, err)
		}
		os.WriteFile(path, []byte(legacyHistory), 0o600)
		q := historyPlugin(t, dir, time.Unix(1_800_000_000, 0))
		q.loadHistory(path)
		if len(q.Snapshot().Accounts) != 1 {
			t.Errorf("a valid file afterwards was not imported")
		}
	}
}

// A save before the history was read back (the read failed) does not
// remove what it did not read: it reads it first, and writes nothing while
// it cannot; once read, what was recorded meanwhile joins it.
func TestHistorySaveAfterAFailedRead(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_800_000_000, 0)
	p := historyPlugin(t, dir, now)
	path := p.historyPath()
	os.WriteFile(path, []byte(legacyHistory), 0o600)
	p.loadHistory(path)
	dbFile := plugin.CoreDBFile(filepath.Join(dir, "settings-dev.json"))
	// The database cannot be opened: a directory takes its name.
	if err := os.Rename(dbFile, dbFile+".away"); err != nil {
		t.Fatal(err)
	}
	os.Remove(dbFile + "-wal")
	os.Remove(dbFile + "-shm")
	if err := os.Mkdir(dbFile, 0o700); err != nil {
		t.Fatal(err)
	}
	q := historyPlugin(t, dir, now)
	q.loadHistory(path)
	q.mu.Lock()
	q.history.Windows["claude:acc-2"] = map[string][][2]float64{"session|": {{1800000100, 5}}}
	q.mu.Unlock()
	q.save() // cannot read: writes nothing
	os.Remove(dbFile)
	if err := os.Rename(dbFile+".away", dbFile); err != nil {
		t.Fatal(err)
	}
	if w, a, al := historyRowsIn(t, dir); w != 1 || a != 1 || al != 1 {
		t.Fatalf("rows while unread %d %d %d", w, a, al)
	}
	q.save()
	if w, a, al := historyRowsIn(t, dir); w != 2 || a != 1 || al != 1 {
		t.Fatalf("rows %d %d %d", w, a, al)
	}
	if pts := q.history.Windows["claude:acc-1"]["weekly|"]; len(pts) != 2 || len(q.Snapshot().Accounts) != 1 {
		t.Errorf("read back into memory: %v, %d accounts", pts, len(q.Snapshot().Accounts))
	}
}

// What memory recorded before the read joins what was kept: a window's
// earlier points come first, alerts fired meanwhile stay.
func TestHistoryMerge(t *testing.T) {
	h := newHistory()
	h.Windows["a"] = map[string][][2]float64{"w": {{30, 3}, {40, 4}}}
	h.Alerts = map[string]alertRecord{"k1": {End: 9}}
	s := newHistory()
	s.Windows["a"] = map[string][][2]float64{"w": {{10, 1}, {20, 2}, {30, 2}}, "v": {{5, 1}}}
	s.Windows["b"] = map[string][][2]float64{"w": {{1, 1}}}
	s.Alerts = map[string]alertRecord{"k1": {End: 1}, "k2": {End: 2}}
	h.merge(s)
	if got := h.Windows["a"]["w"]; len(got) != 4 || got[0][0] != 10 || got[2] != [2]float64{30, 3} {
		t.Errorf("points %v", got)
	}
	if len(h.Windows["a"]["v"]) != 1 || len(h.Windows["b"]["w"]) != 1 {
		t.Errorf("windows %v", h.Windows)
	}
	if h.Alerts["k1"].End != 9 || h.Alerts["k2"].End != 2 {
		t.Errorf("alerts %v", h.Alerts)
	}
}

// A save writes what changed and removes what memory no longer has.
func TestHistorySaveRemovesGone(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_800_000_000, 0)
	p := historyPlugin(t, dir, now)
	path := p.historyPath()
	os.WriteFile(path, []byte(legacyHistory), 0o600)
	p.loadHistory(path)
	p.mu.Lock()
	p.history.Windows["claude:acc-2"] = map[string][][2]float64{"session|": {{1800000000, 5}}}
	clear(p.accounts)
	clear(p.history.Alerts)
	p.mu.Unlock()
	p.save()
	if w, a, al := historyRowsIn(t, dir); w != 2 || a != 0 || al != 0 {
		t.Fatalf("rows %d %d %d", w, a, al)
	}
	q := historyPlugin(t, dir, now)
	q.loadHistory(path)
	if pts := q.history.Windows["claude:acc-2"]["session|"]; len(pts) != 1 || pts[0][1] != 5 {
		t.Errorf("read back %v", q.history.Windows)
	}
	// Without a settings file nothing is kept.
	m := New()
	m.host = &fakeHost{}
	m.save()
	m.loadHistory("")
}

// Tables of a newer version are read, not written.
func TestHistoryNewerVersion(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_800_000_000, 0)
	p := historyPlugin(t, dir, now)
	path := p.historyPath()
	os.WriteFile(path, []byte(legacyHistory), 0o600)
	p.loadHistory(path)
	db, err := store.OpenShared(plugin.CoreDBFile(filepath.Join(dir, "settings-dev.json")))
	if err != nil {
		t.Fatal(err)
	}
	db.Exec("UPDATE store_features SET version = version + 1 WHERE feature = ?", historyFeature)
	db.Close()
	q := historyPlugin(t, dir, now)
	q.loadHistory(path)
	if len(q.Snapshot().Accounts) != 1 {
		t.Fatal("not read")
	}
	q.mu.Lock()
	clear(q.accounts)
	q.mu.Unlock()
	q.save()
	if _, a, _ := historyRowsIn(t, dir); a != 1 {
		t.Errorf("written: %d accounts", a)
	}
}
