package usage

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"veldr/internal/plugin"
	"veldr/internal/settings"
	"veldr/internal/store"
)

// seedJSON is a history (accounts, their points and the alerts fired) the
// tests start from (seedHistory).
const seedJSON = `{"version":1,"windows":{"claude:acc-1":{"weekly|":[[1799996400,10],[1800000000,15]]}},` +
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

// seedHistory writes seedJSON into the core's database of p.
func seedHistory(t *testing.T, p *Plugin) {
	t.Helper()
	h := newHistory()
	if err := json.Unmarshal([]byte(seedJSON), h); err != nil {
		t.Fatal(err)
	}
	rows, err := h.rows()
	if err != nil {
		t.Fatal(err)
	}
	db, _, err := p.openHistoryDB()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Update(context.Background(), func(tx *sql.Tx) error { return writeHistory(tx, rows) }); err != nil {
		t.Fatal(err)
	}
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

// A save before the history was read back (the read failed) does not
// remove what it did not read: it reads it first, and writes nothing while
// it cannot; once read, what was recorded meanwhile joins it.
func TestHistorySaveAfterAFailedRead(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_800_000_000, 0)
	p := historyPlugin(t, dir, now)
	seedHistory(t, p)
	p.loadHistory()
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
	q.loadHistory()
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
	seedHistory(t, p)
	p.loadHistory()
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
	q.loadHistory()
	if pts := q.history.Windows["claude:acc-2"]["session|"]; len(pts) != 1 || pts[0][1] != 5 {
		t.Errorf("read back %v", q.history.Windows)
	}
	// Without a settings file nothing is kept.
	m := New()
	m.host = &fakeHost{}
	m.save()
	m.loadHistory()
}

// Tables of a newer version are read, not written.
func TestHistoryNewerVersion(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(1_800_000_000, 0)
	p := historyPlugin(t, dir, now)
	seedHistory(t, p)
	p.loadHistory()
	db, err := store.OpenShared(plugin.CoreDBFile(filepath.Join(dir, "settings-dev.json")))
	if err != nil {
		t.Fatal(err)
	}
	db.Exec("UPDATE store_features SET version = version + 1 WHERE feature = ?", historyFeature)
	db.Close()
	q := historyPlugin(t, dir, now)
	q.loadHistory()
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
