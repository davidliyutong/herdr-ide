package store

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// Databases kept per host. A data directory may be on a home that several
// hosts share (NFS): SQLite's write-ahead logging needs every connection
// of a database on one host (its -shm file is shared memory), so a
// database a process of a machine owns (the agent's machine database, the
// chat host's) is named after the host it runs on: HostFile. The databases
// other hosts left go with PruneHostFiles.

// HostFile is the database name of this host in dir: name with this host's
// key before its extension (machine.db → <dir>/machine-<host>.db; a name
// without an extension gets -<host> at its end). The key is the host's
// whole name (hostName) and, when the system has one, a hash of its
// machine id (machineID): two hosts of one name (cloned machines, or
// node01 of two clusters that share a home) do not share a database.
func HostFile(dir, name string) string {
	return filepath.Join(dir, hostFileName(name, thisHost()))
}

// thisHost is this host's key as database names have it: hostName, and
// "-" with the first 8 hex digits of the SHA-256 of the machine id when
// there is one. The id is hashed (systemd asks programs not to show it),
// with a prefix of the store's own, so that the hash names no id
// elsewhere. Without an id (a container without /etc/machine-id) the key
// is the host's name alone.
var thisHost = sync.OnceValue(func() string {
	h, _ := os.Hostname()
	return hostKey(h, machineID())
})

// hostKey is the key of host name h with machine id id ("" for none).
func hostKey(h, id string) string {
	key := hostName(h)
	if id = strings.TrimSpace(id); id != "" {
		sum := sha256.Sum256([]byte("store host\x00" + id))
		key += "-" + hex.EncodeToString(sum[:4])
	}
	return key
}

// hostFileName is name with host before its extension.
func hostFileName(name, host string) string {
	ext := filepath.Ext(name)
	return strings.TrimSuffix(name, ext) + "-" + host + ext
}

// maxHostName is the length of a host's name in database names at most:
// with the hash and a database's name, a file name stays far below the
// 255 bytes file systems take.
const maxHostName = 128

// hostName is host name h as database names have it: the whole name,
// lowercase, with what is not a letter, a digit, -, _ or . replaced by _,
// without dots at its ends, at most maxHostName bytes; "localhost" for
// none.
func hostName(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	var b strings.Builder
	for _, r := range h {
		if b.Len() >= maxHostName {
			break
		}
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	if n := strings.Trim(b.String(), "."); n != "" {
		return n
	}
	return "localhost"
}

// validHostKey reports whether key may be a host's key in a database name
// (thisHost of some host, or of an earlier version: the host's first
// label): of the letters, digits, -, _ and . hostName leaves, without a
// dot at its ends, at most as long as a name and a hash.
func validHostKey(key string) bool {
	if key == "" || len(key) > maxHostName+9 || key[0] == '.' || key[len(key)-1] == '.' {
		return false
	}
	for _, r := range key {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

// HostFileRetention is how long another host's database stays unopened
// before PruneHostFiles removes it.
const HostFileRetention = 30 * 24 * time.Hour

// LegacyFileRetention is how long a legacy un-hosted file (from before
// per-host naming) stays unopened once this host has its own per-host file
// (or for non-database files such as logs) before PruneHostFiles removes it.
const LegacyFileRetention = time.Hour

// maxDirEntries bounds the entries of a data directory PruneHostFiles
// looks at.
const maxDirEntries = 4096

// journals are the files SQLite keeps beside a database.
var journals = []string{"-wal", "-shm", "-journal"}

// PruneHostFiles removes from dir the databases of name (HostFile) of
// other hosts, and name itself (a database of no host's name, from before
// they were named per host), that no process opened for retention and no
// process holds, with their journal files; this host's stays. It returns
// the names of the databases it removed.
//
// A database is opened when its file's modification time is that of its
// last use: Open sets it, at most once an hour, and a write sets it or its
// journal files'. It is held while any process (also on another host, as
// far as the file system's locks reach) has it open: SQLite holds a shared
// lock on the database file then (write-ahead logging keeps it while the
// connection is open, between transactions too). A removal takes the
// exclusive lock SQLite's writers take, without waiting, and removes the
// files while it holds it, so that no SQLite connection reads the
// database meanwhile; when the lock cannot be taken (held, or the file
// system has no locks) the database stays. A database whose file or
// journal files are not this user's regular files stays too, and so does
// one this process has open (OpenShared). Without such locks (Windows)
// nothing is removed.
func PruneHostFiles(dir, name string, retention time.Duration, now time.Time) ([]string, error) {
	d, err := os.Open(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	names, err := d.Readdirnames(maxDirEntries)
	d.Close()
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext) + "-"
	mine := hostFileName(name, thisHost())
	mineExists := Exists(filepath.Join(dir, mine))
	otherInstances := coreInstances(names, name)
	var removed []string
	for _, n := range names {
		if n == mine {
			continue
		}
		fileRetention := retention
		if n == name {
			// Legacy un-hosted files are pruned promptly once this host has
			// its own per-host database (migration complete) or for logs.
			if ext != ".db" || mineExists {
				fileRetention = min(retention, LegacyFileRetention)
			}
		} else {
			host, ok := strings.CutPrefix(n, stem)
			if !ok {
				continue
			}
			if host, ok = strings.CutSuffix(host, ext); !ok || !validHostKey(host) {
				continue
			}
			if hasInstancePrefix(host, otherInstances) {
				continue
			}
		}
		p := filepath.Join(dir, n)
		if !stale(p, fileRetention, now) || openHere(p) {
			continue
		}
		ok, err := removeUnheld(p, func() bool { return stale(p, fileRetention, now) })
		if err != nil {
			return removed, err
		}
		if ok {
			removed = append(removed, n)
		}
	}
	return removed, nil
}

// coreInstances finds instance suffixes (e.g. "dev", "desktop") present in
// dir's configuration files so pruning core.db never removes core-<instance>*.db.
func coreInstances(names []string, target string) []string {
	if target != "core.db" {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, n := range names {
		for _, prefix := range []string{"settings-", "vault-", "machines-", "keybindings-"} {
			if rest, ok := strings.CutPrefix(n, prefix); ok {
				if inst, ok := strings.CutSuffix(rest, ".json"); ok && inst != "" && !seen[inst] {
					seen[inst] = true
					out = append(out, inst)
				}
			}
		}
	}
	return out
}

func hasInstancePrefix(host string, instances []string) bool {
	for _, inst := range instances {
		if host == inst || strings.HasPrefix(host, inst+"-") {
			return true
		}
	}
	return false
}

// stale reports whether the database at p and its journal files are this
// user's regular files, none of them modified within retention before
// now.
func stale(p string, retention time.Duration, now time.Time) bool {
	for _, s := range append([]string{""}, journals...) {
		st, err := os.Lstat(p + s)
		if errors.Is(err, fs.ErrNotExist) && s != "" {
			continue
		}
		if err != nil || !st.Mode().IsRegular() || !owned(st) || now.Sub(st.ModTime()) < retention {
			return false
		}
	}
	return true
}

// openHere reports whether this process has the shared database at p open.
func openHere(p string) bool {
	shared.Lock()
	defer shared.Unlock()
	st, err := os.Lstat(p)
	for _, pl := range shared.pools {
		if pl.path == p || err == nil && os.SameFile(st, pl.file) {
			return true
		}
	}
	return false
}

// removeFiles removes the database at p, its journal files first (a
// journal file left without its database would be taken for the journal
// of the next one of the name).
func removeFiles(p string) error {
	for _, s := range append(slices.Clone(journals), "") {
		if err := os.Remove(p + s); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

// usedEvery is how often a database is marked used (its modification
// time) at most: when Open opens it, and while it is open.
const usedEvery = time.Hour

// markUsed sets the modification time of the database file at p to now
// when it is older than usedEvery: PruneHostFiles counts its retention
// from it. Open calls it, and it keeps the database marked while it is
// open (keepMarked).
func markUsed(p string) {
	markOld(p, time.Now())
	keepMarked(p)
}

// markOld sets the modification time of the database file at p to now
// when it is older than usedEvery.
func markOld(p string, now time.Time) {
	st, err := os.Lstat(p)
	if err != nil || !st.Mode().IsRegular() {
		return
	}
	if now.Sub(st.ModTime()) >= usedEvery {
		os.Chtimes(p, now, now)
	}
}

// maxMarked bounds the databases a process keeps marked: a process opens
// a few (its own, and in the tests one per test).
const maxMarked = 256

// markGrace is how long a database keepMarked took stays kept before
// refreshMarked looks at whether it is open: Open takes it before it opens
// the database.
const markGrace = time.Minute

// marked are the databases this process opened, with when, which it marks
// used every usedEvery while they are open (refreshMarked); the timer runs
// from the first one on.
var marked = struct {
	sync.Mutex
	paths map[string]time.Time
	timer sync.Once
}{paths: map[string]time.Time{}}

// keepMarked has the database at p marked used every usedEvery while it is
// open: a database a process holds open for longer than the retention
// without writing would otherwise look unused to another host's
// PruneHostFiles, which then removes it when the file system's locks do
// not reach across hosts (a home on NFS without a lock manager).
func keepMarked(p string) {
	marked.Lock()
	if _, ok := marked.paths[p]; ok || len(marked.paths) < maxMarked {
		marked.paths[p] = time.Now()
	}
	marked.Unlock()
	marked.timer.Do(func() {
		go func() {
			t := time.NewTicker(usedEvery)
			defer t.Stop()
			for now := range t.C {
				refreshMarked(now)
			}
		}()
	})
}

// refreshMarked marks the databases of keepMarked that are open used, and
// forgets those that are not, once taken markGrace before now (a later
// Open has them marked again). A
// database is open while its write-ahead log is there: every database of
// the store uses write-ahead logging, which SQLite creates with the first
// connection and removes when the last one closes; only processes of this
// host open its databases (HostFile), so the log says that this process
// or another of this host has it open. A log left by a process that
// crashed keeps its database marked while this process runs.
func refreshMarked(now time.Time) {
	marked.Lock()
	paths := make(map[string]time.Time, len(marked.paths))
	for p, at := range marked.paths {
		paths[p] = at
	}
	marked.Unlock()
	for p, at := range paths {
		if st, err := os.Lstat(p + "-wal"); err == nil && st.Mode().IsRegular() {
			markOld(p, now)
			continue
		}
		if now.Sub(at) < markGrace {
			continue
		}
		marked.Lock()
		if marked.paths[p] == at {
			delete(marked.paths, p)
		}
		marked.Unlock()
	}
}
