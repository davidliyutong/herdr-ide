//go:build unix

package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agent/sessions"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

// headlessID is the session of the recorded transcript.
const headlessID = "00000000-0000-4000-8000-000000000001"

// claudeHome is a home with the recorded transcript in the projects
// directory of /work, and its environment.
func claudeHome(t *testing.T) (string, []string) {
	t.Helper()
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "-work")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(fixtureDir, "claude-transcript-headless.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, headlessID+".jsonl"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	return home, []string{"HOME=" + home}
}

func readHistory(t *testing.T, p chatadapter.HistoryParams) ([]chatproto.Event, error) {
	t.Helper()
	var evs []chatproto.Event
	err := Adapter{}.History(context.Background(), p, func(ev chatproto.Event) {
		if ev.Seq != 0 || ev.Live {
			t.Errorf("History emitted a numbered or live event: %+v", ev)
		}
		evs = append(evs, ev)
	})
	return evs, err
}

// The recorded transcript of a session of the SDK protocol is the chat's
// stored events: its turns end without turn_duration lines (once each),
// no usage updates, items named as the live session names them.
func TestHistory(t *testing.T) {
	_, env := claudeHome(t)
	p := chatadapter.HistoryParams{Kind: "claude", Env: env, Cwd: "/work", SessionID: headlessID}
	evs, err := readHistory(t, p)
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Events []json.RawMessage `json:"events"`
	}
	starts, ends := 0, 0
	open := false
	for _, ev := range evs {
		if ev.T == chatproto.EventTurn {
			switch ev.State {
			case chatproto.TurnStart:
				if open {
					t.Errorf("a turn starts in a turn")
				}
				starts++
			default:
				if !open {
					t.Errorf("a turn ends twice")
				}
				ends++
			}
			open = ev.State == chatproto.TurnStart
		}
		if ev.T == chatproto.EventUpdate {
			h := headOf(ev.Update)
			if h.SessionUpdate == "usage_update" {
				t.Errorf("a usage update")
			}
			if (isChunk(h.SessionUpdate) || h.ToolCallID != "") && ev.Item == "" {
				t.Errorf("an update without its item: %s", ev.Update)
			}
		}
		ev.At = time.Time{}
		g.Events = append(g.Events, rawOf(ev))
	}
	if starts != ends || starts != 22 || open {
		t.Errorf("%d turns started, %d ended", starts, ends)
	}
	checkGolden(t, "history", golden{Events: g.Events})

	// The items of the live session: the thinking and the reply of the
	// first response are its blocks 0 and 1.
	items := map[string]bool{}
	for _, ev := range evs {
		items[ev.Item] = true
	}
	for _, want := range []string{"msg_0001/0", "msg_0001/1", "msg_0015/0", "toolu_0001"} {
		if !items[want] {
			t.Errorf("no item %s", want)
		}
	}
}

// After an item, History emits what came after it, without the end of the
// turn the chat has already; an item it does not have is not found.
func TestHistoryAfter(t *testing.T) {
	_, env := claudeHome(t)
	p := chatadapter.HistoryParams{Kind: "claude", Env: env, Cwd: "/work", SessionID: headlessID}
	all, err := readHistory(t, p)
	if err != nil {
		t.Fatal(err)
	}
	// The last item of the turn that counts to 40.
	at := -1
	for i, ev := range all {
		if ev.Item == "msg_0030/0" {
			at = i
		}
	}
	if at < 0 {
		t.Fatal("no item msg_0030/0")
	}
	p.After = "msg_0030/0"
	after, err := readHistory(t, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) == 0 || after[0].T != chatproto.EventTurn || after[0].State != chatproto.TurnStart {
		t.Fatalf("after: %+v", after[:min(len(after), 2)])
	}
	// The rest is the whole's, from the next turn's start.
	rest := all[at+1:]
	for len(rest) > 0 && rest[0].T == chatproto.EventTurn && rest[0].State != chatproto.TurnStart {
		rest = rest[1:]
	}
	if !bytes.Equal(rawOf(after), rawOf(rest)) {
		t.Errorf("after: %d events, want %d", len(after), len(rest))
	}

	p.After = "msg_9999/0"
	if _, err := readHistory(t, p); !hasCode(err, chatproto.CodeNotFound) {
		t.Errorf("an unknown item: %v", err)
	}
	p.After, p.Cwd = "", "/elsewhere"
	if _, err := readHistory(t, p); !hasCode(err, chatproto.CodeBadRequest) {
		t.Errorf("another directory: %v", err)
	}
	p.Cwd, p.SessionID = "/work", "00000000-0000-4000-8000-000000000099"
	if _, err := readHistory(t, p); !hasCode(err, chatproto.CodeNotFound) {
		t.Errorf("no transcript: %v", err)
	}
	p.SessionID = "../../etc/passwd"
	if _, err := readHistory(t, p); !hasCode(err, chatproto.CodeBadRequest) {
		t.Errorf("no session id: %v", err)
	}
}

func hasCode(err error, code string) bool {
	var e *chatproto.Error
	return errors.As(err, &e) && e.Code == code
}

// transcriptLines is a small transcript of a session in cwd.
func transcriptLines(cwd, prompt string, extra ...string) string {
	ls := []string{
		`{"type":"session-owner","sessionId":"x"}`,
		string(rawOf(map[string]any{"type": "user", "cwd": cwd, "timestamp": "2026-11-22T10:00:00Z", "message": map[string]any{"role": "user", "content": prompt}})),
	}
	return strings.Join(append(ls, extra...), "\n") + "\n"
}

// Sessions lists the transcripts of a directory, the latest first, a page
// at a time; those of another directory with the same projects directory,
// those that are no regular file of their own and names that are no
// session ids are left out.
func TestSessions(t *testing.T) {
	home, env := claudeHome(t)
	dir := filepath.Join(home, ".claude", "projects", "-work")
	write := func(name, content string, mod time.Time) {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mod, mod); err != nil {
			t.Fatal(err)
		}
	}
	base := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(dir, headlessID+".jsonl"), base, base); err != nil {
		t.Fatal(err)
	}
	write("00000000-0000-4000-8000-000000000002.jsonl", transcriptLines("/work", "fix the\n  tests", `{"type":"ai-title","aiTitle":"Fix tests"}`, `{"type":"custom-title","customTitle":"My name"}`), base.Add(2*time.Hour))
	write("00000000-0000-4000-8000-000000000003.jsonl", transcriptLines("/work", "first prompt"), base.Add(time.Hour))
	// Another directory of the same escaped name.
	write("00000000-0000-4000-8000-000000000004.jsonl", transcriptLines("/work/", "x")[:0]+transcriptLines("/wo-rk", "other"), base.Add(3*time.Hour))
	write("not-a-session.jsonl", transcriptLines("/work", "x"), base.Add(4*time.Hour))
	// No conversation yet.
	write("00000000-0000-4000-8000-000000000005.jsonl", `{"type":"session-owner"}`+"\n", base.Add(5*time.Hour))
	// A link to a transcript elsewhere.
	outside := filepath.Join(t.TempDir(), "o.jsonl")
	os.WriteFile(outside, []byte(transcriptLines("/work", "linked")), 0o600)
	os.Symlink(outside, filepath.Join(dir, "00000000-0000-4000-8000-000000000006.jsonl"))

	p := chatadapter.SessionsParams{Kind: "claude", Env: env, Cwd: "/work"}
	got, next, err := Adapter{}.Sessions(context.Background(), p)
	if err != nil || next != "" {
		t.Fatal(err, next)
	}
	var ids, titles []string
	for _, s := range got {
		ids = append(ids, s.SessionID[len(s.SessionID)-1:])
		titles = append(titles, s.Title)
		if s.Cwd != "/work" || s.UpdatedAt.IsZero() {
			t.Errorf("session %+v", s)
		}
	}
	if strings.Join(ids, ",") != "2,3,1" {
		t.Errorf("sessions %v", ids)
	}
	if titles[0] != "My name" || titles[1] != "first prompt" || titles[2] != "回复问候语" {
		t.Errorf("titles %q", titles)
	}

	// A page at a time.
	defer func(n int) { sessionsPage = n }(sessionsPage)
	sessionsPage = 1
	var paged []string
	for range 5 {
		got, next, err := Adapter{}.Sessions(context.Background(), p)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range got {
			paged = append(paged, s.SessionID[len(s.SessionID)-1:])
		}
		if next == "" {
			break
		}
		p.Cursor = next
	}
	if strings.Join(paged, ",") != "2,3,1" {
		t.Errorf("paged %v", paged)
	}
	p.Cursor = "x"
	if _, _, err := (Adapter{}).Sessions(context.Background(), p); !hasCode(err, chatproto.CodeBadRequest) {
		t.Errorf("a bad cursor: %v", err)
	}
	p.Cursor, p.Cwd = "", "relative"
	if _, _, err := (Adapter{}).Sessions(context.Background(), p); !hasCode(err, chatproto.CodeBadRequest) {
		t.Errorf("a relative directory: %v", err)
	}
	p.Cwd = "/nowhere"
	if got, _, err := (Adapter{}).Sessions(context.Background(), p); err != nil || len(got) != 0 {
		t.Errorf("a directory without sessions: %v %v", got, err)
	}
}

// A long directory's transcripts are in the directories that start with
// the first 200 characters of its escaped name.
func TestSessionsLongDirectory(t *testing.T) {
	home, env := claudeHome(t)
	long := "/" + strings.Repeat("a", 230)
	esc := sessions.ClaudeEscape(long)
	dir := filepath.Join(home, ".claude", "projects", esc[:sessions.ClaudeMaxName]+"-h4sh")
	os.MkdirAll(dir, 0o700)
	os.WriteFile(filepath.Join(dir, "00000000-0000-4000-8000-000000000007.jsonl"), []byte(transcriptLines(long, "long")), 0o600)
	got, _, err := Adapter{}.Sessions(context.Background(), chatadapter.SessionsParams{Kind: "claude", Env: env, Cwd: long})
	if err != nil || len(got) != 1 || got[0].Title != "long" {
		t.Errorf("%+v %v", got, err)
	}
	if sessions.ClaudeEscape("/a.b/ü😀") != "-a-b----" {
		t.Errorf("escape %q", sessions.ClaudeEscape("/a.b/ü😀"))
	}
}
