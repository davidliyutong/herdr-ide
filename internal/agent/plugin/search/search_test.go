//go:build unix

package search

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"veldr/internal/agent/plugin"
	"veldr/internal/agentproto"
	"veldr/internal/brand"
)

// testEnv is an agent's environment with HOME at a temporary directory.
func testEnv(t *testing.T) *plugin.Env {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return &plugin.Env{
		Home: home,
		Expand: func(p string) (string, error) {
			if p == "~" {
				return home, nil
			}
			if strings.HasPrefix(p, "~/") {
				return filepath.Join(home, p[2:]), nil
			}
			if !filepath.IsAbs(p) {
				return filepath.Join(home, p), nil
			}
			return filepath.Clean(p), nil
		},
	}
}

// tree writes files (path: contents) below dir.
func tree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, s := range files {
		f := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// withEngine runs searches with the walker (rg "") or ripgrep at rg.
func withEngine(t *testing.T, rg string) {
	t.Helper()
	old := lookRg
	lookRg = func(*plugin.Env) string { return rg }
	t.Cleanup(func() { lookRg = old })
}

// summary is a result as "path:line:col" per match line.
func summary(r *Result) []string {
	var out []string
	for _, f := range r.Files {
		for _, m := range f.Matches {
			out = append(out, f.Path+":"+itoa(m.Line)+":"+itoa(m.Col))
		}
	}
	return out
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

var sample = map[string]string{
	"src/a.go":            "package a\n\nfunc Needle() {}\n// needle and NEEDLE\n",
	"src/lib/b.go":        "x := needles\n",
	"docs/c.md":           "A needle in docs.\r\n",
	"node_modules/m/i.js": "needle\n",
	".git/config":         "needle\n",
	".hidden/h.txt":       "needle\n",
	"bin.dat":             "needle\x00\x01\x02",
}

// The searches both engines must agree on.
func engineCases(t *testing.T, rg string) {
	env := testEnv(t)
	dir := filepath.Join(env.Home, "proj")
	tree(t, dir, sample)
	withEngine(t, rg)
	run := func(p Params) *Result {
		t.Helper()
		p.Dir = "~/proj"
		r, err := Run(context.Background(), env, p)
		if err != nil {
			t.Fatalf("%+v: %v", p, err)
		}
		return r
	}
	cases := []struct {
		name string
		p    Params
		want []string
	}{
		{"literal, any case", Params{Query: "needle"}, []string{".hidden/h.txt:1:1", "docs/c.md:1:3", "src/a.go:3:6", "src/a.go:4:4", "src/lib/b.go:1:6"}},
		{"case", Params{Query: "NEEDLE", CaseSensitive: true}, []string{"src/a.go:4:15"}},
		{"whole word", Params{Query: "needle", WholeWord: true}, []string{".hidden/h.txt:1:1", "docs/c.md:1:3", "src/a.go:3:6", "src/a.go:4:4"}},
		{"regex", Params{Query: `Need(le)?\(\)`, Regex: true, CaseSensitive: true}, []string{"src/a.go:3:6"}},
		{"literal is not a regex", Params{Query: "needle.*"}, nil},
		{"include by name", Params{Query: "needle", Include: "*.md"}, []string{"docs/c.md:1:3"}},
		{"include a folder", Params{Query: "needle", Include: "lib"}, []string{"src/lib/b.go:1:6"}},
		{"include a path", Params{Query: "needle", Include: "./src, docs/*.txt"}, []string{"src/a.go:3:6", "src/a.go:4:4", "src/lib/b.go:1:6"}},
		{"braces", Params{Query: "needle", Include: "*.{md,txt}"}, []string{".hidden/h.txt:1:1", "docs/c.md:1:3"}},
		{"exclude", Params{Query: "needle", Exclude: "lib, docs/**, .hidden"}, []string{"src/a.go:3:6", "src/a.go:4:4"}},
	}
	for _, c := range cases {
		r := run(c.p)
		if got := summary(r); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
		if r.Truncated || r.Dir != dir {
			t.Errorf("%s: %+v", c.name, r)
		}
	}
	// Matches on a line count each; the preview drops leading blanks
	// and marks them.
	r := run(Params{Query: "needle", Include: "src/a.go"})
	if r.MatchCount != 3 || len(r.Files) != 1 {
		t.Fatalf("count: %+v", r)
	}
	m := r.Files[0].Matches[1]
	if m.Preview != "// needle and NEEDLE" || !reflect.DeepEqual(m.Ranges, [][2]int{{3, 9}, {14, 20}}) {
		t.Errorf("preview %+v", m)
	}
	// The limit stops the search and says so.
	r = run(Params{Query: "needle", MaxResults: 2})
	if r.MatchCount != 2 || !r.Truncated || r.Reason != "max_results" {
		t.Errorf("limit: %+v", r)
	}
}

func TestWalker(t *testing.T) {
	engineCases(t, "")
}

// The same searches with ripgrep, when the machine running the tests has it.
func TestRipgrep(t *testing.T) {
	rg, err := exec.LookPath("rg")
	if err != nil {
		t.Skip("no ripgrep")
	}
	engineCases(t, rg)
}

func TestWalkerSpecifics(t *testing.T) {
	env := testEnv(t)
	dir := filepath.Join(env.Home, "p")
	tree(t, dir, map[string]string{
		".gitignore":  "# built\nout/\n/top.log\n!keep\n",
		"out/x.txt":   "needle\n",
		"sub/top.log": "needle\n",
		"top.log":     "needle\n",
		"big.txt":     strings.Repeat("a", MaxFileSize) + "needle",
		"ok.txt":      "needle\n",
	})
	if err := syscall.Mkfifo(filepath.Join(dir, "fifo"), 0o644); err != nil {
		t.Fatal(err)
	}
	os.Symlink(filepath.Join(dir, "ok.txt"), filepath.Join(dir, "link.txt"))
	withEngine(t, "")
	r, err := Run(context.Background(), env, Params{Dir: dir, Query: "needle"})
	if err != nil {
		t.Fatal(err)
	}
	// The top-level .gitignore, files over the limit, FIFOs and links are
	// left out.
	if got := summary(r); !reflect.DeepEqual(got, []string{"ok.txt:1:1", "sub/top.log:1:1"}) || r.Engine != "builtin" {
		t.Errorf("%v %s", got, r.Engine)
	}
	if _, err := Run(context.Background(), env, Params{Dir: dir, Query: "(", Regex: true}); code(err) != "bad_regex" {
		t.Errorf("bad regex: %v", err)
	}
}

// A search past its time stops with what it found.
func TestTimeout(t *testing.T) {
	env := testEnv(t)
	tree(t, env.Home, map[string]string{"a.txt": "needle\n"})
	withEngine(t, "")
	old := timeout
	timeout = time.Nanosecond
	t.Cleanup(func() { timeout = old })
	r, err := Run(context.Background(), env, Params{Dir: "~", Query: "needle"})
	if err != nil || !r.Truncated || r.Reason != "timeout" {
		t.Fatalf("%+v %v", r, err)
	}
}

func code(err error) string {
	var pe *plugin.Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	return ""
}

func TestParams(t *testing.T) {
	env := testEnv(t)
	tree(t, env.Home, map[string]string{"f.txt": "x"})
	for _, c := range []struct {
		p    Params
		code string
	}{
		{Params{Dir: "~", Query: ""}, "bad_params"},
		{Params{Dir: "~", Query: strings.Repeat("x", MaxQuery+1)}, "bad_params"},
		{Params{Dir: "~", Query: "a\nb"}, "bad_params"},
		{Params{Dir: "~", Query: "a\x00"}, "bad_params"},
		{Params{Dir: "", Query: "a"}, "bad_params"},
		{Params{Dir: "~", Query: "a", Include: strings.Repeat("x", MaxGlobs+1)}, "bad_params"},
		{Params{Dir: "~/nope", Query: "a"}, "not_found"},
		{Params{Dir: "~/f.txt", Query: "a"}, "not_dir"},
	} {
		if _, err := Run(context.Background(), env, c.p); code(err) != c.code {
			t.Errorf("%.60q: %v, want %s", c.p.Query+" "+c.p.Dir, err, c.code)
		}
	}
	q, err := check(env, Params{Dir: "~", Query: "a", MaxResults: MaxResults * 10})
	if err != nil || q.limit != MaxResults {
		t.Errorf("limit %v %v", q, err)
	}
}

// The handler answers over the stream; an unknown action is refused.
func TestHandle(t *testing.T) {
	env := testEnv(t)
	tree(t, env.Home, map[string]string{"a.txt": "hello needle\n"})
	withEngine(t, "")
	call := func(action string, p any) agentproto.Reply {
		a, b := net.Pipe()
		defer b.Close()
		raw, _ := json.Marshal(p)
		go handle(context.Background(), a, action, raw, env)
		var rep agentproto.Reply
		if err := agentproto.ReadLine(b, &rep); err != nil {
			t.Fatal(err)
		}
		return rep
	}
	rep := call("search", Params{Dir: "~", Query: "needle"})
	var r Result
	if !rep.OK || json.Unmarshal(rep.Plugin, &r) != nil || summary(&r)[0] != "a.txt:1:7" {
		t.Fatalf("%+v", rep)
	}
	if rep := call("write", Params{}); rep.OK || rep.Code != "bad_params" {
		t.Errorf("unknown action: %+v", rep)
	}
	if rep := call("search", Params{Dir: "~"}); rep.OK || rep.Code != "bad_params" {
		t.Errorf("no query: %+v", rep)
	}
}

// ripgrep's --json output, as recorded from ripgrep 15: text, a line that
// is not UTF-8 (bytes), messages that are not matches, a broken line.
const rgOutput = `{"type":"begin","data":{"path":{"text":"./src/a.go"}}}
{"type":"match","data":{"path":{"text":"./src/a.go"},"lines":{"text":"\tfunc Needle() {} // needle\n"},"line_number":3,"absolute_offset":11,"submatches":[{"match":{"text":"Needle"},"start":6,"end":12},{"match":{"text":"needle"},"start":21,"end":27}]}}
{"type":"context","data":{"path":{"text":"./src/a.go"},"lines":{"text":"x\n"},"line_number":4}}
{"type":"end","data":{"path":{"text":"./src/a.go"},"binary_offset":null,"stats":{}}}
{"type":"begin","data":{"path":{"text":"./bad.txt"}}}
{"type":"match","data":{"path":{"text":"./bad.txt"},"lines":{"bytes":"Yf9uZWVkbGUK"},"line_number":1,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":2,"end":8}]}}
not json
{"type":"match","data":{"path":{"text":"./😀.txt"},"lines":{"text":"😀needle\r\n"},"line_number":9,"absolute_offset":0,"submatches":[{"match":{"text":"needle"},"start":4,"end":10},{"match":{"text":""},"start":10,"end":10}]}}
{"type":"summary","data":{"elapsed_total":{"secs":0,"nanos":1},"stats":{}}}
`

func TestParseRg(t *testing.T) {
	c := newCollector("rg", 100)
	if !parseRg(strings.NewReader(rgOutput), c) {
		t.Fatal("nothing seen")
	}
	want := []File{
		{Path: "src/a.go", Matches: []Match{{Line: 3, Col: 7, Preview: "func Needle() {} // needle", Ranges: [][2]int{{5, 11}, {20, 26}}}}},
		{Path: "bad.txt", Matches: []Match{{Line: 1, Col: 3, Preview: "a�needle", Ranges: [][2]int{{2, 8}}}}},
		{Path: "😀.txt", Matches: []Match{{Line: 9, Col: 3, Preview: "😀needle", Ranges: [][2]int{{2, 8}}}}},
	}
	if !reflect.DeepEqual(c.res.Files, want) || c.res.MatchCount != 4 {
		t.Errorf("%+v", c.res)
	}
	// The limit stops reading.
	c = newCollector("rg", 1)
	parseRg(strings.NewReader(rgOutput), c)
	if c.res.MatchCount != 1 || len(c.res.Files) != 1 {
		t.Errorf("limit: %+v", c.res)
	}
	// Nothing searched (a refused regex prints no JSON).
	if parseRg(strings.NewReader(""), newCollector("rg", 1)) {
		t.Error("seen")
	}
}

func TestReadLineLimit(t *testing.T) {
	long := strings.Repeat("x", 200<<10)
	c := newCollector("rg", 100)
	in := long + "\n" + strings.SplitN(rgOutput, "\n", 3)[1] + "\n"
	parseRg(strings.NewReader(in), c)
	if c.res.MatchCount != 2 {
		t.Errorf("%+v", c.res)
	}
}

func TestExcerpt(t *testing.T) {
	// A match far into a long line: the preview starts shortly before it,
	// with an ellipsis, and ends after MaxPreview characters.
	line := strings.Repeat("a", 500) + "needle" + strings.Repeat("b", 500)
	p, col, r := excerpt(line, [][2]int{{500, 506}})
	if col != 501 || !strings.HasPrefix(p, "…") || !strings.HasSuffix(p, "…") || len([]rune(p)) != MaxPreview+2 {
		t.Errorf("%q %d", p, col)
	}
	if got := []rune(p)[r[0][0]:r[0][1]]; string(got) != "needle" {
		t.Errorf("range %v: %q", r, string(got))
	}
	// A match past the preview's end is not marked.
	_, _, r = excerpt(line, [][2]int{{500, 506}, {990, 995}})
	if len(r) != 1 {
		t.Errorf("ranges %v", r)
	}
}

func TestGlobs(t *testing.T) {
	if got := splitGlobs(" *.ts , ./src/, {a,b}/*.go,, /x"); !reflect.DeepEqual(got, []string{"*.ts", "src", "{a,b}/*.go", "/x"}) {
		t.Errorf("split %q", got)
	}
	m := newMatcher([]string{"*.go", "docs/**/*.md", "/build"})
	for p, want := range map[string]bool{
		"a.go": true, "x/y/a.go": true, "a.gox": false,
		"docs/a.md": true, "docs/x/y/a.md": true, "x/docs/a.md": false,
		"build/out.txt": true, "src/build/out.txt": false,
	} {
		if m.any(p) != want {
			t.Errorf("%s: %v", p, !want)
		}
	}
	if got := rgGlobs([]string{"src", "a/b"}, []string{"*.min.js", "/out"}); !reflect.DeepEqual(got[len(skipped):], []string{
		"--glob=src", "--glob=**/src/**", "--glob=/a/b", "--glob=/a/b/**", "--glob=!*.min.js", "--glob=!/out",
	}) {
		t.Errorf("rg globs %q", got)
	}
	q := &query{Params: Params{Query: "-e"}, includes: nil}
	args := rgArgs(q)
	if args[len(args)-3] != "--" || args[len(args)-2] != "-e" || !contains(args, "--no-config") || !contains(args, "--fixed-strings") || !contains(args, "--ignore-case") {
		t.Errorf("args %q", args)
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func TestBundledRg(t *testing.T) {
	home := t.TempDir()
	if bundledRg(home) != "" {
		t.Fatal("found in an empty home")
	}
	for _, v := range []string{"4.1.0", "4.2.0"} {
		p := filepath.Join(home, brand.DataDirName, "code-server", v, "lib", "vscode", "node_modules", "@vscode", "ripgrep-universal", "bin", rgPlatform(), "rg")
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755)
	}
	if got := bundledRg(home); !strings.Contains(got, "4.2.0") {
		t.Errorf("found %q", got)
	}
}

// The environment drops ripgrep's configuration file.
func TestRgEnviron(t *testing.T) {
	env := &plugin.Env{Environ: func() []string { return []string{"A=1", "RIPGREP_CONFIG_PATH=/x"} }}
	if got := rgEnviron(env); !reflect.DeepEqual(got, []string{"A=1"}) {
		t.Errorf("%q", got)
	}
}
