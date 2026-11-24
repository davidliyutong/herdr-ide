//go:build unix

package search

import (
	"strings"
	"unicode/utf8"
)

// lead is how much of a line before its first match a preview shows at
// most (bytes); a line whose first match is further in starts with an
// ellipsis, leadKept bytes before the match.
const (
	lead     = 120
	leadKept = 40
)

// u16 counts the UTF-16 code units of s as an editor sees it: an invalid
// byte is one replacement character.
func u16(s string) int {
	n := 0
	for i := 0; i < len(s); {
		r, w := utf8.DecodeRuneInString(s[i:])
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
		i += w
	}
	return n
}

// runeStart moves byte offset i of s back to the start of its rune.
func runeStart(s string, i int) int {
	for i > 0 && i < len(s) && !utf8.RuneStart(s[i]) {
		i--
	}
	return i
}

// excerpt is the preview of line (without its line break) with the
// matches spans (byte offsets, in order): the text around the first match,
// at most MaxPreview characters, leading blanks dropped, an ellipsis where
// it was cut; the first match's column (1-based, UTF-16 code units of the
// whole line); and the matches in the preview ([start, end) in UTF-16 code
// units of it).
func excerpt(line string, spans [][2]int) (string, int, [][2]int) {
	first := 0
	if len(spans) > 0 {
		first = min(max(spans[0][0], 0), len(line))
	}
	col := u16(line[:first]) + 1
	lo := len(line) - len(strings.TrimLeft(line, " \t"))
	if lo > first {
		lo = 0
	}
	prefix := ""
	if first-lo > lead {
		lo = runeStart(line, first-leadKept)
		prefix = "…"
	}
	// hi: MaxPreview characters on.
	hi, n := lo, 0
	for hi < len(line) && n < MaxPreview {
		_, w := utf8.DecodeRuneInString(line[hi:])
		hi += w
		n++
	}
	var b strings.Builder
	b.WriteString(prefix)
	for i := lo; i < hi; {
		r, w := utf8.DecodeRuneInString(line[i:])
		b.WriteRune(r)
		i += w
	}
	if hi < len(line) {
		b.WriteString("…")
	}
	off := u16(prefix)
	var ranges [][2]int
	for _, sp := range spans {
		s, e := max(sp[0], lo), min(sp[1], hi)
		if sp[0] >= hi || e < s {
			continue
		}
		s, e = runeStart(line, s), runeStart(line, e)
		ranges = append(ranges, [2]int{off + u16(line[lo:s]), off + u16(line[lo:e])})
	}
	return b.String(), col, ranges
}
