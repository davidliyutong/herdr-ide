// Package panefind searches the text of a herdr pane for the find bar
// (docs/features/20-find-in-panes.md): a literal or an RE2 regular
// expression, with or without case, optionally whole words only. The text
// comes from herdr's pane.selection.read, one line per line of output with
// soft-wrapped rows joined; matches are mapped back to the pane's cells by
// laying the text out again in the pane's width, grapheme cluster by
// grapheme cluster, the way herdr's terminal placed it.
package panefind

import (
	"errors"
	"regexp"
	"regexp/syntax"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/rivo/uniseg"

	"herdr-ide/internal/agentproto"
)

type (
	// Point is a cell: its row counted from the oldest line kept (as
	// herdr's pane.copy_search and selections count them) and its column.
	Point = agentproto.TextPoint
	// Range is a match: its first and last cell, both included.
	Range = agentproto.TextRange
	// Result has the shape of herdr's pane.copy_search answer.
	Result = agentproto.FindResult
)

// less orders points the way text is read.
func less(p, q Point) bool { return p.Row < q.Row || p.Row == q.Row && p.Col < q.Col }

// Options say what to look for.
type Options struct {
	Query     string
	Regex     bool
	MatchCase bool
	WholeWord bool
}

const (
	// MaxQuery bounds the query, as herdr bounds its own search's.
	MaxQuery = 4096
	// Limit is how many matches an answer carries, as herdr's search.
	Limit = 1024
	// MaxTotal stops counting matches (a one-letter query in a long
	// scrollback).
	MaxTotal = 100_000
)

// ErrTooLarge: the query is longer than MaxQuery.
var ErrTooLarge = errors.New("query too large")

// InvalidError: the regular expression does not compile.
type InvalidError struct{ Detail string }

func (e *InvalidError) Error() string { return "invalid regular expression: " + e.Detail }

// Matcher finds the matches of Options in one line of text.
type Matcher struct {
	re   *regexp.Regexp
	word bool
}

// Compile prepares o. Go's regexp (RE2) runs in time linear in the text,
// so no query can make a search take long.
func Compile(o Options) (*Matcher, error) {
	if len(o.Query) > MaxQuery {
		return nil, ErrTooLarge
	}
	pat := o.Query
	if !o.Regex {
		pat = regexp.QuoteMeta(pat)
	}
	if !o.MatchCase {
		pat = "(?i)" + pat
	}
	re, err := regexp.Compile(pat)
	if err != nil {
		var se *syntax.Error
		if errors.As(err, &se) {
			return nil, &InvalidError{Detail: string(se.Code) + ": " + se.Expr}
		}
		return nil, &InvalidError{Detail: err.Error()}
	}
	return &Matcher{re: re, word: o.WholeWord}, nil
}

// find returns the byte ranges of the matches in line: no empty ones,
// and only whole words when asked.
func (m *Matcher) find(line string, max int) [][]int {
	if max <= 0 {
		return nil
	}
	all := m.re.FindAllStringIndex(line, max)
	out := all[:0]
	for _, r := range all {
		if r[0] == r[1] || m.word && !wholeWord(line, r[0], r[1]) {
			continue
		}
		out = append(out, r)
	}
	return out
}

func isWord(r rune) bool { return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) }

// wholeWord: a match that starts (ends) with a word character has none
// right before (after) it, like \b in Unicode text.
func wholeWord(line string, start, end int) bool {
	first, _ := utf8.DecodeRuneInString(line[start:end])
	if isWord(first) && start > 0 {
		if before, _ := utf8.DecodeLastRuneInString(line[:start]); isWord(before) {
			return false
		}
	}
	last, _ := utf8.DecodeLastRuneInString(line[start:end])
	if isWord(last) && end < len(line) {
		if after, _ := utf8.DecodeRuneInString(line[end:]); isWord(after) {
			return false
		}
	}
	return true
}

// Search finds m's matches in text, rows firstRow on of a pane cols
// wide, as herdr's pane.selection.read returned them. The current match is
// the first one starting after origin (forward) or the last one ending
// before it (backward), wrapping around; herdr's pane.copy_search picks it
// the same way.
func Search(text string, firstRow uint32, cols int, m *Matcher, backward bool, origin Point) Result {
	var all []Range
	target := -1
	capped := false
	row := firstRow
	for line := range strings.SplitSeq(text, "\n") {
		found := m.find(line, MaxTotal+1-len(all))
		ranges, rows := layout(line, row, cols, found)
		for _, r := range ranges {
			if len(all) == MaxTotal {
				capped = true
				break
			}
			if !backward && target < 0 && less(origin, r.Start) {
				target = len(all)
			}
			if backward && less(r.End, origin) {
				target = len(all)
			}
			all = append(all, r)
		}
		if capped {
			break
		}
		row += rows
	}
	res := Result{Total: len(all), Capped: capped, FirstRow: firstRow, Matches: []Range{}}
	if len(all) == 0 {
		return res
	}
	if target < 0 {
		target = 0
		if backward {
			target = len(all) - 1
		}
	}
	n := min(Limit, len(all))
	start := min(max(target-n/2, 0), len(all)-n)
	res.Matches = all[start : start+n]
	cur := target - start
	res.Current, res.CurrentGlobal = &cur, &target
	return res
}

// layout places line from row on in a pane cols wide, the way the terminal
// wrapped it, and returns the cells of the byte ranges found and how many
// rows the line takes. A cluster that does not fit the rest of a row
// starts the next one; a zero-width one belongs to the cell before it.
func layout(line string, row uint32, cols int, found [][]int) ([]Range, uint32) {
	if cols <= 0 {
		cols = 1 << 16
	}
	out := make([]Range, len(found))
	if ascii(line) {
		// One byte, one cell: no need to look at clusters.
		at := func(b int) Point { return Point{Row: row + uint32(b/cols), Col: uint16(b % cols)} }
		for i, f := range found {
			out[i] = Range{Start: at(f[0]), End: at(f[1] - 1)}
		}
		return out, uint32(max(1, (len(line)+cols-1)/cols))
	}
	r, col := row, 0
	si, ei := 0, 0 // next match start and end to place
	state := -1
	pos := 0
	rest := line
	for rest != "" {
		var cluster string
		var width int
		cluster, rest, width, state = uniseg.FirstGraphemeClusterInString(rest, state)
		var first, last Point
		if width == 0 {
			c := max(col-1, 0)
			first, last = Point{Row: r, Col: uint16(c)}, Point{Row: r, Col: uint16(c)}
		} else {
			width = min(width, 2)
			if col+width > cols && col > 0 {
				r, col = r+1, 0
			}
			first = Point{Row: r, Col: uint16(col)}
			last = Point{Row: r, Col: uint16(min(col+width, cols) - 1)}
			col += width
		}
		end := pos + len(cluster)
		for si < len(found) && found[si][0] < end {
			out[si].Start = first
			si++
		}
		for ei < len(found) && found[ei][1]-1 < end {
			out[ei].End = last
			ei++
		}
		pos = end
	}
	return out, r - row + 1
}

func ascii(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}
