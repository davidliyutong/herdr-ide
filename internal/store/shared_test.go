package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

func openShared(t *testing.T, path string) *DB {
	t.Helper()
	db, err := OpenShared(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func migrateT(t *testing.T, db *DB, feature string, steps ...string) int {
	t.Helper()
	v, err := db.Migrate(feature, steps)
	if err != nil {
		t.Fatalf("%s: %v", feature, err)
	}
	return v
}

// A process has one pool per shared database: the handles share it, each
// closes once, and the pool closes with the last one.
func TestSharedOnePool(t *testing.T) {
	path := filepath.Join(t.TempDir(), "core.db")
	a := openShared(t, path)
	b := openShared(t, path)
	if a.DB != b.DB {
		t.Fatal("two pools for one database")
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	a.Close() // a second close of a handle releases nothing more
	if err := b.Ping(); err != nil {
		t.Fatalf("the pool closed with a handle left: %v", err)
	}
	b.Close()
	if err := b.Ping(); err == nil {
		t.Fatal("the pool stayed open without handles")
	}
	shared.Lock()
	n := len(shared.pools)
	shared.Unlock()
	if n != 0 {
		t.Errorf("%d pools left", n)
	}
	// Opened again: a new pool of the same file.
	c := openShared(t, path)
	if err := c.Ping(); err != nil || c.Version() != len(layout) || c.ReadOnly() {
		t.Fatalf("reopened: %v, version %d", err, c.Version())
	}
	if _, err := OpenShared("relative.db"); err == nil {
		t.Error("a relative path opened")
	}
}

// A database file removed or replaced while a pool is open on it is
// opened anew; the old pool's holders keep it until they close it.
func TestSharedFileReplaced(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("an open file is not removed on Windows")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "machine.db")
	a := openShared(t, path)
	migrateT(t, a, "x", "CREATE TABLE x_t (n INTEGER)")
	for _, s := range []string{"", "-wal", "-shm"} {
		os.Remove(path + s)
	}
	b := openShared(t, path)
	if a.DB == b.DB {
		t.Fatal("the pool of a removed file was handed out")
	}
	if v := migrateT(t, b, "x", "CREATE TABLE x_t (n INTEGER)"); v != 1 {
		t.Fatalf("version %d", v)
	}
	if err := a.Ping(); err != nil {
		t.Fatalf("the old pool closed under its holder: %v", err)
	}
}

// Features migrate independently: each step of each feature runs once, a
// new step of one runs alone, and the layout's version stays.
func TestFeaturesMigrateIndependently(t *testing.T) {
	path := filepath.Join(t.TempDir(), "core.db")
	db := openShared(t, path)
	a1 := "CREATE TABLE a_runs (n INTEGER); INSERT INTO a_runs VALUES (1)"
	a2 := "INSERT INTO a_runs VALUES (2)"
	b1 := "CREATE TABLE b_runs (n INTEGER); INSERT INTO b_runs VALUES (1)"
	if migrateT(t, db, "a", a1) != 1 || migrateT(t, db, "b", b1) != 1 {
		t.Fatal("first versions")
	}
	if migrateT(t, db, "a", a1) != 1 {
		t.Fatal("again")
	}
	if migrateT(t, db, "a", a1, a2) != 2 || migrateT(t, db, "b", b1) != 1 {
		t.Fatal("a's second version")
	}
	count := func(table string) int {
		var n int
		db.QueryRow("SELECT count(*) FROM " + table).Scan(&n)
		return n
	}
	if count("a_runs") != 2 || count("b_runs") != 1 {
		t.Errorf("runs: a %d, b %d", count("a_runs"), count("b_runs"))
	}
	var uv int
	db.QueryRow("PRAGMA user_version").Scan(&uv)
	if uv != len(layout) {
		t.Errorf("user_version %d", uv)
	}
	// A failed step changes nothing.
	if _, err := db.Migrate("b", []string{b1, "INSERT INTO b_runs VALUES (2); CREATE TABLE broken ("}); err == nil {
		t.Fatal("a broken step migrated")
	}
	if count("b_runs") != 1 || migrateT(t, db, "b", b1) != 1 {
		t.Error("a failed step left something")
	}
	for _, bad := range []string{"", "A", "1x", "a-b", "a b", "store features"} {
		if _, err := db.Migrate(bad, nil); err == nil {
			t.Errorf("feature %q", bad)
		}
	}
}

// Tables a newer program migrated further make their feature read-only:
// it reads, Migrate says ErrNewer, and the other features still write.
func TestFeatureNewer(t *testing.T) {
	db := openShared(t, filepath.Join(t.TempDir(), "core.db"))
	migrateT(t, db, "a", "CREATE TABLE a_t (n INTEGER)", "ALTER TABLE a_t ADD COLUMN m INTEGER")
	db.Exec("INSERT INTO a_t VALUES (1, 2)")
	v, err := db.Migrate("a", []string{"CREATE TABLE a_t (n INTEGER)"})
	if !errors.Is(err, ErrNewer) || v != 2 {
		t.Fatalf("older code: %d %v", v, err)
	}
	var n int
	if err := db.QueryRow("SELECT n FROM a_t").Scan(&n); err != nil || n != 1 {
		t.Errorf("read %d %v", n, err)
	}
	if migrateT(t, db, "b", "CREATE TABLE b_t (n INTEGER)") != 1 {
		t.Fatal("another feature")
	}
	if _, err := db.Exec("INSERT INTO b_t VALUES (1)"); err != nil {
		t.Errorf("another feature does not write: %v", err)
	}
}

// A database whose layout is newer opens read-only: every feature reads
// and none writes, migrates or imports.
func TestLayoutNewer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "core.db")
	db := openShared(t, path)
	migrateT(t, db, "a", "CREATE TABLE a_t (n INTEGER)")
	db.Exec("INSERT INTO a_t VALUES (7)")
	db.Exec("PRAGMA user_version = 99")
	db.Close()

	ro, err := OpenShared(path)
	if !errors.Is(err, ErrNewer) || ro == nil || !ro.ReadOnly() {
		t.Fatalf("OpenShared %v %v", ro, err)
	}
	defer ro.Close()
	if _, err := ro.Migrate("a", []string{"CREATE TABLE a_t (n INTEGER)"}); !errors.Is(err, ErrNewer) {
		t.Errorf("Migrate %v", err)
	}
	if _, err := ro.Migrate("b", []string{"CREATE TABLE b_t (n INTEGER)"}); !errors.Is(err, ErrNewer) {
		t.Errorf("Migrate of a new feature %v", err)
	}
	var n int
	if err := ro.QueryRow("SELECT n FROM a_t").Scan(&n); err != nil || n != 7 {
		t.Errorf("read %d %v", n, err)
	}
	if _, err := ro.Exec("INSERT INTO a_t VALUES (8)"); err == nil {
		t.Error("written")
	}
	if _, err := ro.Import(context.Background(), "a", "files", func(*sql.Tx) error { return nil }); !errors.Is(err, ErrNewer) {
		t.Errorf("Import %v", err)
	}
	// Another handle of the same pool is read-only too.
	ro2, err := OpenShared(path)
	if !errors.Is(err, ErrNewer) || !ro2.ReadOnly() {
		t.Errorf("second handle %v", err)
	}
	ro2.Close()
}

// An import runs once per database, also when two run at once; one that
// fails leaves nothing and runs again.
func TestImportOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machine.db")
	db := openShared(t, path)
	migrateT(t, db, "a", "CREATE TABLE a_t (n INTEGER)")
	ctx := context.Background()
	fail := errors.New("unreadable")
	ran, err := db.Import(ctx, "a", "files", func(tx *sql.Tx) error {
		tx.Exec("INSERT INTO a_t VALUES (1)")
		return fail
	})
	if ran || !errors.Is(err, fail) {
		t.Fatalf("failed import: %v %v", ran, err)
	}
	if done, _ := db.Imported("a", "files"); done {
		t.Fatal("a failed import recorded")
	}
	var n int
	db.QueryRow("SELECT count(*) FROM a_t").Scan(&n)
	if n != 0 {
		t.Fatal("a failed import left rows")
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	runs := 0
	for range 4 {
		wg.Go(func() {
			ran, err := db.Import(ctx, "a", "files", func(tx *sql.Tx) error {
				_, err := tx.Exec("INSERT INTO a_t VALUES (1)")
				return err
			})
			if err != nil {
				t.Error(err)
			}
			if ran {
				mu.Lock()
				runs++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	db.QueryRow("SELECT count(*) FROM a_t").Scan(&n)
	if runs != 1 || n != 1 {
		t.Errorf("%d runs, %d rows", runs, n)
	}
	if done, _ := db.Imported("a", "files"); !done {
		t.Error("not recorded")
	}
	if done, _ := db.Imported("b", "files"); done {
		t.Error("recorded for another feature")
	}
	// A database opened again knows it too.
	db.Close()
	db = openShared(t, path)
	if ran, err := db.Import(ctx, "a", "files", func(*sql.Tx) error { t.Error("ran again"); return nil }); ran || err != nil {
		t.Errorf("again: %v %v", ran, err)
	}
}

// Durable commits and leaves its connection as the others are; Update
// rolls back what a failing function did.
func TestDurableAndUpdate(t *testing.T) {
	db := openShared(t, filepath.Join(t.TempDir(), "core.db"))
	migrateT(t, db, "a", "CREATE TABLE a_t (n INTEGER)")
	db.SetMaxOpenConns(1) // the connection Durable used is the one asked next
	ctx := context.Background()
	if err := db.Durable(ctx, func(tx *sql.Tx) error {
		var s int
		tx.QueryRow("PRAGMA synchronous").Scan(&s)
		if s != 2 {
			t.Errorf("synchronous %d in a durable transaction", s)
		}
		_, err := tx.Exec("INSERT INTO a_t VALUES (1)")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var s, n int
	db.QueryRow("PRAGMA synchronous").Scan(&s)
	if s != 1 {
		t.Errorf("synchronous %d after", s)
	}
	fail := errors.New("no")
	if err := db.Update(ctx, func(tx *sql.Tx) error {
		tx.Exec("INSERT INTO a_t VALUES (2)")
		return fail
	}); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	if err := db.Durable(ctx, func(tx *sql.Tx) error {
		tx.Exec("INSERT INTO a_t VALUES (3)")
		return fail
	}); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	db.QueryRow("SELECT count(*) FROM a_t").Scan(&n)
	if n != 1 {
		t.Errorf("%d rows", n)
	}
}

// A database of one feature (Open) has no features' tables.
func TestNotShared(t *testing.T) {
	db := openT(t, filepath.Join(t.TempDir(), "chat.db"), v1)
	if _, err := db.Migrate("a", nil); !errors.Is(err, ErrNotShared) {
		t.Errorf("Migrate %v", err)
	}
	if _, err := db.Import(context.Background(), "a", "x", nil); !errors.Is(err, ErrNotShared) {
		t.Errorf("Import %v", err)
	}
}

// A shared database is private to the user as any other.
func TestSharedPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mode bits")
	}
	dir := filepath.Join(t.TempDir(), "d")
	path := filepath.Join(dir, "core.db")
	db := openShared(t, path)
	migrateT(t, db, "a", "CREATE TABLE a_t (n INTEGER)")
	db.Exec("INSERT INTO a_t VALUES (1)")
	for p, want := range map[string]os.FileMode{dir: 0o700, path: 0o600, path + "-wal": 0o600} {
		if st, err := os.Stat(p); err != nil || st.Mode().Perm() != want {
			t.Errorf("%s: %v %v", filepath.Base(p), st, err)
		}
	}
	link := filepath.Join(t.TempDir(), "link.db")
	os.Symlink(path, link)
	if _, err := OpenShared(link); !errors.Is(err, ErrUnsafe) {
		t.Errorf("a link: %v", err)
	}
}

// A directory that is a link of the user's to a directory of the user's
// (a dotfile manager's) holds a shared database in its target; the
// database's file itself is never a link.
func TestSharedLinkedDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("links")
	}
	real := filepath.Join(t.TempDir(), "real")
	os.Mkdir(real, 0o700)
	link := filepath.Join(t.TempDir(), "config")
	if err := os.Symlink(real, link); err != nil {
		t.Skip(err)
	}
	db := openShared(t, filepath.Join(link, "core.db"))
	migrateT(t, db, "a", "CREATE TABLE a_t (n INTEGER)")
	if st, err := os.Lstat(filepath.Join(real, "core.db")); err != nil || !st.Mode().IsRegular() {
		t.Fatalf("not in the target: %v", err)
	}
	if other := openShared(t, filepath.Join(real, "core.db")); other.DB != db.DB {
		t.Error("two pools for one file")
	}
	// Open itself still refuses the linked directory.
	if _, err := Open(filepath.Join(link, "x.db"), Options{}); !errors.Is(err, ErrUnsafe) {
		t.Errorf("Open in a linked directory: %v", err)
	}
}

// A database whose rows went gives their pages back once they are many;
// a few stay for the next rows.
func TestReclaim(t *testing.T) {
	path := filepath.Join(t.TempDir(), "machine.db")
	db := openShared(t, path)
	var av int
	db.QueryRow("PRAGMA auto_vacuum").Scan(&av)
	if av != 2 {
		t.Fatalf("auto_vacuum %d", av)
	}
	migrateT(t, db, "a", "CREATE TABLE a_t (b BLOB)")
	blob := make([]byte, 1<<20)
	for range 24 {
		if _, err := db.Exec("INSERT INTO a_t VALUES (?)", blob); err != nil {
			t.Fatal(err)
		}
	}
	pages := func() (n, free int64) {
		db.QueryRow("PRAGMA page_count").Scan(&n)
		db.QueryRow("PRAGMA freelist_count").Scan(&free)
		return n, free
	}
	full, _ := pages()
	db.Exec("DELETE FROM a_t WHERE rowid > 22")
	if err := db.Reclaim(); err != nil {
		t.Fatal(err)
	}
	if n, free := pages(); n != full || free == 0 {
		t.Errorf("2 MiB of %d pages reclaimed: %d pages, %d free", full, n, free)
	}
	db.Exec("DELETE FROM a_t")
	if err := db.Reclaim(); err != nil {
		t.Fatal(err)
	}
	if n, free := pages(); n*4 > full || free != 0 {
		t.Errorf("after all went: %d pages of %d, %d free", n, full, free)
	}
}
