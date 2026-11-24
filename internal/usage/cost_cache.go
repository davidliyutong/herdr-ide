package usage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"time"

	"veldr/internal/store"
)

type fileEntry struct {
	Kind  string `json:"kind"`
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"`
	// Off is where the last complete line ended: a log that grew is read
	// on from there (not a gzipped one).
	Off int64 `json:"off,omitempty"`
	// Records are the log's, one per key (dedupe).
	Records []Record          `json:"records,omitempty"`
	Models  map[string]string `json:"models,omitempty"`
	// Codex is the rollout parser's state at Off.
	Codex *codexState `json:"codex,omitempty"`
}

type costCache struct {
	Version int                   `json:"version"`
	Files   map[string]*fileEntry `json:"files"`
}

// The cache is kept in the machine's database (store.MachineDB in the
// agent's data directory, the directory CostCacheFile is below, named
// after the host: store.HostFile): a row per
// log with its entry as JSON and that JSON's SHA-256 (usage_cost_files),
// and the cache's version, when it was last saved and a generation every
// save bumps (usage_cost_state). A save writes the entries that changed
// and removes those gone, in one transaction, so another agent of the
// instance sees either save whole. The file it was kept in before
// (CostCacheFile) is imported once and then removed. The cache's path
// (cachePath in Cost) names the database it is in.
const costFeature = "usage"

var costMigrations = []string{
	`CREATE TABLE usage_cost_files (
		path TEXT PRIMARY KEY,
		sum BLOB NOT NULL,
		entry BLOB NOT NULL
	);
	CREATE TABLE usage_cost_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		version INTEGER NOT NULL,
		saved INTEGER NOT NULL,
		gen INTEGER NOT NULL
	);`,
}

// errCostNewer: the machine's database, or the cache's tables in it, are
// of a newer version, which this agent reads and does not write: the
// cache stays in memory.
var errCostNewer = errors.New("usage: the machine's database is of a newer version: the cost cache is kept in memory")

// costDB is the machine's database of the cache at p (CostCacheFile below
// the agent's data directory): this host's.
func costDB(p string) string {
	return store.HostFile(filepath.Dir(filepath.Dir(p)), store.MachineDB)
}

// openCostDB opens the database of the cache at p with the cache's
// tables; writable false when they are of a newer version. The caller
// closes it.
func openCostDB(p string) (db *store.DB, writable bool, err error) {
	db, err = store.OpenShared(costDB(p))
	if db == nil {
		return nil, false, err
	}
	v, err := db.Migrate(costFeature, costMigrations)
	switch {
	case errors.Is(err, store.ErrNewer) && v >= len(costMigrations):
		return db, false, nil
	case err != nil:
		db.Close()
		return nil, false, err
	}
	return db, true, nil
}

// memCostState keeps the last loaded costCache in memory (guarded by
// costMu) so scans do not read and unmarshal megabytes of JSON again
// while the database's cache did not change (another agent of the
// instance saved), and keep incremental progress between periodic saves.
type memCostState struct {
	path  string
	cache *costCache
	// dbGen is the database's generation of the cache when this was loaded
	// or saved.
	dbGen int64
	dirty bool
	gen   uint64
}

var memCost memCostState

// costSaved is the generation the last save of the cache at path wrote
// (markCostSaved). Guarded by costMu.
var costSaved struct {
	path string
	gen  int64
}

// acquireCostCache returns the in-memory costCache for p when the
// database's cache did not change since (or cannot be read), else loads
// it from the database. Must be called with costMu held.
func acquireCostCache(p string) (c *costCache, dirty bool, gen uint64) {
	if p == "" {
		memCost.gen++
		return &costCache{Version: costCacheVer, Files: map[string]*fileEntry{}}, false, memCost.gen
	}
	if memCost.path == p && memCost.cache != nil {
		if g, err := costGen(p); err != nil || g == memCost.dbGen {
			return memCost.cache, memCost.dirty, memCost.gen
		}
	}
	c, g := loadCost(p)
	memCost.gen++
	memCost = memCostState{path: p, cache: c, dbGen: g, gen: memCost.gen}
	return c, false, memCost.gen
}

// costGen is the generation of the cache at p in its database: 0 when
// it was never saved (or there is no database).
func costGen(p string) (int64, error) {
	if !store.Exists(costDB(p)) {
		return 0, nil
	}
	db, _, err := openCostDB(p)
	if err != nil {
		return 0, err
	}
	defer db.Close()
	var g int64
	err = db.QueryRow("SELECT gen FROM usage_cost_state WHERE id = 1").Scan(&g)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return g, err
}

// markCostSaved records that the cache in memory is the one saveCostCache
// just wrote at p. Must be called with costMu held.
func markCostSaved(p string) {
	if memCost.path != p {
		return
	}
	memCost.dirty = false
	if costSaved.path == p {
		memCost.dbGen = costSaved.gen
	}
}

// persistDue tells whether a scan that changed the cache and read n bytes
// of logs writes it: none written yet, the last save is older than
// costPersistEvery, or the scan read at least costPersistBytes.
func persistDue(p string, n int64) bool {
	at, ok := costSavedAt(p)
	return !ok || time.Since(at) >= costPersistEvery || n >= costPersistBytes
}

// costSavedAt is when the cache at p was last saved; false when never (or
// its database cannot be read).
func costSavedAt(p string) (time.Time, bool) {
	if !store.Exists(costDB(p)) {
		return time.Time{}, false
	}
	db, _, err := openCostDB(p)
	if err != nil {
		return time.Time{}, false
	}
	defer db.Close()
	var ns int64
	if db.QueryRow("SELECT saved FROM usage_cost_state WHERE id = 1").Scan(&ns) != nil {
		return time.Time{}, false
	}
	return time.Unix(0, ns), true
}

func loadCostCache(p string) *costCache {
	c, _ := loadCost(p)
	return c
}

// loadCost reads the cache at p and its generation: an empty cache when
// there is none, it is of another version or larger than maxCacheMemory.
// Entries that do not parse are left out.
func loadCost(p string) (*costCache, int64) {
	c := &costCache{Version: costCacheVer, Files: map[string]*fileEntry{}}
	if p == "" {
		return c, 0
	}
	db, _, err := openCostDB(p)
	if err != nil {
		return c, 0
	}
	defer db.Close()
	var version int
	var gen int64
	if db.QueryRow("SELECT version, gen FROM usage_cost_state WHERE id = 1").Scan(&version, &gen) != nil {
		return c, 0
	}
	var total int64
	if db.QueryRow("SELECT coalesce(sum(length(entry)), 0) FROM usage_cost_files").Scan(&total) != nil || version != costCacheVer || total > maxCacheMemory {
		return c, gen
	}
	rows, err := db.Query("SELECT path, entry FROM usage_cost_files")
	if err != nil {
		return c, gen
	}
	defer rows.Close()
	for rows.Next() {
		var path string
		var b []byte
		var ent fileEntry
		if rows.Scan(&path, &b) != nil || json.Unmarshal(b, &ent) != nil {
			continue
		}
		c.Files[path] = &ent
	}
	if rows.Err() != nil {
		return &costCache{Version: costCacheVer, Files: map[string]*fileEntry{}}, gen
	}
	return c, gen
}

// dedupe keeps one record per key, the one with the most output (the
// first of equals), where the key first was: Claude logs a streamed
// response once per content block, each line with the usage so far.
// Records without a key all stay (without allocating a map).
func dedupe(rs []Record) []Record {
	var at map[string]int
	out := rs[:0]
	for _, r := range rs {
		if r.K == "" {
			out = append(out, r)
			continue
		}
		if at == nil {
			at = make(map[string]int, len(rs))
		}
		if i, ok := at[r.K]; ok {
			if r.O > out[i].O {
				out[i] = r
			}
			continue
		}
		at[r.K] = len(out)
		out = append(out, r)
	}
	clear(rs[len(out):])
	return out
}

// saveCostCache writes the cache at p into its database: the entries that
// changed (by their JSON's SHA-256), without those gone, in one
// transaction; each entry is marshaled on its own, so memory holds one
// entry's JSON at a time.
func saveCostCache(p string, c *costCache) error {
	db, writable, err := openCostDB(p)
	if err != nil {
		return err
	}
	defer db.Close()
	if !writable {
		return errCostNewer
	}
	var gen int64
	err = db.Update(context.Background(), func(tx *sql.Tx) error {
		var err error
		gen, err = writeCostCache(tx, c, time.Now())
		return err
	})
	if err != nil {
		return err
	}
	costSaved.path, costSaved.gen = p, gen
	db.Reclaim()
	return nil
}

// writeCostCache writes c's entries that changed and removes those it does
// not have (all of a cache of another version), saved at saved, and
// returns the new generation.
func writeCostCache(tx *sql.Tx, c *costCache, saved time.Time) (int64, error) {
	var version int
	var gen int64
	err := tx.QueryRow("SELECT version, gen FROM usage_cost_state WHERE id = 1").Scan(&version, &gen)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	sums := map[string][]byte{}
	if err == nil && version == c.Version {
		rows, err := tx.Query("SELECT path, sum FROM usage_cost_files")
		if err != nil {
			return 0, err
		}
		for rows.Next() {
			var path string
			var sum []byte
			if err := rows.Scan(&path, &sum); err != nil {
				rows.Close()
				return 0, err
			}
			sums[path] = sum
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return 0, err
		}
	} else if _, err := tx.Exec("DELETE FROM usage_cost_files"); err != nil {
		return 0, err
	}
	for path, ent := range c.Files {
		b, err := json.Marshal(ent)
		if err != nil {
			return 0, err
		}
		sum := sha256.Sum256(b)
		old, had := sums[path]
		delete(sums, path)
		if had && bytes.Equal(old, sum[:]) {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO usage_cost_files (path, sum, entry) VALUES (?, ?, ?)
			ON CONFLICT (path) DO UPDATE SET sum = excluded.sum, entry = excluded.entry`, path, sum[:], b); err != nil {
			return 0, err
		}
	}
	for path := range sums {
		if _, err := tx.Exec("DELETE FROM usage_cost_files WHERE path = ?", path); err != nil {
			return 0, err
		}
	}
	gen++
	if _, err := tx.Exec(`INSERT INTO usage_cost_state (id, version, saved, gen) VALUES (1, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET version = excluded.version, saved = excluded.saved, gen = excluded.gen`,
		c.Version, saved.UnixNano(), gen); err != nil {
		return 0, err
	}
	return gen, nil
}
