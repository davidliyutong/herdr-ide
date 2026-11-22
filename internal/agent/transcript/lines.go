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
	// chunkRaw is about how many bytes of lines are parsed at once, and
	// chunkLines the most lines.
	chunkRaw   = 256 << 10
	chunkLines = 4096
	// backChunk is the size of a read backward.
	backChunk = 64 << 10
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
	// open: the part ends without the line's newline: the line did not end
	// within what the read scanned, or a read backward began inside it.
	open bool
	// cont: the part does not begin at the line's start (a read began
	// inside the line, or did not reach its start): it makes no notice,
	// the part with the start does.
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

// errBudget ends a read that read as much of its file as one read may
// (maxScan): the reply says More, and its cursor goes on from there.
var errBudget = errors.New("transcript: the read's scan budget is spent")

// budget is what one read may still read of its file, until its context
// ends.
type budget struct {
	r    io.ReaderAt
	ctx  context.Context
	left int64
}

// view reads the file within a budget, leaving keep bytes of it for other
// views (a format's look back). Once the budget refused a read, the view
// refuses every later one: what a read stopped at stays where it stopped.
type view struct {
	b    *budget
	keep int64
	err  error
}

func (v *view) ReadAt(p []byte, off int64) (int, error) {
	if v.err == nil {
		v.err = v.b.ctx.Err()
	}
	if v.err != nil {
		return 0, v.err
	}
	room := max(v.b.left-v.keep, 0)
	short := int64(len(p)) > room
	if short {
		p = p[:room]
	}
	n, err := v.b.r.ReadAt(p, off)
	v.b.left -= int64(n)
	if short && err == nil {
		v.err, err = errBudget, errBudget
	}
	return n, err
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

// lastNewline is the offset of the last newline in [lo, hi), -1 when there
// is none; low is where its scan got to: [low, hi) has no newline but the
// one it found. On an error low is how far it got before.
func lastNewline(r io.ReaderAt, lo, hi int64) (p, low int64, err error) {
	buf := make([]byte, min(backChunk, max(hi-lo, 0)))
	for hi > lo {
		n := min(int64(len(buf)), hi-lo)
		b := buf[:n]
		if err := readAt(r, b, hi-n); err != nil {
			return -1, hi, err
		}
		hi -= n
		if i := bytes.LastIndexByte(b, '\n'); i >= 0 {
			return hi + int64(i), hi, nil
		}
	}
	return -1, hi, nil
}

// firstNewline is the offset of the first newline in [lo, hi), -1 when
// there is none.
func firstNewline(r io.ReaderAt, lo, hi int64) (int64, error) {
	buf := make([]byte, min(backChunk, max(hi-lo, 0)))
	for lo < hi {
		n := min(int64(len(buf)), hi-lo)
		b := buf[:n]
		if err := readAt(r, b, lo); err != nil {
			return -1, err
		}
		if i := bytes.IndexByte(b, '\n'); i >= 0 {
			return lo + int64(i), nil
		}
		lo += n
	}
	return -1, nil
}

// inLongLine tells whether off is inside a line longer than maxLine, after
// its first byte: where a read that stopped inside a line it skips leaves
// its cursor. It reads at most about maxLine bytes.
func inLongLine(r io.ReaderAt, off, size int64) bool {
	if off <= 0 || off > size {
		return false
	}
	lo := max(off-maxLine-1, 0)
	p, _, err := lastNewline(r, lo, off)
	switch {
	case err != nil:
		return false
	case p < 0 && lo > 0:
		// No newline in the maxLine+1 bytes before off.
		return true
	}
	start := p + 1
	end := start + maxLine + 1
	if start == off || end > size {
		return false
	}
	q, err := firstNewline(r, off, end)
	return err == nil && q < 0
}

// fwdReader reads the lines of a file from an offset on, up to a size
// read before: the complete ones, and the parts of long lines a read can
// take.
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
	// budget, the context, the file).
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
		if long && r.off > start && (err == io.EOF || errors.Is(err, errBudget)) {
			// A long line that does not end yet, or not within what the
			// read scans: the part read is skipped, and the next read goes
			// on inside the line.
			return rawLine{off: start, n: r.off - start, long: true, open: true, cont: cont}, true
		}
		// What is left is a line that does not end (yet).
		return rawLine{}, false
	}
}

// keep is a copy of a line in the slab.
func (r *fwdReader) keep(line []byte) []byte {
	if len(r.slab)+len(line) > cap(r.slab) {
		r.slab = make([]byte, 0, max(backChunk, len(line)))
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

// chunk is the next lines appended to lines, about raw bytes of them and
// at most chunkLines (at least one line unless none is left).
func (r *fwdReader) chunk(raw int64, lines []rawLine) []rawLine {
	var n int64
	for n < raw && len(lines) < chunkLines {
		l, ok := r.next()
		if !ok {
			break
		}
		lines = append(lines, l)
		n += l.n
	}
	return lines
}

// lineAt is the line that starts at off.
func lineAt(r io.ReaderAt, off, size int64) (rawLine, bool) {
	return newFwdReader(r, off, size).next()
}

// backReader reads the lines of a file backward from a line's end, not
// below a floor.
type backReader struct {
	r io.ReaderAt
	// buf holds the bytes [start, end) of the file; end is where the lines
	// not yet returned end (after a newline, or 0).
	buf        []byte
	start, end int64
	// floor is the lowest offset read.
	floor int64
	// block is the size of the first read; the others double what was
	// read.
	block int64
	// open: the first line ends at end without its newline (end is inside
	// a long line, where a read stopped).
	open bool
	err  error
}

func newBackReader(r io.ReaderAt, end, floor int64) *backReader {
	return &backReader{r: r, start: end, end: end, floor: floor, block: backChunk, open: !isLineStart(r, end)}
}

// grow reads the bytes before buf into it; false at the floor or on an
// error. Reads double buf up to what the longest line kept needs, so that
// a long line is copied a few times only.
func (b *backReader) grow() bool {
	if b.start <= b.floor || b.err != nil {
		return false
	}
	have := int64(len(b.buf))
	n := min(max(b.block, min(have, maxLine+2-have)), b.start-b.floor)
	nb := make([]byte, n+have)
	if err := readAt(b.r, nb[:n], b.start-n); err != nil {
		b.err = err
		return false
	}
	copy(nb[n:], b.buf)
	b.buf, b.start = nb, b.start-n
	return true
}

// prev is the line before the ones returned so far; false at the file's
// start, at the floor or on an error (err).
func (b *backReader) prev() (rawLine, bool) {
	if b.end <= b.floor {
		return rawLine{}, false
	}
	for len(b.buf) == 0 {
		if !b.grow() {
			return rawLine{}, false
		}
	}
	for {
		// The last byte of buf is the line's newline, unless open.
		last := len(b.buf) - 1
		if b.open {
			last = len(b.buf)
		}
		i := bytes.LastIndexByte(b.buf[:last], '\n')
		if i >= 0 || b.start == 0 {
			off := b.start + int64(i+1)
			l := rawLine{off: off, n: b.end - off, open: b.open}
			if b.open || l.n-1 > maxLine {
				l.long = true
			} else {
				l.b = bytes.TrimSpace(b.buf[i+1 : last])
			}
			b.buf, b.end, b.open = b.buf[:i+1], off, false
			return l, true
		}
		if len(b.buf) > maxLine+1 {
			return b.skipLong()
		}
		if !b.grow() {
			return rawLine{}, false
		}
	}
}

// skipLong finds the start of a line longer than maxLine that ends at end,
// without keeping its bytes. When the read's budget ends first, the part of
// the line it read is the line (cont): a read before it goes on from
// there.
func (b *backReader) skipLong() (rawLine, bool) {
	end, open := b.end, b.open
	b.buf, b.open = nil, false
	chunk := make([]byte, backChunk)
	for b.start > b.floor {
		n := min(backChunk, b.start-b.floor)
		c := chunk[:n]
		if err := readAt(b.r, c, b.start-n); err != nil {
			b.err = err
			if errors.Is(err, errBudget) {
				b.end = b.start
				return rawLine{off: b.start, n: end - b.start, long: true, open: open, cont: true}, true
			}
			return rawLine{}, false
		}
		b.start -= n
		if i := bytes.LastIndexByte(c, '\n'); i >= 0 {
			off := b.start + int64(i+1)
			b.buf, b.end = bytes.Clone(c[:i+1]), off
			return rawLine{off: off, n: end - off, long: true, open: open}, true
		}
	}
	if b.start > 0 {
		// The line begins below the floor.
		b.end = b.start
		return rawLine{}, false
	}
	b.end = 0
	return rawLine{off: 0, n: end, long: true, open: open}, true
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
	// into maps, slices and scalars (a tool call's input, a Codex item):
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
