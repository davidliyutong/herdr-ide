// Package sshconfig reads the Host aliases of the user's OpenSSH client
// configuration on the core host (~/.ssh/config and the files it
// includes), which the Add Machine dialog offers (GET /api/ssh/hosts,
// docs/features/02-multi-machine-transport.md). It only reads, and keeps
// only each concrete alias with its HostName and User: patterns, Match
// blocks and every other option (keys, proxies, commands) are left out.
//
// The files are read the way ssh reads them for this purpose: keywords
// without regard to case, "Keyword value" or "Keyword=value", quoted
// arguments, "Host a b c" naming several aliases, the first HostName and
// User given to an alias winning, and Include with globs, relative paths
// resolved against ~/.ssh. What is read is bounded: files of at most
// MaxFileSize bytes (larger ones are skipped), MaxFiles files, includes
// MaxDepth deep, MaxHosts aliases.
package sshconfig

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Host is an alias of the configuration and what it connects to, when the
// configuration says so.
type Host struct {
	Alias    string `json:"alias"`
	HostName string `json:"hostname,omitempty"`
	User     string `json:"user,omitempty"`
}

// Bounds of what Read reads and returns.
const (
	MaxFileSize = 256 << 10
	MaxFiles    = 64
	MaxDepth    = 8
	MaxHosts    = 1000
	// maxValue bounds an alias, host name or user name.
	maxValue = 255
	// maxGlob bounds the files one Include pattern names.
	maxGlob = 64
)

// Read returns the concrete aliases of the configuration in
// home/.ssh/config, in the order the files name them, each once (compared
// without regard to case, as ssh lowercases the host it is given). A
// missing or unreadable file gives none.
func Read(home string) []Host {
	r := &reader{home: home, sshDir: filepath.Join(home, ".ssh"), index: map[string]int{}, seen: map[string]bool{}}
	r.file(filepath.Join(r.sshDir, "config"), 0, nil)
	return r.hosts
}

type reader struct {
	home, sshDir string
	hosts        []Host
	// index is the position in hosts of each alias, lowercased.
	index map[string]int
	seen  map[string]bool
	files int
}

// file reads one file; block is the aliases the lines before it apply to
// (an Include inside a Host block), which its own Host lines replace.
func (r *reader) file(path string, depth int, block []int) {
	if depth > MaxDepth || r.files >= MaxFiles {
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil || r.seen[abs] {
		return
	}
	r.seen[abs] = true
	b, ok := readSmall(abs)
	if !ok {
		return
	}
	r.files++
	for _, line := range bytes.Split(b, []byte("\n")) {
		keyword, args := parseLine(string(line))
		switch keyword {
		case "host":
			block = block[:0:0]
			for _, a := range args {
				if i, ok := r.add(a); ok {
					block = append(block, i)
				}
			}
		case "match":
			// Match blocks apply on conditions this reader does not evaluate.
			block = nil
		case "hostname", "user":
			if len(args) == 0 || !printable(args[0]) {
				continue
			}
			for _, i := range block {
				h := &r.hosts[i]
				if keyword == "hostname" && h.HostName == "" {
					h.HostName = expandHost(args[0], h.Alias)
				} else if keyword == "user" && h.User == "" {
					h.User = args[0]
				}
			}
		case "include":
			for _, a := range args {
				for _, p := range r.glob(a) {
					r.file(p, depth+1, block)
				}
			}
		}
	}
}

// readSmall reads a regular file of at most MaxFileSize bytes.
func readSmall(path string) ([]byte, bool) {
	// Only regular files: a FIFO or device named by an Include would block
	// or never end.
	if st, err := os.Stat(path); err != nil || !st.Mode().IsRegular() || st.Size() > MaxFileSize {
		return nil, false
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, MaxFileSize+1))
	if err != nil || len(b) > MaxFileSize {
		return nil, false
	}
	return b, true
}

// add records a concrete alias (not a pattern or negation) and returns its
// position.
func (r *reader) add(alias string) (int, bool) {
	if strings.ContainsAny(alias, "*?!,") || !printable(alias) {
		return 0, false
	}
	key := strings.ToLower(alias)
	if i, ok := r.index[key]; ok {
		return i, true
	}
	if len(r.hosts) >= MaxHosts {
		return 0, false
	}
	r.index[key] = len(r.hosts)
	r.hosts = append(r.hosts, Host{Alias: alias})
	return len(r.hosts) - 1, true
}

// glob resolves an Include argument: ~ is the home directory, a relative
// path is in ~/.ssh; the matches are sorted, as ssh reads them.
func (r *reader) glob(pattern string) []string {
	switch {
	case pattern == "~":
		pattern = r.home
	case strings.HasPrefix(pattern, "~/"):
		pattern = filepath.Join(r.home, pattern[2:])
	case strings.HasPrefix(pattern, "~"):
		// Another user's home directory: not this user's configuration.
		return nil
	case !filepath.IsAbs(pattern):
		pattern = filepath.Join(r.sshDir, pattern)
	}
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil
	}
	sort.Strings(matches)
	if len(matches) > maxGlob {
		matches = matches[:maxGlob]
	}
	return matches
}

// parseLine splits a line into its keyword (lowercased) and arguments; ""
// for blank lines and comments.
func parseLine(line string) (string, []string) {
	line = strings.TrimSpace(line)
	if line == "" || line[0] == '#' {
		return "", nil
	}
	end := strings.IndexFunc(line, func(r rune) bool { return r == '=' || unicode.IsSpace(r) })
	if end < 0 {
		return strings.ToLower(line), nil
	}
	keyword := strings.ToLower(line[:end])
	rest := strings.TrimLeftFunc(line[end:], unicode.IsSpace)
	if strings.HasPrefix(rest, "=") {
		rest = rest[1:]
	}
	return keyword, splitArgs(rest)
}

// splitArgs splits arguments at whitespace; double or single quotes group
// one, and a backslash takes the next character as it is. A # outside
// quotes at the start of an argument ends the line.
func splitArgs(s string) []string {
	var out []string
	var cur strings.Builder
	in := false
	var quote rune
	esc := false
	for _, c := range s {
		switch {
		case esc:
			cur.WriteRune(c)
			esc = false
			in = true
		case c == '\\':
			esc = true
		case quote != 0:
			if c == quote {
				quote = 0
			} else {
				cur.WriteRune(c)
			}
		case c == '"' || c == '\'':
			quote = c
			in = true
		case unicode.IsSpace(c):
			if in {
				out = append(out, cur.String())
				cur.Reset()
				in = false
			}
		case c == '#' && !in:
			return out
		default:
			cur.WriteRune(c)
			in = true
		}
	}
	if in {
		out = append(out, cur.String())
	}
	return out
}

// expandHost writes the tokens a HostName may hold that this reader knows:
// %h (the alias) and %%.
func expandHost(v, alias string) string {
	if !strings.Contains(v, "%") {
		return v
	}
	var b strings.Builder
	for i := 0; i < len(v); i++ {
		if v[i] == '%' && i+1 < len(v) {
			switch v[i+1] {
			case 'h':
				b.WriteString(alias)
				i++
				continue
			case '%':
				b.WriteByte('%')
				i++
				continue
			}
		}
		b.WriteByte(v[i])
	}
	return b.String()
}

// printable accepts a short value without control or format characters.
func printable(s string) bool {
	if s == "" || len(s) > maxValue || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}
