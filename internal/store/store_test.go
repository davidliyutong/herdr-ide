package store

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

// v1 and v2 are a schema's two versions; each records that it ran.
var (
	v1 = `CREATE TABLE runs (n INTEGER NOT NULL);
	      INSERT INTO runs VALUES (1);
	      CREATE TABLE chats (id TEXT PRIMARY KEY);
	      CREATE TABLE events (chat TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, seq INTEGER NOT NULL);`
	v2 = `INSERT INTO runs VALUES (2); ALTER TABLE chats ADD COLUMN title TEXT NOT NULL DEFAULT '';`
)

func openT(t *testing.T, path string, migrations ...string) *DB {
	t.Helper()
	db, err := Open(path, Options{Migrations: migrations})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func runs(t *testing.T, db *DB) []int {
	t.Helper()
	rows, err := db.Query("SELECT n FROM runs ORDER BY rowid")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var n int
		rows.Scan(&n)
		out = append(out, n)
	}
	return out
}

// Each migration runs once, in order, and a later version runs only the
// migrations it adds.
func TestMigrationsOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "chat.db")
	db := openT(t, path, v1)
	if db.Version() != 1 || db.ReadOnly() {
		t.Fatalf("version %d, read-only %v", db.Version(), db.ReadOnly())
	}
	db.Close()
	db = openT(t, path, v1)
	if got := runs(t, db); len(got) != 1 || got[0] != 1 {
		t.Fatalf("runs after opening twice: %v", got)
	}
	db.Close()
	db = openT(t, path, v1, v2)
	if got := runs(t, db); len(got) != 2 || got[1] != 2 || db.Version() != 2 {
		t.Fatalf("runs after a new version: %v, version %d", got, db.Version())
	}
	// A failed migration changes nothing.
	db.Close()
	if _, err := Open(path, Options{Migrations: []string{v1, v2, "INSERT INTO runs VALUES (3); CREATE TABLE broken ("}}); err == nil {
		t.Fatal("a broken migration opened")
	}
	db = openT(t, path, v1, v2)
	if got := runs(t, db); len(got) != 2 || db.Version() != 2 {
		t.Fatalf("a failed migration left %v, version %d", got, db.Version())
	}
}

// The connections' settings: write-ahead logging, foreign keys enforced.
func TestPragmas(t *testing.T) {
	db := openT(t, filepath.Join(t.TempDir(), "x.db"), v1)
	var mode string
	var fk, timeout int
	db.QueryRow("PRAGMA journal_mode").Scan(&mode)
	db.QueryRow("PRAGMA foreign_keys").Scan(&fk)
	db.QueryRow("PRAGMA busy_timeout").Scan(&timeout)
	if mode != "wal" || fk != 1 || timeout != int(DefaultBusyTimeout.Milliseconds()) {
		t.Errorf("journal_mode %s, foreign_keys %d, busy_timeout %d", mode, fk, timeout)
	}
	if _, err := db.Exec("INSERT INTO events VALUES ('nope', 1)"); err == nil {
		t.Error("a row that refers to nothing was written")
	}
	if _, err := db.Exec("INSERT INTO chats (id) VALUES ('c1'); INSERT INTO events VALUES ('c1', 1); DELETE FROM chats"); err != nil {
		t.Fatal(err)
	}
	var n int
	db.QueryRow("SELECT count(*) FROM events").Scan(&n)
	if n != 0 {
		t.Error("a chat's events outlived it")
	}
}

// A database a newer program migrated further opens read-only: it reads,
// and nothing writes.
func TestNewerOpensReadOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	db := openT(t, path, v1, v2)
	db.Exec("INSERT INTO chats (id, title) VALUES ('c1', 'kept')")
	db.Close()

	old, err := Open(path, Options{Migrations: []string{v1}})
	if !errors.Is(err, ErrNewer) || old == nil {
		t.Fatalf("Open = %v, %v", old, err)
	}
	defer old.Close()
	if !old.ReadOnly() || old.Version() != 2 {
		t.Errorf("read-only %v, version %d", old.ReadOnly(), old.Version())
	}
	var title string
	if err := old.QueryRow("SELECT title FROM chats WHERE id = 'c1'").Scan(&title); err != nil || title != "kept" {
		t.Errorf("read %q, %v", title, err)
	}
	if _, err := old.Exec("INSERT INTO chats (id) VALUES ('c2')"); err == nil {
		t.Error("a read-only database was written")
	}
	if _, err := old.Exec("PRAGMA user_version = 1"); err == nil {
		t.Error("a read-only database's version was changed")
	}
	old.Close()
	// The newer program still has its database as it left it.
	db = openT(t, path, v1, v2)
	if got := runs(t, db); len(got) != 2 || db.Version() != 2 {
		t.Errorf("runs %v, version %d", got, db.Version())
	}
}

// Two programs opening one database at once (an old host and the new one
// at a handover) migrate it once, and both write.
func TestConcurrentOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	const n = 4
	dbs := make([]*DB, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Go(func() { dbs[i], errs[i] = Open(path, Options{Migrations: []string{v1, v2}}) })
	}
	wg.Wait()
	for i := range n {
		if errs[i] != nil {
			t.Fatalf("open %d: %v", i, errs[i])
		}
		defer dbs[i].Close()
	}
	if got := runs(t, dbs[0]); len(got) != 2 {
		t.Fatalf("migrations ran %v", got)
	}
	for i := range n {
		wg.Go(func() {
			for j := range 20 {
				if _, err := dbs[i].Exec("INSERT INTO chats (id) VALUES (?)", string(rune('a'+i))+string(rune('a'+j))); err != nil {
					errs[i] = err
					return
				}
			}
		})
	}
	wg.Wait()
	for i := range n {
		if errs[i] != nil {
			t.Fatalf("writer %d: %v", i, errs[i])
		}
	}
	var count int
	dbs[1].QueryRow("SELECT count(*) FROM chats").Scan(&count)
	if count != n*20 {
		t.Errorf("%d rows, want %d", count, n*20)
	}
}

// The database and its directory are this user's alone.
func TestPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mode bits")
	}
	base := t.TempDir()
	dir := filepath.Join(base, "a", "b")
	path := filepath.Join(dir, "chat.db")
	db := openT(t, path, v1)
	db.Exec("INSERT INTO chats (id) VALUES ('c1')")
	for p, want := range map[string]os.FileMode{dir: 0o700, path: 0o600, path + "-wal": 0o600, path + "-shm": 0o600} {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != want {
			t.Errorf("%s: %v, want %v", filepath.Base(p), st.Mode().Perm(), want)
		}
	}
	db.Close()

	// Looser modes of the user's own directory and file are made private.
	os.Chmod(dir, 0o755)
	os.Chmod(path, 0o644)
	openT(t, path, v1).Close()
	if st, _ := os.Stat(dir); st.Mode().Perm() != 0o700 {
		t.Errorf("directory %v", st.Mode().Perm())
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
		t.Errorf("file %v", st.Mode().Perm())
	}
}

// A link is refused where the database, its journal or its directory
// would be, and so is what is not a regular file.
func TestLinksRefused(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real.db")
	openT(t, real, v1).Close()

	link := filepath.Join(base, "link.db")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("no symbolic links:", err)
	}
	if db, err := Open(link, Options{Migrations: []string{v1}}); !errors.Is(err, ErrUnsafe) {
		if db != nil {
			db.Close()
		}
		t.Errorf("a link to a database: %v", err)
	}
	dangling := filepath.Join(base, "dangling.db")
	os.Symlink(filepath.Join(base, "elsewhere.db"), dangling)
	if _, err := Open(dangling, Options{Migrations: []string{v1}}); err == nil {
		t.Error("a link to nothing opened")
	}
	if _, err := os.Stat(filepath.Join(base, "elsewhere.db")); err == nil {
		t.Error("a link's target was created")
	}

	dirLink := filepath.Join(base, "dirlink")
	os.Symlink(base, dirLink)
	if _, err := Open(filepath.Join(dirLink, "x.db"), Options{Migrations: []string{v1}}); !errors.Is(err, ErrUnsafe) {
		t.Errorf("a database in a linked directory: %v", err)
	}

	wal := filepath.Join(base, "w.db")
	os.Symlink(filepath.Join(base, "target"), wal+"-wal")
	if _, err := Open(wal, Options{Migrations: []string{v1}}); !errors.Is(err, ErrUnsafe) {
		t.Errorf("a linked journal: %v", err)
	}

	notFile := filepath.Join(base, "adir.db")
	os.Mkdir(notFile, 0o700)
	if _, err := Open(notFile, Options{Migrations: []string{v1}}); !errors.Is(err, ErrUnsafe) {
		t.Errorf("a directory for a database: %v", err)
	}
	if _, err := Open("relative.db", Options{}); err == nil {
		t.Error("a relative path opened")
	}
}

// Paths with characters a URI quotes open as themselves.
func TestPathsQuoted(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a b?c#d%e")
	path := filepath.Join(dir, "chat x.db")
	openT(t, path, v1).Close()
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "chat x.db" && e.Name() != "chat x.db-wal" && e.Name() != "chat x.db-shm" {
			t.Errorf("unexpected %q", e.Name())
		}
	}
	if db := openT(t, path, v1); len(runs(t, db)) != 1 {
		t.Error("the database opened again is another")
	}
}
