//go:build unix

package history

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"herdr-ide/internal/agentproto"
)

// The snapshots live in <data dir>/history (0700), per terminal address:
// <address>.vt with the bytes and <address>.json with what describes them
// (meta), and <address>.prev.vt and <address>.prev.json for the previous
// generation. Every file is 0600 and written as a temporary file renamed
// over the old one. A generation exists for readers while its .json does
// and its .vt has the size the .json gives: a writer removes the .json
// first and puts it back last. Writers (capture, clear, the agent's
// housekeeping) hold the directory's lock, .lock, which two agents of the
// same instance (two cores that reach the machine) share; readers (list,
// read) take no lock.

const (
	dirName  = "history"
	lockName = ".lock"
	// tmpSuffix ends the temporary files, which start with a dot as no
	// address does.
	tmpSuffix = ".tmp"
	// tmpMaxAge: a temporary file older than this is left over from an
	// agent that ended while it wrote.
	tmpMaxAge = time.Hour
	// maxMeta bounds a .json file.
	maxMeta = 64 << 10
	// maxEntries bounds the directory entries one scan looks at.
	maxEntries = 4096
)

// meta is a generation's .json.
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

// stored are a terminal's generations on disk; either may be nil.
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

// store is the directory and, for a writer that holds its lock, what it
// holds.
type store struct {
	dir   string
	terms map[string]*stored
	lock  *os.File
}

// fileName is a generation's file: ext is ".vt" or ".json".
func fileName(addr string, prev bool, ext string) string {
	if prev {
		return addr + ".prev" + ext
	}
	return addr + ext
}

// historyDir is the snapshots' directory below the agent's data directory
// base, created 0700 when missing. It must be a directory of this user,
// not a link; one others may access is made 0700.
func historyDir(base string) (string, error) {
	if base == "" || !path.IsAbs(base) {
		return "", errors.New("history: no data directory")
	}
	dir := path.Join(base, dirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	st, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !st.IsDir() || !ok || int(sys.Uid) != os.Getuid() {
		return "", errors.New("history: the snapshots' directory is not a directory of this user")
	}
	if st.Mode().Perm() != 0o700 {
		if err := os.Chmod(dir, 0o700); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// errBusy: another writer holds the directory's lock.
var errBusy = errors.New("history: another capture is running")

// lockDir takes the directory's lock: at once or errBusy without wait,
// else retrying until ctx ends.
func lockDir(ctx context.Context, dir string, wait bool) (*os.File, error) {
	f, err := os.OpenFile(path.Join(dir, lockName), os.O_RDWR|os.O_CREATE|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return f, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			f.Close()
			return nil, err
		}
		if !wait {
			f.Close()
			return nil, errBusy
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// openStore takes the lock of the snapshots' directory below base and
// reads what it holds: generations that are not whole (a .json without
// its .vt or of another size, a .vt without its .json, a file that is not
// a regular one) and temporary files older than tmpMaxAge are removed.
// removed counts the terminals that lost a generation so.
func openStore(ctx context.Context, base string, wait bool, now time.Time) (s *store, removed int, err error) {
	dir, err := historyDir(base)
	if err != nil {
		return nil, 0, err
	}
	lock, err := lockDir(ctx, dir, wait)
	if err != nil {
		return nil, 0, err
	}
	s = &store{dir: dir, terms: map[string]*stored{}, lock: lock}
	removed = s.scan(now)
	return s, removed, nil
}

// close releases the lock.
func (s *store) close() {
	if s.lock != nil {
		s.lock.Close()
		s.lock = nil
	}
}

// entries lists the directory's names (at most maxEntries).
func entries(dir string) []fs.DirEntry {
	d, err := os.Open(dir)
	if err != nil {
		return nil
	}
	defer d.Close()
	ents, _ := d.ReadDir(maxEntries)
	return ents
}

// parseName tells which generation's file name is: its address, whether
// it is the previous generation's and its extension; ok false for a name
// of no generation.
func parseName(name string) (addr string, prev bool, ext string, ok bool) {
	for _, e := range []string{".json", ".vt"} {
		if base, found := strings.CutSuffix(name, e); found {
			addr, prev = strings.CutSuffix(base, ".prev")
			return addr, prev, e, agentproto.ValidHistoryTerminal(addr)
		}
	}
	return "", false, "", false
}

// scan reads the directory into s.terms and removes what is not whole.
func (s *store) scan(now time.Time) int {
	type pair struct{ json, vt bool }
	seen := map[string]*[2]pair{}
	broken := map[string]bool{}
	for _, e := range entries(s.dir) {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			if strings.HasSuffix(name, tmpSuffix) {
				if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > tmpMaxAge {
					os.Remove(path.Join(s.dir, name))
				}
			}
			continue
		}
		addr, prev, ext, ok := parseName(name)
		if !ok {
			continue
		}
		if !e.Type().IsRegular() {
			// Not written here: a link or a special file is removed, not
			// followed (a directory stays).
			if !e.IsDir() {
				os.Remove(path.Join(s.dir, name))
				broken[addr] = true
			}
			continue
		}
		p := seen[addr]
		if p == nil {
			p = &[2]pair{}
			seen[addr] = p
		}
		i := 0
		if prev {
			i = 1
		}
		if ext == ".json" {
			p[i].json = true
		} else {
			p[i].vt = true
		}
	}
	removed := 0
	addrs := make([]string, 0, len(seen))
	for a := range seen {
		addrs = append(addrs, a)
	}
	sort.Strings(addrs)
	for _, addr := range addrs {
		p := seen[addr]
		st := &stored{}
		lost := broken[addr]
		for i, prev := range []bool{false, true} {
			if !p[i].json && !p[i].vt {
				continue
			}
			g := s.readGen(addr, prev)
			if g == nil {
				s.removeFiles(addr, prev)
				lost = true
				continue
			}
			if prev {
				st.prev = g
			} else {
				st.cur = g
			}
		}
		if st.cur != nil || st.prev != nil {
			s.terms[addr] = st
		}
		if lost {
			removed++
		}
	}
	for addr := range broken {
		if seen[addr] == nil {
			removed++
		}
	}
	return removed
}

// readGen reads a generation whose files are whole, nil otherwise.
func (s *store) readGen(addr string, prev bool) *meta {
	return readMeta(s.dir, addr, prev)
}

// readMeta reads the .json of a generation whose files are whole, nil
// otherwise.
func readMeta(dir, addr string, prev bool) *meta {
	b, err := readRegular(path.Join(dir, fileName(addr, prev, ".json")), maxMeta)
	if err != nil {
		return nil
	}
	var m meta
	if json.Unmarshal(b, &m) != nil || m.Terminal != addr || m.Bytes < 0 || m.Bytes > agentproto.HistoryMaxBytes || m.At <= 0 {
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

// removeFiles removes a generation's files: its .json first, so readers
// no longer take it while its .vt goes.
func (s *store) removeFiles(addr string, prev bool) {
	os.Remove(path.Join(s.dir, fileName(addr, prev, ".json")))
	os.Remove(path.Join(s.dir, fileName(addr, prev, ".vt")))
}

// removeGen removes one generation.
func (s *store) removeGen(addr string, prev bool) {
	st := s.terms[addr]
	if st == nil {
		return
	}
	s.removeFiles(addr, prev)
	if prev {
		st.prev = nil
	} else {
		st.cur = nil
	}
	if st.cur == nil && st.prev == nil {
		delete(s.terms, addr)
	}
}

// remove removes a terminal's snapshots; false when it had none.
func (s *store) remove(addr string) bool {
	if s.terms[addr] == nil {
		return false
	}
	s.removeGen(addr, false)
	s.removeGen(addr, true)
	return true
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
// returns the terminals that lost one.
func (s *store) pruneAge(now time.Time, days int) int {
	removed := 0
	for addr, st := range s.terms {
		lost := false
		for _, prev := range []bool{false, true} {
			if m := st.gen(prev); m != nil && expired(m, now, days) {
				s.removeGen(addr, prev)
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
// how many went.
func (s *store) fit(maxTerminals int, maxTotal int64, keep map[string]bool) int {
	evicted := 0
	for len(s.terms) > maxTerminals || s.total() > maxTotal {
		victim := s.oldest(keep)
		if victim == "" {
			break
		}
		s.evict(victim)
		evicted++
	}
	return evicted
}

// evict removes a terminal's snapshots for the limits, remembering the
// screen its current one was of (evictions).
func (s *store) evict(addr string) {
	if st := s.terms[addr]; st != nil && st.cur != nil {
		evictions.set(addr, screenKey(st.cur.PID, st.cur.Hash))
	}
	s.remove(addr)
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
// maxTotal. ok is false when the generation does not fit.
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
			s.evict(victim)
			evicted++
			continue
		}
		if total > maxTotal && mine != nil && mine.prev != nil && n+mine.prev.Bytes > maxTotal {
			s.removeGen(addr, true)
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
	s.removeFiles(addr, true)
	st.prev = nil
	if err := os.Rename(path.Join(s.dir, fileName(addr, false, ".vt")), path.Join(s.dir, fileName(addr, true, ".vt"))); err != nil {
		s.removeGen(addr, false)
		return err
	}
	if err := os.Rename(path.Join(s.dir, fileName(addr, false, ".json")), path.Join(s.dir, fileName(addr, true, ".json"))); err != nil {
		s.removeFiles(addr, true)
		s.removeGen(addr, false)
		return err
	}
	st.prev, st.cur = st.cur, nil
	return nil
}

// adopt makes the newest generation of from (its current, else its
// previous) the previous generation of to, unless to has a previous one
// captured later, and removes from's snapshots either way; false when
// nothing moved. Readers stop taking each generation (its .json goes)
// before its files change, and take the moved one once its .json is back.
func (s *store) adopt(from, to string) (bool, error) {
	src := s.terms[from]
	if src == nil {
		return false, nil
	}
	prev := src.cur == nil
	m := src.gen(prev)
	if dst := s.terms[to]; dst != nil && dst.prev != nil && dst.prev.At > m.At {
		s.remove(from)
		return false, nil
	}
	moved := *m
	moved.Terminal = to
	b, err := json.Marshal(moved)
	if err != nil {
		s.remove(from)
		return false, err
	}
	js, err := writeTemp(s.dir, fileName(to, true, ".json"), b)
	if err != nil {
		s.remove(from)
		return false, err
	}
	s.removeGen(to, true)
	os.Remove(path.Join(s.dir, fileName(from, prev, ".json")))
	if err := os.Rename(path.Join(s.dir, fileName(from, prev, ".vt")), path.Join(s.dir, fileName(to, true, ".vt"))); err != nil {
		os.Remove(js)
		s.remove(from)
		return false, err
	}
	if err := os.Rename(js, path.Join(s.dir, fileName(to, true, ".json"))); err != nil {
		os.Remove(js)
		os.Remove(path.Join(s.dir, fileName(to, true, ".vt")))
		s.remove(from)
		return false, err
	}
	dst := s.terms[to]
	if dst == nil {
		dst = &stored{}
		s.terms[to] = dst
	}
	dst.prev = &moved
	// The moved generation's files are to's now: only from's other one is
	// left to remove.
	if prev {
		src.prev = nil
	} else {
		src.cur = nil
	}
	if src.cur == nil && src.prev == nil {
		delete(s.terms, from)
	}
	s.remove(from)
	syncDir(s.dir)
	return true, nil
}

// write writes addr's current generation.
func (s *store) write(m meta, data []byte) error {
	m.Bytes = int64(len(data))
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	vt, err := writeTemp(s.dir, fileName(m.Terminal, false, ".vt"), data)
	if err != nil {
		return err
	}
	js, err := writeTemp(s.dir, fileName(m.Terminal, false, ".json"), b)
	if err != nil {
		os.Remove(vt)
		return err
	}
	st := s.terms[m.Terminal]
	if st == nil {
		st = &stored{}
		s.terms[m.Terminal] = st
	}
	// Readers stop taking the old generation before its bytes change.
	os.Remove(path.Join(s.dir, fileName(m.Terminal, false, ".json")))
	st.cur = nil
	if err := os.Rename(vt, path.Join(s.dir, fileName(m.Terminal, false, ".vt"))); err != nil {
		os.Remove(vt)
		os.Remove(js)
		s.removeGen(m.Terminal, false)
		return err
	}
	if err := os.Rename(js, path.Join(s.dir, fileName(m.Terminal, false, ".json"))); err != nil {
		os.Remove(js)
		s.removeGen(m.Terminal, false)
		return err
	}
	st.cur = &m
	syncDir(s.dir)
	return nil
}

// writeTemp writes data to a new temporary file (0600) in dir for the file
// name and returns its path. Its content is flushed to disk: a snapshot
// matters most after the machine lost its power.
func writeTemp(dir, name string, data []byte) (string, error) {
	var r [6]byte
	rand.Read(r[:])
	p := path.Join(dir, "."+name+"."+hex.EncodeToString(r[:])+tmpSuffix)
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return "", err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(p)
		return "", err
	}
	return p, nil
}

// syncDir flushes the directory's entries (the renames).
func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
}

// clearAll removes every terminal's snapshots and returns how many
// terminals had some.
func (s *store) clearAll() int {
	n := 0
	for addr := range s.terms {
		if s.remove(addr) {
			n++
		}
	}
	return n
}

func clamp[T int | int64](v, lo, hi T) T { return max(lo, min(v, hi)) }
