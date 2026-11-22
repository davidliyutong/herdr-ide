//go:build unix

package transcript

import (
	"bytes"
	"context"
	"encoding/json"
	"runtime"
	"testing"
	"unicode/utf8"

	"herdr-ide/internal/agentproto"
)

// measured is a read of data as a transcript of kind, the bytes it read of
// data and those it allocated (garbage included).
func measured(t testing.TB, kind string, data []byte, ref agentproto.TranscriptRef, lim Limits) (agentproto.TranscriptTail, int64, uint64) {
	t.Helper()
	c := &counting{r: bytes.NewReader(data)}
	out := agentproto.TranscriptTail{Kind: kind}
	var a, b runtime.MemStats
	runtime.ReadMemStats(&a)
	err := tail(context.Background(), formats[kind], c, int64(len(data)), ref, lim.norm(), &out)
	runtime.ReadMemStats(&b)
	if err != nil {
		t.Fatal(err)
	}
	return out, c.n.Load(), b.TotalAlloc - a.TotalAlloc
}

// A read reads each byte of a small transcript a few times at most (the
// cursor's check, the line's end, the lines, a format's look back), and
// allocates a few buffers and some times what it reads.
func readBound(n int) int64       { return min(8*int64(n)+64, maxScan) }
func allocBound(n int) uint64     { return 4<<20 + 128*uint64(n) }
func lineAllocBound(n int) uint64 { return 16<<20 + 8*uint64(n) }

// Any bytes, any cursor and any limits: no panic, valid JSON and text,
// replies within their limit, events in order, pages that move on, and
// reads bounded in the bytes they read and allocate. The seed corpus is
// the vectors. Run with
//
//	go test -run '^$' -fuzz FuzzTail -fuzztime 30s -fuzzminimizetime 2s ./internal/agent/transcript/
//
// (minimizing each new input for the default minute stalls the run).
func FuzzTail(f *testing.F) {
	for _, file := range vectorFiles(f) {
		v := readVector(f, file)
		f.Add(v.content(), v.Kind == "codex", uint16(0), false, uint64(0))
		f.Add(v.content(), v.Kind == "codex", uint16(700), true, uint64(0))
		f.Add(v.content(), v.Kind != "codex", uint16(3000), false, agentproto.Seq(int64(len(v.Lines[0])+1), 1))
	}
	types := map[string]bool{agentproto.TranscriptUpdate: true, agentproto.TranscriptUser: true, agentproto.TranscriptTurn: true, agentproto.TranscriptNotice: true}
	f.Fuzz(func(t *testing.T, data []byte, codex bool, size uint16, back bool, from uint64) {
		kind := "claude"
		if codex {
			kind = "codex"
		}
		lim := Limits{Bytes: 1024 + int(size), Text: 300, ToolOutput: 200}
		ref := agentproto.TranscriptRef{From: from, Back: back}
		for n := range 64 {
			p, read, alloc := measured(t, kind, data, ref, lim)
			if read > readBound(len(data)) || alloc > allocBound(len(data)) {
				t.Fatalf("from %d back %v: read %d bytes and allocated %d of a transcript of %d", ref.From, ref.Back, read, alloc, len(data))
			}
			b, err := json.Marshal(p)
			if err != nil || !utf8.Valid(b) {
				t.Fatalf("reply %q: %v", b, err)
			}
			if len(p.Events) > 1 && len(b) > lim.Bytes {
				t.Fatalf("a reply of %d bytes, the limit %d", len(b), lim.Bytes)
			}
			for i, ev := range p.Events {
				if !types[ev.T] || i > 0 && ev.Seq <= p.Events[i-1].Seq {
					t.Fatalf("event %d: %+v", i, ev)
				}
				if ev.Seq < p.First || agentproto.SeqOffset(ev.Seq) >= int64(len(data)) {
					t.Fatalf("event %d at %d, first %d", i, ev.Seq, p.First)
				}
			}
			if p.Next > agentproto.Seq(int64(len(data)), 0) && !(n == 0 && p.Next == from) {
				t.Fatalf("next %d after the end", p.Next)
			}
			if !p.More {
				return
			}
			// The first read may have started over; from then on each page
			// moves on.
			if back {
				if n > 0 && p.First >= ref.From {
					t.Fatalf("back: first %d from %d", p.First, ref.From)
				}
				ref.From = p.First
			} else {
				if n > 0 && p.Next <= ref.From {
					t.Fatalf("forward: next %d from %d", p.Next, ref.From)
				}
				ref.From = p.Next
			}
		}
	})
}

// lineShapes are where the parsers read arrays of a line: an element
// repeated there makes a line of many values. With quote the array is a
// JSON string (a function call's arguments).
var lineShapes = []struct {
	kind, head, tail string
	quote            bool
}{
	{"claude", `{"type":"assistant","message":{"id":"m","model":"x","content":[`, `]}}`, false},
	{"claude", `{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"X","input":{"a":[`, `]}}]}}`, false},
	{"claude", `{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"TodoWrite","input":{"todos":[`, `]}}]}}`, false},
	{"claude", `{"type":"user","message":{"content":[`, `]}}`, false},
	{"claude", `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":[`, `]}]}}`, false},
	{"claude", `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]},"toolUseResult":{"filePath":"/p","edits":[`, `]}}`, false},
	{"codex", `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[`, `]}}`, false},
	{"codex", `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"mcp_tool_call","id":"c","server":"s","tool":"t","arguments":{"a":[`, `]}}}}`, false},
	{"codex", `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"a","content":[`, `]}}}`, false},
	{"codex", `{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","id":"f","changes":[`, `]}}}`, false},
	{"codex", `{"type":"event_msg","payload":{"type":"user_message","message":"hi","images":[`, `]}}`, false},
	{"codex", `{"type":"response_item","payload":{"type":"function_call","name":"x","call_id":"c","arguments":`, `}}`, true},
}

// shapedLine is elem repeated in lineShapes[shape] to a line of about size
// bytes.
func shapedLine(elem []byte, shape uint8, size int) (string, []byte) {
	s := lineShapes[int(shape)%len(lineShapes)]
	head, tail := s.head, s.tail
	if s.quote {
		head, tail = `{"a":[`, `]}`
	}
	line := repeated(head, string(elem), tail, size)
	if s.quote {
		q, _ := json.Marshal(string(bytes.TrimSuffix(line, []byte("\n"))))
		line = append(append(append([]byte(s.head), q...), s.tail...), '\n')
	}
	return s.kind, line
}

// A line of many small values, whatever they are, takes a few times its
// size to read, forward and back. Run with
//
//	go test -run '^$' -fuzz FuzzLineMemory -fuzztime 30s -fuzzminimizetime 2s ./internal/agent/transcript/
func FuzzLineMemory(f *testing.F) {
	for i := range lineShapes {
		for _, elem := range []string{`{}`, `{"k":{}}`, `""`, `{"type":"text","text":"a"}`, `{"type":"tool_result","tool_use_id":"t","content":"x"}`, `{"path":"/p","kind":{"type":"add"}}`} {
			f.Add([]byte(elem), uint8(i))
		}
	}
	// Lines of a byte: no buffer of a line or of a chunk's lines each, and
	// no look back of more than its lines.
	f.Add([]byte("\n"), uint8(3))
	f.Add([]byte("\n"), uint8(6))
	f.Fuzz(func(t *testing.T, elem []byte, shape uint8) {
		if len(elem) == 0 || len(elem) > 4096 {
			return
		}
		kind, line := shapedLine(elem, shape, 1<<20)
		if len(line) > maxLine {
			return
		}
		for _, back := range []bool{false, true} {
			p, read, alloc := measured(t, kind, line, agentproto.TranscriptRef{Back: back}, Limits{})
			if read > readBound(len(line)) || alloc > lineAllocBound(len(line)) {
				t.Fatalf("back %v: read %d bytes and allocated %d MiB of a line of %d MiB (%d events)", back, read, alloc>>20, len(line)>>20, len(p.Events))
			}
		}
	})
}
