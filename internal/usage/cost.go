package usage

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"hash/fnv"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"slices"
	"sort"
	"strconv"
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
}

// Kinds of log files.
const (
	logClaude      = "claude"
	logCodex       = "codex"
	logGrok        = "grok"
	logGrokLegacy  = "grok-legacy"
	logGrokEvents  = "grok-events"
	costCacheVer   = 1
	maxCacheMemory = 256 << 20
)

type fileEntry struct {
	Kind  string `json:"kind"`
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"`
	// Off is where the last complete line ended (Claude's logs are read
	// on from there when they grow).
	Off     int64             `json:"off,omitempty"`
	Records []Record          `json:"records,omitempty"`
	Models  map[string]string `json:"models,omitempty"`
}

type costCache struct {
	Version int                   `json:"version"`
	Files   map[string]*fileEntry `json:"files"`
}

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

// CostReport is the cost of a machine's logs.
type CostReport struct {
	Since    int64     `json:"since"`
	Rows     []CostRow `json:"rows"`
	Retries  int64     `json:"retries,omitempty"`
	Unpriced []string  `json:"unpriced,omitempty"`
	Files    int       `json:"files"`
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
	return out
}

func providerOf(kind string) string {
	switch kind {
	case logClaude:
		return Claude
	case logCodex:
		return Codex
	}
	return Grok
}

// costSaveEvery is how often a long scan saves what it read so far.
const costSaveEvery = 20 * time.Second

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
	cachePath := ""
	if e.Base != "" {
		cachePath = path.Join(e.Base, CostCacheFile)
	}
	cache := loadCostCache(cachePath)
	seen := map[string]bool{}
	logs := costLogs(e, o)
	changed := false
	lastSave := time.Now()
	for _, lf := range logs {
		if err := ctx.Err(); err != nil {
			if changed && cachePath != "" {
				saveCostCache(cachePath, cache)
			}
			return nil, err
		}
		if changed && cachePath != "" && time.Since(lastSave) >= costSaveEvery {
			saveCostCache(cachePath, cache)
			lastSave = time.Now()
		}
		st, err := os.Stat(lf.path)
		if err != nil || st.ModTime().Unix() < cutoff {
			continue
		}
		seen[lf.path] = true
		size, mtime := st.Size(), st.ModTime().UnixNano()
		old := cache.Files[lf.path]
		if old != nil && old.Kind == lf.kind && old.Size == size && old.MTime == mtime {
			continue
		}
		changed = true
		ent := &fileEntry{Kind: lf.kind, Size: size, MTime: mtime}
		from := int64(0)
		if old != nil && old.Kind == logClaude && lf.kind == logClaude && old.Off > 0 && old.Off <= size && mtime >= old.MTime {
			// Claude's logs only grow: read on from the last line read.
			from = old.Off
			ent.Records = old.Records
		}
		if err := parseLog(lf, from, ent); err != nil {
			continue
		}
		cache.Files[lf.path] = ent
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
		saveCostCache(cachePath, cache)
	}
	return aggregateCost(cache, seen, o), nil
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

// parseLog reads a log from offset from into ent.
func parseLog(lf logFile, from int64, ent *fileEntry) error {
	f, err := os.Open(lf.path)
	if err != nil {
		return err
	}
	defer f.Close()
	var r io.Reader = f
	if strings.HasSuffix(lf.path, ".gz") {
		gz, err := gzip.NewReader(f)
		if err != nil {
			return err
		}
		defer gz.Close()
		r = gz
	} else if from > 0 {
		if _, err := f.Seek(from, io.SeekStart); err != nil {
			return err
		}
	}
	switch lf.kind {
	case logClaude:
		end, err := eachLine(r, func(line []byte) { parseClaudeLine(lf.path, line, ent) })
		ent.Off = from + end
		return err
	case logCodex:
		return parseCodexLog(lf.path, r, ent)
	case logGrok:
		_, err := eachLine(r, func(line []byte) { parseGrokUpdate(lf.path, line, ent) })
		return err
	case logGrokLegacy:
		_, err := eachLine(r, func(line []byte) { parseGrokUnified(line, ent) })
		return err
	case logGrokEvents:
		ent.Models = map[string]string{}
		_, err := eachLine(r, func(line []byte) {
			if !bytes.Contains(line, []byte(`"turn_started"`)) || !bytes.Contains(line, []byte(`"model_id"`)) {
				return
			}
			var d struct {
				SessionID string `json:"session_id"`
				ModelID   string `json:"model_id"`
			}
			if json.Unmarshal(line, &d) == nil && d.SessionID != "" && d.ModelID != "" {
				if _, ok := ent.Models[d.SessionID]; !ok {
					ent.Models[d.SessionID] = d.ModelID
				}
			}
		})
		return err
	}
	return nil
}

// eachLine calls fn with every non-empty line of r shorter than maxLine
// and returns the offset after the last newline.
func eachLine(r io.Reader, fn func([]byte)) (int64, error) {
	br := bufio.NewReaderSize(r, 64<<10)
	var buf []byte
	var off, end int64
	long := false
	for {
		chunk, err := br.ReadSlice('\n')
		off += int64(len(chunk))
		if !long {
			if len(buf)+len(chunk) > maxLine {
				long, buf = true, buf[:0]
			} else {
				buf = append(buf, chunk...)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		complete := len(chunk) > 0 && chunk[len(chunk)-1] == '\n'
		if !long && (complete || err == io.EOF) {
			if line := bytes.TrimSpace(buf); len(line) > 0 {
				fn(line)
			}
		}
		if complete {
			end = off
		}
		buf, long = buf[:0], false
		if err != nil {
			if err == io.EOF {
				return end, nil
			}
			return end, err
		}
	}
}

func hashKey(parts ...string) string {
	h := fnv.New64a()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return strconv.FormatUint(h.Sum64(), 36)
}

func isoTime(s string) int64 {
	if s == "" {
		return 0
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.Unix()
	}
	if len(s) >= 19 {
		if t, err := time.Parse("2006-01-02T15:04:05", s[:19]); err == nil {
			return t.Unix()
		}
	}
	return 0
}

func projectName(cwd string) string {
	cwd = strings.TrimRight(cwd, "/")
	if cwd == "" {
		return ""
	}
	return path.Base(cwd)
}

// parseClaudeLine reads an assistant message's usage: one record per
// response, keyed by (requestId, message.id) as duplicates of forked and
// streamed sessions are; "<synthetic>" messages are errors.
func parseClaudeLine(file string, line []byte, ent *fileEntry) {
	if !bytes.Contains(line, []byte(`"usage"`)) {
		return
	}
	var d struct {
		Timestamp string `json:"timestamp"`
		RequestID string `json:"requestId"`
		UUID      string `json:"uuid"`
		CWD       string `json:"cwd"`
		Message   struct {
			Role  string `json:"role"`
			Model string `json:"model"`
			ID    string `json:"id"`
			Usage struct {
				Input         int64 `json:"input_tokens"`
				CacheRead     int64 `json:"cache_read_input_tokens"`
				CacheCreation int64 `json:"cache_creation_input_tokens"`
				Breakdown     struct {
					W5 int64 `json:"ephemeral_5m_input_tokens"`
					W1 int64 `json:"ephemeral_1h_input_tokens"`
				} `json:"cache_creation"`
				Output  int64 `json:"output_tokens"`
				Details struct {
					Thinking int64 `json:"thinking_tokens"`
				} `json:"output_tokens_details"`
			} `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &d) != nil || d.Message.Role != "assistant" || d.Message.Model == "<synthetic>" {
		return
	}
	u := d.Message.Usage
	w5, w1 := u.Breakdown.W5, u.Breakdown.W1
	if w5 == 0 && w1 == 0 {
		w5 = u.CacheCreation
	}
	if u.Input == 0 && u.CacheRead == 0 && w5 == 0 && w1 == 0 && u.Output == 0 {
		return
	}
	model := d.Message.Model
	if model == "" {
		model = "unknown"
	}
	id := d.Message.ID
	if id == "" {
		id = d.UUID
	}
	proj := projectName(d.CWD)
	if proj == "" {
		proj = path.Base(path.Dir(file))
	}
	ent.Records = append(ent.Records, Record{
		K: hashKey("claude", d.RequestID, id), T: isoTime(d.Timestamp), M: model, J: proj,
		I: u.Input, C: u.CacheRead, W: w5, H: w1, O: u.Output, R: u.Details.Thinking, N: 1,
	})
}

type codexUsage struct {
	Input     int64 `json:"input_tokens"`
	Cached    int64 `json:"cached_input_tokens"`
	CacheW    int64 `json:"cache_write_input_tokens"`
	Output    int64 `json:"output_tokens"`
	Reasoning int64 `json:"reasoning_output_tokens"`
}

func (u codexUsage) record(model, proj string, t int64) (Record, bool) {
	if u.Input == 0 && u.Output == 0 && u.CacheW == 0 {
		return Record{}, false
	}
	// input_tokens includes the cached tokens; the tier goes by the
	// whole prompt.
	return Record{T: t, M: model, J: proj, I: max(u.Input-u.Cached, 0), C: u.Cached, W: u.CacheW, O: u.Output, R: u.Reasoning, N: 1, X: u.Input}, true
}

// parseCodexLog reads a rollout: token_usage_record events (one per
// response, keyed by response_id, the model by turn_id), else the legacy
// token_count events (last_token_usage; an event whose total did not move
// is a replay), which after the first token_usage_record are replays too.
func parseCodexLog(file string, r io.Reader, ent *fileEntry) error {
	turnModel := map[string]string{}
	lastModel, proj := "", ""
	seenNew := false
	var prevTotal int64 = -1
	_, err := eachLine(r, func(line []byte) {
		switch {
		case bytes.Contains(line, []byte(`"session_meta"`)):
			var d struct {
				Payload struct {
					CWD string `json:"cwd"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &d) == nil && d.Payload.CWD != "" {
				proj = projectName(d.Payload.CWD)
			}
		case bytes.Contains(line, []byte(`"turn_context"`)):
			var d struct {
				Payload struct {
					Model  string `json:"model"`
					TurnID string `json:"turn_id"`
					CWD    string `json:"cwd"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &d) == nil && d.Payload.Model != "" {
				lastModel = d.Payload.Model
				if d.Payload.TurnID != "" {
					turnModel[d.Payload.TurnID] = d.Payload.Model
				}
				if proj == "" && d.Payload.CWD != "" {
					proj = projectName(d.Payload.CWD)
				}
			}
		case bytes.Contains(line, []byte(`"token_usage_record"`)):
			var d struct {
				Timestamp string `json:"timestamp"`
				Ordinal   any    `json:"ordinal"`
				Payload   struct {
					TurnID     string     `json:"turn_id"`
					ResponseID string     `json:"response_id"`
					Usage      codexUsage `json:"usage"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &d) != nil {
				return
			}
			seenNew = true
			model := firstNonEmpty(turnModel[d.Payload.TurnID], lastModel, "unknown")
			rec, ok := d.Payload.Usage.record(model, proj, isoTime(d.Timestamp))
			if !ok {
				return
			}
			if d.Payload.ResponseID != "" {
				rec.K = hashKey("codex", d.Payload.ResponseID)
			} else {
				b, _ := json.Marshal(d.Ordinal)
				rec.K = hashKey("codex-ord", file, string(b))
			}
			ent.Records = append(ent.Records, rec)
		case bytes.Contains(line, []byte(`"token_count"`)):
			if seenNew {
				return
			}
			var d struct {
				Timestamp string `json:"timestamp"`
				Payload   struct {
					Type string `json:"type"`
					Info struct {
						Total struct {
							Input int64 `json:"input_tokens"`
						} `json:"total_token_usage"`
						Last json.RawMessage `json:"last_token_usage"`
					} `json:"info"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &d) != nil || d.Payload.Type != "token_count" {
				return
			}
			total := d.Payload.Info.Total.Input
			if prevTotal >= 0 && total == prevTotal {
				return
			}
			prevTotal = total
			var u codexUsage
			if json.Unmarshal(d.Payload.Info.Last, &u) != nil {
				return
			}
			rec, ok := u.record(firstNonEmpty(lastModel, "unknown"), proj, isoTime(d.Timestamp))
			if !ok {
				return
			}
			rec.K = hashKey("codex-tc", file, d.Timestamp, string(d.Payload.Info.Last))
			ent.Records = append(ent.Records, rec)
		}
	})
	return err
}

type grokUsage struct {
	ModelCalls int64 `json:"modelCalls"`
	Input      int64 `json:"inputTokens"`
	CachedRead int64 `json:"cachedReadTokens"`
	CacheCreat int64 `json:"cacheCreationTokens"`
	Output     int64 `json:"outputTokens"`
	Reasoning  int64 `json:"reasoningTokens"`
}

// parseGrokUpdate reads a turn_completed update: the turn's usage, by
// model when modelUsage has them.
func parseGrokUpdate(file string, line []byte, ent *fileEntry) {
	if !bytes.Contains(line, []byte(`"turn_completed"`)) || !bytes.Contains(line, []byte(`"usage"`)) {
		return
	}
	var d struct {
		Timestamp any `json:"timestamp"`
		Params    struct {
			Meta struct {
				TS any `json:"agentTimestampMs"`
			} `json:"_meta"`
			Update struct {
				SessionUpdate string `json:"sessionUpdate"`
				Usage         struct {
					grokUsage
					ModelUsage map[string]grokUsage `json:"modelUsage"`
				} `json:"usage"`
			} `json:"update"`
		} `json:"params"`
	}
	if json.Unmarshal(line, &d) != nil || d.Params.Update.SessionUpdate != "turn_completed" {
		return
	}
	t := timeOf(d.Params.Meta.TS)
	if t == 0 {
		t = timeOf(d.Timestamp)
	}
	if t == 0 {
		return
	}
	proj := grokProject(file)
	models := d.Params.Update.Usage.ModelUsage
	if len(models) == 0 {
		models = map[string]grokUsage{"unknown": d.Params.Update.Usage.grokUsage}
	}
	names := make([]string, 0, len(models))
	for m := range models {
		names = append(names, m)
	}
	sort.Strings(names)
	for _, m := range names {
		u := models[m]
		if u.Input == 0 && u.Output == 0 {
			continue
		}
		calls := max(u.ModelCalls, 1)
		// inputTokens includes the cached reads; the tier goes by the
		// average prompt of the turn's calls.
		ent.Records = append(ent.Records, Record{
			T: t, M: firstNonEmpty(m, "unknown"), J: proj,
			I: max(u.Input-u.CachedRead, 0), C: u.CachedRead, W: u.CacheCreat, O: u.Output, R: u.Reasoning,
			N: calls, X: max((u.Input+u.CacheCreat)/calls, 1),
		})
	}
}

// grokProject names a session's project by its directory
// (sessions/<project>/<session>/).
func grokProject(file string) string {
	dir := path.Base(path.Dir(path.Dir(file)))
	if s, err := url.PathUnescape(dir); err == nil {
		dir = s
	}
	return projectName(dir)
}

// parseGrokUnified reads a legacy shell.turn.inference_done event (the
// model comes from the session's events), and counts retries.
func parseGrokUnified(line []byte, ent *fileEntry) {
	done := bytes.Contains(line, []byte("inference_done"))
	retry := bytes.Contains(line, []byte("inference_retry"))
	if !done && !retry {
		return
	}
	var d struct {
		Msg string `json:"msg"`
		TS  string `json:"ts"`
		SID string `json:"sid"`
		Ctx struct {
			Prompt     int64 `json:"prompt_tokens"`
			Cached     int64 `json:"cached_prompt_tokens"`
			Completion int64 `json:"completion_tokens"`
			Reasoning  int64 `json:"reasoning_tokens"`
		} `json:"ctx"`
	}
	if json.Unmarshal(line, &d) != nil {
		return
	}
	t := isoTime(d.TS)
	if t == 0 {
		return
	}
	if strings.Contains(d.Msg, "inference_retry") {
		ent.Records = append(ent.Records, Record{T: t, E: true})
		return
	}
	if !strings.Contains(d.Msg, "inference_done") {
		return
	}
	ent.Records = append(ent.Records, Record{T: t, S: d.SID, I: max(d.Ctx.Prompt-d.Ctx.Cached, 0), C: d.Ctx.Cached, O: d.Ctx.Completion, R: d.Ctx.Reasoning, N: 1})
}

type rowKey struct{ day, provider, model, project string }

// aggregateCost dedupes the records (the most output wins) and sums them
// by day, model and project.
func aggregateCost(c *costCache, seen map[string]bool, o CostOptions) *CostReport {
	rep := &CostReport{Since: o.Since, Rows: []CostRow{}}
	sid := map[string]string{}
	for p, ent := range c.Files {
		if seen[p] && ent.Kind == logGrokEvents {
			for k, v := range ent.Models {
				if _, ok := sid[k]; !ok {
					sid[k] = v
				}
			}
		}
	}
	type keyed struct {
		provider string
		r        Record
	}
	best := map[string]keyed{}
	var plain []keyed
	paths := make([]string, 0, len(c.Files))
	for p := range c.Files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		ent := c.Files[p]
		if !seen[p] || ent.Kind == logGrokEvents {
			continue
		}
		prov := providerOf(ent.Kind)
		rep.Files++
		for _, r := range ent.Records {
			if r.T < o.Since {
				continue
			}
			if r.E {
				rep.Retries++
				continue
			}
			if r.S != "" && r.M == "" {
				r.M = firstNonEmpty(sid[r.S], "unknown")
			}
			if r.K == "" {
				plain = append(plain, keyed{prov, r})
				continue
			}
			if b, ok := best[r.K]; !ok || r.O > b.r.O {
				best[r.K] = keyed{prov, r}
			}
		}
	}
	for _, k := range best {
		plain = append(plain, k)
	}
	rows := map[rowKey]*CostRow{}
	unpriced := map[string]bool{}
	zone := time.FixedZone("", o.TZOffset*60)
	for _, k := range plain {
		r := k.r
		day := time.Unix(r.T, 0).In(zone).Format("2006-01-02")
		label, mp := Pricing.ModelPricing(k.provider, r.M)
		cost, priced := 0.0, mp != nil
		if priced {
			basis := r.X
			if basis == 0 {
				basis = r.I + r.C + r.W + r.H
			}
			_, tier := mp.Tier(basis)
			cost = tier.Cost(r.I, r.C, r.W, r.H, r.O)
		} else {
			label = r.M
			unpriced[k.provider+"/"+r.M] = true
		}
		rk := rowKey{day, k.provider, label, r.J}
		row := rows[rk]
		if row == nil {
			row = &CostRow{Day: day, Provider: k.provider, Model: label, Project: r.J, Priced: priced}
			rows[rk] = row
		}
		row.Input += r.I
		row.Cached += r.C
		row.CacheWrite += r.W + r.H
		row.Output += r.O
		row.Reasoning += r.R
		row.Requests += max(r.N, 1)
		row.Cost += cost
	}
	for _, row := range rows {
		rep.Rows = append(rep.Rows, *row)
	}
	sort.Slice(rep.Rows, func(i, j int) bool {
		a, b := rep.Rows[i], rep.Rows[j]
		if a.Day != b.Day {
			return a.Day < b.Day
		}
		if a.Provider != b.Provider {
			return a.Provider < b.Provider
		}
		if a.Model != b.Model {
			return a.Model < b.Model
		}
		return a.Project < b.Project
	})
	for k := range unpriced {
		rep.Unpriced = append(rep.Unpriced, k)
	}
	sort.Strings(rep.Unpriced)
	return rep
}
