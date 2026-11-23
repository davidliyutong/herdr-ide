//go:build unix

package transcript

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"unicode/utf8"
)

const (
	// maxLine is the longest line read: a longer one is skipped with a
	// notice. Claude Code keeps pasted images in its lines as base64, so
	// lines of several megabytes are ordinary.
	maxLine = 8 << 20
	// slabSize is the least a slab of copied lines takes.
	slabSize = 64 << 10
)

// rawLine is a line of a transcript: a complete one (it ends in a
// newline), or the part of a long line a read saw.
type rawLine struct {
	// off is the offset of its first byte, n its length with the newline;
	// for an open or a cont line, of the part the read saw.
	off, n int64
	// b is its text without the newline and surrounding space; nil when
	// the line is longer than maxLine (long).
	b    []byte
	long bool
	// open: the part ends without the line's newline: the line does not
	// end yet.
	open bool
	// cont: the part does not begin at the line's start (the read began
	// inside the line): it makes no notice, the part with the start does.
	cont bool
}

// skipped is the bytes of a long line its notice gives: those the read
// saw, without the newline.
func (l *rawLine) skipped() int64 {
	if l.open {
		return l.n
	}
	return l.n - 1
}

var errShort = errors.New("transcript: the file changed while it was read")

// ctxReader reads r until ctx ends.
type ctxReader struct {
	r   io.ReaderAt
	ctx context.Context
}

func (c ctxReader) ReadAt(p []byte, off int64) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.ReadAt(p, off)
}

// readAt reads len(b) bytes at off, all of them or an error.
func readAt(r io.ReaderAt, b []byte, off int64) error {
	n, err := r.ReadAt(b, off)
	if n == len(b) {
		return nil
	}
	if err == nil || err == io.EOF {
		err = errShort
	}
	return err
}

// isLineStart tells whether off starts a line: the start of the file or
// the byte after a newline.
func isLineStart(r io.ReaderAt, off int64) bool {
	if off == 0 {
		return true
	}
	var b [1]byte
	return readAt(r, b[:], off-1) == nil && b[0] == '\n'
}

// fwdReader reads the lines of a file from an offset on, up to a size
// read before: the complete ones, and the parts of long lines.
type fwdReader struct {
	br  *bufio.Reader
	off int64
	// cont: the first line is the rest of a long line that began before
	// off.
	cont bool
	// slab is where the lines that fit a read of br are copied, many to
	// an allocation.
	slab []byte
	// done: no complete line is left; err: why, when it was no end (the
	// context, the file).
	done bool
	err  error
}

func newFwdReader(r io.ReaderAt, off, size int64) *fwdReader {
	return &fwdReader{
		br:   bufio.NewReaderSize(io.NewSectionReader(r, off, max(size-off, 0)), 64<<10),
		off:  off,
		cont: !isLineStart(r, off),
	}
}

// next is the next line; false when none is left.
func (r *fwdReader) next() (rawLine, bool) {
	if r.done {
		return rawLine{}, false
	}
	start, cont := r.off, r.cont
	r.cont = false
	var buf []byte
	long := cont
	for {
		chunk, err := r.br.ReadSlice('\n')
		r.off += int64(len(chunk))
		if !long {
			switch {
			case len(buf)+len(chunk) > maxLine+1:
				long, buf = true, nil
			case buf == nil && err == nil:
				// A whole line: into the slab.
				buf = r.keep(chunk)
			default:
				buf = appendLine(buf, chunk)
			}
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err == nil {
			l := rawLine{off: start, n: r.off - start, long: long, cont: cont}
			if !long {
				l.b = bytes.TrimSpace(buf)
			}
			return l, true
		}
		r.done = true
		if err != io.EOF {
			r.err = err
		}
		if long && r.off > start && err == io.EOF {
			// A long line that does not end yet: the part read is skipped.
			return rawLine{off: start, n: r.off - start, long: true, open: true, cont: cont}, true
		}
		// What is left is a line that does not end (yet).
		return rawLine{}, false
	}
}

// keep is a copy of a line in the slab.
func (r *fwdReader) keep(line []byte) []byte {
	if len(r.slab)+len(line) > cap(r.slab) {
		r.slab = make([]byte, 0, max(slabSize, len(line)))
	}
	n := len(r.slab)
	r.slab = append(r.slab, line...)
	return r.slab[n:len(r.slab):len(r.slab)]
}

// appendLine appends a chunk of a line to buf, growing it by doubling up
// to the longest line kept, so that a long line is copied a few times only.
func appendLine(buf, chunk []byte) []byte {
	if need := len(buf) + len(chunk); need > cap(buf) {
		nb := make([]byte, len(buf), min(max(2*cap(buf), need), maxLine+1))
		copy(nb, buf)
		buf = nb
	}
	return append(buf, chunk...)
}

// ---- reading members of a JSON object without decoding it ----

func skipSpace(b []byte, i int) int {
	for i < len(b) && (b[i] == ' ' || b[i] == '\t' || b[i] == '\n' || b[i] == '\r') {
		i++
	}
	return i
}

// stringEnd is the index after the string that starts at b[i] (a quote),
// -1 when it does not end.
func stringEnd(b []byte, i int) int {
	for j := i + 1; ; {
		k := bytes.IndexByte(b[j:], '"')
		if k < 0 {
			return -1
		}
		q := j + k
		n := 0
		for p := q - 1; p > i && b[p] == '\\'; p-- {
			n++
		}
		if n%2 == 0 {
			return q + 1
		}
		j = q + 1
	}
}

// valueEnd is the index after the JSON value that starts at b[i], -1 when
// it does not end.
func valueEnd(b []byte, i int) int {
	if i >= len(b) {
		return -1
	}
	switch b[i] {
	case '"':
		return stringEnd(b, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(b); {
			switch b[j] {
			case '"':
				if j = stringEnd(b, j); j < 0 {
					return -1
				}
				continue
			case '{', '[':
				depth++
			case '}', ']':
				if depth--; depth == 0 {
					return j + 1
				}
			}
			j++
		}
		return -1
	}
	j := i
	for ; j < len(b); j++ {
		if c := b[j]; c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\r' || c == '\n' {
			break
		}
	}
	if j == i {
		return -1
	}
	return j
}

// member is the raw value of the first top-level member key of the JSON
// object b, found without decoding the other members; false when b is no
// object or has no such member before something that is not JSON.
func member(b []byte, key string) ([]byte, bool) {
	i := skipSpace(b, 0)
	if i >= len(b) || b[i] != '{' {
		return nil, false
	}
	i++
	for {
		i = skipSpace(b, i)
		if i >= len(b) || b[i] != '"' {
			return nil, false
		}
		ke := stringEnd(b, i)
		if ke < 0 {
			return nil, false
		}
		k := b[i+1 : ke-1]
		i = skipSpace(b, ke)
		if i >= len(b) || b[i] != ':' {
			return nil, false
		}
		i = skipSpace(b, i+1)
		ve := valueEnd(b, i)
		if ve < 0 {
			return nil, false
		}
		if string(k) == key {
			return b[i:ve], true
		}
		if i = skipSpace(b, ve); i >= len(b) || b[i] != ',' {
			return nil, false
		}
		i++
	}
}

// memberString is the string value of a top-level member of the JSON
// object b; "" when it has none or the value is no string.
func memberString(b []byte, key string) string {
	v, ok := member(b, key)
	if !ok || len(v) < 2 || v[0] != '"' {
		return ""
	}
	if bytes.IndexByte(v, '\\') < 0 {
		return string(v[1 : len(v)-1])
	}
	var s string
	if json.Unmarshal(v, &s) != nil {
		return ""
	}
	return s
}

// present tells whether a raw value is there and not null.
func present(v []byte) bool {
	v = bytes.TrimSpace(v)
	return len(v) > 0 && string(v) != "null"
}

// elements calls fn with each element of the JSON array a, in order, until
// fn returns false, at most limit of them (none for limit < 0): more tells
// that it stopped at the limit with elements left. ok is false when a is
// no array. Nothing is decoded or copied.
func elements(a []byte, limit int, fn func(v []byte) bool) (more, ok bool) {
	i := skipSpace(a, 0)
	if i >= len(a) || a[i] != '[' {
		return false, false
	}
	i = skipSpace(a, i+1)
	if i < len(a) && a[i] == ']' {
		return false, true
	}
	for n := 0; ; n++ {
		e := valueEnd(a, i)
		if e < 0 {
			return false, false
		}
		if limit >= 0 && n == limit {
			return true, true
		}
		if !fn(a[i:e]) {
			return false, true
		}
		i = skipSpace(a, e)
		if i >= len(a) {
			return false, false
		}
		switch a[i] {
		case ',':
			i = skipSpace(a, i+1)
		case ']':
			return false, true
		default:
			return false, false
		}
	}
}

// pick is the members of the JSON object b that keys name, as
// encoding/json decodes an object into a map of raw values (of members of
// one name, the last), without decoding or copying the others; nil when b
// is no object.
func pick(b []byte, keys ...string) map[string][]byte {
	i := skipSpace(b, 0)
	if i >= len(b) || b[i] != '{' {
		return nil
	}
	out := map[string][]byte{}
	i = skipSpace(b, i+1)
	if i < len(b) && b[i] == '}' {
		return out
	}
	for {
		if i >= len(b) || b[i] != '"' {
			return nil
		}
		ke := stringEnd(b, i)
		if ke < 0 {
			return nil
		}
		k := b[i:ke]
		i = skipSpace(b, ke)
		if i >= len(b) || b[i] != ':' {
			return nil
		}
		i = skipSpace(b, i+1)
		ve := valueEnd(b, i)
		if ve < 0 {
			return nil
		}
		for _, key := range keys {
			if keyIs(k, key) {
				out[key] = b[i:ve]
				break
			}
		}
		i = skipSpace(b, ve)
		if i >= len(b) {
			return nil
		}
		switch b[i] {
		case ',':
			i = skipSpace(b, i+1)
		case '}':
			return out
		default:
			return nil
		}
	}
}

// keyIs tells whether the JSON string q (with its quotes) holds key, an
// ASCII name; without allocating unless q has escapes.
func keyIs(q []byte, key string) bool {
	if len(q) < len(key)+2 {
		return false
	}
	if bytes.IndexByte(q, '\\') < 0 {
		return string(q[1:len(q)-1]) == key
	}
	return unquote(q) == key
}

// unquote is the string a JSON string (with its quotes) holds, as
// encoding/json decodes it (bytes that are no UTF-8 replaced).
func unquote(q []byte) string {
	s := q[1 : len(q)-1]
	if bytes.IndexByte(s, '\\') < 0 && utf8.Valid(s) {
		return string(s)
	}
	var out string
	_ = json.Unmarshal(q, &out)
	return out
}

// ---- decoding JSON of unknown shape, bounded ----

const (
	// maxLineNodes is the most JSON values the parsers decode of one line
	// into maps, slices and scalars (a tool call's input):
	// what is beyond is left out, so that a line of many small values does
	// not take many times its size.
	maxLineNodes = 1 << 15
	// decodeDepth is the deepest a value is decoded (an event keeps less,
	// maxDepth); what is deeper is left out.
	decodeDepth = 2 * maxDepth
)

// decoder decodes JSON as encoding/json does into an any, from a budget of
// values.
type decoder struct {
	nodes *int
	// cut: something was left out; bad: a number a float64 does not hold
	// (encoding/json fails on it, and decodes it as nil).
	cut, bad bool
}

// value decodes the JSON value at b[i] of valid JSON b, and gives the index
// after it.
func (d *decoder) value(b []byte, i, depth int) (any, int) {
	if *d.nodes <= 0 || depth > decodeDepth {
		d.cut = true
		return nil, valueEnd(b, i)
	}
	*d.nodes--
	switch b[i] {
	case '{':
		m := obj{}
		i = skipSpace(b, i+1)
		if b[i] == '}' {
			return m, i + 1
		}
		for {
			ke := stringEnd(b, i)
			k := b[i:ke]
			i = skipSpace(b, skipSpace(b, ke)+1)
			if *d.nodes > 0 {
				var v any
				v, i = d.value(b, i, depth+1)
				m[unquote(k)] = v
			} else {
				d.cut = true
				i = valueEnd(b, i)
			}
			if i = skipSpace(b, i); b[i] == '}' {
				return m, i + 1
			}
			i = skipSpace(b, i+1)
		}
	case '[':
		a := []any{}
		i = skipSpace(b, i+1)
		if b[i] == ']' {
			return a, i + 1
		}
		for {
			if *d.nodes > 0 {
				var v any
				v, i = d.value(b, i, depth+1)
				a = append(a, v)
			} else {
				d.cut = true
				i = valueEnd(b, i)
			}
			if i = skipSpace(b, i); b[i] == ']' {
				return a, i + 1
			}
			i = skipSpace(b, i+1)
		}
	case '"':
		e := stringEnd(b, i)
		return unquote(b[i:e]), e
	case 't':
		return true, i + 4
	case 'f':
		return false, i + 5
	case 'n':
		return nil, i + 4
	}
	e := valueEnd(b, i)
	f, err := strconv.ParseFloat(string(b[i:e]), 64)
	if err != nil {
		d.bad = true
		return nil, e
	}
	return f, e
}
