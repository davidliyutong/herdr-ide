package usage

import (
	"encoding/json"
	"os"
	"path"
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
// Records without a key all stay.
func dedupe(rs []Record) []Record {
	at := make(map[string]int, len(rs))
	out := rs[:0]
	for _, r := range rs {
		if r.K == "" {
			out = append(out, r)
			continue
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

// saveCostCache writes the cache atomically, 0600 in a 0700 directory.
func saveCostCache(p string, c *costCache) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	dir := path.Dir(p)
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
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}
