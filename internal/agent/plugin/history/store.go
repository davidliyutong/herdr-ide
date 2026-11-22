//go:build unix

package history

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"herdr-ide/internal/agentproto"
	dbstore "herdr-ide/internal/store"
)

// The snapshots live in the machine's database (store.MachineDB in the
// agent's data directory, named after the host: store.HostFile), table
// history_snapshots: a row per generation
// of a terminal (prev 0 for the current one, 1 for the previous one) with
// what describes it and its bytes. Every change is a transaction of its
// own, so readers (list, read) take no lock and see each generation whole;
// a written generation is on disk before the write returns (store.Durable).
//
// Writers (capture, clear, adopt, the agent's housekeeping) hold the
// snapshots' lease, history_lease, which two agents of the same instance
// (two cores that reach the machine) share: its row names the writer (its
// process's random id and its own), its process and host and until when it
// holds it, taken in a transaction and renewed by each of the writer's
// changes, which fail once another writer took it. It ends when the writer
// closes the store, when its process is gone (same host: no process of its
// pid, or this process while the writer's process id is another's, an
// agent of a container started again with the same pid), or leaseTTL after
// its last renewal. Memory follows the database: a change that fails
// leaves what describes the snapshots as it was.
//
// The snapshots were kept before in <data dir>/history, as files: their
// whole generations are imported once when the database is opened, then
// the directory is removed (also one an agent of an older version left
// again later).

const (
	// feature names the snapshots' tables in the machine's database.
	feature = "history"
	// leaseTTL is how long a writer holds the lease after its last change:
	// longer than a capture's or a clear's time (captureTimeout,
	// clearTimeout), each of whose changes renews it.
	leaseTTL = time.Minute
	// leaseRetry is how often a writer that waits for the lease asks again.
	leaseRetry = 50 * time.Millisecond

	// dirName is the directory below the data directory the snapshots were
	// kept in before, as files (imported once).
	dirName = "history"
	// maxMeta bounds a former generation's .json file.
	maxMeta = 64 << 10
	// maxEntries bounds the former directory's entries the import looks at.
	maxEntries = 4096
)

var migrations = []string{
	`CREATE TABLE history_snapshots (
		terminal TEXT NOT NULL,
		prev INTEGER NOT NULL CHECK (prev IN (0, 1)),
		pid INTEGER NOT NULL,
		at INTEGER NOT NULL,
		lines INTEGER NOT NULL,
		cols INTEGER NOT NULL,
		grid_rows INTEGER NOT NULL,
		bytes INTEGER NOT NULL,
		hash TEXT NOT NULL,
		days INTEGER NOT NULL,
		restored INTEGER NOT NULL,
		data BLOB NOT NULL,
		PRIMARY KEY (terminal, prev)
	);
	CREATE TABLE history_lease (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		owner TEXT NOT NULL,
		host TEXT NOT NULL,
		pid INTEGER NOT NULL,
		expires INTEGER NOT NULL
	);`,
}

// meta describes a generation (its row's columns; the JSON was its file's
// before the database, which the import reads).
type meta struct {
	Terminal string `json:"terminal"`
	agentproto.HistorySnapshot
	// Hash is the SHA-256 of the terminal's grid and screen text when the
	// snapshot was taken (screenHash): a capture that reads the same and
	// the same pid writes nothing.
	Hash string `json:"hash"`
	// Days is the retention the snapshot was written under, which the
	// agent applies when it starts and whenever the snapshots are listed
	// or read, before the core asks for a capture.
	Days int `json:"days"`
	// Restored: the terminal core restored the screen of the program
	// before into this program's terminal (restoredByCore). It stays set
	// for the later snapshots of the same program, whose lines may no
	// longer reach back to the core's line.
	Restored bool `json:"restored,omitempty"`
}

// valid tells whether m describes a generation of addr that can be one.
func (m *meta) valid() bool {
	return agentproto.ValidHistoryTerminal(m.Terminal) && m.Bytes >= 0 && m.Bytes <= agentproto.HistoryMaxBytes && m.At > 0
}

// stored are a terminal's generations; either may be nil.
type stored struct{ cur, prev *meta }

// gen is the current generation, or the previous one.
func (s *stored) gen(prev bool) *meta {
	if prev {
		return s.prev
	}
	return s.cur
}

// newest is when the terminal was captured last, in ms.
func (s *stored) newest() int64 {
	var at int64
	for _, m := range []*meta{s.cur, s.prev} {
		if m != nil && m.At > at {
			at = m.At
		}
	}
	return at
}

func (s *stored) bytes() int64 {
	var n int64
	for _, m := range []*meta{s.cur, s.prev} {
		if m != nil {
			n += m.Bytes
		}
	}
	return n
}

// store is a writer's view of the snapshots: the database, the lease it
// holds and what describes each terminal's generations.
type store struct {
	db    *dbstore.DB
	owner string
	terms map[string]*stored
}

var (
	// errBusy: another writer holds the lease.
	errBusy = errors.New("history: another capture is running")
	// errLeaseLost: the lease expired and another writer took it.
	errLeaseLost = errors.New("history: the snapshots' lease was taken over")
	// errNewer: the machine's database, or the snapshots' tables in it,
	// are of a newer version, which this agent reads and does not write.
	errNewer = errors.New("history: the snapshots' database is of a newer version")
	// errNoData: no data directory.
	errNoData = errors.New("history: no data directory")
)

// dbPath is the machine's database below the data directory base: this
// host's (store.HostFile).
func dbPath(base string) string { return dbstore.HostFile(base, dbstore.MachineDB) }

// exists tells whether base has snapshots to look at: the machine's
// database or the directory they were kept in before (a read creates
// nothing).
func exists(base string) bool {
	if base == "" || !path.IsAbs(base) {
		return false
	}
	if dbstore.Exists(dbPath(base)) {
		return true
	}
	st, err := os.Lstat(path.Join(base, dirName))
	return err == nil && st.IsDir()
}

// openDB opens the machine's database below base with the snapshots'
// tables, after importing the files they were kept in before. With
// errNewer the database is returned to read. The caller closes it.
func openDB(base string) (*dbstore.DB, error) {
	if base == "" || !path.IsAbs(base) {
		return nil, errNoData
	}
	db, err := dbstore.OpenShared(dbPath(base))
	if db == nil {
		return nil, err
	}
	v, err := db.Migrate(feature, migrations)
	switch {
	case errors.Is(err, dbstore.ErrNewer) && v >= len(migrations):
		return db, errNewer
	case err != nil:
		db.Close()
		return nil, err
	}
	importFiles(db, base)
	return db, nil
}

// openStore opens the snapshots below base for a writer: it takes the
// lease (at once or errBusy without wait, else asking again until ctx
// ends) and reads what describes every generation. Rows that cannot be a
// generation go; removed counts the terminals that lost one so.
func openStore(ctx context.Context, base string, wait bool, now time.Time) (s *store, removed int, err error) {
	db, err := openDB(base)
	if err != nil {
		if db != nil {
			db.Close()
		}
		return nil, 0, err
	}
	var r [12]byte
	rand.Read(r[:])
	s = &store{db: db, owner: processID() + "." + hex.EncodeToString(r[:]), terms: map[string]*stored{}}
	if err := s.lock(ctx, wait); err != nil {
		db.Close()
		return nil, 0, err
	}
	if removed, err = s.load(); err != nil {
		s.close()
		return nil, 0, err
	}
	return s, removed, nil
}

// close releases the lease and the database, giving the pages of the
// generations that went back to the file system when they are many
// (store.DB.Reclaim).
func (s *store) close() {
	if s.db == nil {
		return
	}
	s.db.Exec("DELETE FROM history_lease WHERE id = 1 AND owner = ?", s.owner)
	s.db.Reclaim()
	s.db.Close()
	s.db = nil
}

// hostname tells this computer's writers from those of another sharing
// the data directory, whose processes cannot be looked at.
var hostname = sync.OnceValue(func() string {
	h, _ := os.Hostname()
	return h
})

// processID is this process's random id, which its writers' owner names
// begin with (before a dot): a lease of this pid whose owner does not is
// a process's before this one with the same pid.
var processID = sync.OnceValue(func() string {
	var r [8]byte
	rand.Read(r[:])
	return hex.EncodeToString(r[:])
})

// lock takes the lease: at once or errBusy without wait, else asking again
// until ctx ends.
func (s *store) lock(ctx context.Context, wait bool) error {
	for {
		taken, err := s.tryLease()
		if err != nil || taken {
			return err
		}
		if !wait {
			return errBusy
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(leaseRetry):
		}
	}
}

// tryLease takes the lease unless another writer holds it: one whose
// time is not over and whose process is there (on this host) or may be
// (on another).
func (s *store) tryLease() (bool, error) {
	taken := false
	err := s.db.Update(context.Background(), func(tx *sql.Tx) error {
		var owner, host string
		var pid int
		var expires int64
		now := time.Now()
		err := tx.QueryRow("SELECT owner, host, pid, expires FROM history_lease WHERE id = 1").Scan(&owner, &host, &pid, &expires)
		switch {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			return err
		case owner != s.owner && expires > now.UnixMilli() && (host != hostname() || alive(pid, owner)):
			return nil
		}
		_, err = tx.Exec(`INSERT INTO history_lease (id, owner, host, pid, expires) VALUES (1, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, host = excluded.host, pid = excluded.pid, expires = excluded.expires`,
			s.owner, hostname(), os.Getpid(), now.Add(leaseTTL).UnixMilli())
		taken = err == nil
		return err
	})
	return taken, err
}

// alive tells whether the process of writer owner, pid of this host, is
// there: this process when owner is one of its writers (another writer of
// it holds the lease), not when owner is of an earlier process of the same
// pid.
func alive(pid int, owner string) bool {
	if pid == os.Getpid() {
		return strings.HasPrefix(owner, processID()+".")
	}
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// change runs fn in a transaction that renews the writer's lease, its
// commit on disk when durable.
func (s *store) change(durable bool, fn func(tx *sql.Tx) error) error {
	run := s.db.Update
	if durable {
		run = s.db.Durable
	}
	return run(context.Background(), func(tx *sql.Tx) error {
		res, err := tx.Exec("UPDATE history_lease SET expires = ? WHERE id = 1 AND owner = ?", time.Now().Add(leaseTTL).UnixMilli(), s.owner)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil || n != 1 {
			return errLeaseLost
		}
		return fn(tx)
	})
}

// columns are a generation's columns but its bytes, as scanMeta reads
// them, with the size of its bytes last.
const columns = "terminal, prev, pid, at, lines, cols, grid_rows, bytes, hash, days, restored, length(data)"

// scanMeta reads a row of columns: its generation, whether it is the
// previous one, and whether its bytes have the size it gives.
func scanMeta(sc interface{ Scan(...any) error }, extra ...any) (m *meta, prev, whole bool, err error) {
	m = &meta{}
	var size int64
	dst := append([]any{&m.Terminal, &prev, &m.PID, &m.At, &m.Lines, &m.Cols, &m.Rows, &m.Bytes, &m.Hash, &m.Days, &m.Restored, &size}, extra...)
	if err := sc.Scan(dst...); err != nil {
		return nil, false, false, err
	}
	return m, prev, size == m.Bytes && m.valid(), nil
}

// load reads what describes every generation into s.terms; rows that are
// not whole go.
func (s *store) load() (int, error) {
	rows, err := s.db.Query("SELECT " + columns + " FROM history_snapshots ORDER BY terminal, prev")
	if err != nil {
		return 0, err
	}
	type key struct {
		addr string
		prev bool
	}
	var broken []key
	for rows.Next() {
		m, prev, whole, err := scanMeta(rows)
		if err != nil {
			rows.Close()
			return 0, err
		}
		if !whole {
			broken = append(broken, key{m.Terminal, prev})
			continue
		}
		st := s.terms[m.Terminal]
		if st == nil {
			st = &stored{}
			s.terms[m.Terminal] = st
		}
		if prev {
			st.prev = m
		} else {
			st.cur = m
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(broken) == 0 {
		return 0, nil
	}
	lost := map[string]bool{}
	err = s.change(false, func(tx *sql.Tx) error {
		for _, k := range broken {
			if _, err := tx.Exec("DELETE FROM history_snapshots WHERE terminal = ? AND prev = ?", k.addr, k.prev); err != nil {
				return err
			}
			lost[k.addr] = true
		}
		return nil
	})
	return len(lost), err
}

// removeRows removes rows of addr: one generation, or both (prev nil).
func (s *store) removeRows(addr string, prev *bool) error {
	return s.change(false, func(tx *sql.Tx) error {
		var err error
		if prev == nil {
			_, err = tx.Exec("DELETE FROM history_snapshots WHERE terminal = ?", addr)
		} else {
			_, err = tx.Exec("DELETE FROM history_snapshots WHERE terminal = ? AND prev = ?", addr, *prev)
		}
		return err
	})
}

// removeGen removes one generation; memory changes once the removal
// committed.
func (s *store) removeGen(addr string, prev bool) error {
	st := s.terms[addr]
	if st == nil {
		return nil
	}
	if err := s.removeRows(addr, &prev); err != nil {
		return err
	}
	if prev {
		st.prev = nil
	} else {
		st.cur = nil
	}
	if st.cur == nil && st.prev == nil {
		delete(s.terms, addr)
	}
	return nil
}

// remove removes a terminal's snapshots; false when it had none or the
// removal failed (they stay, also in memory).
func (s *store) remove(addr string) bool {
	ok, _ := s.removeTerminal(addr)
	return ok
}

// removeTerminal removes a terminal's snapshots: false without error when
// it had none; memory changes once the removal committed.
func (s *store) removeTerminal(addr string) (bool, error) {
	if s.terms[addr] == nil {
		return false, nil
	}
	if err := s.removeRows(addr, nil); err != nil {
		return false, err
	}
	delete(s.terms, addr)
	return true, nil
}

// expired tells whether generation m was taken before now minus its
// retention: days, or with days 0 the one it was written under.
func expired(m *meta, now time.Time, days int) bool {
	keep := days
	if keep == 0 {
		keep = m.Days
		if keep == 0 {
			keep = agentproto.HistoryMaxDays
		}
		keep = clamp(keep, agentproto.HistoryMinDays, agentproto.HistoryMaxDays)
	}
	return now.Sub(time.UnixMilli(m.At)) > time.Duration(keep)*24*time.Hour
}

// pruneAge removes the generations that expired (expired with days). It
// returns the terminals that lost one (a removal that failed loses
// nothing).
func (s *store) pruneAge(now time.Time, days int) int {
	removed := 0
	for addr, st := range s.terms {
		lost := false
		for _, prev := range []bool{false, true} {
			if m := st.gen(prev); m != nil && expired(m, now, days) && s.removeGen(addr, prev) == nil {
				lost = true
			}
		}
		if lost {
			removed++
		}
	}
	return removed
}

// total is the bytes of every generation.
func (s *store) total() int64 {
	var n int64
	for _, st := range s.terms {
		n += st.bytes()
	}
	return n
}

// oldest is the terminal captured longest ago among those not in keep,
// "" when there is none.
func (s *store) oldest(keep map[string]bool) string {
	best, at := "", int64(0)
	for addr, st := range s.terms {
		if keep[addr] {
			continue
		}
		if n := st.newest(); best == "" || n < at || n == at && addr < best {
			best, at = addr, n
		}
	}
	return best
}

// fit evicts the terminals captured longest ago until there are at most
// maxTerminals of them and maxTotal bytes, not those in keep; it returns
// how many went. A removal that fails ends it: what stays is counted.
func (s *store) fit(maxTerminals int, maxTotal int64, keep map[string]bool) int {
	evicted := 0
	for len(s.terms) > maxTerminals || s.total() > maxTotal {
		victim := s.oldest(keep)
		if victim == "" || !s.evict(victim) {
			break
		}
		evicted++
	}
	return evicted
}

// evict removes a terminal's snapshots for the limits, remembering the
// screen its current one was of (evictions); false when the removal
// failed.
func (s *store) evict(addr string) bool {
	st := s.terms[addr]
	if st == nil {
		return false
	}
	cur := st.cur
	if ok, err := s.removeTerminal(addr); !ok || err != nil {
		return false
	}
	if cur != nil {
		evictions.set(addr, screenKey(cur.PID, cur.Hash))
	}
	return true
}

// memo is what the agent's process remembers of the live terminals between
// captures, by address. It is lost when the agent ends, which costs one
// capture of each terminal again.
type memo[V any] struct {
	mu sync.Mutex
	m  map[string]V
}

func newMemo[V any]() *memo[V] { return &memo[V]{m: map[string]V{}} }

func (e *memo[V]) get(addr string) (V, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	v, ok := e.m[addr]
	return v, ok
}

func (e *memo[V]) set(addr string, v V) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.m[addr] = v
}

// forget drops addr ("" for all).
func (e *memo[V]) forget(addr string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if addr == "" {
		clear(e.m)
	} else {
		delete(e.m, addr)
	}
}

// keepOnly drops the terminals not in live.
func (e *memo[V]) keepOnly(live map[string]bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for a := range e.m {
		if !live[a] {
			delete(e.m, a)
		}
	}
}

func screenKey(pid int, hash string) string { return strconv.Itoa(pid) + ":" + hash }

// refusal is a terminal's screen that a capture did not store for good
// reason, and that reason's code.
type refusal struct{ key, code string }

var (
	// evictions remember the screen of each terminal whose snapshot the
	// limits evicted (screenKey): such a terminal is captured again only
	// once its program or its screen changed, so that the terminals beyond
	// the limits do not take each other's place at every capture.
	evictions = newMemo[string]()
	// refusals remember the screen of each terminal that the limits had no
	// room for (limit) or whose paint exceeds a generation's size with the
	// fewest lines (too_large), with the limits it was refused under: it is
	// not read again until its program, its screen or the limits changed.
	refusals = newMemo[refusal]()
	// tried remember when a capture last tried a terminal and stored
	// nothing (ms since the epoch): it then comes after the terminals
	// captured longer ago (capturer order), so a terminal that keeps
	// failing slowly does not hold back the others.
	tried = newMemo[int64]()
	// vanished remember when a capture first saw a terminal with snapshots
	// missing from the terminal core's records (ms since the epoch): its
	// snapshots go once it has been gone for goneGrace (run). An agent
	// that starts again starts the grace again.
	vanished = newMemo[int64]()
)

// forgetTerminal drops what the agent's process remembers of addr ("" for
// all terminals).
func forgetTerminal(addr string) {
	evictions.forget(addr)
	refusals.forget(addr)
	tried.forget(addr)
	vanished.forget(addr)
}

// keepOnlyLive drops what the agent's process remembers of the terminals
// not in live.
func keepOnlyLive(live map[string]bool) {
	evictions.keepOnly(live)
	refusals.keepOnly(live)
	tried.keepOnly(live)
}

// room tells, before a terminal's paint is read, whether a new current
// generation of addr could fit at all: among maxTerminals once every
// terminal that may go is gone (all but addr and those in keep), with
// bytes left besides those that stay. Its size is known only once read,
// when makeRoom decides.
func (s *store) room(addr string, maxTerminals int, maxTotal int64, keep map[string]bool) bool {
	count, stay := 1, int64(0)
	for a, st := range s.terms {
		if a != addr && keep[a] {
			count++
			stay += st.bytes()
		}
	}
	return count <= maxTerminals && stay < maxTotal
}

// makeRoom evicts for a new current generation of n bytes of addr: the
// terminals captured longest ago go first, never addr nor those in keep;
// addr's previous generation goes only when addr alone would exceed
// maxTotal. ok is false when the generation does not fit, or a removal
// failed.
func (s *store) makeRoom(addr string, n int64, maxTerminals int, maxTotal int64, keep map[string]bool) (evicted int, ok bool) {
	if n > maxTotal {
		return 0, false
	}
	protect := map[string]bool{addr: true}
	for a := range keep {
		protect[a] = true
	}
	for {
		count := len(s.terms)
		var mine *stored
		if st := s.terms[addr]; st != nil {
			mine = st
		} else {
			count++
		}
		total := s.total() + n
		if mine != nil && mine.cur != nil {
			total -= mine.cur.Bytes
		}
		if count <= maxTerminals && total <= maxTotal {
			return evicted, true
		}
		if victim := s.oldest(protect); victim != "" {
			if !s.evict(victim) {
				return evicted, false
			}
			evicted++
			continue
		}
		if total > maxTotal && mine != nil && mine.prev != nil && n+mine.prev.Bytes > maxTotal {
			if s.removeGen(addr, true) != nil {
				return evicted, false
			}
			continue
		}
		return evicted, false
	}
}

// rotate makes addr's current generation its previous one, replacing the
// previous one.
func (s *store) rotate(addr string) error {
	st := s.terms[addr]
	if st == nil || st.cur == nil {
		return nil
	}
	err := s.change(true, func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM history_snapshots WHERE terminal = ? AND prev = 1", addr); err != nil {
			return err
		}
		_, err := tx.Exec("UPDATE history_snapshots SET prev = 1 WHERE terminal = ? AND prev = 0", addr)
		return err
	})
	if err != nil {
		return err
	}
	st.prev, st.cur = st.cur, nil
	return nil
}

// adopt makes the newest generation of from (its current, else its
// previous) the previous generation of to, unless to has a previous one
// captured later, and removes from's snapshots either way; false when
// nothing moved. It is one transaction: readers see the generation at
// from or at to. One that fails changes nothing.
func (s *store) adopt(from, to string) (bool, error) {
	src := s.terms[from]
	if src == nil {
		return false, nil
	}
	prev := src.cur == nil
	m := src.gen(prev)
	if dst := s.terms[to]; dst != nil && dst.prev != nil && dst.prev.At > m.At {
		_, err := s.removeTerminal(from)
		return false, err
	}
	err := s.change(true, func(tx *sql.Tx) error {
		if _, err := tx.Exec("DELETE FROM history_snapshots WHERE terminal = ? AND prev = 1", to); err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE history_snapshots SET terminal = ?, prev = 1 WHERE terminal = ? AND prev = ?", to, from, prev); err != nil {
			return err
		}
		_, err := tx.Exec("DELETE FROM history_snapshots WHERE terminal = ?", from)
		return err
	})
	if err != nil {
		return false, err
	}
	moved := *m
	moved.Terminal = to
	dst := s.terms[to]
	if dst == nil {
		dst = &stored{}
		s.terms[to] = dst
	}
	dst.prev = &moved
	delete(s.terms, from)
	return true, nil
}

// write writes addr's current generation.
func (s *store) write(m meta, data []byte) error {
	m.Bytes = int64(len(data))
	st := s.terms[m.Terminal]
	if st == nil {
		st = &stored{}
		s.terms[m.Terminal] = st
	}
	err := s.change(true, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO history_snapshots (terminal, prev, pid, at, lines, cols, grid_rows, bytes, hash, days, restored, data)
			VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (terminal, prev) DO UPDATE SET pid = excluded.pid, at = excluded.at, lines = excluded.lines,
				cols = excluded.cols, grid_rows = excluded.grid_rows, bytes = excluded.bytes, hash = excluded.hash,
				days = excluded.days, restored = excluded.restored, data = excluded.data`,
			m.Terminal, m.PID, m.At, m.Lines, m.Cols, m.Rows, m.Bytes, m.Hash, m.Days, m.Restored, data)
		return err
	})
	if err != nil {
		// Nothing changed: the generation before stays.
		if st.cur == nil && st.prev == nil {
			delete(s.terms, m.Terminal)
		}
		return err
	}
	st.cur = &m
	return nil
}

// clearAll removes every terminal's snapshots and returns how many
// terminals had some; one that fails removes nothing.
func (s *store) clearAll() (int, error) {
	n := len(s.terms)
	err := s.change(false, func(tx *sql.Tx) error {
		_, err := tx.Exec("DELETE FROM history_snapshots")
		return err
	})
	if err != nil {
		return 0, err
	}
	clear(s.terms)
	return n, nil
}

func clamp[T int | int64](v, lo, hi T) T { return max(lo, min(v, hi)) }

// importFiles imports the snapshots kept below base before the database,
// in <base>/history, once: every whole generation (a .json and a .vt of
// the size it gives, regular files) of a valid address, unless the
// database has that generation captured later; what is not whole, links
// and temporary files are left out. Once the import committed (now
// or before), the directory is removed; a failed import leaves it. A
// directory that is a link or another user's is neither read nor removed.
func importFiles(db *dbstore.DB, base string) {
	dir := path.Join(base, dirName)
	st, err := os.Lstat(dir)
	if err != nil || !st.IsDir() {
		return
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); !ok || int(sys.Uid) != os.Getuid() {
		return
	}
	_, err = db.Import(context.Background(), feature, "files", func(tx *sql.Tx) error {
		ents, err := readDirNames(dir)
		if err != nil {
			return err
		}
		for _, name := range ents {
			addr, prev, ext, ok := parseName(name)
			if !ok || ext != ".json" {
				continue
			}
			m := readMeta(dir, addr, prev)
			if m == nil {
				continue
			}
			data, err := readRegular(path.Join(dir, fileName(addr, prev, ".vt")), agentproto.HistoryMaxBytes)
			if err != nil || int64(len(data)) != m.Bytes {
				continue
			}
			// A generation the database has already, captured later (after
			// an import that failed), stays.
			if _, err := tx.Exec(`INSERT INTO history_snapshots (terminal, prev, pid, at, lines, cols, grid_rows, bytes, hash, days, restored, data)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (terminal, prev) DO UPDATE SET pid = excluded.pid, at = excluded.at, lines = excluded.lines,
					cols = excluded.cols, grid_rows = excluded.grid_rows, bytes = excluded.bytes, hash = excluded.hash,
					days = excluded.days, restored = excluded.restored, data = excluded.data
				WHERE excluded.at > history_snapshots.at`,
				addr, prev, m.PID, m.At, m.Lines, m.Cols, m.Rows, m.Bytes, m.Hash, m.Days, m.Restored, data); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return
	}
	os.RemoveAll(dir)
}

// readDirNames lists a directory's names (at most maxEntries), sorted.
func readDirNames(dir string) ([]string, error) {
	d, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer d.Close()
	names, err := d.Readdirnames(maxEntries)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	sort.Strings(names)
	return names, nil
}

// fileName is a former generation's file: ext is ".vt" or ".json".
func fileName(addr string, prev bool, ext string) string {
	if prev {
		return addr + ".prev" + ext
	}
	return addr + ext
}

// parseName tells which former generation's file name is: its address,
// whether it is the previous generation's and its extension; ok false for
// a name of no generation.
func parseName(name string) (addr string, prev bool, ext string, ok bool) {
	for _, e := range []string{".json", ".vt"} {
		if base, found := strings.CutSuffix(name, e); found {
			addr, prev = strings.CutSuffix(base, ".prev")
			return addr, prev, e, agentproto.ValidHistoryTerminal(addr)
		}
	}
	return "", false, "", false
}

// readMeta reads the .json of a former generation whose files are whole,
// nil otherwise.
func readMeta(dir, addr string, prev bool) *meta {
	b, err := readRegular(path.Join(dir, fileName(addr, prev, ".json")), maxMeta)
	if err != nil {
		return nil
	}
	var m meta
	if json.Unmarshal(b, &m) != nil || m.Terminal != addr || !m.valid() {
		return nil
	}
	st, err := os.Lstat(path.Join(dir, fileName(addr, prev, ".vt")))
	if err != nil || !st.Mode().IsRegular() || st.Size() != m.Bytes {
		return nil
	}
	return &m
}

// readRegular reads a regular file of at most max bytes, without following
// a link and without waiting on a special file.
func readRegular(p string, max int64) ([]byte, error) {
	return readFile(p, max, syscall.O_NOFOLLOW)
}

// readFile reads a regular file of at most max bytes, opened with flags
// added, without waiting on a special file (O_NONBLOCK: opening a FIFO
// returns at once and the file is then refused).
func readFile(p string, max int64, flags int) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NONBLOCK|flags, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("history: not a regular file")
	}
	if st.Size() > max {
		return nil, errors.New("history: file too large")
	}
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errors.New("history: file too large")
	}
	return b, nil
}
