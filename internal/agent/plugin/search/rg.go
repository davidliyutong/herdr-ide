//go:build unix

package search

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"veldr/internal/agent/plugin"
	"veldr/internal/brand"
)

const (
	// rgMaxFileSize: ripgrep skips larger files.
	rgMaxFileSize = "4M"
	// maxRgLine bounds a line of ripgrep's output; a longer one (a match
	// in a file of one huge line) is skipped.
	maxRgLine = 16 << 20
	// maxStderr bounds what is kept of ripgrep's errors.
	maxStderr = 64 << 10
)

// lookRg finds ripgrep: on PATH, else the copy of a code-server the agent
// installed (the newest). A variable for tests.
var lookRg = func(env *plugin.Env) string {
	if p, err := exec.LookPath("rg"); err == nil {
		return p
	}
	return bundledRg(env.Home)
}

// rgPlatform is the name of the machine's platform among the binaries of
// @vscode/ripgrep-universal (darwin-arm64, linux-x64…).
func rgPlatform() string {
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	return runtime.GOOS + "-" + arch
}

// bundledRg is the ripgrep of the newest code-server installed in home's
// data directory (code-server ships VS Code's @vscode/ripgrep), "" when
// there is none.
func bundledRg(home string) string {
	if home == "" {
		return ""
	}
	modules := filepath.Join(home, brand.DataDirName, "code-server", "*", "lib", "vscode", "node_modules", "@vscode")
	var found []string
	for _, g := range []string{
		filepath.Join(modules, "ripgrep-universal", "bin", rgPlatform(), "rg"),
		filepath.Join(modules, "ripgrep", "bin", "rg"),
	} {
		m, _ := filepath.Glob(g)
		found = append(found, m...)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(found)))
	for _, p := range found {
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	return ""
}

// findRg is the ripgrep a search runs, "" for the walker.
func findRg(env *plugin.Env) string { return lookRg(env) }

// rgArgs are ripgrep's arguments for q: JSON output, no configuration
// file, hidden files searched (the skipped folders are excluded by globs),
// links not followed, the query after "--", the directory as ".".
func rgArgs(q *query) []string {
	args := []string{"--json", "--no-config", "--hidden", "--max-filesize", rgMaxFileSize}
	if q.CaseSensitive {
		args = append(args, "--case-sensitive")
	} else {
		args = append(args, "--ignore-case")
	}
	if !q.Regex {
		args = append(args, "--fixed-strings")
	}
	if q.WholeWord {
		args = append(args, "--word-regexp")
	}
	args = append(args, rgGlobs(q.includes, q.excludes)...)
	return append(args, "--", q.Query, ".")
}

// rgEnviron is ripgrep's environment: the agent's, without a
// configuration file.
func rgEnviron(env *plugin.Env) []string {
	base := os.Environ()
	if env.Environ != nil {
		base = env.Environ()
	}
	out := make([]string, 0, len(base))
	for _, kv := range base {
		if !strings.HasPrefix(kv, "RIPGREP_CONFIG_PATH=") {
			out = append(out, kv)
		}
	}
	return out
}

// runRg searches with ripgrep at bin.
func runRg(ctx context.Context, env *plugin.Env, bin string, q *query) (*Result, error) {
	cmd := exec.Command(bin, rgArgs(q)...)
	cmd.Dir = q.dir
	cmd.Env = rgEnviron(env)
	// A session of its own: a process group to kill.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.WaitDelay = 2 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, plugin.Errorf("failed", "%v", err)
	}
	var stderr capBuf
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return nil, plugin.Errorf("failed", "ripgrep did not start: %v", err)
	}
	kill := func() { syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	stopWatch := context.AfterFunc(ctx, kill)
	c := newCollector("rg", q.limit)
	seen := parseRg(stdout, c)
	if c.full() {
		kill()
	}
	stopWatch()
	// Drain what is left so ripgrep is not blocked on a full pipe.
	io.Copy(io.Discard, stdout)
	werr := cmd.Wait()
	c.finish(ctx)
	if ctx.Err() == context.Canceled {
		return nil, plugin.Errorf("cancelled", "%v", ctx.Err())
	}
	var ee *exec.ExitError
	if werr != nil && !c.res.Truncated && errors.As(werr, &ee) && ee.ExitCode() == 2 && !seen {
		// Nothing searched: the query or a glob was refused.
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 2000 {
			msg = msg[:2000] + "…"
		}
		code := "failed"
		if strings.Contains(msg, "regex") {
			code = "bad_regex"
		} else if strings.Contains(msg, "glob") {
			code = "bad_glob"
		}
		return nil, &plugin.Error{Code: code, Err: errors.New(msg)}
	}
	return &c.res, nil
}

// capBuf keeps the first maxStderr bytes written to it.
type capBuf struct{ bytes.Buffer }

func (b *capBuf) Write(p []byte) (int, error) {
	if left := maxStderr - b.Len(); left > 0 {
		b.Buffer.Write(p[:min(len(p), left)])
	}
	return len(p), nil
}

// rgText is ripgrep's text: UTF-8 as text, other bytes base64-encoded.
type rgText struct {
	Text  *string `json:"text"`
	Bytes string  `json:"bytes"`
}

func (t rgText) String() string {
	if t.Text != nil {
		return *t.Text
	}
	b, _ := base64.StdEncoding.DecodeString(t.Bytes)
	return string(b)
}

// rgMessage is a line of ripgrep's --json output.
type rgMessage struct {
	Type string `json:"type"`
	Data struct {
		Path       rgText `json:"path"`
		Lines      rgText `json:"lines"`
		LineNumber int    `json:"line_number"`
		Submatches []struct {
			Start int `json:"start"`
			End   int `json:"end"`
		} `json:"submatches"`
	} `json:"data"`
}

// parseRg adds the matches of ripgrep's --json output to c until it ends
// or c is full; it reports whether ripgrep searched anything (a begin,
// match or summary message).
func parseRg(r io.Reader, c *collector) bool {
	br := bufio.NewReaderSize(r, 64<<10)
	seen := false
	for !c.full() {
		line, err := readLine(br, maxRgLine)
		if len(line) > 0 {
			var m rgMessage
			if json.Unmarshal(line, &m) == nil {
				switch m.Type {
				case "begin", "summary", "end":
					seen = true
				case "match":
					seen = true
					addRg(c, &m)
				}
			}
		}
		if err != nil {
			break
		}
	}
	return seen
}

// addRg adds a match message to c.
func addRg(c *collector, m *rgMessage) {
	path := strings.TrimPrefix(filepath.ToSlash(m.Data.Path.String()), "./")
	text := m.Data.Lines.String()
	text = strings.TrimSuffix(strings.TrimSuffix(text, "\n"), "\r")
	var spans [][2]int
	for _, s := range m.Data.Submatches {
		if s.Start < 0 || s.End <= s.Start || s.End > len(text)+2 {
			continue
		}
		spans = append(spans, [2]int{min(s.Start, len(text)), min(s.End, len(text))})
	}
	c.add(path, m.Data.LineNumber, text, spans)
}

// readLine reads a line of at most limit bytes; a longer one is skipped
// (an empty line is returned for it).
func readLine(br *bufio.Reader, limit int) ([]byte, error) {
	var buf []byte
	over := false
	for {
		chunk, err := br.ReadSlice('\n')
		if !over {
			if len(buf)+len(chunk) > limit {
				over, buf = true, nil
			} else {
				buf = append(buf, chunk...)
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if over {
			return nil, err
		}
		return buf, err
	}
}
