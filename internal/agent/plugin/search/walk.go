//go:build unix

package search

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"

	"veldr/internal/agent/plugin"
)

// binarySniff is how much of a file is looked at for a NUL byte, which
// makes it binary (as git and ripgrep tell).
const binarySniff = 8 << 10

// compile is the regular expression of a query: its text quoted unless it
// is a regular expression, case-insensitive unless asked otherwise.
func compile(q *query) (*regexp.Regexp, error) {
	expr := q.Query
	if !q.Regex {
		expr = regexp.QuoteMeta(expr)
	}
	if !q.CaseSensitive {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, plugin.Errorf("bad_regex", "%v", err)
	}
	return re, nil
}

// isWord reports whether r is part of a word (letters, digits, "_").
func isWord(r rune) bool { return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) }

// wordAt reports whether the match [s, e) of line stands as a whole word:
// no word character right before or after it.
func wordAt(line []byte, s, e int) bool {
	if s > 0 {
		if r, _ := utf8.DecodeLastRune(line[:s]); isWord(r) {
			return false
		}
	}
	if e < len(line) {
		if r, _ := utf8.DecodeRune(line[e:]); isWord(r) {
			return false
		}
	}
	return true
}

// lineMatches are the matches in a line (byte offsets).
func lineMatches(re *regexp.Regexp, line []byte, whole bool) [][2]int {
	var out [][2]int
	for _, m := range re.FindAllIndex(line, -1) {
		if m[1] == m[0] {
			// An empty match finds nothing to show.
			continue
		}
		if whole && !wordAt(line, m[0], m[1]) {
			continue
		}
		out = append(out, [2]int{m[0], m[1]})
	}
	return out
}

// gitignore are the patterns of the top-level .gitignore of dir (the
// walker's approximation of ripgrep's ignore rules): blank lines,
// comments and negations are left out.
func gitignore(dir string) []string {
	f, err := os.Open(filepath.Join(dir, ".gitignore"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(io.LimitReader(f, 256<<10))
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		if l == "" || strings.HasPrefix(l, "#") || strings.HasPrefix(l, "!") {
			continue
		}
		l = strings.TrimRight(l, "/")
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

// errStop ends a walk.
var errStop = errors.New("stop")

// walk searches the files below q.dir without ripgrep: regular files of at
// most MaxFileSize bytes that are not binary, not in the skipped folders
// or those the top-level .gitignore names, matching the includes and not
// the excludes; links are not followed. It reads at most MaxFiles files.
func walk(ctx context.Context, q *query) (*Result, error) {
	re, err := compile(q)
	if err != nil {
		return nil, err
	}
	include := newMatcher(q.includes)
	exclude := newMatcher(append(append(append([]string{}, skipped...), gitignore(q.dir)...), q.excludes...))
	c := newCollector("builtin", q.limit)
	files := 0
	buf := make([]byte, MaxFileSize)
	prefix := q.dir
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	err = filepath.WalkDir(q.dir, func(p string, d fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return errStop
		}
		if err != nil {
			// A folder that cannot be read is left out.
			if d != nil && d.IsDir() && p != q.dir {
				return fs.SkipDir
			}
			return nil
		}
		if p == q.dir {
			return nil
		}
		rel := filepath.ToSlash(strings.TrimPrefix(p, prefix))
		if d.IsDir() {
			if exclude.self(rel) {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || exclude.self(rel) || (!include.empty() && !include.any(rel)) {
			return nil
		}
		if files >= MaxFiles {
			c.stop("max_files")
			return errStop
		}
		files++
		data, ok := readText(p, buf)
		if !ok {
			return nil
		}
		searchText(c, re, q.WholeWord, rel, data)
		if c.full() {
			return errStop
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return nil, plugin.Errorf("failed", "%v", err)
	}
	c.finish(ctx)
	return &c.res, nil
}

// readText reads a file of at most MaxFileSize bytes into buf; false for
// a larger, binary or unreadable one. The file is opened without blocking
// and must still be a regular file (not a FIFO put there since).
func readText(p string, buf []byte) ([]byte, bool) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > MaxFileSize {
		return nil, false
	}
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, false
	}
	if n == len(buf) {
		// Grew past the limit since the stat.
		var one [1]byte
		if m, _ := f.Read(one[:]); m > 0 {
			return nil, false
		}
	}
	data := buf[:n]
	if bytes.IndexByte(data[:min(n, binarySniff)], 0) >= 0 {
		return nil, false
	}
	return data, true
}

// searchText adds the matches of each line of data to c.
func searchText(c *collector, re *regexp.Regexp, whole bool, rel string, data []byte) {
	for no := 1; len(data) > 0; no++ {
		i := bytes.IndexByte(data, '\n')
		line := data
		if i >= 0 {
			line, data = data[:i], data[i+1:]
		} else {
			data = nil
		}
		line = bytes.TrimSuffix(line, []byte("\r"))
		if spans := lineMatches(re, line, whole); len(spans) > 0 {
			if !c.add(rel, no, string(line), spans) {
				return
			}
		}
	}
}
