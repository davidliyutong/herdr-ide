package usage

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
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

// memCostState keeps the last loaded costCache in memory (guarded by
// costMu) so scans do not re-read and unmarshal megabytes of JSON from
// disk when the file has not changed externally, and keep incremental
// progress between periodic disk flushes.
type memCostState struct {
	path  string
	cache *costCache
	stat  os.FileInfo
	size  int64
	mtime int64
	dirty bool
	gen   uint64
}

var memCost memCostState

// acquireCostCache returns the in-memory costCache for p when the file on
// disk has not been modified externally, else reloads it from disk.
// Must be called with costMu held.
func acquireCostCache(p string) (c *costCache, dirty bool, gen uint64) {
	if p == "" {
		memCost.gen++
		return &costCache{Version: costCacheVer, Files: map[string]*fileEntry{}}, false, memCost.gen
	}
	st, err := os.Stat(p)
	if memCost.path == p && memCost.cache != nil {
		if err == nil && memCost.stat != nil && os.SameFile(st, memCost.stat) && st.Size() == memCost.size && st.ModTime().UnixNano() == memCost.mtime {
			return memCost.cache, memCost.dirty, memCost.gen
		}
		if os.IsNotExist(err) && memCost.stat == nil {
			return memCost.cache, memCost.dirty, memCost.gen
		}
	}
	c = loadCostCache(p)
	memCost.gen++
	memCost = memCostState{path: p, cache: c, gen: memCost.gen}
	if err == nil {
		memCost.stat, memCost.size, memCost.mtime = st, st.Size(), st.ModTime().UnixNano()
	}
	return c, false, memCost.gen
}

// markCostSaved records the new on-disk stamp after saveCostCache writes p.
// Must be called with costMu held.
func markCostSaved(p string) {
	if memCost.path != p {
		return
	}
	memCost.dirty = false
	if st, err := os.Stat(p); err == nil {
		memCost.stat, memCost.size, memCost.mtime = st, st.Size(), st.ModTime().UnixNano()
	}
}

// persistDue tells whether a scan that changed the cache and read n bytes
// of logs writes it: none written yet, it is older than costPersistEvery,
// or the scan read at least costPersistBytes.
func persistDue(p string, n int64) bool {
	st, err := os.Stat(p)
	return err != nil || time.Since(st.ModTime()) >= costPersistEvery || n >= costPersistBytes
}

func loadCostCache(p string) *costCache {
	c := &costCache{Version: costCacheVer, Files: map[string]*fileEntry{}}
	if p == "" {
		return c
	}
	b, err := os.ReadFile(p)
	if err != nil || len(b) > maxCacheMemory {
		return c
	}
	var v costCache
	if json.Unmarshal(b, &v) != nil || v.Version != costCacheVer || v.Files == nil {
		return c
	}
	return &v
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

// saveCostCache writes the cache atomically, 0600 in a 0700 directory,
// streaming JSON through a buffered writer to avoid a second full-size
// buffer in memory.
func saveCostCache(p string, c *costCache) error {
	dir := filepath.Dir(p)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".cost-cache-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	bw := bufio.NewWriterSize(tmp, 64<<10)
	enc := json.NewEncoder(bw)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(c); err != nil {
		tmp.Close()
		return err
	}
	if err := bw.Flush(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}
