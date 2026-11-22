package store

import (
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

// HostFile is the database name of this host in dir: name with the host's
// name before its extension (machine.db → <dir>/machine-<host>.db; a name
// without an extension gets -<host> at its end). The host's name is its
// first label, lowercase, with what is not a letter, a digit, - or _
// replaced by _, at most 63 bytes, "localhost" when the system gives none.
func HostFile(dir, name string) string {
	return filepath.Join(dir, hostFileName(name, thisHost()))
}

// thisHost is this host's name as database names have it (hostLabel).
var thisHost = sync.OnceValue(func() string {
	h, _ := os.Hostname()
	return hostLabel(h)
})

// hostFileName is name with host before its extension.
func hostFileName(name, host string) string {
	ext := filepath.Ext(name)
	return strings.TrimSuffix(name, ext) + "-" + host + ext
}

// hostLabel is the first label of host name h, lowercase, with what is not
// a letter, a digit, - or _ replaced by _, at most 63 bytes; "localhost"
// for none.
func hostLabel(h string) string {
	h, _, _ = strings.Cut(strings.TrimSpace(h), ".")
	h = strings.ToLower(h)
	var b strings.Builder
	for _, r := range h {
		if b.Len() >= 63 {
			break
		}
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "localhost"
	}
	return b.String()
}

// HostFileRetention is how long another host's database stays unopened
// before PruneHostFiles removes it.
const HostFileRetention = 30 * 24 * time.Hour

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
	var removed []string
	for _, n := range names {
		if n == mine {
			continue
		}
		if n != name {
			host, ok := strings.CutPrefix(n, stem)
			if !ok {
				continue
			}
			if host, ok = strings.CutSuffix(host, ext); !ok || host == "" || hostLabel(host) != host {
				continue
			}
		}
		p := filepath.Join(dir, n)
		if !stale(p, retention, now) || openHere(p) {
			continue
		}
		ok, err := removeUnheld(p, func() bool { return stale(p, retention, now) })
		if err != nil {
			return removed, err
		}
		if ok {
			removed = append(removed, n)
		}
	}
	return removed, nil
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

// usedEvery is how often Open marks a database used (its modification
// time) at most.
const usedEvery = time.Hour

// markUsed sets the modification time of the database file at p to now
// when it is older than usedEvery: PruneHostFiles counts its retention
// from it.
func markUsed(p string) {
	st, err := os.Lstat(p)
	if err != nil {
		return
	}
	if now := time.Now(); now.Sub(st.ModTime()) >= usedEvery {
		os.Chtimes(p, now, now)
	}
}
