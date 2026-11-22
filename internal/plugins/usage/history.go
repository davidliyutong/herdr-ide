package usage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"

	"herdr-ide/internal/plugin"
	"herdr-ide/internal/store"
	"herdr-ide/internal/usage"
	"herdr-ide/internal/userfile"
)

const (
	// historyKeep is how long the history keeps a point.
	historyKeep = 30 * 24 * time.Hour
	// pointEvery is the least time between two points of a window whose
	// use did not change.
	pointEvery     = 15 * time.Minute
	historyVersion = 1
)

// history is the windows' use over time, per account and window, the
// accounts of the last poll (shown again after a restart) and the alerts
// fired in each window's current period.
type history struct {
	Version int `json:"version"`
	// Windows maps account key → window id (kind|label) → [time, used %].
	Windows  map[string]map[string][][2]float64 `json:"windows"`
	Accounts []AccountView                      `json:"accounts,omitempty"`
	// Alerts maps account key|kind|label|length|alert → the period it
	// fired in.
	Alerts map[string]alertRecord `json:"alerts,omitempty"`
	// loaded: what the core's database keeps was read into it (or the
	// history is kept in memory only); until then a save would remove
	// what it did not read, and does not write.
	loaded bool
}

func newHistory() *history {
	return &history{Version: historyVersion, Windows: map[string]map[string][][2]float64{}}
}

// windowIDs are the ids of an account's windows: kind|label, and after
// another | the window's length when two windows share kind and label
// (Kimi's limits have no labels), and their place when that is shared too.
func windowIDs(ws []usage.Window) []string {
	ids := make([]string, len(ws))
	count := map[string]int{}
	for i, w := range ws {
		ids[i] = w.Kind + "|" + w.Label
		count[ids[i]]++
	}
	for i, w := range ws {
		if count[ids[i]] > 1 {
			ids[i] += "|" + strconv.FormatInt(w.WindowSec, 10)
		}
	}
	seen := map[string]int{}
	for i := range ids {
		if n := seen[ids[i]]; n > 0 {
			seen[ids[i]]++
			ids[i] += "#" + strconv.Itoa(n)
		} else {
			seen[ids[i]] = 1
		}
	}
	return ids
}

// record adds a point for each window of the accounts read in this poll
// (fresh, by key) with current numbers, and drops points older than
// historyKeep. Numbers kept from an earlier poll add none: they were not
// read again.
func (h *history) record(accs map[string]*account, fresh map[string]bool, now time.Time) {
	t := float64(now.Unix())
	for k, a := range accs {
		if !fresh[k] || a.view.Status != usage.StatusOK {
			continue
		}
		ws := h.Windows[k]
		if ws == nil {
			ws = map[string][][2]float64{}
			h.Windows[k] = ws
		}
		ids := windowIDs(a.view.Account.Windows)
		for i, w := range a.view.Account.Windows {
			id := ids[i]
			pts := ws[id]
			if n := len(pts); n > 0 && pts[n-1][1] == w.UsedPct && t-pts[n-1][0] < pointEvery.Seconds() {
				continue
			}
			ws[id] = append(pts, [2]float64{t, w.UsedPct})
		}
	}
	h.prune(now)
}

// prune drops points older than historyKeep, and accounts left without.
func (h *history) prune(now time.Time) {
	cut := float64(now.Add(-historyKeep).Unix())
	for k, ws := range h.Windows {
		for id, pts := range ws {
			i := 0
			for i < len(pts) && pts[i][0] < cut {
				i++
			}
			if i == len(pts) {
				delete(ws, id)
			} else if i > 0 {
				ws[id] = append([][2]float64(nil), pts[i:]...)
			}
		}
		if len(ws) == 0 {
			delete(h.Windows, k)
		}
	}
}

// merge adds what stored, the history read back from the core's
// database, has that h, what this core recorded since it started, has
// not: each window's points before h's first, and the alerts h has not
// fired.
func (h *history) merge(stored *history) {
	for k, ws := range stored.Windows {
		mine := h.Windows[k]
		if mine == nil {
			mine = map[string][][2]float64{}
			h.Windows[k] = mine
		}
		for id, pts := range ws {
			cur := mine[id]
			if len(cur) == 0 {
				mine[id] = pts
				continue
			}
			i := 0
			for i < len(pts) && pts[i][0] < cur[0][0] {
				i++
			}
			mine[id] = append(append([][2]float64(nil), pts[:i]...), cur...)
		}
	}
	for k, r := range stored.Alerts {
		if h.Alerts == nil {
			h.Alerts = map[string]alertRecord{}
		}
		if _, ok := h.Alerts[k]; !ok {
			h.Alerts[k] = r
		}
	}
}

// first is the first point of window w (id) in its current period (the
// last 7 days when its length is unknown), for its pace; nil when none.
func (h *history) first(key, id string, w usage.Window, now time.Time) *[2]float64 {
	from := float64(now.Add(-7 * 24 * time.Hour).Unix())
	if w.ResetsAt > 0 && w.WindowSec > 0 {
		from = float64(w.ResetsAt - w.WindowSec)
	}
	for _, p := range h.Windows[key][id] {
		if p[0] >= from {
			return &p
		}
	}
	return nil
}

// The history is kept in the core's database (plugin.OpenDB), in tables of
// its own: the points of each account's window (usage_windows, a JSON
// array of [time, used %]), the accounts of the last poll (usage_accounts)
// and the alerts fired (usage_alerts). A save writes the rows that
// changed and removes those gone from memory, once the history was read
// back (a save before reads it first, and writes nothing while it cannot:
// what memory lacks would be removed). The file it was kept in before,
// usage-history[-<instance>].json beside the settings file, is imported
// once and then removed; one of another version, or that does not parse,
// is not this version's to import: it stays, unimported.
const historyFeature = "usage"

var historyMigrations = []string{
	`CREATE TABLE usage_windows (
		account TEXT NOT NULL,
		win TEXT NOT NULL,
		points TEXT NOT NULL,
		PRIMARY KEY (account, win)
	);
	CREATE TABLE usage_accounts (
		key TEXT PRIMARY KEY,
		view TEXT NOT NULL
	);
	CREATE TABLE usage_alerts (
		key TEXT PRIMARY KEY,
		record TEXT NOT NULL
	);`,
}

// historyNewerTold: a save said once that the core's database is of a
// newer version, whose history this core reads and does not write.
var historyNewerTold atomic.Bool

// openHistoryDB opens the core's database with the history's tables;
// writable false when they are of a newer version. nil without a host or
// a settings file (the history is kept in memory then). The caller closes
// it.
func (p *Plugin) openHistoryDB() (db *store.DB, writable bool, err error) {
	h := p.getHost()
	if h == nil {
		return nil, false, nil
	}
	db, err = plugin.OpenDB(h)
	if db == nil {
		return nil, false, err
	}
	v, err := db.Migrate(historyFeature, historyMigrations)
	switch {
	case errors.Is(err, store.ErrNewer) && v >= len(historyMigrations):
		return db, false, nil
	case err != nil:
		db.Close()
		return nil, false, err
	}
	return db, true, nil
}

// loadHistory reads the history and the accounts it kept from the core's
// database, after importing path, the file it was kept in before, into
// what memory has (merge: at the start nothing; a read that failed then
// is tried again by the next save).
func (p *Plugin) loadHistory(path string) {
	db, writable, err := p.openHistoryDB()
	if db == nil {
		if err != nil {
			p.logf("usage: %v", err)
			return
		}
		// No database: the history is kept in memory.
		p.mu.Lock()
		p.history.loaded = true
		p.mu.Unlock()
		return
	}
	defer db.Close()
	if writable {
		p.importHistoryFile(db, path)
	}
	h, err := readHistory(db)
	if err != nil {
		p.logf("usage: %v", err)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.history.merge(h)
	p.history.prune(p.now())
	p.history.loaded = true
	for _, v := range h.Accounts {
		if v.Key == "" || p.now().Sub(time.Unix(v.SeenAt, 0)) > forgetAfter || p.accounts[v.Key] != nil {
			continue
		}
		v.Account.Windows = nil
		for _, w := range v.Windows {
			v.Account.Windows = append(v.Account.Windows, w.Window)
		}
		v.Windows = nil
		p.accounts[v.Key] = &account{view: v}
	}
}

func (p *Plugin) logf(format string, args ...any) {
	if h := p.getHost(); h != nil {
		h.Logger().Printf(format, args...)
	}
}

// errOtherHistory: the history file is of another version or does not
// parse; it stays, and is not recorded as imported.
var errOtherHistory = errors.New("not a history this version reads: it stays")

// importHistoryFile imports the history file at path into db once, then
// removes it (an empty one holds nothing); a failed import leaves it for
// the next start, and so does one of another version or that does not
// parse (errOtherHistory), for a program that reads it.
func (p *Plugin) importHistoryFile(db *store.DB, path string) {
	if path == "" {
		return
	}
	if _, err := os.Lstat(path); err != nil {
		return
	}
	_, err := db.Import(context.Background(), historyFeature, "history", func(tx *sql.Tx) error {
		b, _, err := userfile.Read(path)
		if err != nil {
			return err
		}
		if len(b) == 0 {
			return nil
		}
		h := newHistory()
		if json.Unmarshal(b, h) != nil || h.Version != historyVersion {
			return errOtherHistory
		}
		rows, err := h.rows()
		if err != nil {
			return err
		}
		return writeHistory(tx, rows)
	})
	if err != nil {
		p.logf("usage: importing %s: %v", filepath.Base(path), err)
		return
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		p.logf("usage: %v", err)
	}
}

// readHistory reads the history's tables; rows that do not parse are
// skipped.
func readHistory(db *store.DB) (*history, error) {
	h := newHistory()
	rows, err := db.Query("SELECT account, win, points FROM usage_windows")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k, id string
		var b []byte
		var pts [][2]float64
		if rows.Scan(&k, &id, &b) != nil || json.Unmarshal(b, &pts) != nil || len(pts) == 0 {
			continue
		}
		if h.Windows[k] == nil {
			h.Windows[k] = map[string][][2]float64{}
		}
		h.Windows[k][id] = pts
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = db.Query("SELECT view FROM usage_accounts ORDER BY key")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var b []byte
		var v AccountView
		if rows.Scan(&b) != nil || json.Unmarshal(b, &v) != nil {
			continue
		}
		h.Accounts = append(h.Accounts, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = db.Query("SELECT key, record FROM usage_alerts")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var b []byte
		var r alertRecord
		if rows.Scan(&k, &b) != nil || json.Unmarshal(b, &r) != nil {
			continue
		}
		if h.Alerts == nil {
			h.Alerts = map[string]alertRecord{}
		}
		h.Alerts[k] = r
	}
	return h, rows.Err()
}

// historyRows are a history's rows as written: by (account, window), by
// account key, by alert key.
type historyRows struct {
	windows  map[[2]string][]byte
	accounts map[string][]byte
	alerts   map[string][]byte
}

// rows marshals h's rows.
func (h *history) rows() (historyRows, error) {
	r := historyRows{windows: map[[2]string][]byte{}, accounts: map[string][]byte{}, alerts: map[string][]byte{}}
	for k, ws := range h.Windows {
		for id, pts := range ws {
			b, err := json.Marshal(pts)
			if err != nil {
				return r, err
			}
			r.windows[[2]string{k, id}] = b
		}
	}
	for _, v := range h.Accounts {
		if v.Key == "" {
			continue
		}
		b, err := json.Marshal(v)
		if err != nil {
			return r, err
		}
		r.accounts[v.Key] = b
	}
	for k, a := range h.Alerts {
		b, err := json.Marshal(a)
		if err != nil {
			return r, err
		}
		r.alerts[k] = b
	}
	return r, nil
}

// writeHistory writes the rows that changed and removes those r does not
// have.
func writeHistory(tx *sql.Tx, r historyRows) error {
	for k, b := range r.windows {
		if _, err := tx.Exec(`INSERT INTO usage_windows (account, win, points) VALUES (?, ?, ?)
			ON CONFLICT (account, win) DO UPDATE SET points = excluded.points WHERE points != excluded.points`, k[0], k[1], b); err != nil {
			return err
		}
	}
	for k, b := range r.accounts {
		if _, err := tx.Exec(`INSERT INTO usage_accounts (key, view) VALUES (?, ?)
			ON CONFLICT (key) DO UPDATE SET view = excluded.view WHERE view != excluded.view`, k, b); err != nil {
			return err
		}
	}
	for k, b := range r.alerts {
		if _, err := tx.Exec(`INSERT INTO usage_alerts (key, record) VALUES (?, ?)
			ON CONFLICT (key) DO UPDATE SET record = excluded.record WHERE record != excluded.record`, k, b); err != nil {
			return err
		}
	}
	windows, err := keysOf(tx, "SELECT account, win FROM usage_windows")
	if err != nil {
		return err
	}
	for _, k := range windows {
		if r.windows[k] == nil {
			if _, err := tx.Exec("DELETE FROM usage_windows WHERE account = ? AND win = ?", k[0], k[1]); err != nil {
				return err
			}
		}
	}
	for _, t := range []struct {
		table string
		keep  map[string][]byte
	}{{"usage_accounts", r.accounts}, {"usage_alerts", r.alerts}} {
		keys, err := keysOf(tx, "SELECT key, '' FROM "+t.table)
		if err != nil {
			return err
		}
		for _, k := range keys {
			if t.keep[k[0]] == nil {
				if _, err := tx.Exec("DELETE FROM "+t.table+" WHERE key = ?", k[0]); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// keysOf are the rows of a query of two text columns.
func keysOf(tx *sql.Tx, query string) ([][2]string, error) {
	rows, err := tx.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][2]string
	for rows.Next() {
		var k [2]string
		if err := rows.Scan(&k[0], &k[1]); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// save writes the history into the core's database (in memory only
// without a settings file), once it was read back from there (loadHistory,
// tried again here while it was not).
func (p *Plugin) save() {
	path := p.historyPath()
	if path == "" {
		return
	}
	p.saveMu.Lock()
	defer p.saveMu.Unlock()
	p.mu.Lock()
	loaded := p.history.loaded
	p.mu.Unlock()
	if !loaded {
		p.loadHistory(path)
		p.mu.Lock()
		loaded = p.history.loaded
		p.mu.Unlock()
		if !loaded {
			return
		}
	}
	p.mu.Lock()
	h := &history{Version: historyVersion, Windows: p.history.Windows, Accounts: make([]AccountView, 0, len(p.accounts)), Alerts: p.history.Alerts}
	for _, a := range p.accounts {
		v := a.view
		v.Windows = make([]WindowView, 0, len(v.Account.Windows))
		for _, w := range v.Account.Windows {
			v.Windows = append(v.Windows, WindowView{Window: w})
		}
		v.Account.Windows = nil
		h.Accounts = append(h.Accounts, v)
	}
	rows, err := h.rows()
	p.mu.Unlock()
	if err != nil {
		return
	}
	db, writable, err := p.openHistoryDB()
	if db == nil {
		if err != nil {
			p.logf("usage: %v", err)
		}
		return
	}
	defer db.Close()
	if !writable {
		if !historyNewerTold.Swap(true) {
			p.logf("usage: the core's database is of a newer version: the history is not kept")
		}
		return
	}
	if err := db.Update(context.Background(), func(tx *sql.Tx) error { return writeHistory(tx, rows) }); err != nil {
		p.logf("usage: %v", err)
	}
}
