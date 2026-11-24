package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

// Shared databases. The core's database (core.db, beside its settings
// file) and a machine's (machine-<host>.db, HostFile, in the agent's data
// directory) hold
// the state of several features of one owner. Such a database is opened
// with OpenShared: its user_version is the store's own layout (layout: the
// features' schema versions and their one-time imports), and each feature
// brings its own tables, named with the feature's name as their prefix, to
// its version with Migrate, independently of the other features. A feature
// whose tables a newer program migrated further reads them and does not
// write (Migrate's ErrNewer); so does every feature of a database whose
// layout is newer (OpenShared's ErrNewer).
//
// A process opens a shared database once: OpenShared hands out a handle
// of the connection pool it already has open on that file, and the pool
// closes with its last handle. An owner that keeps a handle while it runs
// (the core's server) makes every feature's use of the database take the
// open pool.

// MachineDB is the name of a machine's shared database in its agent's
// data directory, which is kept per host (HostFile:
// ~/.<slug>[-<instance>]/machine-<host>.db). The core's is core.db beside
// its settings file (internal/plugin's CoreDBFile).
const MachineDB = "machine.db"

// layout is the store's own tables of a shared database, versioned by its
// user_version: what each feature migrated to. (store_imports recorded
// one-time imports of files features kept before; the second step drops
// it.)
var layout = []string{
	`CREATE TABLE store_features (
		feature TEXT PRIMARY KEY,
		version INTEGER NOT NULL
	);
	CREATE TABLE store_imports (
		feature TEXT NOT NULL,
		name TEXT NOT NULL,
		at INTEGER NOT NULL,
		PRIMARY KEY (feature, name)
	);`,
	`DROP TABLE IF EXISTS store_imports;`,
}

// ErrNotShared is the error of Migrate on a database that was
// not opened with OpenShared.
var ErrNotShared = errors.New("store: not a shared database")

// pool is a shared database's connection pool and its handles.
type pool struct {
	path     string
	db       *sql.DB
	readOnly bool
	version  int
	// file is the database's file when the pool opened it: a file removed
	// or replaced since is opened again.
	file os.FileInfo
	refs int
}

var shared = struct {
	sync.Mutex
	pools map[string]*pool
}{pools: map[string]*pool{}}

// OpenShared opens the shared database at path, an absolute path, as Open
// does (creating it and its directory, private to the user), with the
// store's layout; or hands out another handle of the pool this process
// has open on it. Close releases the handle. For a database whose layout
// is newer it returns the database read-only and ErrNewer, as Open. A
// directory that is a link of the user's to a directory of the user's is
// taken as its target (resolveDir).
func OpenShared(path string) (*DB, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("store: %q is not an absolute path", path)
	}
	path = resolveDir(filepath.Clean(path))
	shared.Lock()
	defer shared.Unlock()
	st, err := os.Lstat(path)
	if p := shared.pools[path]; p != nil {
		if err == nil && os.SameFile(st, p.file) {
			p.refs++
			return p.handle()
		}
		// The file went or was replaced: its holders keep the old pool
		// until they close it.
		delete(shared.pools, path)
	}
	if err == nil {
		// The same file by another path (a link above it).
		for _, p := range shared.pools {
			if os.SameFile(st, p.file) {
				p.refs++
				return p.handle()
			}
		}
	}
	db, err := Open(path, Options{Migrations: layout})
	if db == nil {
		return nil, err
	}
	st, serr := os.Lstat(path)
	if serr != nil {
		db.DB.Close()
		return nil, serr
	}
	p := &pool{path: path, db: db.DB, readOnly: db.readOnly, version: db.version, file: st, refs: 1}
	shared.pools[path] = p
	return p.handle()
}

// resolveDir is path in the directory its directory links to, when that
// directory is a symbolic link of this user's to a directory of this
// user's: the configuration or data directory a dotfile manager linked,
// which Open would refuse. Any other path is path (and Open decides).
func resolveDir(path string) string {
	dir := filepath.Dir(path)
	st, err := os.Lstat(dir)
	if err != nil || st.Mode()&os.ModeSymlink == 0 || !modeBits {
		return path
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return path
	}
	rst, err := os.Lstat(real)
	if err != nil || !rst.IsDir() || !owned(rst) || !owned(st) {
		return path
	}
	return filepath.Join(real, filepath.Base(path))
}

// handle is a new handle of p; ErrNewer with a read-only pool.
func (p *pool) handle() (*DB, error) {
	h := &DB{DB: p.db, readOnly: p.readOnly, version: p.version, pool: p}
	if p.readOnly {
		return h, fmt.Errorf("%w (layout %d, the code knows %d)", ErrNewer, p.version, len(layout))
	}
	return h, nil
}

// release closes handle h of p, and p with its last handle.
func (p *pool) release(h *DB) error {
	shared.Lock()
	defer shared.Unlock()
	if h.closed {
		return nil
	}
	h.closed = true
	p.refs--
	if p.refs > 0 {
		return nil
	}
	if shared.pools[p.path] == p {
		delete(shared.pools, p.path)
	}
	return p.db.Close()
}

// Close closes the database; a handle of a shared database (OpenShared)
// is released, and the pool closes with its last handle.
func (db *DB) Close() error {
	if db.pool == nil {
		return db.DB.Close()
	}
	return db.pool.release(db)
}

var validFeature = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

// Migrate brings feature's tables in a shared database to the version of
// steps (SQL, in order: steps[i] takes the feature from version i to i+1;
// a released step is never changed, a change is a new one at the end), in
// one transaction, each step once, and returns the feature's version.
// ErrNewer, with the feature's version, when the feature's tables are of a
// version above the code's or the database is read-only: the feature then
// reads its tables (when its version is the code's or above) and does not
// write.
func (db *DB) Migrate(feature string, steps []string) (int, error) {
	if db.pool == nil {
		return 0, ErrNotShared
	}
	if !validFeature.MatchString(feature) {
		return 0, fmt.Errorf("store: bad feature name %q", feature)
	}
	ctx := context.Background()
	version, err := featureVersion(ctx, db.DB, feature)
	if err != nil {
		return 0, err
	}
	switch {
	case version > len(steps):
		return version, fmt.Errorf("%w (%s %d, the code knows %d)", ErrNewer, feature, version, len(steps))
	case db.readOnly:
		return version, fmt.Errorf("%w (the database is read-only)", ErrNewer)
	case version == len(steps):
		return version, nil
	}
	tx, err := db.BeginTx(ctx, nil) // IMMEDIATE: one migrating writer at a time
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	// Another connection may have migrated since the first look.
	if version, err = featureVersion(ctx, tx, feature); err != nil {
		return 0, err
	}
	if version > len(steps) {
		return version, fmt.Errorf("%w (%s %d, the code knows %d)", ErrNewer, feature, version, len(steps))
	}
	if version == len(steps) {
		return version, nil
	}
	for i := version; i < len(steps); i++ {
		if _, err := tx.ExecContext(ctx, steps[i]); err != nil {
			return 0, fmt.Errorf("store: %s migration %d: %w", feature, i+1, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO store_features (feature, version) VALUES (?, ?)
		ON CONFLICT (feature) DO UPDATE SET version = excluded.version`, feature, len(steps)); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(steps), nil
}

type queryRower interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func featureVersion(ctx context.Context, q queryRower, feature string) (int, error) {
	var v int
	err := q.QueryRowContext(ctx, "SELECT version FROM store_features WHERE feature = ?", feature).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return v, err
}

// Update runs fn in a transaction, which takes the database's write lock
// when it begins (IMMEDIATE), and commits it unless fn fails.
func (db *DB) Update(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// Durable is Update for what must survive the computer's loss of power
// once Durable returned: its connection syncs the commit to disk
// (synchronous FULL; the others, NORMAL, may lose their last transactions
// then).
func (db *DB) Durable(ctx context.Context, fn func(tx *sql.Tx) error) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "PRAGMA synchronous = FULL"); err != nil {
		return err
	}
	// The connection goes back to the pool as the others are.
	defer conn.ExecContext(context.Background(), "PRAGMA synchronous = NORMAL")
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// Exists reports whether there is a file at path (a database that a read
// would not create).
func Exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// reclaimMin is the least free space Reclaim gives back.
const reclaimMin = 8 << 20

// Reclaim gives the database's free pages back to the file system when
// they are many (at least reclaimMin bytes and a quarter of the file), so
// that a database whose rows went (expired, cleared, evicted) does not
// keep its largest size; fewer are left for the next rows. A database
// created before incremental vacuuming keeps them.
func (db *DB) Reclaim() error {
	if db.readOnly {
		return nil
	}
	var free, pages, size int64
	if err := db.QueryRow("PRAGMA freelist_count").Scan(&free); err != nil {
		return err
	}
	if err := db.QueryRow("PRAGMA page_count").Scan(&pages); err != nil {
		return err
	}
	if err := db.QueryRow("PRAGMA page_size").Scan(&size); err != nil {
		return err
	}
	if free*size < reclaimMin || free*4 < pages {
		return nil
	}
	_, err := db.Exec("PRAGMA incremental_vacuum")
	return err
}
