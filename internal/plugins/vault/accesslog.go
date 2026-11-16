package vault

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/userfile"
)

// The access log records every request of a machine's MCP server and every
// value a page took (a reveal, an export), with names only, never values.
// It is kept beside the vault's file, in vault[-<instance>]-access.jsonl
// (0600, one record a line), and read back at the core's start, so the
// panel shows what happened before a restart too. A record that lets
// values out is written (and flushed to disk) before they leave: one that
// cannot be written refuses the release (log_failed).

// Bounds of the access log: the records that let values out and the others
// are kept apart, so lists and refusals, which a program can repeat at
// will, never push a release out of the log.
const (
	// MaxReleases is how many records of values let out are kept
	// (allowed, approved, approved_always, revealed, exported).
	MaxReleases = 1000
	// MaxOthers is how many of the others are kept (lists, refusals,
	// denials).
	MaxOthers = 500
	// maxLogRead is how much of the file a start reads (its end).
	maxLogRead = 16 << 20
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
	// ResultLogFailed: values were not released because their record
	// could not be written.
	ResultLogFailed = "log_failed"
)

// released reports whether a record of result let values out.
func released(result string) bool {
	switch result {
	case ResultAllowed, ResultApproved, ResultApprovedAlways, ResultRevealed, ResultExported:
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
	// (once), approved_always, listed, denied, expired, cancelled,
	// revealed, exported, log_failed or the error's code (busy…).
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

// accessLog is the log in memory and its file ("" keeps it in memory only:
// the core keeps no settings file).
type accessLog struct {
	path   string
	logger *log.Logger
	// maxReleases, maxOthers and flushEvery replace MaxReleases, MaxOthers
	// and logFlushEvery (tests).
	maxReleases, maxOthers int
	flushEvery             time.Duration

	mu     sync.Mutex
	loaded bool
	recs   []Access
	nextID uint64
	f      *os.File
	// lines is how many lines the file holds: past twice the records kept
	// it is written again with those only.
	lines int
	// stale: the last record took in calls since it was written; flush
	// writes it again.
	stale bool
	flush *time.Timer
}

// accessLogPath is the access log's file beside the vault's.
func accessLogPath(vault string) string {
	if vault == "" {
		return ""
	}
	return strings.TrimSuffix(vault, ".json") + "-access.jsonl"
}

func newAccessLog(path string, logger *log.Logger) *accessLog {
	return &accessLog{path: path, logger: logger, maxReleases: MaxReleases, maxOthers: MaxOthers, flushEvery: logFlushEvery}
}

func (l *accessLog) logf(format string, args ...any) {
	if l.logger != nil {
		l.logger.Printf("vault: access log: "+format, args...)
	}
}

// load reads the file once; called with l.mu held. Lines that do not
// parse are skipped; of a record written several times the last counts.
func (l *accessLog) load() {
	if l.loaded {
		return
	}
	l.loaded, l.nextID = true, 1
	if l.path == "" {
		return
	}
	f, err := os.Open(l.path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			l.logf("%v", err)
		}
		return
	}
	defer f.Close()
	partial := false
	if st, err := f.Stat(); err == nil && st.Size() > maxLogRead {
		if _, err := f.Seek(st.Size()-maxLogRead, io.SeekStart); err == nil {
			partial = true // the first line read is the end of one
		}
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 8<<20)
	at := map[uint64]int{}
	for sc.Scan() {
		l.lines++
		if partial {
			partial = false
			continue
		}
		var a Access
		if json.Unmarshal(sc.Bytes(), &a) != nil || a.ID == 0 {
			continue
		}
		if i, ok := at[a.ID]; ok {
			l.recs[i] = a
			continue
		}
		at[a.ID] = len(l.recs)
		l.recs = append(l.recs, a)
		l.nextID = max(l.nextID, a.ID+1)
	}
	if err := sc.Err(); err != nil {
		l.logf("%v", err)
	}
	l.trim()
}

// add records rec: one that repeats the last record's call (coalesce: a
// list call or a refusal) adds to its Count instead. The record is
// appended to the file, flushed to disk when durable (it lets values
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
		if err := l.write(l.recs[len(l.recs)-1], false); err != nil {
			l.logf("%v", err)
		}
		l.stale = false
	}
	rec.ID = l.nextID
	l.nextID++
	l.recs = append(l.recs, rec)
	err := l.write(rec, durable)
	if err != nil {
		l.logf("%v", err)
		if durable {
			rec.Result = ResultLogFailed
			l.recs[len(l.recs)-1] = rec
		} else {
			err = nil
		}
	}
	l.trim()
	if l.lines > 2*(l.maxReleases+l.maxOthers) {
		l.compact()
	}
	return rec, err
}

// write appends rec to the file, flushed to disk when durable; called with
// l.mu held.
func (l *accessLog) write(rec Access, durable bool) error {
	if l.path == "" {
		return nil
	}
	if l.f == nil {
		if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
			return err
		}
		f, err := os.OpenFile(l.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
		if err != nil {
			return err
		}
		l.f = f
	}
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	if _, err := l.f.Write(append(b, '\n')); err != nil {
		l.f.Close()
		l.f = nil
		return err
	}
	l.lines++
	if durable {
		return l.f.Sync()
	}
	return nil
}

// compact writes the file again with the records kept (atomically: the
// old file or the new one); called with l.mu held.
func (l *accessLog) compact() {
	var b []byte
	for _, a := range l.recs {
		line, err := json.Marshal(a)
		if err != nil {
			continue
		}
		b = append(append(b, line...), '\n')
	}
	if l.f != nil {
		l.f.Close() // Windows replaces no file that is open
		l.f = nil
	}
	if _, err := userfile.Write(l.path, b); err != nil {
		l.logf("%v", err)
		return
	}
	l.lines, l.stale = len(l.recs), false
}

// scheduleFlush writes the last record again once a while is over, if it
// took in calls meanwhile; called with l.mu held.
func (l *accessLog) scheduleFlush() {
	if l.flush != nil || l.path == "" {
		return
	}
	l.flush = time.AfterFunc(l.flushEvery, func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.flush = nil
		if l.stale && len(l.recs) > 0 {
			if err := l.write(l.recs[len(l.recs)-1], false); err != nil {
				l.logf("%v", err)
			}
			l.stale = false
		}
	})
}

// trim drops the oldest records past the bounds of their class; called
// with l.mu held.
func (l *accessLog) trim() {
	var releases, others int
	for _, a := range l.recs {
		if released(a.Result) {
			releases++
		} else {
			others++
		}
	}
	if releases <= l.maxReleases && others <= l.maxOthers {
		return
	}
	dropR, dropO := max(0, releases-l.maxReleases), max(0, others-l.maxOthers)
	l.recs = slices.DeleteFunc(l.recs, func(a Access) bool {
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

// close ends the file's use (tests reopen it).
func (l *accessLog) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.flush != nil {
		l.flush.Stop()
		l.flush = nil
	}
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
}
