//go:build unix

package transcript

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
)

func TestMain(m *testing.M) {
	// Nothing here reads a home directory; should anything, it is not the
	// user's.
	home, err := os.MkdirTemp("", "transcript-home")
	if err != nil {
		panic(err)
	}
	os.Setenv("HOME", home)
	code := m.Run()
	os.RemoveAll(home)
	os.Exit(code)
}

// read is a read of data as a transcript of kind.
func read(t testing.TB, kind string, data []byte, ref agentproto.TranscriptRef, lim Limits) agentproto.TranscriptTail {
	t.Helper()
	out := agentproto.TranscriptTail{Kind: kind}
	if err := tail(context.Background(), formats[kind], bytes.NewReader(data), int64(len(data)), ref, lim.norm(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func jsonLine(t testing.TB, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func lines(ls ...string) []byte { return []byte(strings.Join(ls, "\n") + "\n") }

// Claude Code's lines, as the tests need them.
func userLine(t testing.TB, content any) string {
	return jsonLine(t, obj{"type": "user", "timestamp": "2026-11-21T10:00:00.000Z", "message": obj{"role": "user", "content": content}})
}

func textLine(t testing.TB, id, text string) string {
	return jsonLine(t, obj{"type": "assistant", "timestamp": "2026-11-21T10:00:01.000Z", "message": obj{
		"id": id, "model": "claude-opus-5-5", "role": "assistant", "content": []any{obj{"type": "text", "text": text}},
		"usage": obj{"input_tokens": 1, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 100, "output_tokens": 5},
	}})
}

func updateOf(t testing.TB, ev agentproto.TranscriptEvent) obj {
	t.Helper()
	var u obj
	if err := json.Unmarshal(ev.Update, &u); err != nil {
		t.Fatalf("update %s: %v", ev.Update, err)
	}
	return u
}

func ownMeta(m obj) obj { return asObj(asObj(m["_meta"])[brand.Slug]) }

// A line that does not end yet is not read: the read ends before it, and
// goes on with it once it ends.
func TestPartialLastLine(t *testing.T) {
	done := userLine(t, "first")
	partial := textLine(t, "msg_1", "second")
	data := []byte(done + "\n" + partial[:len(partial)/2])
	p := read(t, "claude", data, agentproto.TranscriptRef{}, Limits{})
	if len(p.Events) != 2 || p.More || p.Next != agentproto.Seq(int64(len(done)+1), 0) {
		t.Fatalf("read %+v", p)
	}
	if changed(bytes.NewReader(data), int64(len(data)), p.Next) {
		t.Error("a line that does not end yet is no change")
	}
	back := read(t, "claude", data, agentproto.TranscriptRef{Back: true}, Limits{})
	if len(back.Events) != 2 || back.Next != p.Next || back.More {
		t.Errorf("back %+v", back)
	}
	data = []byte(done + "\n" + partial + "\n")
	if !changed(bytes.NewReader(data), int64(len(data)), p.Next) {
		t.Error("the line ended")
	}
	q := read(t, "claude", data, agentproto.TranscriptRef{From: p.Next}, Limits{})
	if len(q.Events) != 2 || q.First != agentproto.Seq(int64(len(done)+1), 0) || q.Next != agentproto.Seq(int64(len(data)), 0) {
		t.Fatalf("rest %+v", q)
	}
	if u := updateOf(t, q.Events[0]); u["sessionUpdate"] != "agent_message_chunk" {
		t.Errorf("rest %v", u)
	}
	if changed(bytes.NewReader(data), int64(len(data)), q.Next) {
		t.Error("nothing after the end")
	}
}

// A forward read from any event's Seq gives exactly the events from that
// one on, also inside a line.
func TestResumeFromEachSeq(t *testing.T) {
	for _, file := range vectorFiles(t) {
		v := readVector(t, file)
		data := v.content()
		full := read(t, v.Kind, data, agentproto.TranscriptRef{}, Limits{})
		for i, ev := range full.Events {
			got := read(t, v.Kind, data, agentproto.TranscriptRef{From: ev.Seq}, Limits{})
			if !reflect.DeepEqual(seqs(got.Events), seqs(full.Events[i:])) {
				t.Errorf("%s from %d: %v, want %v", filepath.Base(file), ev.Seq, seqs(got.Events), seqs(full.Events[i:]))
				continue
			}
			if got.First != ev.Seq || got.Next != full.Next {
				t.Errorf("%s from %d: first %d next %d", filepath.Base(file), ev.Seq, got.First, got.Next)
			}
			sameEvents(t, filepath.Base(file), plainEvents(t, got.Events), plainEvents(t, full.Events[i:]))
		}
	}
}

// A line with more events than a reply holds is cut inside: Next is the
// first event left out, and a read from it gives the rest.
func TestCutInsideALine(t *testing.T) {
	var results []any
	for i := range 40 {
		results = append(results, obj{"type": "tool_result", "tool_use_id": fmt.Sprintf("toolu_%02d", i), "content": strings.Repeat("x", 200)})
	}
	data := lines(userLine(t, "go"), userLine(t, results), userLine(t, "more"))
	full := read(t, "claude", data, agentproto.TranscriptRef{}, Limits{})
	if len(full.Events) != 44 {
		t.Fatalf("%d events", len(full.Events))
	}
	var got []agentproto.TranscriptEvent
	ref := agentproto.TranscriptRef{}
	insideALine := false
	for n := 0; ; n++ {
		p := read(t, "claude", data, ref, Limits{Bytes: 2048})
		if b := encodedSize(t, p); b > 2048 {
			t.Errorf("a reply of %d bytes", b)
		}
		got = append(got, p.Events...)
		if !p.More {
			break
		}
		if agentproto.SeqIndex(p.Next) > 0 {
			insideALine = true
		}
		if n > 100 || p.Next <= ref.From {
			t.Fatalf("no progress: %+v", p)
		}
		ref.From = p.Next
	}
	if !insideALine || !reflect.DeepEqual(seqs(got), seqs(full.Events)) {
		t.Errorf("pages: inside a line %v, %v want %v", insideALine, seqs(got), seqs(full.Events))
	}
	// And back, page by page from each page's First.
	var pages []agentproto.TranscriptEvent
	ref = agentproto.TranscriptRef{Back: true}
	for n := 0; ; n++ {
		p := read(t, "claude", data, ref, Limits{Bytes: 2048})
		pages = append(p.Events, pages...)
		if !p.More {
			break
		}
		if n > 100 {
			t.Fatal("no start")
		}
		ref.From = p.First
	}
	if !reflect.DeepEqual(seqs(pages), seqs(full.Events)) {
		t.Errorf("back pages %v, want %v", seqs(pages), seqs(full.Events))
	}
}

// A cursor that is no line's start any more (the file was truncated or
// replaced) is answered as a first read, from the end.
func TestCursorReset(t *testing.T) {
	data := lines(userLine(t, "one"), textLine(t, "msg_1", "two"), userLine(t, "three"))
	first := read(t, "claude", data, agentproto.TranscriptRef{Back: true}, Limits{})
	for _, ref := range []agentproto.TranscriptRef{
		{From: agentproto.Seq(int64(len(data))+10, 0)},
		{From: agentproto.Seq(5, 0)},
		{From: agentproto.Seq(5, 3)},
		{From: agentproto.Seq(5, 0), Back: true},
		{From: agentproto.Seq(int64(len(data))+1, 2), Back: true},
	} {
		got := read(t, "claude", data, ref, Limits{})
		if !reflect.DeepEqual(got, first) {
			t.Errorf("from %d back %v: %+v, want %+v", ref.From, ref.Back, got, first)
		}
	}
	// A cursor at a line's start is kept, also inside the line.
	l0 := int64(len(userLine(t, "one")) + 1)
	got := read(t, "claude", data, agentproto.TranscriptRef{From: agentproto.Seq(l0, 1)}, Limits{})
	if got.First != agentproto.Seq(l0, 1) || len(got.Events) != 3 {
		t.Errorf("inside a line: %+v", got)
	}
}

// A reply with a code echoes the cursor.
func TestUnknownKind(t *testing.T) {
	f := writeFile(t, lines(userLine(t, "hi")))
	ref := agentproto.TranscriptRef{Kind: "gemini", Session: "s", From: agentproto.Seq(77, 1)}
	got, err := Tail(context.Background(), "gemini", f, ref, Limits{})
	if err != nil || got.Code != agentproto.TranscriptBadRequest || got.First != ref.From || got.Next != ref.From || got.Kind != "gemini" || got.Session != "s" {
		t.Errorf("%+v %v", got, err)
	}
}

func writeFile(t testing.TB, data []byte) *os.File {
	t.Helper()
	p := filepath.Join(t.TempDir(), "t.jsonl")
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

// Tail reads an open file: the kind and session of the ref, the file's
// identity.
func TestTailFile(t *testing.T) {
	data := lines(userLine(t, "hi"), textLine(t, "msg_1", "hello"))
	f := writeFile(t, data)
	ref := agentproto.TranscriptRef{Kind: "claude", Session: "0b6f5c1e-8d3a-4c2b-9e1f-2a3b4c5d6e7f", Back: true}
	got, err := Tail(context.Background(), "claude", f, ref, Limits{})
	if err != nil || got.Kind != ref.Kind || got.Session != ref.Session || got.File != FileID(f) || len(got.File) != 32 || len(got.Events) != 4 {
		t.Fatalf("%+v %v", got, err)
	}
	if Changed(f, got.Next) {
		t.Error("no change")
	}
	dir, err := os.Open(filepath.Dir(f.Name()))
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	if _, err := Tail(context.Background(), "claude", dir, ref, Limits{}); err == nil {
		t.Error("a directory is no transcript")
	}
}

// The identity of a file stays while it grows and changes when it is
// replaced or rewritten.
func TestFileID(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "t.jsonl")
	open := func() string {
		t.Helper()
		f, err := os.Open(p)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		return FileID(f)
	}
	write := func(data string) {
		t.Helper()
		if err := os.WriteFile(p, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"a":1}` + "\n")
	id := open()
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"b":2}` + "\n")
	f.Close()
	if open() != id {
		t.Error("an appended file is the same")
	}
	write(`{"c":3}` + "\n")
	if open() == id {
		t.Error("a file rewritten in place with another first line is another")
	}
	id = open()
	q := filepath.Join(dir, "u.jsonl")
	os.WriteFile(q, []byte(`{"c":3}`+"\n"), 0o600)
	if err := os.Rename(q, p); err != nil {
		t.Fatal(err)
	}
	if open() == id {
		t.Error("a file put in another's place is another")
	}
	// A first line that does not end yet is not part of the identity.
	write(`{"d":`)
	id = open()
	write(`{"d":4`)
	if open() != id {
		t.Error("a growing first line")
	}
}

func TestChanged(t *testing.T) {
	a, b := userLine(t, "one"), userLine(t, "two")
	end := int64(len(a) + 1)
	for _, c := range []struct {
		data string
		from uint64
		want bool
	}{
		{"", 0, false},
		{a + "\n", 0, true},
		{a + "\n", agentproto.Seq(end, 0), false},
		{a + "\n" + b, agentproto.Seq(end, 0), false},
		{a + "\n" + b + "\n", agentproto.Seq(end, 0), true},
		{a + "\n" + b + "\n" + b[:5], agentproto.Seq(end, 0), true},
		// Inside a line: its other events.
		{a + "\n", agentproto.Seq(0, 1), true},
		// Truncated, or no line's start: a reset.
		{a[:4], agentproto.Seq(end, 0), true},
		{a + "\n" + b + "\n", agentproto.Seq(3, 0), true},
	} {
		if got := changed(strings.NewReader(c.data), int64(len(c.data)), c.from); got != c.want {
			t.Errorf("%q from %d: %v", c.data, c.from, got)
		}
	}
}

// A line longer than the limit is skipped with a notice, and reading goes
// on after it; a long line under the limit (a pasted image) is read, its
// image left out.
func TestLongLines(t *testing.T) {
	long := `{"type":"user","message":{"role":"user","content":"` + strings.Repeat("a", 9<<20) + `"}}`
	img := strings.Repeat("iVBORw0KGgo", 300000)
	pasted := userLine(t, []any{obj{"type": "text", "text": "look"}, obj{"type": "image", "source": obj{"type": "base64", "media_type": "image/png", "data": img}}})
	if len(pasted) < 3<<20 {
		t.Fatal("a pasted image of a few megabytes")
	}
	for _, data := range [][]byte{
		lines(userLine(t, "before"), long, pasted),
		lines(long, userLine(t, "before"), pasted),
		lines(userLine(t, "before"), pasted, long),
	} {
		for _, back := range []bool{false, true} {
			p := read(t, "claude", data, agentproto.TranscriptRef{Back: back}, Limits{})
			var kinds []string
			for _, ev := range p.Events {
				kinds = append(kinds, ev.T)
				if ev.T == agentproto.TranscriptNotice {
					var params obj
					json.Unmarshal(ev.Params, &params)
					if ev.Method != agentproto.NoticeMethod("skipped") || params["bytes"] != float64(len(long)) {
						t.Errorf("notice %s %s", ev.Method, ev.Params)
					}
				}
			}
			if len(p.Events) != 5 || p.More || p.Unknown != 0 {
				t.Errorf("back %v: %v %+v", back, kinds, p)
			}
			b, _ := json.Marshal(p)
			if bytes.Contains(b, []byte("iVBORw0KGgo")) || len(b) > 4096 {
				t.Errorf("the image was forwarded: %d bytes", len(b))
			}
		}
	}
}

// Text, tool output and inputs are cut to the limits, at a character's
// start, and marked.
func TestTruncation(t *testing.T) {
	text := strings.Repeat("é", 100) // 200 bytes
	out := "HEAD" + strings.Repeat("-", 500) + "TAIL"
	data := lines(
		textLine(t, "msg_1", text),
		jsonLine(t, obj{"type": "assistant", "message": obj{"id": "msg_2", "role": "assistant", "content": []any{
			obj{"type": "tool_use", "id": "toolu_1", "name": "Write", "input": obj{"file_path": "/p", "content": text}},
		}}}),
		jsonLine(t, obj{"type": "user", "message": obj{"role": "user", "content": []any{
			obj{"type": "tool_result", "tool_use_id": "toolu_2", "content": out},
		}}, "toolUseResult": obj{"stdout": out, "stderr": "", "interrupted": true, "isImage": false}}),
	)
	p := read(t, "claude", data, agentproto.TranscriptRef{}, Limits{Text: 51, ToolOutput: 100})
	if len(p.Events) != 4 {
		t.Fatalf("%d events", len(p.Events))
	}
	msg := updateOf(t, p.Events[0])
	if s := str(asObj(msg["content"])["text"]); s != strings.Repeat("é", 25) || ownMeta(msg)["truncated"] != true {
		t.Errorf("message %v", msg)
	}
	call := updateOf(t, p.Events[2])
	if s := str(asObj(call["rawInput"])["content"]); len(s) != 50 || !utf8.ValidString(s) || ownMeta(call)["truncated"] != true {
		t.Errorf("input %v", call)
	}
	res := updateOf(t, p.Events[3])
	s := str(asObj(asObj(asArr(res["content"])[0])["content"])["text"])
	if !strings.HasPrefix(s, "HEAD") || !strings.HasSuffix(s, "TAIL") || len(s) > 100 || !strings.Contains(s, "…") {
		t.Errorf("output %q", s)
	}
	if m := ownMeta(res); m["truncated"] != true || m["interrupted"] != true {
		t.Errorf("output meta %v", m)
	}
}

// An event that a reply cannot hold as it is is cut further, and replaced
// by a notice when even that does not do.
func TestEventTooLarge(t *testing.T) {
	var edits []any
	for range 200 {
		edits = append(edits, obj{"old_string": strings.Repeat("o", 4000), "new_string": strings.Repeat("<", 4000)})
	}
	data := lines(jsonLine(t, obj{"type": "assistant", "message": obj{"id": "msg_1", "role": "assistant", "content": []any{
		obj{"type": "tool_use", "id": "toolu_1", "name": "MultiEdit", "input": obj{"file_path": "/p", "edits": edits}},
	}}}))
	p := read(t, "claude", data, agentproto.TranscriptRef{}, Limits{Bytes: 64 << 10})
	if len(p.Events) != 1 || encodedSize(t, p) > 64<<10 {
		t.Fatalf("%d events, %d bytes", len(p.Events), encodedSize(t, p))
	}
	if u := updateOf(t, p.Events[0]); u["toolCallId"] != "toolu_1" || ownMeta(u)["truncated"] != true {
		t.Errorf("%v", u)
	}
}

// A line makes at most MaxLineEvents events; the line counts as unknown
// once when it would make more.
func TestMaxLineEvents(t *testing.T) {
	var results []any
	for i := range 300 {
		results = append(results, obj{"type": "tool_result", "tool_use_id": fmt.Sprint("t", i), "content": "ok"})
	}
	data := lines(userLine(t, results), userLine(t, "after"))
	p := read(t, "claude", data, agentproto.TranscriptRef{}, Limits{})
	if len(p.Events) != agentproto.MaxLineEvents+2 || p.Unknown != 1 {
		t.Fatalf("%d events, unknown %d", len(p.Events), p.Unknown)
	}
	if last := p.Events[agentproto.MaxLineEvents-1]; agentproto.SeqIndex(last.Seq) != agentproto.MaxLineEvents-1 || agentproto.SeqOffset(last.Seq) != 0 {
		t.Errorf("last of the line: %d", last.Seq)
	}
}

// Bytes that are no UTF-8 give valid JSON with valid text.
func TestInvalidUTF8(t *testing.T) {
	bad := string([]byte{0xff, 0xfe, 'a', 0xc3})
	data := lines(
		`{"type":"user","message":{"role":"user","content":"x`+bad+`y"}}`,
		`{"type":"assistant","message":{"id":"m`+bad+`","role":"assistant","content":[{"type":"text","text":"`+bad+`"}]}}`,
		`{"type":"user`+bad+`","message":1}`,
		bad,
	)
	for _, kind := range []string{"claude", "codex"} {
		p := read(t, kind, data, agentproto.TranscriptRef{}, Limits{})
		b, err := json.Marshal(p)
		if err != nil || !json.Valid(b) || !utf8.Valid(b) {
			t.Errorf("%s: %s %v", kind, b, err)
		}
		if kind == "claude" && len(p.Events) != 3 {
			t.Errorf("claude: %d events", len(p.Events))
		}
	}
}

// Of the lines of one message, a page reports the usage once, at the last
// of them.
func TestUsageOncePerMessage(t *testing.T) {
	data := lines(textLine(t, "msg_1", "a"), textLine(t, "msg_1", "b"), textLine(t, "msg_2", "c"))
	for _, back := range []bool{false, true} {
		p := read(t, "claude", data, agentproto.TranscriptRef{Back: back}, Limits{})
		var got []string
		for _, ev := range p.Events {
			u := updateOf(t, ev)
			got = append(got, fmt.Sprint(u["sessionUpdate"], agentproto.SeqOffset(ev.Seq)))
		}
		l := int64(len(textLine(t, "msg_1", "a")) + 1)
		want := []string{"agent_message_chunk0", fmt.Sprint("agent_message_chunk", l), fmt.Sprint("usage_update", l),
			fmt.Sprint("agent_message_chunk", 2*l), fmt.Sprint("usage_update", 2*l)}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("back %v: %v, want %v", back, got, want)
		}
	}
}

// Of the lines of a Codex rollout with items, the response_item lines are
// left out also when a read starts with one, and an older rollout's are
// read also when nothing before them is in the page.
func TestCodexFormAtAPageStart(t *testing.T) {
	v := readVector(t, filepath.Join(vectorDir, "codex-0.170.0-exec.json"))
	data := v.content()
	full := read(t, "codex", data, agentproto.TranscriptRef{}, Limits{})
	// The assistant's message repeated as a response_item is the 15th line.
	off := int64(0)
	for _, l := range v.Lines[:14] {
		off += int64(len(l)) + 1
	}
	if !strings.Contains(v.Lines[14], `"response_item"`) {
		t.Fatal("the 15th line is a response_item")
	}
	p := read(t, "codex", data, agentproto.TranscriptRef{From: agentproto.Seq(off, 0)}, Limits{})
	for _, ev := range p.Events {
		if agentproto.SeqOffset(ev.Seq) == off {
			t.Errorf("the repeated message made %s", ev.Update)
		}
	}
	var want int
	for _, ev := range full.Events {
		if ev.Seq >= agentproto.Seq(off, 0) {
			want++
		}
	}
	if len(p.Events) != want {
		t.Errorf("%d events, want %d", len(p.Events), want)
	}
	// Without the lines before it, the older form is the default.
	legacy := lines(`{"timestamp":"2025-09-20T08:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}`)
	if p := read(t, "codex", legacy, agentproto.TranscriptRef{}, Limits{}); len(p.Events) != 1 {
		t.Errorf("older form: %+v", p)
	}
}

// A page holds at most Bytes, its envelope with a long title too.
func TestReplySize(t *testing.T) {
	var ls []string
	ls = append(ls, jsonLine(t, obj{"type": "custom-title", "customTitle": strings.Repeat("<", 5000)}))
	for i := range 400 {
		ls = append(ls, textLine(t, fmt.Sprint("msg_", i), strings.Repeat("<&>", 2000)))
	}
	data := lines(ls...)
	for _, lim := range []Limits{{}, {Bytes: 100 << 10}, {Bytes: 20 << 10}} {
		for _, back := range []bool{false, true} {
			p := read(t, "claude", data, agentproto.TranscriptRef{Back: back}, lim)
			max := lim.norm().bytes
			if n := encodedSize(t, p); n > max || !p.More || len(p.Events) < 2 {
				t.Errorf("limit %d back %v: %d bytes, %d events, more %v", max, back, n, len(p.Events), p.More)
			}
			if len(p.Title) > maxSessionTitle {
				t.Errorf("title of %d bytes", len(p.Title))
			}
		}
	}
	// Under a small limit the title is cut further.
	data = lines(ls[0], textLine(t, "msg_1", "hi"))
	p := read(t, "claude", data, agentproto.TranscriptRef{}, Limits{Bytes: 1200})
	if n := encodedSize(t, p); n > 1200 || len(p.Events) != 2 || p.Title == "" || len(p.Title) >= maxSessionTitle {
		t.Errorf("%d bytes, %d events, title of %d bytes", n, len(p.Events), len(p.Title))
	}
}

// countingReader counts the bytes read.
type countingReader struct {
	r io.ReaderAt
	n atomic.Int64
}

func (c *countingReader) ReadAt(b []byte, off int64) (int, error) {
	n, err := c.r.ReadAt(b, off)
	c.n.Add(int64(n))
	return n, err
}

// bigTranscript is a Claude transcript of about size bytes: turns of a
// prompt, a reply, a command and its output, and the program's own lines.
func bigTranscript(t testing.TB, size int) []byte {
	var b bytes.Buffer
	attachment := jsonLine(t, obj{"type": "attachment", "attachment": obj{"type": "skill_listing", "content": strings.Repeat("s", 20000)}})
	for i := 0; b.Len() < size; i++ {
		id := fmt.Sprint("msg_", i)
		for _, l := range []string{
			userLine(t, fmt.Sprint("prompt ", i, " ", strings.Repeat("p", 300))),
			attachment,
			textLine(t, id, strings.Repeat("reply ", 200)),
			jsonLine(t, obj{"type": "assistant", "message": obj{"id": id, "role": "assistant", "content": []any{
				obj{"type": "tool_use", "id": fmt.Sprint("toolu_", i), "name": "Bash", "input": obj{"command": "go test ./...", "description": "Run the tests"}},
			}}}),
			jsonLine(t, obj{"type": "user", "message": obj{"role": "user", "content": []any{
				obj{"type": "tool_result", "tool_use_id": fmt.Sprint("toolu_", i), "content": strings.Repeat("ok\n", 1500)},
			}}, "toolUseResult": obj{"stdout": strings.Repeat("ok\n", 1500), "stderr": ""}}),
			jsonLine(t, obj{"type": "system", "subtype": "turn_duration", "durationMs": 1000}),
		} {
			b.WriteString(l)
			b.WriteByte('\n')
		}
	}
	return b.Bytes()
}

// A view's first read of a long transcript reads its end only.
func TestLastPageReadsTheEnd(t *testing.T) {
	data := bigTranscript(t, 20<<20)
	cr := &countingReader{r: bytes.NewReader(data)}
	var out agentproto.TranscriptTail
	if err := tail(context.Background(), formats["claude"], cr, int64(len(data)), agentproto.TranscriptRef{Back: true}, Limits{}.norm(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.More || len(out.Events) == 0 || cr.n.Load() > int64(len(data))/4 {
		t.Errorf("read %d of %d bytes for %d events", cr.n.Load(), len(data), len(out.Events))
	}
}

func BenchmarkTailLastPage(b *testing.B) {
	data := bigTranscript(b, 20<<20)
	cr := &countingReader{r: bytes.NewReader(data)}
	b.SetBytes(int64(len(data)))
	b.ResetTimer()
	for b.Loop() {
		var out agentproto.TranscriptTail
		if err := tail(context.Background(), formats["claude"], cr, int64(len(data)), agentproto.TranscriptRef{Back: true}, Limits{}.norm(), &out); err != nil {
			b.Fatal(err)
		}
	}
	b.ReportMetric(float64(cr.n.Load())/float64(b.N), "bytesread/op")
}

// queuedLine is an attachment line of Claude Code's for a message the user
// sent while the agent worked; att is merged into its attachment.
func queuedLine(t testing.TB, prompt any, att obj) string {
	a := obj{"type": "queued_command", "prompt": prompt, "commandMode": "prompt", "origin": obj{"kind": "human"}, "humanTurn": true, "timestamp": "2026-11-21T10:00:05.000Z"}
	for k, v := range att {
		a[k] = v
	}
	return jsonLine(t, obj{"parentUuid": nil, "isSidechain": false, "attachment": a, "type": "attachment", "timestamp": "2026-11-21T10:00:05.000Z", "rendered": []any{obj{"content": "<system-reminder>queued_command</system-reminder>"}}})
}

// A message the user sent while Claude Code worked, recorded as a
// queued_command attachment, is the user's message (no turn's start: it
// joins the running one), with its line's time and the text limit, also
// one of no origin (an SDK client's); one that cannot be read counts as
// unknown, and attachments of other kinds, origins or modes give nothing
// and count as nothing.
func TestClaudeQueuedPrompt(t *testing.T) {
	data := lines(
		queuedLine(t, "while you work", nil),
		queuedLine(t, strings.Repeat("x", 300), nil),
		queuedLine(t, []any{obj{"type": "text", "text": "a"}, obj{"type": "image", "source": obj{"type": "base64", "data": "iVBORw0KGgo"}}, obj{"type": "document"}}, nil),
		queuedLine(t, 42, nil),
		queuedLine(t, []any{1, obj{"type": "text", "text": "b"}}, nil),
		queuedLine(t, "flagged", obj{"isMeta": true}),
		queuedLine(t, "peer", obj{"origin": obj{"kind": "peer"}}),
		queuedLine(t, "no origin", obj{"origin": nil}),
		queuedLine(t, "bash", obj{"commandMode": "bash"}),
		queuedLine(t, "   ", nil),
		// "queued_command" in another attachment's text, and an attachment
		// of no object.
		jsonLine(t, obj{"type": "attachment", "attachment": obj{"type": "edited_text_file", "snippet": `the "queued_command" kind`}}),
		`{"type":"attachment","attachment":"queued_command"}`,
	)
	p := read(t, "claude", data, agentproto.TranscriptRef{}, Limits{Text: 100})
	var got []string
	for _, ev := range p.Events {
		if ev.T != agentproto.TranscriptUser {
			t.Errorf("event %s %s", ev.T, ev.State)
			continue
		}
		var blocks []obj
		for _, c := range ev.Content {
			var b obj
			_ = json.Unmarshal(c, &b)
			blocks = append(blocks, b)
		}
		var s []string
		for _, b := range blocks {
			if ownMeta(b)["image"] == true {
				s = append(s, "<image>")
			} else {
				s = append(s, fmt.Sprintf("%d:%v", len(str(b["text"])), ownMeta(b)["truncated"] == true))
			}
		}
		got = append(got, strings.Join(s, ","))
		if want := "2026-11-21T10:00:05Z"; ev.At.Format(time.RFC3339) != want {
			t.Errorf("at %v", ev.At)
		}
	}
	want := []string{"14:false", "100:true", "1:false,<image>", "1:false", "9:false"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("user events %q, want %q", got, want)
	}
	// The document block, the prompt of a number, the block of a number.
	if p.Unknown != 3 {
		t.Errorf("unknown %d", p.Unknown)
	}
	if b, _ := json.Marshal(p); bytes.Contains(b, []byte("iVBORw0KGgo")) {
		t.Errorf("an image was forwarded: %s", b)
	}
}
