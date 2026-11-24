//go:build unix

package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"veldr/internal/agent/plugin"
	"veldr/internal/agentproto"
)

const (
	// The session and the directory of a shared vector's transcript, and a
	// Codex session in the same directory (codexRollout).
	claudeSession = "e6cdc860-1055-488f-9ed2-8b8019061bb9"
	codexSession  = "01a1ffa2-e43b-7c13-8240-7eb9e6fa29f3"
	vectorCwd     = "/home/dev/project"
	vectorDir     = "../../../../design/testdata/transcript"
)

// sid is a session id of its own for n.
func sid(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }

// testEnv is a home of its own with no agent directories yet; the
// environment names none either.
type testEnv struct {
	t    *testing.T
	home string
	env  *plugin.Env
	// secrets are the strings no reply may hold: the home's paths.
	secrets []string
}

func newEnv(t *testing.T) *testEnv {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	real, err := filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	return &testEnv{t: t, home: home, env: &plugin.Env{Home: home}, secrets: []string{home, real}}
}

// vectorLines are the lines of a shared vector's transcript.
func vectorLines(t *testing.T, name string) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(vectorDir, name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Lines  []string          `json:"lines"`
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v.Lines
}

// codexRollout is the start of a rollout of Codex CLI 0.170.0's of
// codexSession, run in vectorCwd.
var codexRollout = []string{
	`{"timestamp":"2026-11-21T19:44:00.320Z","ordinal":0,"type":"session_meta","payload":{"id":"` + codexSession + `","session_id":"` + codexSession + `","timestamp":"2026-11-21T19:43:47.797Z","cwd":"` + vectorCwd + `","originator":"codex-tui","cli_version":"0.170.0"}}`,
	`{"timestamp":"2026-11-21T19:44:00.321Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started"}}`,
}

func content(lines []string) []byte {
	var b bytes.Buffer
	for _, l := range lines {
		b.WriteString(l)
		b.WriteByte('\n')
	}
	return b.Bytes()
}

func writeFile(p string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}

func (e *testEnv) write(p string, b []byte) string {
	e.t.Helper()
	if err := writeFile(p, b); err != nil {
		e.t.Fatal(err)
	}
	return p
}

// claudePath is where Claude Code keeps a session's transcript of the
// vectors' directory.
func (e *testEnv) claudePath(session string) string {
	return filepath.Join(e.home, ".claude", "projects", "-home-dev-project", session+".jsonl")
}

func (e *testEnv) codexPath(session string) string {
	return filepath.Join(e.home, ".codex", "sessions", "2026", "11", "21", "rollout-2026-11-21T19-43-47-"+session+".jsonl")
}

// run runs an action over a pipe as the agent does, and gives its reply and
// its result (from the line or the body after it). No reply holds a path of
// the test's home.
func (e *testEnv) run(action string, params any) (agentproto.Reply, []byte) {
	e.t.Helper()
	b, err := json.Marshal(params)
	if err != nil {
		e.t.Fatal(err)
	}
	a, c := net.Pipe()
	defer c.Close()
	done := make(chan error, 1)
	go func() { done <- handle(context.Background(), a, action, b, e.env) }()
	var rep agentproto.Reply
	if err := agentproto.ReadLine(c, &rep); err != nil {
		e.t.Fatal(err)
	}
	res := []byte(rep.Plugin)
	if rep.PluginLength > 0 {
		if res, err = agentproto.ReadBody(c, rep.PluginLength); err != nil {
			e.t.Fatal(err)
		}
	}
	<-done
	line, _ := json.Marshal(rep)
	for _, s := range e.secrets {
		if bytes.Contains(res, []byte(s)) || bytes.Contains(line, []byte(s)) {
			e.t.Fatalf("%s: the reply names a path of the machine: %s %s", action, line, res)
		}
	}
	return rep, res
}

func (e *testEnv) resolve(kind, session, cwd string) agentproto.ResolveReply {
	e.t.Helper()
	rep, res := e.run(ActionResolve, agentproto.ResolveRequest{Kind: kind, Session: session, Cwd: cwd})
	if !rep.OK {
		e.t.Fatalf("resolve: %+v", rep)
	}
	var out agentproto.ResolveReply
	if err := json.Unmarshal(res, &out); err != nil {
		e.t.Fatal(err)
	}
	return out
}

// The plugin is registered; an unknown action fails (the tail of earlier
// versions too), and so does a resolve of another shape.
func TestBadParams(t *testing.T) {
	e := newEnv(t)
	if plugin.Lookup(ID) == nil {
		t.Fatal("not registered")
	}
	for _, c := range []struct {
		action string
		params any
	}{
		{"", nil},
		{"capture", nil},
		{"tail", json.RawMessage(`{"refs":[{"kind":"claude","session":"` + claudeSession + `","back":true}]}`)},
		{ActionResolve, json.RawMessage(`[1]`)},
	} {
		if rep, _ := e.run(c.action, c.params); rep.OK || rep.Code != "bad_params" {
			t.Errorf("%q %v: %+v", c.action, c.params, rep)
		}
	}
}

// A session resolves when its transcript exists and records the
// directory asked about, which is compared, never looked at.
func TestResolve(t *testing.T) {
	e := newEnv(t)
	e.write(e.claudePath(claudeSession), content(vectorLines(t, "claude-2.1.330-tools")))
	e.write(e.codexPath(codexSession), content(codexRollout))
	e.write(e.claudePath(sid(1))+".zst", []byte("x"))
	// A transcript that records no directory yet.
	e.write(e.claudePath(sid(2)), []byte(`{"type":"mode","stub":true}`+"\n"))
	for _, c := range []struct {
		kind, session, cwd string
		want               agentproto.ResolveReply
	}{
		{"claude", claudeSession, vectorCwd, agentproto.ResolveReply{OK: true}},
		{"claude", claudeSession, vectorCwd + "/", agentproto.ResolveReply{OK: true}},
		{"claude", claudeSession, "/home/dev/./project", agentproto.ResolveReply{OK: true}},
		{"codex", codexSession, vectorCwd, agentproto.ResolveReply{OK: true}},
		{"claude", claudeSession, "/home/dev", agentproto.ResolveReply{Code: agentproto.ResolveOtherCwd}},
		{"codex", codexSession, "/home/dev/project2", agentproto.ResolveReply{Code: agentproto.ResolveOtherCwd}},
		{"claude", sid(3), vectorCwd, agentproto.ResolveReply{Code: agentproto.TranscriptNotFound}},
		{"codex", claudeSession, vectorCwd, agentproto.ResolveReply{Code: agentproto.TranscriptNotFound}},
		{"claude", sid(2), vectorCwd, agentproto.ResolveReply{Code: agentproto.TranscriptNotFound}},
		{"claude", sid(1), vectorCwd, agentproto.ResolveReply{Code: agentproto.TranscriptCompressed}},
		{"gemini", claudeSession, vectorCwd, agentproto.ResolveReply{Code: agentproto.TranscriptBadRequest}},
		{"claude", "../" + claudeSession, vectorCwd, agentproto.ResolveReply{Code: agentproto.TranscriptBadRequest}},
		{"claude", claudeSession, "home/dev/project", agentproto.ResolveReply{Code: agentproto.TranscriptBadRequest}},
		{"claude", claudeSession, "", agentproto.ResolveReply{Code: agentproto.TranscriptBadRequest}},
		{"claude", claudeSession, vectorCwd + "\x00", agentproto.ResolveReply{Code: agentproto.TranscriptBadRequest}},
		{"claude", claudeSession, "/" + strings.Repeat("a", MaxCwd), agentproto.ResolveReply{Code: agentproto.TranscriptBadRequest}},
	} {
		if got := e.resolve(c.kind, c.session, c.cwd); got != c.want {
			t.Errorf("%s %s %q: %+v, want %+v", c.kind, c.session, c.cwd, got, c.want)
		}
	}
	// JSON cannot carry what is no UTF-8: checked all the same.
	if got := resolve(resolver(e.env), agentproto.ResolveRequest{Kind: "claude", Session: claudeSession, Cwd: "/home/\xff"}); got.Code != agentproto.TranscriptBadRequest {
		t.Errorf("a directory that is no UTF-8: %+v", got)
	}
}

// One Resolver serves every request of a home, and keeps where it found
// transcripts.
func TestResolverShared(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	ra := resolver(&plugin.Env{Home: a})
	if resolver(&plugin.Env{Home: a}) != ra || ra.Home != a {
		t.Fatal("a second Resolver for the same home")
	}
	if rb := resolver(&plugin.Env{Home: b}); rb == ra || rb.Home != b {
		t.Fatal("the Resolver of another home")
	}
}
