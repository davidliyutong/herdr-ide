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
	"testing"

	"veldr/internal/agentproto"
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
	return b.Bytes()
}

// Any one line just under maxLine whose values are many small ones takes
// at most a few times its size to read.
func TestLineMemory(t *testing.T) {
	size := maxLine - 64
	for _, c := range []struct {
		name string
		line []byte
	}{
		{"text blocks", repeated(`{"type":"assistant","message":{"id":"m","model":"x","content":[`, `{"type":"text"}`, `]}}`, size)},
		{"tool input", repeated(`{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"X","input":{"a":[`, `{"k":{}}`, `]}}]}}`, size)},
		{"tool input keys", repeated(`{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"X","input":{`, `"k":0`, `}}]}}`, size)},
		{"todos", repeated(`{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"TodoWrite","input":{"todos":[`, `{}`, `]}}]}}`, size)},
		{"tool results", repeated(`{"type":"user","message":{"content":[`, `{"type":"tool_result","tool_use_id":"t","content":"x"}`, `]}}`, size)},
		{"result blocks", repeated(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":[`, `{"type":"text","text":"a"}`, `]}]}}`, size)},
		{"prompt blocks", repeated(`{"type":"user","message":{"content":[`, `{"type":"text","text":"a"}`, `]}}`, size)},
		{"result keys", repeated(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"toolUseResult":{`, `"k":{}`, `}}`, size)},
		{"edits", repeated(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"toolUseResult":{"filePath":"/p","edits":[`, `{}`, `]}}`, size)},
	} {
		var f Frame
		n := allocated(func() { f = ClaudeFrame(c.line, Limits{}) })
		t.Logf("%s: %d MiB allocated, %d events, unknown %d", c.name, n>>20, len(f.Events), f.Unknown)
		if n > 64<<20 {
			t.Errorf("%s: %d MiB allocated for a line of %d MiB", c.name, n>>20, len(c.line)>>20)
		}
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

// A transcript with a line of several times maxLine gives the lines around
// it and the line's notice once, at the line's start; read from inside the
// line, the lines after it and no notice.
func TestWalkPastALongLine(t *testing.T) {
	a, b := userLine(t, "before"), userLine(t, "after")
	f := &sparse{size: 3 * maxLine, head: []byte(a + "\n"), tail: []byte("\n" + b + "\n")}
	var offs []int64
	var evs []agentproto.TranscriptEvent
	err := EachClaude(context.Background(), f, 0, f.size, Limits{}, func(off int64, fr Frame) bool {
		offs = append(offs, off)
		evs = append(evs, fr.Events...)
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(evs)
	if noticesOf(evs) != 1 || len(evs) != 5 || !strings.Contains(string(got), "before") || !strings.Contains(string(got), "after") {
		t.Errorf("%d events, %d notices: %s", len(evs), noticesOf(evs), got)
	}
	if len(offs) != 3 || offs[1] != int64(len(a)+1) || offs[2] != f.size-int64(len(b)+1) {
		t.Errorf("offsets %v", offs)
	}
	evs = nil
	err = EachClaude(context.Background(), f, offs[1]+maxLine, f.size, Limits{}, func(_ int64, fr Frame) bool {
		evs = append(evs, fr.Events...)
		return true
	})
	if err != nil || len(evs) != 2 || noticesOf(evs) != 0 {
		t.Errorf("from inside the line: %d events, %v", len(evs), err)
	}
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
func TestEachClaudeCancelled(t *testing.T) {
	f := &sparse{size: 8 << 30}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &cancelling{r: f, after: 1 << 20, cancel: cancel}
	err := EachClaude(ctx, c, 0, f.size, Limits{}, func(int64, Frame) bool { return true })
	if !errors.Is(err, context.Canceled) || c.n > c.after+maxLine+1 {
		t.Errorf("%v after %d bytes", err, c.n)
	}
}
