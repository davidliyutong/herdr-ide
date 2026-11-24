//go:build unix

package search

import (
	"regexp"
	"strings"
)

// maxPatterns bounds the include or exclude patterns of a search.
const maxPatterns = 100

// skipped are the folders no search looks in: version control's data, and
// node_modules (as VS Code's search.exclude has it).
var skipped = []string{".git", ".hg", ".svn", ".bzr", ".jj", "CVS", "node_modules"}

// splitGlobs splits comma-separated patterns (commas inside braces are
// alternatives of a pattern), dropping blanks, a leading "./" and a
// trailing "/".
func splitGlobs(s string) []string {
	var out []string
	depth, start := 0, 0
	add := func(p string) {
		p = strings.TrimSpace(p)
		p = strings.TrimPrefix(p, "./")
		p = strings.TrimRight(p, "/")
		if p != "" && p != "/" && len(out) < maxPatterns {
			out = append(out, p)
		}
	}
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '{':
			depth++
		case '}':
			if depth > 0 {
				depth--
			}
		case ',':
			if depth == 0 {
				add(s[start:i])
				start = i + 1
			}
		}
	}
	add(s[start:])
	return out
}

// anchored reports whether pattern p is matched against paths below the
// directory searched (it has a "/"), else against names.
func anchored(p string) bool { return strings.Contains(p, "/") }

// rgGlobs are ripgrep's --glob values for the include and exclude
// patterns, with the skipped folders first: an include names files and
// what is in the folders it names; an exclude, files and folders, which
// ripgrep then does not enter. A later glob wins over an earlier one.
func rgGlobs(includes, excludes []string) []string {
	var out []string
	for _, s := range skipped {
		out = append(out, "--glob=!"+s)
	}
	for _, p := range includes {
		if anchored(p) {
			p = "/" + strings.TrimPrefix(p, "/")
			out = append(out, "--glob="+p, "--glob="+p+"/**")
		} else {
			out = append(out, "--glob="+p, "--glob=**/"+p+"/**")
		}
	}
	for _, p := range excludes {
		if anchored(p) {
			p = "/" + strings.TrimPrefix(p, "/")
		}
		out = append(out, "--glob=!"+p)
	}
	return out
}

// matcher matches paths below the directory searched ("/" between names)
// against patterns: a pattern without "/" matches the name of the file or
// of a folder it is in, one with "/" (a leading one dropped) the path or a
// folder's path on it. `**` stands for any folders, `*` for any characters
// but "/", `?` for one, `[...]` for a class and `{a,b}` for alternatives.
type matcher struct {
	names []*regexp.Regexp
	paths []*regexp.Regexp
}

func newMatcher(patterns []string) *matcher {
	m := &matcher{}
	for _, p := range patterns {
		re, err := regexp.Compile(globRegexp(strings.TrimPrefix(p, "/")))
		if err != nil {
			continue
		}
		if anchored(p) {
			m.paths = append(m.paths, re)
		} else {
			m.names = append(m.names, re)
		}
	}
	return m
}

func (m *matcher) empty() bool { return len(m.names) == 0 && len(m.paths) == 0 }

// self reports whether the path itself (its name, or its whole path)
// matches: a folder that does is not entered.
func (m *matcher) self(rel string) bool {
	name := rel[strings.LastIndexByte(rel, '/')+1:]
	for _, re := range m.names {
		if re.MatchString(name) {
			return true
		}
	}
	for _, re := range m.paths {
		if re.MatchString(rel) {
			return true
		}
	}
	return false
}

// any reports whether the path or a folder it is in matches.
func (m *matcher) any(rel string) bool {
	for i := 0; i <= len(rel); i++ {
		if i == len(rel) || rel[i] == '/' {
			if m.self(rel[:i]) {
				return true
			}
		}
	}
	return false
}

// globRegexp is the regular expression of a glob pattern, matching whole
// strings.
func globRegexp(g string) string {
	var b strings.Builder
	b.WriteString("^")
	depth := 0
	for i := 0; i < len(g); i++ {
		c := g[i]
		switch {
		case c == '*' && i+1 < len(g) && g[i+1] == '*':
			// "**/" any folders, "/**" at the end anything below, else
			// anything.
			if i+2 < len(g) && g[i+2] == '/' {
				b.WriteString("(?:.*/)?")
				i += 2
			} else {
				b.WriteString(".*")
				i++
			}
		case c == '*':
			b.WriteString("[^/]*")
		case c == '?':
			b.WriteString("[^/]")
		case c == '[':
			end := strings.IndexByte(g[i+1:], ']')
			if end < 0 {
				b.WriteString(`\[`)
				continue
			}
			class := g[i+1 : i+1+end]
			if strings.HasPrefix(class, "!") {
				class = "^" + class[1:]
			}
			b.WriteString("[" + strings.ReplaceAll(class, `\`, `\\`) + "]")
			i += end + 1
		case c == '{':
			depth++
			b.WriteString("(?:")
		case c == '}' && depth > 0:
			depth--
			b.WriteString(")")
		case c == ',' && depth > 0:
			b.WriteString("|")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	for ; depth > 0; depth-- {
		b.WriteString(")")
	}
	b.WriteString("$")
	return b.String()
}
