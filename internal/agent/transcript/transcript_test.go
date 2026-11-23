//go:build unix

package transcript

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
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

// conversation is what a reader of a whole transcript gathers of its
// Frames: the events in their order (of the usage updates of one message
// only the last), the lines that could not be read, and the session's
// title (the user's own before one the agent made, the latest of each).
type conversation struct {
	Events  []agentproto.TranscriptEvent
	Unknown int
	Title   string
}

// readAll reads data as a Claude Code transcript with EachClaude.
func readAll(t testing.TB, data []byte, lim Limits) conversation {
	t.Helper()
	var c conversation
	custom := false
	usage := map[string]int{}
	dropped := map[int]bool{}
	err := EachClaude(context.Background(), bytes.NewReader(data), 0, int64(len(data)), lim, func(_ int64, f Frame) bool {
		c.Unknown += f.Unknown
		if f.Title != "" && (f.Custom || !custom) {
			c.Title, custom = f.Title, f.Custom
		}
		for _, ev := range f.Events {
			if f.Message != "" && bytes.Contains(ev.Update, []byte(`"usage_update"`)) {
				if i, ok := usage[f.Message]; ok {
					dropped[i] = true
				}
				usage[f.Message] = len(c.Events)
			}
			c.Events = append(c.Events, ev)
		}
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
	kept := c.Events[:0]
	for i, ev := range c.Events {
		if !dropped[i] {
			kept = append(kept, ev)
		}
	}
	c.Events = kept
	return c
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
		p := readAll(t, data, Limits{})
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
		if len(p.Events) != 5 || p.Unknown != 0 {
			t.Errorf("%v %+v", kinds, p)
		}
		b, _ := json.Marshal(p)
		if bytes.Contains(b, []byte("iVBORw0KGgo")) || len(b) > 4096 {
			t.Errorf("the image was forwarded: %d bytes", len(b))
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
	p := readAll(t, data, Limits{Text: 51, ToolOutput: 100})
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

// A line makes at most MaxLineEvents events; the line counts as unknown
// once when it would make more.
func TestMaxLineEvents(t *testing.T) {
	var results []any
	for i := range 300 {
		results = append(results, obj{"type": "tool_result", "tool_use_id": fmt.Sprint("t", i), "content": "ok"})
	}
	data := lines(userLine(t, results), userLine(t, "after"))
	p := readAll(t, data, Limits{})
	if len(p.Events) != agentproto.MaxLineEvents+2 || p.Unknown != 1 {
		t.Fatalf("%d events, unknown %d", len(p.Events), p.Unknown)
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
	p := readAll(t, data, Limits{})
	b, err := json.Marshal(p)
	if err != nil || !json.Valid(b) || !utf8.Valid(b) {
		t.Errorf("%s %v", b, err)
	}
	if len(p.Events) != 3 {
		t.Errorf("%d events", len(p.Events))
	}
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
	p := readAll(t, data, Limits{Text: 100})
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
