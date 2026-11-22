package usage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/store"
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

// The file the cache was kept in before, as that agent wrote it, is
// imported once into the machine's database and removed, saved when the
// file was; a file left again is not imported again.
func TestCostCacheImport(t *testing.T) {
	base := filepath.Join(t.TempDir(), ".app")
	p := filepath.Join(base, CostCacheFile)
	os.MkdirAll(filepath.Dir(p), 0o700)
	b, _ := json.Marshal(testCostCache(2, 5))
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour).Truncate(time.Second)
	os.Chtimes(p, old, old)
	c := loadCostCache(p)
	if len(c.Files) != 2 || c.Files["/home/u/.claude/projects/p/s1.jsonl"].Records[0].O != 5 {
		t.Fatalf("imported %+v", c)
	}
	if _, err := os.Lstat(p); err == nil {
		t.Fatal("the file stayed")
	}
	if at, ok := costSavedAt(p); !ok || !at.Equal(old) {
		t.Errorf("saved at %v", at)
	}
	if !persistDue(p, 0) {
		t.Error("an hour-old cache is not due")
	}
	b, _ = json.Marshal(testCostCache(5, 9))
	os.WriteFile(p, b, 0o600)
	if c := loadCostCache(p); len(c.Files) != 2 {
		t.Errorf("imported again: %d files", len(c.Files))
	}
	if _, err := os.Lstat(p); err == nil {
		t.Error("the file left again stayed")
	}
	// A file of another version holds nothing.
	base2 := filepath.Join(t.TempDir(), ".app")
	p2 := filepath.Join(base2, CostCacheFile)
	os.MkdirAll(filepath.Dir(p2), 0o700)
	os.WriteFile(p2, []byte(`{"version":1,"files":{"/x":{"kind":"claude","size":1,"mtime":1}}}`), 0o600)
	if c := loadCostCache(p2); len(c.Files) != 0 {
		t.Errorf("imported a cache of another version: %+v", c)
	}
	if _, err := os.Lstat(p2); err == nil {
		t.Error("the file of another version stayed")
	}
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
