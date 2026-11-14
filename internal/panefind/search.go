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
)

// ErrTooLarge: the query is longer than MaxQuery.
var ErrTooLarge = errors.New("query too large")

// InvalidError: the regular expression does not compile. Reason is a code
// the browser translates (empty when the parser gave none), Expr the part
// of the expression at fault.
type InvalidError struct{ Reason, Expr string }

func (e *InvalidError) Error() string {
	return strings.TrimSpace("invalid regular expression: " + e.Reason + " " + e.Expr)
}

// regexReasons name the parser's errors for the browser.
var regexReasons = map[syntax.ErrorCode]string{
	syntax.ErrInvalidCharClass:      "char_class",
	syntax.ErrInvalidCharRange:      "char_range",
	syntax.ErrInvalidEscape:         "escape",
	syntax.ErrInvalidNamedCapture:   "named_capture",
	syntax.ErrInvalidPerlOp:         "perl_op",
	syntax.ErrInvalidRepeatOp:       "nested_repeat",
	syntax.ErrInvalidRepeatSize:     "repeat_count",
	syntax.ErrInvalidUTF8:           "utf8",
	syntax.ErrMissingBracket:        "missing_bracket",
	syntax.ErrMissingParen:          "missing_paren",
	syntax.ErrMissingRepeatArgument: "missing_repeat_arg",
	syntax.ErrTrailingBackslash:     "trailing_backslash",
	syntax.ErrUnexpectedParen:       "unexpected_paren",
	syntax.ErrNestingDepth:          "too_deep",
	syntax.ErrLarge:                 "too_large",
}

// Matcher finds the matches of Options in one line of text.
type Matcher struct {
	re *regexp.Regexp
	// Whole words only: longest is re preferring the longest match, and
	// restart tells whether re may run on the rest of a line (it asserts
	// nothing about the text before the place it starts at).
	word    bool
	longest *regexp.Regexp
	restart bool
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
	const fold = "(?i)"
	if !o.MatchCase {
		pat = fold + pat
	}
	re, err := regexp.Compile(pat)
	if err != nil {
		var se *syntax.Error
		if errors.As(err, &se) {
			// The part at fault as the user wrote it.
			expr := se.Expr
			if !o.MatchCase {
				expr = strings.TrimPrefix(expr, fold)
			}
			return nil, &InvalidError{Reason: regexReasons[se.Code], Expr: expr}
		}
		return nil, &InvalidError{}
	}
	m := &Matcher{re: re, word: o.WholeWord}
	if o.WholeWord {
		m.longest = re.Copy()
		m.longest.Longest()
		if tree, err := syntax.Parse(pat, syntax.Perl); err == nil {
			m.restart = restartable(tree)
		}
	}
	return m, nil
}

// restartable reports whether re can be matched on the rest of a line as
// on the whole line from there: it asserts nothing about the text before
// where it starts (^, \A, \b, \B).
func restartable(re *syntax.Regexp) bool {
	switch re.Op {
	case syntax.OpBeginLine, syntax.OpBeginText, syntax.OpWordBoundary, syntax.OpNoWordBoundary:
		return false
	}
	for _, sub := range re.Sub {
		if !restartable(sub) {
			return false
		}
	}
	return true
}

// find returns the byte ranges of the matches in line, in order and not
// overlapping: no empty ones, and only whole words when asked.
func (m *Matcher) find(line string) [][]int {
	if m.word && m.restart {
		return m.words(line)
	}
	all := m.re.FindAllStringIndex(line, -1)
	out := all[:0]
	for _, r := range all {
		if r[0] == r[1] || m.word && !wholeWord(line, r[0], r[1]) {
			continue
		}
		out = append(out, r)
	}
	return out
}

// words finds whole-word matches. A match that is not a whole word does
// not hide one inside or after it: the longest match at the same place is
// tried, then the search goes on from the next character. The extra work
// is bounded per line; past it, the rest of the line is searched as by
// find, which skips such matches.
func (m *Matcher) words(line string) [][]int {
	var out [][]int
	budget := 8*len(line) + 4096
	pos := 0
	for pos < len(line) {
		if budget < 0 {
			for _, r := range m.re.FindAllStringIndex(line[pos:], -1) {
				if s, e := pos+r[0], pos+r[1]; s < e && wholeWord(line, s, e) {
					out = append(out, []int{s, e})
				}
			}
			return out
		}
		loc := m.re.FindStringIndex(line[pos:])
		if loc == nil {
			break
		}
		s, e := pos+loc[0], pos+loc[1]
		budget -= e - pos + 1
		if s < e && wholeWord(line, s, e) {
			out = append(out, []int{s, e})
			pos = e
			continue
		}
		if s < e {
			if l := m.longest.FindStringIndex(line[s:]); l != nil && l[0] == 0 {
				budget -= l[1] + 1
				if le := s + l[1]; le != e && wholeWord(line, s, le) {
					out = append(out, []int{s, le})
					pos = le
					continue
				}
			}
		}
		_, size := utf8.DecodeRuneInString(line[s:])
		pos = s + max(size, 1)
	}
	return out
}

// isWord: letters, digits, the underscore and the marks that combine with
// them (é written as e and U+0301).
func isWord(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r)
}

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

// ring keeps the last Limit of the matches pushed: number k of them (from
// 0) while n-len(buf) <= k < n.
type ring struct {
	buf []Range
	n   int
}

func (r *ring) push(x Range) {
	if len(r.buf) < Limit {
		r.buf = append(r.buf, x)
	} else {
		r.buf[r.n%Limit] = x
	}
	r.n++
}

func (r *ring) at(k int) (Range, bool) {
	if k < r.n-len(r.buf) || k >= r.n {
		return Range{}, false
	}
	return r.buf[k%Limit], true
}

// Search finds m's matches in text, rows firstRow on of a pane cols
// wide, as herdr's pane.selection.read returned them. The current match is
// the first one starting after origin (forward) or the last one ending
// before it (backward), wrapping around; herdr's pane.copy_search picks it
// the same way. Inclusive also takes one starting (ending) at origin.
// Every match is counted, but only those an answer may carry are kept:
// the first and the last Limit, and Limit on either side of origin.
func Search(text string, firstRow uint32, cols int, m *Matcher, backward bool, origin Point, inclusive bool) Result {
	// beyond: r lies past origin in the search's direction. Matches come
	// in reading order, so once one does, every later one does.
	beyond := func(r Range) bool {
		switch {
		case backward && inclusive:
			return less(origin, r.End)
		case backward:
			return !less(r.End, origin)
		case inclusive:
			return !less(r.Start, origin)
		}
		return less(origin, r.Start)
	}
	var head, post []Range // the first matches; the first ones past origin
	var tail, pre ring     // the last matches; the last ones before origin
	total, pivot := 0, -1  // pivot: the first match past origin
	row := firstRow
	for line := range strings.SplitSeq(text, "\n") {
		ranges, rows := layout(line, row, cols, m.find(line))
		for _, r := range ranges {
			if len(head) < Limit {
				head = append(head, r)
			}
			tail.push(r)
			if pivot < 0 && beyond(r) {
				pivot = total
			}
			if pivot < 0 {
				pre.push(r)
			} else if len(post) < Limit {
				post = append(post, r)
			}
			total++
		}
		row += rows
	}
	res := Result{Total: total, FirstRow: firstRow, Matches: []Range{}}
	if total == 0 {
		return res
	}
	var target int
	switch {
	case !backward && pivot >= 0:
		target = pivot
	case !backward:
		target = 0 // around the end
	case pivot > 0:
		target = pivot - 1
	default:
		target = total - 1 // every match is before origin, or around the start
	}
	at := func(i int) Range {
		if i < len(head) {
			return head[i]
		}
		if r, ok := tail.at(i); ok {
			return r
		}
		if r, ok := pre.at(i); ok {
			return r
		}
		return post[i-pivot]
	}
	n := min(Limit, total)
	start := min(max(target-n/2, 0), total-n)
	res.Matches = make([]Range, n)
	for i := range n {
		res.Matches[i] = at(start + i)
	}
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
