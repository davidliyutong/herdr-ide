// Package store opens the SQLite databases that hold the program's state,
// one database per owner (the chat host's, a machine's agent's, the
// core's): no two processes of different roles write one database. It uses
// modernc.org/sqlite, SQLite compiled to Go, so every system the core and
// the agent build for has it without cgo.
//
// A database is a file of this user only: its directory is created 0700
// (an existing one must be a directory of this user, not a link, and is
// made 0700), the file is created 0600 (an existing one must be a regular
// file of this user, not a link, and is made 0600), and SQLite's journal
// files, which it creates with the database's mode, must not be links
// either. On Windows the user's profile's access control list keeps them
// the user's; there the mode bits and owners are not looked at.
//
// A database uses write-ahead logging; every connection waits for
// another's lock (busy_timeout), enforces foreign keys, syncs as
// write-ahead logging allows (synchronous NORMAL: a power loss may lose the
// last transactions, never the database) and begins its transactions
// IMMEDIATE (a writer takes the lock when it begins, so two writers never
// deadlock upgrading); one it creates vacuums incrementally (DB.Reclaim).
// A database's schema is versioned by PRAGMA user_version:
// Options.Migrations, applied in order in one transaction, each version
// once. A database of a version above the code's (written by a newer
// program) is opened read-only, with ErrNewer. A database that several
// features share (OpenShared) versions each feature's tables apart
// instead (Migrate).
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // the "sqlite" driver
)

// Options are how a database is opened.
type Options struct {
	// Migrations are the schema's versions as SQL, in order: Migrations[i]
	// takes a database of user_version i to i+1. A released migration is
	// never changed; a change of the schema is a new one at the end.
	Migrations []string
	// BusyTimeout is how long a statement waits for another connection's
	// lock before it fails (0: DefaultBusyTimeout).
	BusyTimeout time.Duration
}

// DefaultBusyTimeout is Options.BusyTimeout's default.
const DefaultBusyTimeout = 5 * time.Second

// DB is an open database.
type DB struct {
	*sql.DB
	readOnly bool
	version  int
	// pool is the shared database's pool this is a handle of (OpenShared),
	// closed whether the handle was released.
	pool   *pool
	closed bool
}

// ReadOnly reports whether the database was opened read-only (ErrNewer):
// every statement that would write fails.
func (db *DB) ReadOnly() bool { return db.readOnly }

// Version is the database's schema version (its user_version) when it was
// opened.
func (db *DB) Version() int { return db.version }

// ErrNewer is Open's error for a database of a schema version above the
// code's: the database is opened read-only, and Open returns it together
// with this error, for the caller to use or close.
var ErrNewer = errors.New("store: the database is of a newer version")

// ErrUnsafe is Open's error for a database whose directory or file is not
// this user's own: a link, another user's, or not a directory or a
// regular file.
var ErrUnsafe = errors.New("store: not a private file of this user")

// Open opens the database at path, an absolute path, creating it and its
// directory when missing, and brings its schema to the version of
// o.Migrations. For a database of a newer version it returns the database
// opened read-only and ErrNewer.
func Open(path string, o Options) (*DB, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("store: %q is not an absolute path", path)
	}
	path = filepath.Clean(path)
	if err := privateDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	if err := privateFile(path); err != nil {
		return nil, err
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if err := notLink(path + suffix); err != nil {
			return nil, err
		}
	}
	timeout := o.BusyTimeout
	if timeout <= 0 {
		timeout = DefaultBusyTimeout
	}
	db, err := open(path, timeout, false)
	if err != nil {
		return nil, err
	}
	version, err := migrate(db, o.Migrations)
	if errors.Is(err, ErrNewer) {
		db.Close()
		ro, rerr := open(path, timeout, true)
		if rerr != nil {
			return nil, rerr
		}
		return &DB{DB: ro, readOnly: true, version: version}, fmt.Errorf("%w (%d, the code knows %d)", ErrNewer, version, len(o.Migrations))
	}
	if err != nil {
		db.Close()
		return nil, err
	}
	return &DB{DB: db, version: version}, nil
}

// dsn is the URI of the database at path with the connections' settings.
func dsn(path string, timeout time.Duration, readOnly bool) string {
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // a Windows drive: file:///C:/...
	}
	q := url.Values{}
	q.Set("_busy_timeout", strconv.FormatInt(timeout.Milliseconds(), 10))
	q.Set("_synchronous", "NORMAL")
	q.Set("_foreign_keys", "1")
	q.Set("_txlock", "immediate")
	// A database created here gives the pages its rows freed back when
	// asked (DB.Reclaim); one created before keeps them for later rows.
	q.Set("_pragma", "auto_vacuum(INCREMENTAL)")
	if readOnly {
		q.Set("_query_only", "1")
	}
	u := url.URL{Scheme: "file", Path: p, RawQuery: q.Encode()}
	return u.String()
}

// open opens the database's connection pool and, for writing, puts the
// database in write-ahead logging (which lasts in the file). Switching the
// journal mode can fail busy without waiting while another program opens
// the same database: open tries again until timeout.
func open(path string, timeout time.Duration, readOnly bool) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dsn(path, timeout, readOnly))
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		err = db.Ping()
		if err == nil && !readOnly {
			_, err = db.Exec("PRAGMA journal_mode = WAL")
		}
		if err == nil || !busy(err) || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("store: %s: %w", filepath.Base(path), err)
	}
	return db, nil
}

// busy reports whether err is SQLite's SQLITE_BUSY or SQLITE_LOCKED, with
// any of their extended codes.
func busy(err error) bool {
	var e interface{ Code() int }
	if !errors.As(err, &e) {
		return false
	}
	code := e.Code() & 0xff
	return code == 5 || code == 6
}

// migrate brings the database to the version of migrations in one
// transaction and returns its version; ErrNewer, and the database's
// version, for one above it.
func migrate(db *sql.DB, migrations []string) (int, error) {
	ctx := context.Background()
	var version int
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return 0, err
	}
	switch {
	case version > len(migrations):
		return version, ErrNewer
	case version == len(migrations):
		return version, nil
	}
	tx, err := db.BeginTx(ctx, nil) // IMMEDIATE: one migrating writer at a time
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	// Another connection may have migrated since the first look.
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return 0, err
	}
	if version > len(migrations) {
		return version, ErrNewer
	}
	if version == len(migrations) {
		return version, nil
	}
	for i := version; i < len(migrations); i++ {
		if _, err := tx.ExecContext(ctx, migrations[i]); err != nil {
			return 0, fmt.Errorf("store: migration %d: %w", i+1, err)
		}
	}
	if _, err := tx.ExecContext(ctx, "PRAGMA user_version = "+strconv.Itoa(len(migrations))); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(migrations), nil
}

// privateDir makes dir, 0700 when missing; an existing one must be a
// directory of this user and not a link, and is made 0700.
func privateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	st, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !st.IsDir() || !owned(st) {
		return fmt.Errorf("%w: %s", ErrUnsafe, dir)
	}
	if modeBits && st.Mode().Perm() != 0o700 {
		return os.Chmod(dir, 0o700)
	}
	return nil
}

// privateFile creates the database's file 0600 when missing; an existing
// one must be a regular file of this user and not a link, and is made
// 0600.
func privateFile(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL|noFollow, 0o600)
	if err == nil {
		return f.Close()
	}
	if !errors.Is(err, fs.ErrExist) {
		return err
	}
	st, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || !owned(st) {
		return fmt.Errorf("%w: %s", ErrUnsafe, path)
	}
	if modeBits && st.Mode().Perm() != 0o600 {
		return os.Chmod(path, 0o600)
	}
	return nil
}

// notLink fails for a path that is there and is not a regular file of
// this user (a journal file SQLite would open).
func notLink(path string) error {
	st, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || !owned(st) {
		return fmt.Errorf("%w: %s", ErrUnsafe, path)
	}
	return nil
}
