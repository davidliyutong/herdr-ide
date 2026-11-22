//go:build unix

// Package transcript reads the session transcripts of coding agents
// (Claude Code's and Codex's JSON lines) into the conversation events of
// internal/agentproto: ACP v1 session updates, the user's prompts, turns
// and notices. A read is one page of a transcript, forward from a cursor
// (agentproto.Seq) or the page before it; nothing is kept between reads,
// so a machine serves any number of views from the files alone.
//
// The transcripts are the agents' internal formats and change between
// versions: a parser maps the lines it knows, passes over the kinds of
// lines known not to be conversation, and counts what it could not read
// (TranscriptTail.Unknown) without forwarding it. Every read is bounded:
// the bytes of a reply, the text of an event, the output of a tool call,
// the length of a line, the events and the decoded values of a line, and
// the bytes read of the file; and it ends with its context.
package transcript

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"slices"
	"syscall"

	"herdr-ide/internal/agentproto"
)

// Limits bound a read. A member that is zero, or above agentproto's
// maximum, is that maximum.
type Limits struct {
	// Bytes is the most bytes a reply takes (agentproto.MaxTailBytes); a
	// page holds one event at least.
	Bytes int
	// Text is the most bytes of an event's text (agentproto.MaxTextBytes).
	Text int
	// ToolOutput is the most bytes of a tool call's output an event keeps,
	// its start and its end (agentproto.MaxToolOutput).
	ToolOutput int
}

func (l Limits) norm() limits {
	or := func(v, m int) int {
		if v <= 0 || v > m {
			return m
		}
		return v
	}
	return limits{or(l.Bytes, agentproto.MaxTailBytes), or(l.Text, agentproto.MaxTextBytes), or(l.ToolOutput, agentproto.MaxToolOutput)}
}

const (
	// maxScan is the most bytes one read reads of its file, backward and
	// forward, skipped lines and looks back included: a page ends there
	// (More), its cursor where the reading stopped, inside a long line if
	// need be (inLongLine), so that the next read goes on.
	maxScan = 64 << 20
	// lookBack is the part of maxScan kept for a format's look back
	// (codexFormat.run) when the lines read stop at the budget.
	lookBack = codexBack + maxLine + 2
	// envelope is what a reply takes besides its events, at most: its
	// kind, session, file, cursors, counts and title.
	envelope = 4 << 10
	// idHead is the most of a file's first line its identity covers.
	idHead = 64 << 10
	// changedScan is how far back Changed looks for the end of a complete
	// line before a line that does not end yet.
	changedScan = 1 << 20
)

// A format is the parser of one kind of transcript.
type format interface {
	// run starts parsing the lines from off on; what the lines before
	// off tell, looked for backward within a bound (at most lookBack
	// bytes), is its state.
	run(r io.ReaderAt, off int64) run
}

// A run parses consecutive lines in their order.
type run interface {
	// prepare sees a chunk's lines before they are parsed.
	prepare(lines []rawLine)
	// parse makes the events of a line.
	parse(l *rawLine, o *lineOut)
}

// formats are the parsers by their id (agentkinds.Kind.Transcript).
var formats = map[string]format{
	"claude": claudeFormat{},
	"codex":  codexFormat{},
}

var errNotRegular = errors.New("transcript: not a regular file")

// Tail reads one page of a transcript. kind is the parser's id ("claude",
// "codex"); f is the open regular file; ref.Kind and ref.Session are
// copied into the reply.
//
// A forward read (ref.Back false) starts at the line at
// agentproto.SeqOffset(ref.From), leaving out that line's events below
// agentproto.SeqIndex(ref.From). A back read gives the latest events before
// ref.From, or before the transcript's end when ref.From is 0. A cursor that
// is no line's start any more (the file was replaced or truncated) is
// answered as a first read, with the file's File, so that the client starts
// over; but one inside a line longer than maxLine, where a read that
// reached its budget left it, goes on there. An unknown kind is answered
// with the code TranscriptBadRequest.
//
// A read reads at most maxScan bytes of the file and ends with ctx (its
// error is ctx's).
func Tail(ctx context.Context, kind string, f *os.File, ref agentproto.TranscriptRef, limit Limits) (agentproto.TranscriptTail, error) {
	out := agentproto.TranscriptTail{Kind: ref.Kind, Session: ref.Session}
	fm, ok := formats[kind]
	if !ok {
		out.Code, out.First, out.Next = agentproto.TranscriptBadRequest, ref.From, ref.From
		return out, nil
	}
	fi, err := f.Stat()
	if err != nil {
		return out, err
	}
	if !fi.Mode().IsRegular() {
		return out, errNotRegular
	}
	out.File = fileID(f, fi)
	return out, tail(ctx, fm, f, fi.Size(), ref, limit.norm(), &out)
}

// Changed tells, cheaply, whether a forward read from from would read
// anything: a complete line after it, the rest of its line, or a file that
// was replaced or truncated.
func Changed(f *os.File, from uint64) bool {
	fi, err := f.Stat()
	if err != nil {
		// A read says why.
		return true
	}
	return changed(f, fi.Size(), from)
}

func changed(r io.ReaderAt, size int64, from uint64) bool {
	off := agentproto.SeqOffset(from)
	switch {
	case off > size, agentproto.SeqIndex(from) > 0:
		return true
	case off == size:
		// Nothing after the cursor, also one a read left inside a long line
		// that does not end yet.
		return false
	case !isLineStart(r, off):
		// Inside a long line, or no line's start any more: a read tells.
		return true
	}
	var b [1]byte
	if readAt(r, b[:], size-1) != nil || b[0] == '\n' {
		return true
	}
	// The last line does not end yet: is there a complete one before it?
	p, _, err := lastNewline(r, max(off, size-1-changedScan), size-1)
	return err != nil || p >= off
}

// FileID is the identity of a transcript's file (TranscriptTail.File): a
// digest of its device, its inode and its first line, never its path.
func FileID(f *os.File) string {
	fi, err := f.Stat()
	if err != nil {
		return ""
	}
	return fileID(f, fi)
}

func fileID(r io.ReaderAt, fi os.FileInfo) string {
	h := sha256.New()
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		var b [16]byte
		binary.LittleEndian.PutUint64(b[:8], uint64(st.Dev))
		binary.LittleEndian.PutUint64(b[8:], st.Ino)
		h.Write(b[:])
	}
	head := make([]byte, min(fi.Size(), idHead))
	n, _ := r.ReadAt(head, 0)
	head = head[:n]
	if i := bytes.IndexByte(head, '\n'); i >= 0 {
		head = head[:i+1]
	} else if n < idHead {
		// The first line is still being written.
		head = nil
	}
	h.Write(head)
	return hex.EncodeToString(h.Sum(nil)[:16])
}

// tailer is one read of a transcript.
type tailer struct {
	// r reads the lines, all a format's looks back: both within the read's
	// budget, r leaving lookBack of it to all.
	r, all *view
	size   int64
	f      format
	lim    limits
	// budget is the bytes the events may take, used what they take.
	budget, used int
	out          *agentproto.TranscriptTail
	title        titleSeen
	err          error
}

// titleSeen is the session's title the lines read give: the user's own
// before one the agent made, the latest of each.
type titleSeen struct {
	off    int64
	s      string
	custom bool
}

func (t *titleSeen) see(off int64, s string, custom bool) {
	if s != "" && (t.s == "" || custom && !t.custom || custom == t.custom && off > t.off) {
		*t = titleSeen{off, s, custom}
	}
}

// tail reads a page of the transcript r of size bytes into out, reading at
// most maxScan bytes of r, until ctx ends.
func tail(ctx context.Context, fm format, r io.ReaderAt, size int64, ref agentproto.TranscriptRef, lim limits, out *agentproto.TranscriptTail) error {
	b := &budget{r: r, ctx: ctx, left: maxScan}
	t := &tailer{r: &view{b: b, keep: lookBack}, all: &view{b: b}, size: size, f: fm, lim: lim, out: out, budget: lim.bytes - min(envelope, lim.bytes/4)}
	off := agentproto.SeqOffset(ref.From)
	start := off <= size && isLineStart(t.r, off)
	inside := off <= size && !start && inLongLine(t.r, off, size)
	switch {
	case ref.Back && ref.From == 0, off > size, !start && !inside:
		t.first()
	case ref.Back:
		out.Next = ref.From
		k := agentproto.SeqIndex(ref.From)
		if inside {
			k = 0
		}
		t.back(off, k, ref.From)
	default:
		t.forward(ref.From)
	}
	out.Title = t.fitTitle()
	return t.err
}

// first is a view's first read: the page that ends with the last complete
// line, whose end is Next.
func (t *tailer) first() {
	p, low, err := lastNewline(t.r, 0, t.size)
	switch {
	case errors.Is(err, errBudget):
		// The last line does not end, and is longer than a read scans:
		// forward reads go on at the file's end, inside it, and a read
		// back where this one stopped.
		t.out.Next = agentproto.Seq(t.size, 0)
		t.out.First, t.out.More = agentproto.Seq(low, 0), true
	case err != nil:
		t.err = err
	default:
		t.out.Next = agentproto.Seq(p+1, 0)
		t.back(p+1, 0, 0)
	}
}

// fitTitle is the session's title, cut so that the reply stays within its
// limit.
func (t *tailer) fitTitle() string {
	s, _ := cutText(t.title.s, maxSessionTitle)
	if s == "" {
		return ""
	}
	base := *t.out
	base.Events, base.Title = nil, ""
	b, _ := json.Marshal(base)
	room := t.lim.bytes - t.used - len(b) - len(`,"events":[],"title":""`)
	for s != "" {
		if e, _ := json.Marshal(s); len(e)-2 <= room {
			return s
		}
		s, _ = cutText(s, len(s)/2)
	}
	return ""
}

// parse makes the events of a line into o: a notice for one that is too
// long (at its start), at most agentproto.MaxLineEvents. o is used again
// from line to line, so that a line of no events allocates nothing.
func (t *tailer) parse(rn run, l *rawLine, o *lineOut) {
	o.reset(&t.lim)
	switch {
	case l.cont:
		// The rest of a long line, whose notice is at its start.
	case l.long:
		o.notice(noticeSkipped, obj{"bytes": l.skipped()})
	case len(l.b) > 0:
		rn.parse(l, o)
	}
	if o.over {
		o.unknown++
	}
}

// lineDone counts a line in the page.
func (t *tailer) lineDone(o *lineOut, l *rawLine) {
	t.out.Unknown += o.unknown
	t.title.see(l.off, o.title, o.custom)
}

// encode is an event with its place and the bytes it takes, made to fit the
// budget: its strings cut shorter and shorter, else a notice in its place.
// An event whose strings alone are beyond the budget is not encoded as it
// is, and one whose keys are (they are not cut) not at all: their JSON
// would be garbage of their size.
func (t *tailer) encode(p *pev, seq uint64) (agentproto.TranscriptEvent, int) {
	var ev agentproto.TranscriptEvent
	keys, values := p.strBytes()
	n := keys + values
	if n <= t.budget {
		ev, n = encode(p, seq)
	}
	for cut := t.lim.text / 4; n > t.budget && keys <= t.budget && cut >= 16; cut /= 4 {
		q := p.shrunk(cut)
		ev, n = encode(&q, seq)
	}
	if n > t.budget {
		q := pev{t: agentproto.TranscriptNotice, at: p.at, method: agentproto.NoticeMethod(noticeSkipped), params: obj{"bytes": n}}
		ev, n = encode(&q, seq)
	}
	return ev, n
}

// slot is an event of a forward page; a usage update that a later one of
// its message replaced is dropped (n < 0).
type slot struct {
	ev    agentproto.TranscriptEvent
	n     int
	usage string
}

// forward reads the events from the Seq from on, until the budget is
// spent, the lines end or the read reached its budget of bytes read (More,
// Next where the lines read end: inside a long line if need be).
func (t *tailer) forward(from uint64) {
	off, idx := agentproto.SeqOffset(from), agentproto.SeqIndex(from)
	t.out.First, t.out.Next = from, from
	rn := t.f.run(t.all, off)
	fr := newFwdReader(t.r, off, t.size)
	var page []slot
	// last is the slot of the latest usage update of each message; kept
	// counts the slots not dropped. The dropped are let go of once they are
	// more than the others, so that a page of lines that replace each
	// other's usage holds no more than the events it returns.
	last := map[string]int{}
	kept, dropped := 0, 0
	var lines []rawLine
	var o lineOut
read:
	for !fr.done {
		if lines = fr.chunk(chunkRaw, lines[:0]); len(lines) == 0 {
			break
		}
		rn.prepare(lines)
		for i := range lines {
			l := &lines[i]
			t.parse(rn, l, &o)
			for j := range o.events {
				if l.off == off && j < idx {
					continue
				}
				p := &o.events[j]
				seq := agentproto.Seq(l.off, j)
				ev, n := t.encode(p, seq)
				if k, ok := last[p.usage]; ok {
					t.used -= page[k].n
					page[k] = slot{n: -1}
					delete(last, p.usage)
					kept, dropped = kept-1, dropped+1
				}
				if t.used+n > t.budget && kept > 0 {
					t.out.More, t.out.Next = true, seq
					break read
				}
				if p.usage != "" {
					last[p.usage] = len(page)
				}
				page = append(page, slot{ev, n, p.usage})
				t.used += n
				kept++
				if dropped > 64 && dropped > kept {
					page = compact(page, last)
					dropped = 0
				}
			}
			t.lineDone(&o, l)
			t.out.Next = agentproto.Seq(l.off+l.n, 0)
		}
	}
	switch {
	case errors.Is(fr.err, errBudget):
		t.out.More = true
	case fr.err != nil:
		t.err = fr.err
	}
	for _, s := range page {
		if s.n >= 0 {
			t.out.Events = append(t.out.Events, s.ev)
		}
	}
	if len(t.out.Events) > 0 {
		t.out.First = t.out.Events[0].Seq
	}
}

// compact is page without its dropped slots, last their new places.
func compact(page []slot, last map[string]int) []slot {
	clear(last)
	live := page[:0]
	for _, s := range page {
		if s.n < 0 {
			continue
		}
		if s.usage != "" {
			last[s.usage] = len(live)
		}
		live = append(live, s)
	}
	clear(page[len(live):])
	return live
}

// back reads the latest events before the line at end (and that line's
// events below k), until the budget is spent, the file's start is reached
// or the read reached its budget of bytes read; from is the read's cursor.
// end may be inside a long line (inLongLine), where a read stopped.
func (t *tailer) back(end int64, k int, from uint64) {
	br := newBackReader(t.r, end, 0)
	// lines are a chunk's, the latest first; with k the line at end is
	// the first of them.
	var lines []rawLine
	if k > 0 {
		if l, ok := lineAt(t.r, end, t.size); ok {
			lines = append(lines, l)
		}
	}
	seen := map[string]bool{}
	var rev []agentproto.TranscriptEvent
	// outs are the chunk's lines' events, their arrays used again.
	var outs []lineOut
	start := end
	// full: the page holds what it may, its first event the cursor of the
	// next.
	full := false
read:
	for {
		var raw int64
		for raw < chunkRaw && len(lines) < chunkLines {
			l, ok := br.prev()
			if !ok {
				break
			}
			lines = append(lines, l)
			raw += l.n
		}
		if len(lines) == 0 {
			break
		}
		slices.Reverse(lines)
		rn := t.f.run(t.all, lines[0].off)
		rn.prepare(lines)
		outs = slices.Grow(outs[:0], len(lines))[:len(lines)]
		for i := range lines {
			t.parse(rn, &lines[i], &outs[i])
		}
		for i := len(lines) - 1; i >= 0; i-- {
			l, o := &lines[i], &outs[i]
			evs := o.events
			if l.off == end {
				evs = evs[:min(k, len(evs))]
			}
			for j := len(evs) - 1; j >= 0; j-- {
				p := &evs[j]
				if p.usage != "" {
					if seen[p.usage] {
						continue
					}
					seen[p.usage] = true
				}
				ev, n := t.encode(p, agentproto.Seq(l.off, j))
				if t.used+n > t.budget && len(rev) > 0 {
					t.out.More, full = true, true
					break read
				}
				rev = append(rev, ev)
				t.used += n
			}
			t.lineDone(o, l)
			start = l.off
		}
		lines = lines[:0]
		if br.err != nil || br.end == 0 {
			break
		}
	}
	switch {
	case errors.Is(br.err, errBudget):
		t.out.More = true
	case br.err != nil:
		t.err = br.err
	}
	slices.Reverse(rev)
	t.out.Events = rev
	switch {
	case full:
		t.out.First = rev[0].Seq
	case t.out.More:
		// The read stopped at its budget of bytes: the next page goes on
		// before the lines read, whether they made events or not (a long
		// line's part included).
		t.out.First = agentproto.Seq(start, 0)
	case len(rev) > 0:
		t.out.First = rev[0].Seq
	default:
		t.out.First = from
	}
}
