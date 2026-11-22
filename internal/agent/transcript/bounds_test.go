//go:build unix

package transcript

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"herdr-ide/internal/agentproto"
)

// allocated is the bytes fn allocates (garbage included): an upper bound of
// how much it grows the heap.
func allocated(fn func()) uint64 {
	runtime.GC()
	var a, b runtime.MemStats
	runtime.ReadMemStats(&a)
	fn()
	runtime.ReadMemStats(&b)
	return b.TotalAlloc - a.TotalAlloc
}

// repeated is head, elem repeated (comma-separated) to a line of about
// size bytes, and tail.
func repeated(head, elem, tail string, size int) []byte {
	var b bytes.Buffer
	b.Grow(size + 64)
	b.WriteString(head)
	for n := 0; b.Len()+len(elem)+len(tail)+1 < size; n++ {
		if n > 0 {
			b.WriteByte(',')
		}
		b.WriteString(elem)
	}
	b.WriteString(tail)
	b.WriteByte('\n')
	return b.Bytes()
}

// hostileLines are lines of a transcript just under maxLine whose values
// are many small ones: each took hundreds of megabytes to read before.
func hostileLines() []struct {
	name, kind string
	line       []byte
} {
	size := maxLine - 64
	quoted := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	return []struct {
		name, kind string
		line       []byte
	}{
		{"claude text blocks", "claude", repeated(`{"type":"assistant","message":{"id":"m","model":"x","content":[`, `{"type":"text"}`, `]}}`, size)},
		{"claude tool input", "claude", repeated(`{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"X","input":{"a":[`, `{"k":{}}`, `]}}]}}`, size)},
		{"claude tool input keys", "claude", repeated(`{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"X","input":{`, `"k":0`, `}}]}}`, size)},
		{"claude todos", "claude", repeated(`{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"TodoWrite","input":{"todos":[`, `{}`, `]}}]}}`, size)},
		{"claude tool results", "claude", repeated(`{"type":"user","message":{"content":[`, `{"type":"tool_result","tool_use_id":"t","content":"x"}`, `]}}`, size)},
		{"claude result blocks", "claude", repeated(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":[`, `{"type":"text","text":"a"}`, `]}]}}`, size)},
		{"claude prompt blocks", "claude", repeated(`{"type":"user","message":{"content":[`, `{"type":"text","text":"a"}`, `]}}`, size)},
		{"claude result keys", "claude", repeated(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"toolUseResult":{`, `"k":{}`, `}}`, size)},
		{"claude edits", "claude", repeated(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"toolUseResult":{"filePath":"/p","edits":[`, `{}`, `]}}`, size)},
		{"codex payload", "codex", repeated(`{"type":"response_item","payload":{"type":"zzz","x":[`, `{}`, `]}}`, size)},
		{"codex mcp arguments", "codex", repeated(`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"mcp_tool_call","id":"c","server":"s","tool":"t","arguments":{"a":[`, `{"k":{}}`, `]}}}}`, size)},
		{"codex message content", "codex", repeated(`{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"a","content":[`, `{"type":"Text","text":"a"}`, `]}}}`, size)},
		{"codex images", "codex", repeated(`{"type":"event_msg","payload":{"type":"user_message","message":"hi","images":[`, `""`, `]}}`, size)},
		{"codex function arguments", "codex", []byte(`{"type":"response_item","payload":{"type":"function_call","name":"x","call_id":"c","arguments":` +
			quoted(strings.TrimSuffix(string(repeated(`{"a":[`, `{}`, `]}`, size*2/3)), "\n")) + "}}\n")},
	}
}

// Any one line takes at most a few times its size to read, whatever its
// values: forward and back.
func TestLineMemory(t *testing.T) {
	for _, c := range hostileLines() {
		if len(c.line) > maxLine+1 {
			t.Fatalf("%s: a line of %d bytes is skipped, not read", c.name, len(c.line))
		}
		for _, back := range []bool{false, true} {
			var p agentproto.TranscriptTail
			n := allocated(func() { p = read(t, c.kind, c.line, agentproto.TranscriptRef{Back: back}, Limits{}) })
			t.Logf("%s, back %v: %d MiB allocated, %d events, unknown %d", c.name, back, n>>20, len(p.Events), p.Unknown)
			if n > 64<<20 {
				t.Errorf("%s, back %v: %d MiB allocated for a line of %d MiB", c.name, back, n>>20, len(c.line)>>20)
			}
		}
	}
}

// liveReader reads r, and every few megabytes collects the garbage and
// notes the heap that is left: the most a read holds while it reads.
type liveReader struct {
	r          io.ReaderAt
	n, next    int64
	base, most uint64
}

func newLiveReader(r io.ReaderAt) *liveReader {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return &liveReader{r: r, base: m.HeapAlloc}
}

func (l *liveReader) ReadAt(p []byte, off int64) (int, error) {
	n, err := l.r.ReadAt(p, off)
	if l.n += int64(n); l.n >= l.next {
		l.next = l.n + 4<<20
		runtime.GC()
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		l.most = max(l.most, m.HeapAlloc)
	}
	return n, err
}

// held is the most the heap held above where it was when l was made.
func (l *liveReader) held() uint64 { return max(l.most, l.base) - l.base }

// Lines that replace each other's usage update are let go of: a read holds
// no more than the events it returns, however many lines it reads.
func TestUsageReplacedLetGo(t *testing.T) {
	line := `{"type":"assistant","message":{"id":"m","content":[],"usage":{"input_tokens":1}}}` + "\n"
	data := []byte(strings.Repeat(line, maxScan/len(line)))
	lr := newLiveReader(bytes.NewReader(data))
	var out agentproto.TranscriptTail
	if err := tail(context.Background(), formats["claude"], lr, int64(len(data)), agentproto.TranscriptRef{}, Limits{}.norm(), &out); err != nil {
		t.Fatal(err)
	}
	t.Logf("%d MiB of %d-byte lines: read %d MiB, held at most %d MiB, %d events, more %v", len(data)>>20, len(line), lr.n>>20, lr.held()>>20, len(out.Events), out.More)
	if len(out.Events) != 1 || !out.More || lr.held() > 16<<20 {
		t.Errorf("held %d MiB for %d events, more %v", lr.held()>>20, len(out.Events), out.More)
	}
	// The next page goes on where this one stopped.
	if next := agentproto.SeqOffset(out.Next); next == 0 || next%int64(len(line)) != 0 {
		t.Errorf("next %d", next)
	}
}

// sparse is a file of size bytes of zeros (no newline), but for head at
// its start and tail at its end: one long line between them, without
// taking any disk.
type sparse struct {
	size       int64
	head, tail []byte
}

func (s *sparse) ReadAt(p []byte, off int64) (int, error) {
	if off >= s.size {
		return 0, io.EOF
	}
	n := int(min(int64(len(p)), s.size-off))
	clear(p[:n])
	if off < int64(len(s.head)) {
		copy(p[:n], s.head[off:])
	}
	if t := s.size - int64(len(s.tail)); off+int64(n) > t {
		if off >= t {
			copy(p[:n], s.tail[off-t:])
		} else {
			copy(p[t-off:n], s.tail)
		}
	}
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

// counting counts the bytes read of r.
type counting struct {
	r io.ReaderAt
	n atomic.Int64
}

func (c *counting) ReadAt(p []byte, off int64) (int, error) {
	n, err := c.r.ReadAt(p, off)
	c.n.Add(int64(n))
	return n, err
}

// readBounded is a read of r that reads at most maxScan bytes of it.
func readBounded(t *testing.T, kind string, r io.ReaderAt, size int64, ref agentproto.TranscriptRef) agentproto.TranscriptTail {
	t.Helper()
	c := &counting{r: r}
	var out agentproto.TranscriptTail
	if err := tail(context.Background(), formats[kind], c, size, ref, Limits{}.norm(), &out); err != nil {
		t.Fatal(err)
	}
	if n := c.n.Load(); n > maxScan {
		t.Fatalf("from %d back %v: read %d MiB of %d MiB", ref.From, ref.Back, n>>20, size>>20)
	}
	return out
}

// noticesOf are the skipped notices among evs.
func noticesOf(evs []agentproto.TranscriptEvent) int {
	n := 0
	for _, ev := range evs {
		if ev.Method == agentproto.NoticeMethod(noticeSkipped) {
			n++
		}
	}
	return n
}

// A line without end, of any length: each read reads at most maxScan
// bytes, and the cursors go on inside it.
func TestScanBudget(t *testing.T) {
	for _, size := range []int64{8 << 30, 1 << 40} {
		for _, kind := range []string{"claude", "codex"} {
			f := &sparse{size: size}
			first := readBounded(t, kind, f, size, agentproto.TranscriptRef{Back: true})
			if len(first.Events) != 0 || !first.More || first.Next != agentproto.Seq(size, 0) || agentproto.SeqOffset(first.First) >= size-maxScan/2 {
				t.Fatalf("%s %d GiB, first read: %+v", kind, size>>30, first)
			}
			if fwd := readBounded(t, kind, f, size, agentproto.TranscriptRef{From: first.Next}); len(fwd.Events) != 0 || fwd.More || fwd.Next != first.Next {
				t.Errorf("%s %d GiB, forward at the end: %+v", kind, size>>30, fwd)
			}
			if changed(f, size, first.Next) {
				t.Errorf("%s %d GiB: no change after the end", kind, size>>30)
			}
			if !changed(f, size+1, first.Next) {
				t.Errorf("%s %d GiB: the line grew", kind, size>>30)
			}
			back := readBounded(t, kind, f, size, agentproto.TranscriptRef{From: first.First, Back: true})
			if len(back.Events) != 0 || !back.More || back.First >= first.First || agentproto.SeqOffset(first.First)-agentproto.SeqOffset(back.First) < maxScan/2 {
				t.Errorf("%s %d GiB, back: %+v after %d", kind, size>>30, back, first.First)
			}
			fwd := readBounded(t, kind, f, size, agentproto.TranscriptRef{})
			if noticesOf(fwd.Events) != 1 || !fwd.More || agentproto.SeqOffset(fwd.Next) < maxScan/2 {
				t.Errorf("%s %d GiB, forward: %+v", kind, size>>30, fwd)
			}
			again := readBounded(t, kind, f, size, agentproto.TranscriptRef{From: fwd.Next})
			if len(again.Events) != 0 || !again.More || agentproto.SeqOffset(again.Next)-agentproto.SeqOffset(fwd.Next) < maxScan/2 {
				t.Errorf("%s %d GiB, forward inside: %+v after %d", kind, size>>30, again, fwd.Next)
			}
		}
	}
}

// Read page by page, forward and back, a transcript with a line of a
// gigabyte gives the lines around it and the line's notice once.
func TestWalkPastALongLine(t *testing.T) {
	a, b := userLine(t, "before"), userLine(t, "after")
	f := &sparse{size: 1 << 30, head: []byte(a + "\n"), tail: []byte("\n" + b + "\n")}
	var fwd []agentproto.TranscriptEvent
	ref := agentproto.TranscriptRef{}
	for n := 0; ; n++ {
		if n > 64 {
			t.Fatal("forward: no end")
		}
		p := readBounded(t, "claude", f, f.size, ref)
		fwd = append(fwd, p.Events...)
		if !p.More {
			if p.Next != agentproto.Seq(f.size, 0) {
				t.Fatalf("forward ends at %d", p.Next)
			}
			break
		}
		if p.Next <= ref.From {
			t.Fatalf("forward: next %d from %d", p.Next, ref.From)
		}
		ref.From = p.Next
	}
	var pages [][]agentproto.TranscriptEvent
	ref = agentproto.TranscriptRef{Back: true}
	for n := 0; ; n++ {
		if n > 64 {
			t.Fatal("back: no start")
		}
		p := readBounded(t, "claude", f, f.size, ref)
		pages = append([][]agentproto.TranscriptEvent{p.Events}, pages...)
		if !p.More {
			break
		}
		if ref.From != 0 && p.First >= ref.From {
			t.Fatalf("back: first %d from %d", p.First, ref.From)
		}
		ref.From = p.First
	}
	var back []agentproto.TranscriptEvent
	for _, p := range pages {
		back = append(back, p...)
	}
	for _, evs := range [][]agentproto.TranscriptEvent{fwd, back} {
		got := eventsText(t, evs)
		if noticesOf(evs) != 1 || len(evs) != 5 || !strings.Contains(got, "before") || !strings.Contains(got, "after") {
			t.Errorf("%d events, %d notices: %s", len(evs), noticesOf(evs), got)
		}
		if !slicesSorted(seqs(evs)) {
			t.Errorf("out of order: %v", seqs(evs))
		}
		if agentproto.SeqOffset(evs[2].Seq) != int64(len(a)+1) {
			t.Errorf("the notice at %d", evs[2].Seq)
		}
	}
}

func eventsText(t *testing.T, evs []agentproto.TranscriptEvent) string {
	t.Helper()
	b, err := json.Marshal(evs)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func slicesSorted(s []uint64) bool {
	for i := 1; i < len(s); i++ {
		if s[i] <= s[i-1] {
			return false
		}
	}
	return true
}

// cancelling cancels its context once it read more than after bytes.
type cancelling struct {
	r      io.ReaderAt
	n      int64
	after  int64
	cancel func()
}

func (c *cancelling) ReadAt(p []byte, off int64) (int, error) {
	n, err := c.r.ReadAt(p, off)
	if c.n += int64(n); c.n > c.after {
		c.cancel()
	}
	return n, err
}

// A read ends with its context, within a block of reading.
func TestTailCancelled(t *testing.T) {
	f := &sparse{size: 8 << 30}
	for _, ref := range []agentproto.TranscriptRef{{}, {Back: true}} {
		ctx, cancel := context.WithCancel(context.Background())
		c := &cancelling{r: f, after: 1 << 20, cancel: cancel}
		var out agentproto.TranscriptTail
		err := tail(ctx, formats["codex"], c, f.size, ref, Limits{}.norm(), &out)
		cancel()
		if !errors.Is(err, context.Canceled) || c.n > c.after+maxLine+1 {
			t.Errorf("back %v: %v after %d bytes", ref.Back, err, c.n)
		}
	}
}

// Events far beyond a page are cut, or replaced by a notice when what
// cannot be cut (a key) is, without being encoded as they are first: each
// page of them allocates a few times the line.
func TestOversizeEvents(t *testing.T) {
	key := strings.Repeat("k", 2<<20)
	id := strings.Repeat("i", 3<<20)
	data := lines(
		`{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"X","input":{"`+key+`":1}}]}}`,
		`{"type":"assistant","message":{"id":"`+id+`","model":"`+id[:1<<20]+`","content":[`+strings.TrimSuffix(strings.Repeat(`{"type":"text","text":"a"},`, 300), ",")+`]}}`,
	)
	var evs []agentproto.TranscriptEvent
	ref := agentproto.TranscriptRef{}
	for n := 0; ; n++ {
		if n > 100 {
			t.Fatal("no end")
		}
		var p agentproto.TranscriptTail
		if a := allocated(func() { p = read(t, "claude", data, ref, Limits{}) }); a > 64<<20 {
			t.Errorf("page %d allocated %d MiB", n, a>>20)
		}
		evs = append(evs, p.Events...)
		if !p.More {
			break
		}
		ref.From = p.Next
	}
	if len(evs) != 1+agentproto.MaxLineEvents || evs[0].Method != agentproto.NoticeMethod(noticeSkipped) {
		t.Fatalf("%d events, the first %s", len(evs), evs[0].Method)
	}
	for _, ev := range evs[1:] {
		if u := updateOf(t, ev); u["sessionUpdate"] != "agent_message_chunk" || ownMeta(u)["truncated"] != true || len(str(u["messageId"])) >= len(id) {
			t.Fatalf("%s", ev.Update[:200])
		}
	}
}
