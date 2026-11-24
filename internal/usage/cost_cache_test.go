package usage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"veldr/internal/store"
)

// costDBOf opens the database of the cache at p for a test.
func costDBOf(t *testing.T, p string) *store.DB {
	t.Helper()
	db, err := store.OpenShared(costDB(p))
	if db == nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// setCostSaved makes the cache at p saved at at.
func setCostSaved(t *testing.T, p string, at time.Time) {
	t.Helper()
	db := costDBOf(t, p)
	if _, err := db.Exec("UPDATE usage_cost_state SET saved = ? WHERE id = 1", at.UnixNano()); err != nil {
		t.Fatal(err)
	}
	db.Close()
}

func testCostCache(n int, out int64) *costCache {
	c := &costCache{Version: costCacheVer, Files: map[string]*fileEntry{}}
	for i := range n {
		c.Files[fmt.Sprintf("/home/u/.claude/projects/p/s%d.jsonl", i)] = &fileEntry{Kind: logClaude, Size: 100, MTime: 7, Off: 100,
			Records: []Record{{K: "req", T: 1_800_000_000, M: "claude-opus-4-6", I: 10, O: out}}}
	}
	return c
}

// A save writes the entries that changed and removes those gone; the
// cache reads back the same.
func TestCostCacheSavesWhatChanged(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".app", CostCacheFile)
	c := testCostCache(3, 5)
	if err := saveCostCache(p, c); err != nil {
		t.Fatal(err)
	}
	db := costDBOf(t, p)
	db.Exec(`CREATE TABLE writes (path TEXT);
		CREATE TRIGGER count_updates AFTER UPDATE ON usage_cost_files BEGIN INSERT INTO writes VALUES (new.path); END;
		CREATE TRIGGER count_inserts AFTER INSERT ON usage_cost_files BEGIN INSERT INTO writes VALUES (new.path); END;`)
	c.Files["/home/u/.claude/projects/p/s1.jsonl"].Records[0].O = 6
	delete(c.Files, "/home/u/.claude/projects/p/s2.jsonl")
	if err := saveCostCache(p, c); err != nil {
		t.Fatal(err)
	}
	var writes, rows int
	db.QueryRow("SELECT count(*) FROM writes").Scan(&writes)
	db.QueryRow("SELECT count(*) FROM usage_cost_files").Scan(&rows)
	if writes != 1 || rows != 2 {
		t.Errorf("%d writes, %d rows", writes, rows)
	}
	got := loadCostCache(p)
	if len(got.Files) != 2 || got.Files["/home/u/.claude/projects/p/s1.jsonl"].Records[0].O != 6 {
		t.Errorf("read back %+v", got.Files)
	}
	// A cache of another version replaces every row.
	c.Version = costCacheVer + 1
	saveCostCache(p, c)
	db.QueryRow("SELECT count(*) FROM writes").Scan(&writes)
	if writes != 3 {
		t.Errorf("%d writes", writes)
	}
}

// Another agent of the instance saving the cache makes this one read it
// again; saves of two at once are each whole.
func TestCostCacheTwoAgents(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".app", CostCacheFile)
	costMu.Lock()
	defer costMu.Unlock()
	c, _, _ := acquireCostCache(p)
	c.Files["/a"] = &fileEntry{Kind: logClaude}
	if err := saveCostCache(p, c); err != nil {
		t.Fatal(err)
	}
	markCostSaved(p)
	if again, _, _ := acquireCostCache(p); again != c {
		t.Fatal("read again without a change")
	}
	// The other agent's save (its own transaction).
	db := costDBOf(t, p)
	other := testCostCache(4, 1)
	if err := db.Update(context.Background(), func(tx *sql.Tx) error {
		_, err := writeCostCache(tx, other, time.Now())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if again, _, _ := acquireCostCache(p); len(again.Files) != 4 {
		t.Fatalf("not read again: %d files", len(again.Files))
	}
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Go(func() {
			if err := db.Update(context.Background(), func(tx *sql.Tx) error {
				_, err := writeCostCache(tx, testCostCache(i+1, int64(i)), time.Now())
				return err
			}); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	var gen, rows int
	db.QueryRow("SELECT gen FROM usage_cost_state").Scan(&gen)
	db.QueryRow("SELECT count(*) FROM usage_cost_files").Scan(&rows)
	if gen != 6 || rows < 1 || rows > 4 {
		t.Errorf("generation %d, %d rows", gen, rows)
	}
}

// Tables of a newer version are read and not written: the cache stays in
// memory.
func TestCostCacheNewerVersion(t *testing.T) {
	p := filepath.Join(t.TempDir(), ".app", CostCacheFile)
	if err := saveCostCache(p, testCostCache(2, 5)); err != nil {
		t.Fatal(err)
	}
	db := costDBOf(t, p)
	db.Exec("UPDATE store_features SET version = version + 1 WHERE feature = ?", costFeature)
	db.Close()
	if c := loadCostCache(p); len(c.Files) != 2 {
		t.Errorf("not read: %+v", c)
	}
	if err := saveCostCache(p, testCostCache(1, 5)); !errors.Is(err, errCostNewer) {
		t.Errorf("saved: %v", err)
	}
	if c := loadCostCache(p); len(c.Files) != 2 {
		t.Errorf("written: %d files", len(c.Files))
	}
}

// The cache is in this host's machine database (machine-<host>.db, the
// terminal history's too), never in one of no host's name that hosts
// sharing the data directory would share.
func TestCostCachePerHost(t *testing.T) {
	base := filepath.Join(t.TempDir(), ".app")
	p := filepath.Join(base, CostCacheFile)
	if err := saveCostCache(p, testCostCache(1, 5)); err != nil {
		t.Fatal(err)
	}
	if got, want := costDB(p), store.HostFile(base, store.MachineDB); got != want {
		t.Fatalf("database %s, want %s", got, want)
	}
	if _, err := os.Lstat(costDB(p)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(base, store.MachineDB)); err == nil {
		t.Fatal("a database of no host's name")
	}
}
