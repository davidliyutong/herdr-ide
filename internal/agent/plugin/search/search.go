//go:build unix

// Package search is the machine side of the Project Search plugin
// (internal/plugins/search, docs/features/41-project-search.md): it
// searches the contents of the files below a directory, as VS Code's
// search view does.
//
// A search runs ripgrep when the machine has it (on PATH, else the copy a
// code-server installed by the agent ships) and a walker of its own
// otherwise. ripgrep runs without a shell, with an argument vector built
// here (the query after "--", globs as --glob=<value>), no configuration
// file (--no-config, RIPGREP_CONFIG_PATH dropped) and so no preprocessor,
// in a session of its own whose process group is killed when the search
// ends: at its time limit, when the core gives up on it, or once enough
// matches were read. Both engines only read: nothing is written on the
// machine. Results are bounded (MaxResults matches, previews of
// MaxPreview characters around the match), and a search that stopped
// early says why (truncated, reason).
package search

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"veldr/internal/agent/plugin"
)

const (
	// DefaultResults is the number of matches a search returns unless it
	// asks for fewer; MaxResults the most it may ask for.
	DefaultResults = 2000
	MaxResults     = 5000
	// Timeout bounds a search; what it found by then is its result.
	Timeout = 30 * time.Second
	// MaxQuery bounds a query, MaxGlobs the include or exclude patterns.
	MaxQuery = 2000
	MaxGlobs = 4000
	// MaxPreview is the length of a line's preview, in characters.
	MaxPreview = 250
	// MaxFileSize: the walker skips larger files; ripgrep's limit is
	// rgMaxFileSize.
	MaxFileSize = 1 << 20
	// MaxFiles bounds the files the walker reads.
	MaxFiles = 100000
	// MaxSearches bounds the searches at once on a machine; one that finds
	// no free slot within slotWait fails with busy.
	MaxSearches = 4
)

var (
	slots    = make(chan struct{}, MaxSearches)
	slotWait = 3 * time.Second
)

func init() { plugin.Register("search", handle) }

// Params are a search's parameters.
type Params struct {
	// Dir is the directory searched ("~" and relative paths from home).
	Dir   string `json:"dir"`
	Query string `json:"query"`
	// Regex: Query is a regular expression, else a literal text.
	Regex         bool `json:"regex,omitempty"`
	CaseSensitive bool `json:"caseSensitive,omitempty"`
	WholeWord     bool `json:"wholeWord,omitempty"`
	// Include and Exclude are comma-separated glob patterns, as VS Code's
	// files to include and to exclude.
	Include string `json:"include,omitempty"`
	Exclude string `json:"exclude,omitempty"`
	// MaxResults bounds the matches (DefaultResults when 0).
	MaxResults int `json:"maxResults,omitempty"`
}

// Match is a line with matches. Line is 1-based; Col the first match's
// column (1-based, in UTF-16 code units, as editors count). Preview is
// the line's text around the matches, Ranges the matches in it ([start,
// end) in UTF-16 code units of Preview).
type Match struct {
	Line    int      `json:"line"`
	Col     int      `json:"col"`
	Preview string   `json:"preview"`
	Ranges  [][2]int `json:"ranges"`
}

// File is a file with matches; Path is relative to the directory searched,
// with "/" between names.
type File struct {
	Path    string  `json:"path"`
	Matches []Match `json:"matches"`
}

// Result is a search's result.
type Result struct {
	// Engine ran it: "rg" or "builtin".
	Engine string `json:"engine"`
	// Dir is the directory searched, absolute.
	Dir   string `json:"dir"`
	Files []File `json:"files"`
	// MatchCount counts the matches (several on a line count each).
	MatchCount int `json:"matchCount"`
	// Truncated: the search stopped before it was through, for Reason:
	// max_results, timeout or max_files.
	Truncated bool   `json:"truncated,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// query is a search's parameters checked.
type query struct {
	Params
	dir      string
	includes []string
	excludes []string
	limit    int
}

func handle(ctx context.Context, st net.Conn, action string, raw json.RawMessage, env *plugin.Env) error {
	if action != "search" {
		return plugin.Reply(st, nil, plugin.Errorf("bad_params", "unknown action %q", action))
	}
	// The search ends when the core gives up on it.
	ctx, cancel := plugin.UntilClosed(ctx, st)
	defer cancel()
	var p Params
	if err := plugin.Decode(raw, &p); err != nil {
		return plugin.Reply(st, nil, err)
	}
	v, err := Run(ctx, env, p)
	return plugin.Reply(st, v, err)
}

// check validates p and resolves its directory.
func check(env *plugin.Env, p Params) (*query, error) {
	if p.Query == "" || len(p.Query) > MaxQuery || strings.ContainsRune(p.Query, 0) {
		return nil, plugin.Errorf("bad_params", "query of 1 to %d bytes required", MaxQuery)
	}
	if strings.ContainsAny(p.Query, "\n\r") {
		return nil, plugin.Errorf("bad_params", "a query is one line")
	}
	if len(p.Include) > MaxGlobs || len(p.Exclude) > MaxGlobs || strings.ContainsRune(p.Include+p.Exclude, 0) {
		return nil, plugin.Errorf("bad_params", "patterns of at most %d bytes", MaxGlobs)
	}
	if p.Dir == "" || strings.ContainsRune(p.Dir, 0) {
		return nil, plugin.Errorf("bad_params", "no directory")
	}
	dir, err := env.Expand(p.Dir)
	if err != nil {
		return nil, plugin.Errorf("bad_params", "%v", err)
	}
	dir = filepath.Clean(dir)
	fi, err := os.Stat(dir)
	switch {
	case os.IsNotExist(err):
		return nil, plugin.Errorf("not_found", "%s: %v", dir, err)
	case os.IsPermission(err):
		return nil, plugin.Errorf("denied", "%s: %v", dir, err)
	case err != nil:
		return nil, plugin.Errorf("failed", "%s: %v", dir, err)
	case !fi.IsDir():
		return nil, plugin.Errorf("not_dir", "%s is not a directory", dir)
	}
	q := &query{Params: p, dir: dir, includes: splitGlobs(p.Include), excludes: splitGlobs(p.Exclude)}
	q.limit = p.MaxResults
	if q.limit <= 0 {
		q.limit = DefaultResults
	}
	q.limit = min(q.limit, MaxResults)
	return q, nil
}

// Run runs a search: with ripgrep when there is one, else the walker.
func Run(ctx context.Context, env *plugin.Env, p Params) (*Result, error) {
	q, err := check(env, p)
	if err != nil {
		return nil, err
	}
	wait := time.NewTimer(slotWait)
	select {
	case slots <- struct{}{}:
		wait.Stop()
	case <-wait.C:
		return nil, plugin.Errorf("busy", "%d searches are in progress", MaxSearches)
	case <-ctx.Done():
		wait.Stop()
		return nil, plugin.Errorf("cancelled", "%v", ctx.Err())
	}
	defer func() { <-slots }()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var res *Result
	if bin := findRg(env); bin != "" {
		res, err = runRg(ctx, env, bin, q)
	} else {
		res, err = walk(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	res.Dir = q.dir
	if res.Files == nil {
		res.Files = []File{}
	}
	sort.Slice(res.Files, func(i, j int) bool { return res.Files[i].Path < res.Files[j].Path })
	return res, nil
}

// timeout is Timeout; a variable for tests.
var timeout = Timeout

// collector gathers matches up to a query's limit.
type collector struct {
	res    Result
	limit  int
	byFile map[string]int
}

func newCollector(engine string, limit int) *collector {
	return &collector{res: Result{Engine: engine}, limit: limit, byFile: map[string]int{}}
}

// full reports whether the limit is reached.
func (c *collector) full() bool { return c.res.MatchCount >= c.limit }

// add records a line of file with the matches spans (byte offsets in
// line); it reports false once the limit is reached (the line's matches
// past it are dropped).
func (c *collector) add(file string, lineNo int, line string, spans [][2]int) bool {
	if len(spans) == 0 {
		return !c.full()
	}
	if left := c.limit - c.res.MatchCount; len(spans) > left {
		spans = spans[:left]
	}
	if len(spans) == 0 {
		return false
	}
	preview, col, ranges := excerpt(line, spans)
	i, ok := c.byFile[file]
	if !ok {
		i = len(c.res.Files)
		c.byFile[file] = i
		c.res.Files = append(c.res.Files, File{Path: file})
	}
	f := &c.res.Files[i]
	f.Matches = append(f.Matches, Match{Line: lineNo, Col: col, Preview: preview, Ranges: ranges})
	c.res.MatchCount += len(spans)
	return !c.full()
}

// stop marks the result truncated for reason (the first reason stays).
func (c *collector) stop(reason string) {
	if !c.res.Truncated {
		c.res.Truncated, c.res.Reason = true, reason
	}
}

// finish marks the result truncated when the limit was reached or ctx
// ended at its deadline.
func (c *collector) finish(ctx context.Context) {
	if c.full() {
		c.stop("max_results")
	}
	if ctx.Err() == context.DeadlineExceeded {
		c.stop("timeout")
	}
}
