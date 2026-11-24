//go:build unix

package claude

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"veldr/internal/chatadapter"
	"veldr/internal/chatproto"
)

// A session another Claude Code runs (its record names it, of a process
// that runs and started when the record says) is not taken up: Start and
// InTerminal answer in_terminal; the adapter's own programs do not count.
func TestInTerminal(t *testing.T) {
	home := t.TempDir()
	env := []string{"HOME=" + home}
	const id = "22222222-2222-4222-8222-222222222222"
	cmd := exec.Command("/bin/sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	defer func() {
		cmd.Process.Kill()
		cmd.Wait()
	}()
	dir := filepath.Join(home, ".claude", "sessions")
	os.MkdirAll(dir, 0o700)
	record := fmt.Sprintf(`{"pid":%d,"sessionId":%q,"cwd":"/w","startedAt":%d}`, cmd.Process.Pid, id, started.UnixMilli())
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprint(cmd.Process.Pid)+".json"), []byte(record), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var e *chatproto.Error
	err := Adapter{}.InTerminal(ctx, chatadapter.HistoryParams{Env: env, SessionID: id})
	if !errors.As(err, &e) || e.Code != chatproto.CodeInTerminal {
		t.Fatalf("InTerminal: %v", err)
	}
	if err := (Adapter{}).InTerminal(ctx, chatadapter.HistoryParams{Env: env, SessionID: "33333333-3333-4333-8333-333333333333"}); err != nil {
		t.Errorf("another session: %v", err)
	}
	exe, _ := os.Executable()
	_, err = Adapter{}.Start(ctx, chatadapter.StartParams{Kind: "claude", Argv: []string{exe}, Cwd: home, Resume: id, Env: env}, newSink())
	if !errors.As(err, &e) || e.Code != chatproto.CodeInTerminal {
		t.Fatalf("Start: %v", err)
	}
	own.Store(cmd.Process.Pid, struct{}{})
	defer own.Delete(cmd.Process.Pid)
	if err := (Adapter{}).InTerminal(ctx, chatadapter.HistoryParams{Env: env, SessionID: id}); err != nil {
		t.Errorf("the adapter's own program: %v", err)
	}
}

// The title of the session's transcript (the user's own before the one
// Claude Code made) is the chat's, once a turn ended.
func TestTitleFromTranscript(t *testing.T) {
	home, env := claudeHome(t)
	dir := filepath.Join(home, ".claude", "projects", "-work")
	const id = "00000000-0000-4000-8000-000000000009"
	file := filepath.Join(dir, id+".jsonl")
	os.WriteFile(file, []byte(transcriptLines("/work", "a prompt")), 0o600)
	sink := newSink()
	s := newSession(chatadapter.StartParams{Env: env, Cwd: "/work"}, sink, id)
	title := func() string {
		sink.mu.Lock()
		defer sink.mu.Unlock()
		return sink.chat.Title
	}
	s.readTitle()
	if got := title(); got != "" {
		t.Errorf("a transcript without a title: %q", got)
	}
	os.WriteFile(file, []byte(transcriptLines("/work", "a prompt", `{"type":"ai-title","aiTitle":"Made by Claude"}`)), 0o600)
	s.mu.Lock()
	s.inTurn = true
	o := &out{}
	s.endTurn(o, chatproto.Event{T: chatproto.EventTurn, State: chatproto.TurnEnd})
	s.mu.Unlock()
	deadline := time.Now().Add(10 * time.Second)
	for title() != "Made by Claude" {
		if time.Now().After(deadline) {
			t.Fatalf("title %q after the turn", title())
		}
		time.Sleep(5 * time.Millisecond)
	}
	os.WriteFile(file, []byte(transcriptLines("/work", "a prompt", `{"type":"ai-title","aiTitle":"Made by Claude"}`, `{"type":"custom-title","customTitle":"Mine"}`)), 0o600)
	s.readTitle()
	if got := title(); got != "Mine" {
		t.Errorf("title %q, want the user's", got)
	}
}

// The plan's approval (the recording): Claude Code leaves plan mode by
// itself, and the adapter states each mode it is in, which the host keeps
// as the chat's.
func TestPlanApprovalMode(t *testing.T) {
	r := replay(t, "claude-05-plan-mode.jsonl", nil)
	r.sink.mu.Lock()
	defer r.sink.mu.Unlock()
	want := []string{chatproto.ModeDefault, chatproto.ModePlan, chatproto.ModeDefault, chatproto.ModeAcceptEdits, chatproto.ModeDefault}
	if !slices.Equal(r.sink.modes, want) {
		t.Errorf("modes %v, want %v", r.sink.modes, want)
	}
}
