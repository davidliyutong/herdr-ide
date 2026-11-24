package vault

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/plugin"
	"veldr/internal/store"
)

// The access log records every request of a machine's MCP server and every
// value a page took (a reveal, an export), with names only, never values.
// It is kept in the core's database (core.db beside the settings file,
// plugin.CoreDBFile), table vault_access, one row a record, and read back
// at the core's start, so the panel shows what happened before a restart
// too. A record that lets values out is committed to disk (store.Durable)
// before they leave: one that cannot be written refuses the release
// (log_failed). A record gets its ID in the transaction that writes it,
// after every row's, so that it never replaces another and the bounds
// never drop it at once; one kept in memory only (its write failed, or the
// log could not be read yet) has an ID of its own until the log is read,
// which numbers it after the rows. The log is read again at each use until
// a read succeeded.

// Bounds of the access log: the records that let values out and the others
// are kept apart, so lists and refusals, which a program can repeat at
// will, never push a release out of the log.
const (
	// MaxReleases is how many records of values let out are kept
	// (allowed, approved, approved_always, exempted, revealed, exported).
	MaxReleases = 1000
	// MaxOthers is how many of the others are kept (lists, refusals,
	// denials).
	MaxOthers = 500
	// logFlushEvery is how often a record that took in repeated calls
	// (Count) since it was written is written again.
	logFlushEvery = 5 * time.Second
)

// Results of the access log beyond the MCP servers' error codes.
const (
	ResultAllowed        = "allowed"
	ResultApproved       = "approved"
	ResultApprovedAlways = "approved_always"
	ResultListed         = "listed"
	// ResultDenied: the user denied the request.
	ResultDenied = "denied"
	// ResultExpired: nobody answered in time (the requester is told
	// denied).
	ResultExpired = "expired"
	// ResultCancelled: the requester went away before an answer (its
	// client cancelled the call, or the server ended).
	ResultCancelled = "cancelled"
	// ResultRevealed and ResultExported: a page took values (a reveal, an
	// export).
	ResultRevealed = "revealed"
	ResultExported = "exported"
	// ResultExempted: values given without asking to an exempt app.
	ResultExempted = "exempted"
	// ResultLogFailed: values were not released because their record
	// could not be written.
	ResultLogFailed = "log_failed"
)

// released reports whether a record of result let values out.
func released(result string) bool {
	switch result {
	case ResultAllowed, ResultApproved, ResultApprovedAlways, ResultExempted, ResultRevealed, ResultExported:
		return true
	}
	return false
}

// noisy results are list calls and refusals (busy, not_found,
// vault_locked, inject_only, bad_request, cancelled…): a program can
// repeat them at will, so they are coalesced in the log, rate-limited in
// the audit log and do not make the pages reload. What lets values out,
// is the user's answer (denied), expired waiting for one or failed to be
// recorded is recorded every time.
func noisy(result string) bool {
	switch result {
	case ResultDenied, ResultExpired, ResultLogFailed:
		return false
	}
	return !released(result)
}

// Access is a record of the access log: names only, never values.
type Access struct {
	// ID orders the records; a record written again (its Count grew)
	// replaces the one of its ID when the file is read.
	ID   uint64    `json:"id"`
	Time time.Time `json:"time"`
	// M is the machine whose MCP server asked; "" for a page of the core.
	M    string `json:"m"`
	Tool string `json:"tool"`
	// Names are the variables asked for (at most 64 for a machine's
	// request; every name of an export).
	Names []string `json:"names,omitempty"`
	// Client, Terminal and Cwd are what the MCP server says of itself:
	// the program that started it, its terminal (HC_TERMINAL_ID) and the
	// directory it or the command works in. Not trusted.
	Client   string `json:"client,omitempty"`
	Terminal string `json:"terminal,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
	// Process is the process connected to vault.sock and its parents, as
	// the machine's agent saw them.
	Process []agentproto.VaultProcess `json:"process,omitempty"`
	// Remote and UserAgent are a page's: its connection's address and its
	// browser.
	Remote    string `json:"remote,omitempty"`
	UserAgent string `json:"userAgent,omitempty"`
	// Result: allowed (by the machines of the variables), approved
	// (once), approved_always, exempted (an exempt app's), listed, denied,
	// expired, cancelled, revealed, exported, log_failed or the error's
	// code (busy…).
	Result string `json:"result"`
	// Count is how many identical list calls or refusals in a row this
	// record stands for (1 when absent).
	Count int `json:"count,omitempty"`
}

// sameCall reports whether b repeats a's call (machine, tool, names,
// client, process, terminal, directory, result).
func sameCall(a, b Access) bool {
	return a.M == b.M && a.Tool == b.Tool && a.Client == b.Client && a.Terminal == b.Terminal && a.Cwd == b.Cwd &&
		a.Result == b.Result && slices.Equal(a.Names, b.Names) && slices.Equal(a.Process, b.Process) &&
		a.Remote == b.Remote && a.UserAgent == b.UserAgent
}

// accessLog is the log in memory and in the core's database ("" keeps it
// in memory only: the core keeps no settings file).
type accessLog struct {
	// settings is the core's settings file, beside which its database is
	// (plugin.CoreDBFile).
	settings string
	logger   *log.Logger
	// maxReleases, maxOthers and flushEvery replace MaxReleases, MaxOthers
	// and logFlushEvery (tests).
	maxReleases, maxOthers int
	flushEvery             time.Duration

	mu sync.Mutex
	// loaded: the records were read from the database (or there is none);
	// until then each use tries again.
	loaded bool
	recs   []Access
	// nextID is the ID of the next record (one written may get a higher
	// one, after every row's).
	nextID uint64
	// unsaved are the records of recs, by ID, that have no row: their
	// write failed, or the log could not be read when it was added.
	unsaved map[uint64]bool
	// stale: the last record took in calls since it was written; flush
	// writes it again.
	stale bool
	flush *time.Timer
	// newerTold: the log said once that the database is of a newer version.
	newerTold bool
}

// settingsBeside is the core's settings file beside the vault's file
// (vault[-<instance>].json beside settings[-<instance>].json); "" for "".
func settingsBeside(vault string) string {
	if vault == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(vault), strings.Replace(filepath.Base(vault), "vault", "settings", 1))
}

func newAccessLog(settings string, logger *log.Logger) *accessLog {
	return &accessLog{settings: settings, logger: logger, maxReleases: MaxReleases, maxOthers: MaxOthers, flushEvery: logFlushEvery}
}

func (l *accessLog) logf(format string, args ...any) {
	if l.logger != nil {
		l.logger.Printf("vault: access log: "+format, args...)
	}
}

// The access log's tables in the core's database (store.DB.Migrate): a
// record by its ID, with its class for the bounds (released).
const accessFeature = "vault"

var accessMigrations = []string{
	`CREATE TABLE vault_access (
		id INTEGER PRIMARY KEY,
		released INTEGER NOT NULL,
		record TEXT NOT NULL
	);
	CREATE INDEX vault_access_class ON vault_access (released, id);`,
}

// errNewer: the core's database, or the access log's tables in it, are
// of a newer version, which this core reads and does not write.
var errNewer = errors.New("the core's database is of a newer version: records are not kept")

// open opens the core's database with the access log's tables; writable
// false when they are of a newer version (errNewer). The caller closes it.
func (l *accessLog) open() (db *store.DB, writable bool, err error) {
	db, err = plugin.OpenCoreDB(l.settings)
	if db == nil {
		return nil, false, err
	}
	v, err := db.Migrate(accessFeature, accessMigrations)
	switch {
	case errors.Is(err, store.ErrNewer) && v >= len(accessMigrations):
		return db, false, nil
	case err != nil:
		db.Close()
		return nil, false, err
	}
	return db, true, nil
}

// load reads the records once a read succeeds; called with l.mu held.
// Records that do not parse are skipped. What was added before a read
// succeeded stays: the records written are among the rows (as kept in
// memory, which may have counted more calls since), those without a row
// follow them, numbered after them.
func (l *accessLog) load() {
	if l.loaded {
		return
	}
	l.nextID = max(l.nextID, 1)
	if l.settings == "" {
		l.loaded = true
		return
	}
	db, _, err := l.open()
	if err != nil {
		l.logf("%v", err)
		return
	}
	defer db.Close()
	recs, err := readRecords(db)
	if err != nil {
		l.logf("%v", err)
		return
	}
	l.loaded = true
	at := make(map[uint64]int, len(recs))
	next := uint64(1)
	for i, a := range recs {
		at[a.ID] = i
		next = max(next, a.ID+1)
	}
	var unsaved map[uint64]bool
	for _, a := range l.recs {
		if l.unsaved[a.ID] {
			a.ID = next
			next++
			if unsaved == nil {
				unsaved = map[uint64]bool{}
			}
			unsaved[a.ID] = true
			recs = append(recs, a)
		} else if i, ok := at[a.ID]; ok {
			recs[i] = a
		}
	}
	l.recs, l.unsaved, l.nextID = recs, unsaved, next
	l.trim()
}

// readRecords reads the access log's rows, by ID; rows that do not parse
// are skipped (tests make it fail).
var readRecords = func(db *store.DB) ([]Access, error) {
	rows, err := db.Query("SELECT record FROM vault_access ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var recs []Access
	for rows.Next() {
		var b []byte
		var a Access
		if rows.Scan(&b) != nil || json.Unmarshal(b, &a) != nil || a.ID == 0 {
			continue
		}
		recs = append(recs, a)
	}
	return recs, rows.Err()
}

// add records rec: one that repeats the last record's call (coalesce: a
// list call or a refusal) adds to its Count instead. The record is written
// to the core's database, committed to disk when durable (it lets values
// out); when that fails, the record says the release was refused
// (log_failed) and the error is returned: the values must not leave.
// It returns the record as kept.
func (l *accessLog) add(rec Access, coalesce, durable bool) (Access, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.load()
	if n := len(l.recs); coalesce && n > 0 && sameCall(l.recs[n-1], rec) {
		last := &l.recs[n-1]
		last.Time = rec.Time
		last.Count = max(last.Count, 1) + 1
		l.stale = true
		l.scheduleFlush()
		return *last, nil
	}
	if l.stale {
		if err := l.writeAt(len(l.recs)-1, false); err != nil {
			l.logf("%v", err)
		}
		l.stale = false
	}
	rec.ID = l.nextID
	l.nextID++
	l.recs = append(l.recs, rec)
	l.markUnsaved(rec.ID)
	err := l.writeAt(len(l.recs)-1, durable)
	rec = l.recs[len(l.recs)-1]
	if err != nil {
		if !errors.Is(err, errNewer) || !l.newerTold {
			l.logf("%v", err)
		}
		l.newerTold = l.newerTold || errors.Is(err, errNewer)
		if durable {
			rec.Result = ResultLogFailed
			l.recs[len(l.recs)-1] = rec
		} else {
			err = nil
		}
	}
	l.trim()
	return rec, err
}

// markUnsaved records that the record of id has no row; called with l.mu
// held.
func (l *accessLog) markUnsaved(id uint64) {
	if l.unsaved == nil {
		l.unsaved = map[uint64]bool{}
	}
	l.unsaved[id] = true
}

// writeAt writes l.recs[i]: a record without a row gets its ID in the
// write's transaction, after every row's, in memory too, once written;
// called with l.mu held.
func (l *accessLog) writeAt(i int, durable bool) error {
	rec := l.recs[i]
	fresh := l.unsaved[rec.ID]
	id, err := l.write(rec, durable, fresh)
	if err != nil {
		return err
	}
	if fresh {
		delete(l.unsaved, rec.ID)
		l.recs[i].ID = id
		l.nextID = max(l.nextID, id+1)
	}
	return nil
}

// write writes rec into the core's database, its commit on disk when
// durable, and drops the oldest records of its class past the bounds; a
// fresh record (no row yet) gets an ID after every row's, at least its
// own. It returns the record's ID as written; called with l.mu held.
func (l *accessLog) write(rec Access, durable, fresh bool) (uint64, error) {
	if l.settings == "" {
		return rec.ID, nil
	}
	db, writable, err := l.open()
	if err != nil {
		return 0, err
	}
	defer db.Close()
	if !writable {
		return 0, errNewer
	}
	run := db.Update
	if durable {
		run = db.Durable
	}
	rel := released(rec.Result)
	keep := l.maxOthers
	if rel {
		keep = l.maxReleases
	}
	err = run(context.Background(), func(tx *sql.Tx) error {
		if fresh {
			var top int64
			if err := tx.QueryRow("SELECT coalesce(max(id), 0) FROM vault_access").Scan(&top); err != nil {
				return err
			}
			rec.ID = max(rec.ID, uint64(top)+1)
		}
		b, err := json.Marshal(rec)
		if err != nil {
			return err
		}
		return writeRecord(tx, rec.ID, rel, b, keep)
	})
	return rec.ID, err
}

// writeRecord writes a record's row and keeps the newest keep of its
// class (tests make it fail).
var writeRecord = func(tx *sql.Tx, id uint64, rel bool, record []byte, keep int) error {
	if _, err := tx.Exec(`INSERT INTO vault_access (id, released, record) VALUES (?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET released = excluded.released, record = excluded.record`, int64(id), rel, record); err != nil {
		return err
	}
	_, err := tx.Exec(`DELETE FROM vault_access WHERE released = ?1 AND id NOT IN
		(SELECT id FROM vault_access WHERE released = ?1 ORDER BY id DESC LIMIT ?2)`, rel, keep)
	return err
}

// scheduleFlush writes the last record again once a while is over, if it
// took in calls meanwhile; called with l.mu held.
func (l *accessLog) scheduleFlush() {
	if l.flush != nil || l.settings == "" {
		return
	}
	l.flush = time.AfterFunc(l.flushEvery, func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.flush = nil
		if l.stale && len(l.recs) > 0 {
			if err := l.writeAt(len(l.recs)-1, false); err != nil && (!errors.Is(err, errNewer) || !l.newerTold) {
				l.logf("%v", err)
			}
			l.stale = false
		}
	})
}

// trim drops the oldest records past the bounds of their class; called
// with l.mu held.
func (l *accessLog) trim() {
	l.recs = trimmed(l.recs, l.maxReleases, l.maxOthers)
	if len(l.unsaved) == 0 {
		return
	}
	kept := make(map[uint64]bool, len(l.recs))
	for _, a := range l.recs {
		kept[a.ID] = true
	}
	for id := range l.unsaved {
		if !kept[id] {
			delete(l.unsaved, id)
		}
	}
}

// trimmed is recs without the oldest records past the bounds of their
// class.
func trimmed(recs []Access, maxReleases, maxOthers int) []Access {
	var releases, others int
	for _, a := range recs {
		if released(a.Result) {
			releases++
		} else {
			others++
		}
	}
	if releases <= maxReleases && others <= maxOthers {
		return recs
	}
	dropR, dropO := max(0, releases-maxReleases), max(0, others-maxOthers)
	return slices.DeleteFunc(recs, func(a Access) bool {
		if released(a.Result) {
			if dropR > 0 {
				dropR--
				return true
			}
		} else if dropO > 0 {
			dropO--
			return true
		}
		return false
	})
}

// list returns the records, newest first.
func (l *accessLog) list() []Access {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.load()
	out := slices.Clone(l.recs)
	slices.Reverse(out)
	if out == nil {
		out = []Access{}
	}
	return out
}

// close stops the pending flush (tests reopen the log).
func (l *accessLog) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.flush != nil {
		l.flush.Stop()
		l.flush = nil
	}
}
