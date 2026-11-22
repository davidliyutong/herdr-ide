//go:build unix

package usage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/usage"
)

const (
	claudeID = "e6cdc860-1055-488f-9ed2-8b8019061bb9"
	codexID  = "01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3"
	marker   = "MARKER-0c9e"
)

func sessionEnv(t *testing.T) *plugin.Env {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	return &plugin.Env{Home: home, Base: filepath.Join(home, ".app"), Environ: func() []string { return nil }}
}

func writeFile(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

func assistant(id, model string, sidechain bool, usage string) string {
	sc := "false"
	if sidechain {
		sc = "true"
	}
	return `{"isSidechain":` + sc + `,"type":"assistant","timestamp":"2026-11-21T19:42:44.031Z","cwd":"/home/dev/project","message":{"model":"` + model + `","id":"` + id + `","role":"assistant","content":[{"type":"text","text":"` + marker + `"}],"usage":` + usage + `}}` + "\n"
}

func TestSessionAction(t *testing.T) {
	e := sessionEnv(t)
	dir := filepath.Join(e.Home, ".claude/projects/-home-dev-project")
	writeFile(t, filepath.Join(dir, claudeID+".jsonl"),
		`{"type":"user","message":{"role":"user","content":"`+marker+`"}}`+"\n"+
			assistant("msg_1", "claude-opus-5-5", false, `{"input_tokens":4,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"output_tokens":30}`))
	writeFile(t, filepath.Join(dir, claudeID, "subagents/agent-a.jsonl"),
		assistant("msg_2", "claude-haiku-5-5", true, `{"input_tokens":6,"cache_read_input_tokens":500,"output_tokens":10}`))
	rep := call(t, e, "session", `{"kind":"claude","session":"`+claudeID+`","prices":{"claude-opus-5-5":{"input":1,"cached":0.1,"output":5}}}`)
	var u agentproto.SessionUsage
	if !rep.OK || json.Unmarshal(rep.Plugin, &u) != nil {
		t.Fatalf("claude %+v %s", rep, rep.Plugin)
	}
	// The subagent's request counts; the context and the model are the
	// session's own; the user's price applies.
	if u.Requests != 2 || u.Output != 40 || u.Model != "claude-opus-5-5" || u.ContextUsed != 1204 || !u.Priced || u.Cost <= 0 {
		t.Errorf("claude %+v", u)
	}
	if strings.Contains(string(rep.Plugin), marker) || strings.Contains(string(rep.Plugin), e.Home) {
		t.Errorf("content or a path in %s", rep.Plugin)
	}

	writeFile(t, filepath.Join(e.Home, ".codex/sessions/2026/11/21/rollout-2026-11-21T19-43-47-"+codexID+".jsonl"),
		`{"timestamp":"2026-11-21T19:43:47.797Z","type":"session_meta","payload":{"id":"`+codexID+`","cwd":"/home/dev/project","base_instructions":{"text":"`+marker+`"}}}
{"timestamp":"2026-11-21T19:44:01.088Z","type":"turn_context","payload":{"turn_id":"t1","cwd":"/home/dev/project","model":"gpt-6.1-sol"}}
{"timestamp":"2026-11-21T19:44:03.431Z","type":"token_usage_record","payload":{"turn_id":"t1","response_id":"r1","usage":{"input_tokens":26763,"cached_input_tokens":13312,"output_tokens":46}}}
{"timestamp":"2026-11-21T19:44:04.504Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":26763},"last_token_usage":{"input_tokens":26763,"cached_input_tokens":13312,"output_tokens":46},"model_context_window":828400}}}
`)
	rep = call(t, e, "session", `{"kind":"codex","session":"`+codexID+`"}`)
	u = agentproto.SessionUsage{}
	if !rep.OK || json.Unmarshal(rep.Plugin, &u) != nil || u.Requests != 1 || u.Model != "gpt-6.1-sol" || u.ContextUsed != 26763 || u.ContextSize != 828400 {
		t.Errorf("codex %+v %s", rep, rep.Plugin)
	}
}

func TestSessionActionCodes(t *testing.T) {
	e := sessionEnv(t)
	dir := filepath.Join(e.Home, ".claude/projects/-p")
	// Only compressed.
	const zstID = "11111111-2222-4333-8444-555555555555"
	writeFile(t, filepath.Join(dir, zstID+".jsonl.zst"), "x")
	// Larger than a transcript is read (sparse).
	const bigID = "22222222-2222-4333-8444-555555555555"
	writeFile(t, filepath.Join(dir, bigID+".jsonl"), "")
	if err := os.Truncate(filepath.Join(dir, bigID+".jsonl"), usage.MaxSessionBytes+1); err != nil {
		t.Fatal(err)
	}
	// A transcript that escapes the session root through a symlink.
	const outID = "33333333-2222-4333-8444-555555555555"
	writeFile(t, filepath.Join(e.Home, "elsewhere.jsonl"), assistant("m", "claude-opus-5-5", false, `{"input_tokens":1,"output_tokens":1}`))
	if err := os.Symlink(filepath.Join(e.Home, "elsewhere.jsonl"), filepath.Join(dir, outID+".jsonl")); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ params, code string }{
		{`[1]`, "bad_params"},
		{`{"kind":"nope","session":"` + claudeID + `"}`, "bad_params"},
		{`{"kind":"gemini","session":"` + claudeID + `"}`, "bad_params"},
		{`{"kind":"opencode","session":"` + claudeID + `"}`, "bad_params"},
		{`{"kind":"claude","session":"../` + claudeID + `"}`, "bad_params"},
		{`{"kind":"claude","session":"` + strings.ToUpper(claudeID) + `"}`, "bad_params"},
		{`{"kind":"claude","session":"` + claudeID + `\n"}`, "bad_params"},
		{`{"kind":"claude","session":"` + claudeID + `","prices":{"":{"input":1}}}`, "bad_params"},
		{`{"kind":"claude","session":"` + claudeID + `"}`, "not_found"},
		{`{"kind":"codex","session":"` + codexID + `"}`, "not_found"},
		{`{"kind":"claude","session":"` + zstID + `"}`, "compressed"},
		{`{"kind":"claude","session":"` + bigID + `"}`, "too_large"},
		{`{"kind":"claude","session":"` + outID + `"}`, "not_found"},
	} {
		rep := call(t, e, "session", c.params)
		if rep.OK || rep.Code != c.code || strings.Contains(rep.Error, e.Home) {
			t.Errorf("%s: %+v", c.params, rep)
		}
	}
}

// TestSessionFilesOpenAsLocated: the transcripts a session action reads are
// the files Locate found, opened through no symbolic link: one swapped for
// a link out of the session root after Locate is not read (the session's
// own: not_found; a subagent's: left out), nor one hard-linked to a file
// elsewhere.
func TestSessionFilesOpenAsLocated(t *testing.T) {
	e := sessionEnv(t)
	dir := filepath.Join(e.Home, ".claude/projects/-home-dev-project")
	main := filepath.Join(dir, claudeID+".jsonl")
	writeFile(t, main, assistant("msg_1", "claude-opus-5-5", false, `{"input_tokens":4,"output_tokens":30}`))
	writeFile(t, filepath.Join(dir, claudeID, "subagents/agent-a.jsonl"), assistant("msg_2", "claude-haiku-5-5", true, `{"input_tokens":6,"output_tokens":10}`))
	writeFile(t, filepath.Join(dir, claudeID, "subagents/agent-b.jsonl"), assistant("msg_3", "claude-haiku-5-5", true, `{"input_tokens":6,"output_tokens":10}`))
	outside := filepath.Join(t.TempDir(), "outside.jsonl")
	writeFile(t, outside, assistant("msg_x", "claude-opus-5-5", false, `{"input_tokens":700,"output_tokens":900}`))
	ctx := context.Background()

	f, err := resolver(e.Home).Locate("claude", claudeID)
	if err != nil || len(f.Subagents) != 2 {
		t.Fatalf("Locate %+v %v", f, err)
	}
	u, err := usage.SessionCost(ctx, env(e), usage.Claude, sessionFiles(f), usage.SessionOptions{})
	if err != nil || u.Requests != 3 {
		t.Fatalf("as located %+v %v", u, err)
	}
	// A subagent swapped for a link out: left out.
	os.Remove(f.Subagents[1])
	os.Symlink(outside, f.Subagents[1])
	u, err = usage.SessionCost(ctx, env(e), usage.Claude, sessionFiles(f), usage.SessionOptions{})
	if err != nil || u.Requests != 2 || u.Output != 40 {
		t.Errorf("subagent swapped: %+v %v", u, err)
	}
	// The session's own swapped: not found, nothing of the file outside read.
	os.Remove(f.Path)
	os.Symlink(outside, f.Path)
	u, err = usage.SessionCost(ctx, env(e), usage.Claude, sessionFiles(f), usage.SessionOptions{})
	if err == nil || u.Output != 0 {
		t.Errorf("session swapped: %+v %v", u, err)
	}
	if rep, ok := sessionError(err).(*plugin.Error); !ok || rep.Code != agentproto.TranscriptNotFound {
		t.Errorf("session swapped: %v", sessionError(err))
	}
	if rep := call(t, e, "session", `{"kind":"claude","session":"`+claudeID+`"}`); rep.OK || rep.Code != agentproto.TranscriptNotFound {
		t.Errorf("action after the swap: %+v", rep)
	}

	// A hard link inside the root to a file elsewhere is not a transcript.
	const linkID = "44444444-2222-4333-8444-555555555555"
	if err := os.Link(outside, filepath.Join(dir, linkID+".jsonl")); err != nil {
		t.Skip(err)
	}
	if rep := call(t, e, "session", `{"kind":"claude","session":"`+linkID+`"}`); rep.OK || rep.Code != agentproto.TranscriptNotFound {
		t.Errorf("hard link: %+v", rep)
	}
}
