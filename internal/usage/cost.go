package usage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// Retention is how far back the cost scanner reads logs and keeps its
// cache's records.
const Retention = 90 * 24 * time.Hour

// CostCacheFile is the scanner's cache below the agent's data directory.
const CostCacheFile = "usage/cost-cache.json"

// maxLine bounds a log line; longer ones (a tool's output) carry no usage
// and are skipped.
const maxLine = 16 << 20

// Record is one API response's tokens, as a log recorded it.
type Record struct {
	// K is the key duplicates share (the same response logged twice).
	K string `json:"k,omitempty"`
	T int64  `json:"t"`
	M string `json:"m,omitempty"`
	// S is the session of a legacy Grok record, whose model the session's
	// events name.
	S string `json:"s,omitempty"`
	J string `json:"j,omitempty"` // project
	I int64  `json:"i,omitempty"` // input, not cached
	C int64  `json:"c,omitempty"` // cache reads
	W int64  `json:"w,omitempty"` // cache writes, 5 minutes
	H int64  `json:"h,omitempty"` // cache writes, 1 hour
	O int64  `json:"o,omitempty"` // output
	R int64  `json:"r,omitempty"` // reasoning, part of the output
	N int64  `json:"n,omitempty"` // API calls
	// X is the prompt length the tier is chosen by (0: I+C+W+H).
	X int64 `json:"x,omitempty"`
	// E marks a failed attempt (legacy Grok retries), counted only.
	E bool `json:"e,omitempty"`
	// V is the provider whose model served it, where the CLI is a client
	// of many (OpenCode's providerID): it picks the price table.
	V string `json:"v,omitempty"`
	// P is the cost the CLI recorded (USD; OpenCode's, from its price
	// list), for a model the tables do not price.
	P float64 `json:"p,omitempty"`
}

// Kinds of log files.
const (
	logClaude      = "claude"
	logCodex       = "codex"
	logGrok        = "grok"
	logGrokLegacy  = "grok-legacy"
	logGrokEvents  = "grok-events"
	logAntigravity = "antigravity"
	logKimi        = "kimi"
	logOpenCode    = "opencode"
	costCacheVer   = 2
	maxCacheMemory = 256 << 20
)

// CostOptions select what Cost reports.
type CostOptions struct {
	// Since is the first instant reported (Unix seconds; at most
	// Retention back).
	Since int64 `json:"since"`
	// TZOffset is the offset of the user's time zone in minutes east of
	// UTC: days are the user's.
	TZOffset   int      `json:"tzOffset,omitempty"`
	CodexHomes []string `json:"codexHomes,omitempty"`
	Providers  []string `json:"providers,omitempty"`
	// Prices are the user's (usage.prices, ParsePrices), over the table's
	// (PricingWith).
	Prices map[string]Tier `json:"prices,omitempty"`
	// RecentSince, when not 0, asks for Recent from that instant on (Unix
	// seconds; at most Retention back), whatever Since is: the spend of a
	// subscription's window (5 hours, a week) needs times finer than days.
	RecentSince int64 `json:"recentSince,omitempty"`
	// IfNoneMatch is the ETag of the caller's last report: when the cache
	// and options yield the same ETag, Cost answers NotModified with no rows.
	IfNoneMatch string `json:"ifNoneMatch,omitempty"`
}

// CostRow is a day's tokens and cost of one model in one project.
type CostRow struct {
	Day        string  `json:"day"`
	Provider   string  `json:"provider"`
	Model      string  `json:"model"`
	Project    string  `json:"project,omitempty"`
	Input      int64   `json:"input"`
	Cached     int64   `json:"cached"`
	CacheWrite int64   `json:"cacheWrite"`
	Output     int64   `json:"output"`
	Reasoning  int64   `json:"reasoning,omitempty"`
	Requests   int64   `json:"requests"`
	Cost       float64 `json:"cost"`
	Priced     bool    `json:"priced"`
}

// SlotSec is the length of a CostSlot: a quarter of an hour.
const SlotSec = 900

// CostSlot is a provider's tokens and cost in a quarter of an hour
// (SlotSec), all models and projects together.
type CostSlot struct {
	// At is the slot's start (Unix seconds, a multiple of SlotSec).
	At       int64   `json:"at"`
	Provider string  `json:"provider"`
	Tokens   int64   `json:"tokens"`
	Requests int64   `json:"requests"`
	Cost     float64 `json:"cost"`
	// Priced is false when a record of the slot had no price (its tokens
	// count, its cost does not).
	Priced bool `json:"priced"`
}

// CostReport is the cost of a machine's logs.
type CostReport struct {
	Since int64     `json:"since"`
	Rows  []CostRow `json:"rows"`
	// Recent are the slots with spend from CostOptions.RecentSince on,
	// oldest first; none when it was 0.
	Recent []CostSlot `json:"recent,omitempty"`
	// Failed are the logs this scan could not read, as provider:code
	// (readFailure): their records are those of the last read.
	Failed   []string `json:"failed,omitempty"`
	Retries  int64    `json:"retries,omitempty"`
	Unpriced []string `json:"unpriced,omitempty"`
	Files    int      `json:"files"`
	// ETag identifies this report's inputs; NotModified is true when
	// CostOptions.IfNoneMatch matched ETag (Rows is omitted).
	ETag        string `json:"etag,omitempty"`
	NotModified bool   `json:"notModified,omitempty"`
}

var costMu sync.Mutex

// logFile is a log to read and its kind.
type logFile struct {
	path, kind string
}

// costLogs lists the logs of the providers selected.
func costLogs(e *Env, o CostOptions) []logFile {
	want := func(p string) bool { return len(o.Providers) == 0 || slices.Contains(o.Providers, p) }
	var out []logFile
	walk := func(root, kind string, match func(rel string) bool) {
		fs.WalkDir(os.DirFS(root), ".", func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if p == "." {
					return fs.SkipAll
				}
				return nil
			}
			if !d.IsDir() && d.Type().IsRegular() && match(p) {
				out = append(out, logFile{path.Join(root, p), kind})
			}
			return nil
		})
	}
	if want(Claude) {
		roots := []string{path.Join(claudeDir(e), "projects"), path.Join(e.Home, ".config/claude/projects")}
		if roots[0] == roots[1] {
			roots = roots[:1]
		}
		for _, r := range roots {
			walk(r, logClaude, func(p string) bool { return strings.HasSuffix(p, ".jsonl") })
		}
	}
	if want(Codex) {
		for _, h := range codexHomes(e, o.CodexHomes) {
			for _, d := range []string{"sessions", "archived_sessions"} {
				walk(path.Join(h, d), logCodex, func(p string) bool { return strings.HasSuffix(p, ".jsonl") })
			}
		}
	}
	if want(Grok) {
		g := grokHome(e)
		walk(path.Join(g, "sessions"), logGrok, func(p string) bool {
			parts := strings.Split(p, "/")
			return len(parts) == 3 && parts[2] == "updates.jsonl"
		})
		walk(path.Join(g, "sessions"), logGrokEvents, func(p string) bool {
			parts := strings.Split(p, "/")
			return len(parts) == 3 && parts[2] == "events.jsonl"
		})
		walk(path.Join(g, "logs"), logGrokLegacy, func(p string) bool {
			return !strings.Contains(p, "/") && strings.HasPrefix(p, "unified.jsonl")
		})
	}
	if want(Antigravity) {
		for _, db := range antigravityDBs(e) {
			out = append(out, logFile{db, logAntigravity})
		}
	}
	if want(Kimi) {
		walk(path.Join(kimiHome(e), "sessions"), logKimi, func(p string) bool {
			parts := strings.Split(p, "/")
			return len(parts) == 5 && parts[2] == "agents" && parts[4] == "wire.jsonl" ||
				len(parts) == 3 && parts[2] == "wire.jsonl"
		})
	}
	if want(OpenCode) {
		for _, db := range openCodeDBs(e) {
			out = append(out, logFile{db, logOpenCode})
		}
	}
	return out
}

func providerOf(kind string) string {
	switch kind {
	case logClaude:
		return Claude
	case logCodex:
		return Codex
	case logAntigravity:
		return Antigravity
	case logKimi:
		return Kimi
	case logOpenCode:
		return OpenCode
	}
	return Grok
}

// logStamp is a log's size and time (ns), which tell whether it changed:
// for SQLite databases (OpenCode's and Antigravity's) with their WAL's,
// where commits go first.
func logStamp(lf logFile) (int64, int64, error) {
	st, err := os.Stat(lf.path)
	if err != nil || !st.Mode().IsRegular() {
		return 0, 0, os.ErrNotExist
	}
	size, mtime := st.Size(), st.ModTime().UnixNano()
	if lf.kind == logOpenCode || lf.kind == logAntigravity {
		if w, err := os.Stat(lf.path + "-wal"); err == nil {
			size += w.Size()
			mtime = max(mtime, w.ModTime().UnixNano())
		}
	}
	return size, mtime, nil
}

const (
	// costSaveEvery is how often a long scan saves what it read so far.
	costSaveEvery = 20 * time.Second
	// costPersistEvery and costPersistBytes: a scan that changed the cache
	// writes it when the file is older than costPersistEvery or the scan
	// read at least costPersistBytes of logs; otherwise the next scan
	// reads on from the file's older offsets, which costs less than
	// writing every record again whenever a log in use grew a line.
	costPersistEvery = 5 * time.Minute
	costPersistBytes = 8 << 20
)

// Cost reads the CLIs' logs (only what changed since the cache was
// written) and returns the days' tokens and cost at API prices. ctx is
// checked between files: a scan that ends early keeps what it read in the
// cache (saved every costSaveEvery as well) and returns ctx's error.
func Cost(ctx context.Context, e *Env, o CostOptions) (*CostReport, error) {
	costMu.Lock()
	defer costMu.Unlock()
	now := e.now()
	cutoff := now.Add(-Retention).Unix()
	if o.Since < cutoff {
		o.Since = cutoff
	}
	if o.RecentSince != 0 && o.RecentSince < cutoff {
		o.RecentSince = cutoff
	}
	cachePath := ""
	if e.Base != "" {
		cachePath = path.Join(e.Base, CostCacheFile)
	}
	cache, dirty, gen := acquireCostCache(cachePath)
	seen := map[string]bool{}
	logs := costLogs(e, o)
	changed := false
	lastSave := time.Now()
	var read int64
	var failed []string
	for _, lf := range logs {
		if err := ctx.Err(); err != nil {
			if changed && cachePath != "" {
				memCost.gen++
				memCost.dirty = true
				if saveCostCache(cachePath, cache) == nil {
					markCostSaved(cachePath)
				}
			}
			return nil, err
		}
		if (changed || dirty) && cachePath != "" && time.Since(lastSave) >= costSaveEvery {
			if saveCostCache(cachePath, cache) == nil {
				markCostSaved(cachePath)
				dirty = false
			}
			lastSave = time.Now()
		}
		size, mtime, err := logStamp(lf)
		if err != nil || time.Unix(0, mtime).Unix() < cutoff {
			continue
		}
		seen[lf.path] = true
		old := cache.Files[lf.path]
		if old != nil && old.Kind == lf.kind && old.Size == size && old.MTime == mtime {
			continue
		}
		ent := &fileEntry{Kind: lf.kind, Size: size, MTime: mtime}
		n, err := parseLog(ctx, lf, old, ent, cutoff)
		read += n
		if err != nil {
			if ctx.Err() == nil {
				failed = append(failed, providerOf(lf.kind)+":"+readFailure(err))
			}
			continue
		}
		ent.Records = dedupe(ent.Records)
		cache.Files[lf.path] = ent
		changed = true
	}
	// Stopped in the last log: what was read stays, as between logs.
	if err := ctx.Err(); err != nil {
		if changed && cachePath != "" {
			memCost.gen++
			memCost.dirty = true
			if saveCostCache(cachePath, cache) == nil {
				markCostSaved(cachePath)
			}
		}
		return nil, err
	}
	// Logs that are gone or too old leave the cache; those of providers
	// not selected stay as they are.
	for p, ent := range cache.Files {
		if !seen[p] && (len(o.Providers) == 0 || slices.Contains(o.Providers, providerOf(ent.Kind))) {
			delete(cache.Files, p)
			changed = true
			continue
		}
		n := 0
		for _, r := range ent.Records {
			if r.T >= cutoff {
				ent.Records[n] = r
				n++
			}
		}
		if n != len(ent.Records) {
			ent.Records = ent.Records[:n]
			changed = true
		}
	}
	if changed && cachePath != "" {
		memCost.gen++
		gen = memCost.gen
		memCost.dirty = true
		dirty = true
	}
	if (changed || dirty) && cachePath != "" && persistDue(cachePath, read) {
		if saveCostCache(cachePath, cache) == nil {
			markCostSaved(cachePath)
		}
	}
	slices.Sort(failed)
	failed = slices.Compact(failed)
	etag := costETag(gen, o, failed)
	if cachePath != "" && o.IfNoneMatch != "" && o.IfNoneMatch == etag {
		return &CostReport{Since: o.Since, ETag: etag, NotModified: true}, nil
	}
	rep := aggregateCost(cache, seen, o)
	rep.Failed = failed
	rep.ETag = etag
	return rep, nil
}

// costETag hashes the cache generation and query parameters so unchanged
// scans can short-circuit aggregation and SSH transfer.
func costETag(gen uint64, o CostOptions, failed []string) string {
	h := sha256.New()
	fmt.Fprintf(h, "%d|%d|%d|%d|", gen, o.Since, o.TZOffset, o.RecentSince)
	provs := slices.Clone(o.Providers)
	sort.Strings(provs)
	fmt.Fprintf(h, "%q|", provs)
	homes := slices.Clone(o.CodexHomes)
	sort.Strings(homes)
	fmt.Fprintf(h, "%q|", homes)
	fmt.Fprintf(h, "%q|", failed)
	if len(o.Prices) > 0 {
		keys := make([]string, 0, len(o.Prices))
		for k := range o.Prices {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			t := o.Prices[k]
			cw := -1.0
			if t.CacheWrite != nil {
				cw = *t.CacheWrite
			}
			fmt.Fprintf(h, "%s:%g,%g,%g,%g;", k, t.Input, t.Cached, t.Output, cw)
		}
	}
	return hex.EncodeToString(h.Sum(nil)[:8])
}

// readFailure is the code of a log that could not be read: too_large (a
// read's budget), busy (a database changed at each read), damaged, or
// unreadable (any other: not a regular file, refused, a table missing).
func readFailure(err error) string {
	switch {
	case errors.Is(err, errSQLiteBudget):
		return "too_large"
	case errors.Is(err, errSQLiteChanged):
		return "busy"
	case errors.Is(err, errSQLite):
		return "damaged"
	}
	return "unreadable"
}
