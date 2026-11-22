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
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agent/transcript"
	"herdr-ide/internal/agentproto"
)

const (
	// The sessions and the directory of the shared vectors' transcripts.
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

// fast shortens the waits' intervals for the test.
func fast(t *testing.T) {
	t.Helper()
	p, r := pollEvery, relocateEvery
	pollEvery, relocateEvery = 10*time.Millisecond, 40*time.Millisecond
	t.Cleanup(func() { pollEvery, relocateEvery = p, r })
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

// appendTo appends b to the file p; goroutines of a test call it too, so
// it reports a failure without ending the test.
func appendTo(t *testing.T, p string, b []byte) {
	t.Helper()
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Error(err)
		return
	}
	defer f.Close()
	if _, err := f.Write(b); err != nil {
		t.Error(err)
	}
}

// prompt is a line of Claude Code's transcript with a prompt of the user.
func prompt(session, text string) []byte {
	b, _ := json.Marshal(map[string]any{
		"parentUuid": nil, "isSidechain": false, "type": "user",
		"message":   map[string]any{"role": "user", "content": text},
		"uuid":      "11111111-2222-4333-8444-555555555555",
		"timestamp": "2026-11-21T19:50:00.000Z", "cwd": vectorCwd, "sessionId": session,
	})
	return append(b, '\n')
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

func (e *testEnv) tail(refs []agentproto.TranscriptRef, waitMS int) agentproto.TailReply {
	e.t.Helper()
	rep, res := e.run(ActionTail, agentproto.TailRequest{Refs: refs, WaitMS: waitMS})
	if !rep.OK {
		e.t.Fatalf("tail: %+v", rep)
	}
	var out agentproto.TailReply
	if err := json.Unmarshal(res, &out); err != nil {
		e.t.Fatal(err)
	}
	if len(out.Tails) != len(refs) {
		e.t.Fatalf("%d tails for %d refs", len(out.Tails), len(refs))
	}
	for i, tl := range out.Tails {
		if tl.Kind != refs[i].Kind || tl.Session != refs[i].Session {
			e.t.Fatalf("tail %d is %s/%s", i, tl.Kind, tl.Session)
		}
	}
	return out
}

func (e *testEnv) tailOne(ref agentproto.TranscriptRef, waitMS int) agentproto.TranscriptTail {
	e.t.Helper()
	return e.tail([]agentproto.TranscriptRef{ref}, waitMS).Tails[0]
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

func eventsJSON(t *testing.T, evs []agentproto.TranscriptEvent) string {
	t.Helper()
	b, err := json.Marshal(evs)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The plugin is registered; an unknown action fails, and so do requests
// of no ref or more than a reply reads.
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
		{ActionTail, agentproto.TailRequest{}},
		{ActionTail, agentproto.TailRequest{Refs: make([]agentproto.TranscriptRef, agentproto.MaxTailRefs+1)}},
		{ActionTail, json.RawMessage(`{"refs":"x"}`)},
		{ActionResolve, json.RawMessage(`[1]`)},
	} {
		if rep, _ := e.run(c.action, c.params); rep.OK || rep.Code != "bad_params" {
			t.Errorf("%q %v: %+v", c.action, c.params, rep)
		}
	}
	refs := make([]agentproto.TranscriptRef, agentproto.MaxTailRefs)
	for i := range refs {
		refs[i] = agentproto.TranscriptRef{Kind: "claude", Session: sid(i), Back: true}
	}
	for _, tl := range e.tail(refs, 0).Tails {
		if tl.Code != agentproto.TranscriptNotFound {
			t.Errorf("%+v", tl)
		}
	}
}

// A view's first read is the page ending at the transcript's end; a
// forward read from its Next reads only what was added since.
func TestFirstAndForwardReads(t *testing.T) {
	e := newEnv(t)
	lines := vectorLines(t, "claude-2.1.330-tools")
	p := e.write(e.claudePath(claudeSession), content(lines))
	size := int64(len(content(lines)))

	first := e.tailOne(agentproto.TranscriptRef{Kind: "claude", Session: claudeSession, Back: true}, 0)
	if first.Code != "" || len(first.Events) == 0 || first.File == "" || first.More ||
		first.Next != agentproto.Seq(size, 0) || first.First != first.Events[0].Seq || first.Title == "" {
		t.Fatalf("first read: code %q, %d events, file %q, more %v, first %d, next %d, title %q",
			first.Code, len(first.Events), first.File, first.More, first.First, first.Next, first.Title)
	}
	// Nothing new: an empty page at once.
	start := time.Now()
	same := e.tailOne(agentproto.TranscriptRef{Kind: "claude", Session: claudeSession, From: first.Next}, 0)
	if same.Code != "" || len(same.Events) != 0 || same.Next != first.Next || same.File != first.File || time.Since(start) > 2*time.Second {
		t.Fatalf("nothing new: %+v", same)
	}

	appendTo(t, p, prompt(claudeSession, "MARKER second prompt"))
	next := e.tailOne(agentproto.TranscriptRef{Kind: "claude", Session: claudeSession, From: first.Next}, 0)
	got := eventsJSON(t, next.Events)
	if len(next.Events) == 0 || !strings.Contains(got, "MARKER second prompt") || strings.Contains(got, "create hello.txt") {
		t.Fatalf("forward read: %s", got)
	}
	for _, ev := range next.Events {
		if ev.Seq < first.Next {
			t.Errorf("event %d before the cursor %d", ev.Seq, first.Next)
		}
	}
	if next.Next <= first.Next || next.File != first.File {
		t.Errorf("forward read: next %d, file %q", next.Next, next.File)
	}

	// Codex's rollout, read forward from its start.
	cl := vectorLines(t, "codex-0.170.0-exec")
	e.write(e.codexPath(codexSession), content(cl))
	cx := e.tailOne(agentproto.TranscriptRef{Kind: "codex", Session: codexSession}, 0)
	if cx.Code != "" || len(cx.Events) == 0 || cx.Next != agentproto.Seq(int64(len(content(cl))), 0) || cx.More {
		t.Fatalf("codex: %+v", cx)
	}
}

// A ref that names no transcript to read, or one that cannot be read,
// gets a code and its cursor back; the other refs of the request are read.
func TestRefCodes(t *testing.T) {
	e := newEnv(t)
	lines := content(vectorLines(t, "claude-2.1.330-tools"))
	e.write(e.claudePath(claudeSession), lines)
	// Compressed only.
	e.write(e.claudePath(sid(1))+".zst", []byte("x"))
	e.write(strings.TrimSuffix(e.codexPath(sid(2)), ".jsonl")+".jsonl.zst", []byte("x"))
	// A symlink out of the session root.
	outside := e.write(filepath.Join(t.TempDir(), "secret.jsonl"), lines)
	if err := os.Symlink(outside, e.claudePath(sid(3))); err != nil {
		t.Fatal(err)
	}
	// A FIFO where a transcript would be: never opened for reading, so
	// nothing blocks.
	if err := unix.Mkfifo(e.claudePath(sid(4)), 0o600); err != nil {
		t.Fatal(err)
	}
	// A directory.
	if err := os.MkdirAll(e.claudePath(sid(5)), 0o700); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		ref  agentproto.TranscriptRef
		code string
	}{
		{agentproto.TranscriptRef{Kind: "gemini", Session: claudeSession, From: 77}, agentproto.TranscriptBadRequest},
		{agentproto.TranscriptRef{Kind: "", Session: claudeSession}, agentproto.TranscriptBadRequest},
		{agentproto.TranscriptRef{Kind: "../claude", Session: claudeSession}, agentproto.TranscriptBadRequest},
		{agentproto.TranscriptRef{Kind: "claude", Session: strings.ToUpper(claudeSession)}, agentproto.TranscriptBadRequest},
		{agentproto.TranscriptRef{Kind: "claude", Session: "../" + claudeSession}, agentproto.TranscriptBadRequest},
		{agentproto.TranscriptRef{Kind: "claude", Session: "/etc/" + claudeSession + ".jsonl"}, agentproto.TranscriptBadRequest},
		{agentproto.TranscriptRef{Kind: "claude", Session: sid(1), From: 5 << 8}, agentproto.TranscriptCompressed},
		{agentproto.TranscriptRef{Kind: "codex", Session: sid(2), Back: true}, agentproto.TranscriptCompressed},
		{agentproto.TranscriptRef{Kind: "claude", Session: sid(3), Back: true}, agentproto.TranscriptNotFound},
		{agentproto.TranscriptRef{Kind: "claude", Session: sid(4), Back: true}, agentproto.TranscriptNotFound},
		{agentproto.TranscriptRef{Kind: "claude", Session: sid(5)}, agentproto.TranscriptNotFound},
		{agentproto.TranscriptRef{Kind: "codex", Session: claudeSession}, agentproto.TranscriptNotFound},
	}
	refs := []agentproto.TranscriptRef{{Kind: "claude", Session: claudeSession, Back: true}}
	for _, c := range cases {
		refs = append(refs, c.ref)
	}
	for len(refs) > 0 {
		n := min(len(refs), agentproto.MaxTailRefs)
		start := time.Now()
		out := e.tail(refs[:n], 0)
		if time.Since(start) > 5*time.Second {
			t.Fatal("a read blocked")
		}
		for i, tl := range out.Tails {
			if tl.Session == claudeSession && tl.Kind == "claude" {
				if tl.Code != "" || len(tl.Events) == 0 {
					t.Errorf("the good ref: %+v", tl)
				}
				continue
			}
			want := ""
			for _, c := range cases {
				if c.ref == refs[i] {
					want = c.code
				}
			}
			if tl.Code != want || len(tl.Events) != 0 || tl.File != "" || tl.First != refs[i].From || tl.Next != refs[i].From {
				t.Errorf("%+v: %+v, want %s", refs[i], tl, want)
			}
		}
		refs = refs[n:]
	}
}

// A forward read that finds nothing waits for a line to be appended, and
// answers it as soon as it is there.
func TestWaitForAppend(t *testing.T) {
	fast(t)
	e := newEnv(t)
	lines := content(vectorLines(t, "claude-2.1.330-tools"))
	p := e.write(e.claudePath(claudeSession), lines)
	from := agentproto.Seq(int64(len(lines)), 0)
	go func() {
		time.Sleep(150 * time.Millisecond)
		// Half a line is not yet something to read.
		line := prompt(claudeSession, "MARKER appended")
		appendTo(t, p, line[:20])
		time.Sleep(150 * time.Millisecond)
		appendTo(t, p, line[20:])
	}()
	start := time.Now()
	tl := e.tailOne(agentproto.TranscriptRef{Kind: "claude", Session: claudeSession, From: from}, 10000)
	took := time.Since(start)
	if !strings.Contains(eventsJSON(t, tl.Events), "MARKER appended") || took < 250*time.Millisecond || took > 5*time.Second {
		t.Fatalf("after %v: %+v", took, tl)
	}
}

// A transcript that does not exist yet (an agent writes it at the first
// prompt) is looked for again while the read waits.
func TestWaitForCreate(t *testing.T) {
	fast(t)
	e := newEnv(t)
	rollout := content(vectorLines(t, "codex-0.170.0-exec"))
	go func() {
		time.Sleep(200 * time.Millisecond)
		if err := writeFile(e.codexPath(codexSession), rollout); err != nil {
			t.Error(err)
		}
	}()
	start := time.Now()
	out := e.tail([]agentproto.TranscriptRef{
		{Kind: "codex", Session: codexSession},
		{Kind: "claude", Session: sid(9), From: 40 << 8},
	}, 10000)
	took := time.Since(start)
	if tl := out.Tails[0]; tl.Code != "" || len(tl.Events) == 0 || took > 5*time.Second {
		t.Fatalf("after %v: %+v", took, tl)
	}
	if tl := out.Tails[1]; tl.Code != agentproto.TranscriptNotFound || tl.Next != 40<<8 {
		t.Fatalf("the other ref: %+v", tl)
	}
	// A view's first read of a transcript with no conversation yet waits
	// for it too.
	p := e.write(e.claudePath(sid(10)), []byte(`{"type":"mode","stub":true}`+"\n"))
	go func() {
		time.Sleep(150 * time.Millisecond)
		appendTo(t, p, prompt(sid(10), "MARKER first prompt"))
	}()
	tl := e.tailOne(agentproto.TranscriptRef{Kind: "claude", Session: sid(10), Back: true}, 10000)
	if !strings.Contains(eventsJSON(t, tl.Events), "MARKER first prompt") {
		t.Fatalf("first read: %+v", tl)
	}
}

// A wait ends at its limit, with the empty pages; one beyond
// agentproto.MaxTailWait is cut to it. A page before a cursor waits for
// nothing.
func TestWaitLimit(t *testing.T) {
	fast(t)
	e := newEnv(t)
	lines := content(vectorLines(t, "claude-2.1.330-tools"))
	e.write(e.claudePath(claudeSession), lines)
	end := agentproto.Seq(int64(len(lines)), 0)
	start := time.Now()
	out := e.tail([]agentproto.TranscriptRef{
		{Kind: "claude", Session: claudeSession, From: end},
		{Kind: "claude", Session: sid(1)},
		{Kind: "gemini", Session: sid(2)},
	}, 300)
	took := time.Since(start)
	if took < 300*time.Millisecond || took > 3*time.Second {
		t.Fatalf("waited %v", took)
	}
	for _, tl := range out.Tails {
		if len(tl.Events) != 0 {
			t.Errorf("%+v", tl)
		}
	}
	if out.Tails[0].Code != "" || out.Tails[0].Next != end || out.Tails[0].File == "" {
		t.Errorf("the transcript's page: %+v", out.Tails[0])
	}
	// The page before the first event: none, at once.
	first := e.tailOne(agentproto.TranscriptRef{Kind: "claude", Session: claudeSession, Back: true}, 0)
	start = time.Now()
	before := e.tailOne(agentproto.TranscriptRef{Kind: "claude", Session: claudeSession, From: first.First, Back: true}, 10000)
	if time.Since(start) > 2*time.Second || len(before.Events) != 0 || before.More {
		t.Fatalf("page before the start: %+v", before)
	}
	// The limit.
	for ms, want := range map[int]time.Duration{-5: 0, 0: 0, 300: 300 * time.Millisecond, 15000: agentproto.MaxTailWait, 15001: agentproto.MaxTailWait, 1 << 62: agentproto.MaxTailWait} {
		if got := waitOf(ms); got != want {
			t.Errorf("waitOf(%d) = %v, want %v", ms, got, want)
		}
	}
}

// A wait ends when the core closes the stream, and leaves no goroutine
// behind.
func TestWaitEndsWithTheStream(t *testing.T) {
	fast(t)
	e := newEnv(t)
	lines := content(vectorLines(t, "claude-2.1.330-tools"))
	e.write(e.claudePath(claudeSession), lines)
	before := runtime.NumGoroutine()
	params, _ := json.Marshal(agentproto.TailRequest{WaitMS: 15000, Refs: []agentproto.TranscriptRef{
		{Kind: "claude", Session: claudeSession, From: agentproto.Seq(int64(len(lines)), 0)},
		{Kind: "codex", Session: codexSession},
	}})
	a, c := net.Pipe()
	done := make(chan error, 1)
	go func() { done <- handle(context.Background(), a, ActionTail, params, e.env) }()
	time.Sleep(200 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("ended before the stream closed")
	default:
	}
	c.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the wait outlived its stream")
	}
	for i := 0; runtime.NumGoroutine() > before; i++ {
		if i > 200 {
			buf := make([]byte, 1<<16)
			t.Fatalf("%d goroutines, %d before:\n%s", runtime.NumGoroutine(), before, buf[:runtime.Stack(buf, true)])
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The pages of a reply share MaxReplyBytes; a reply above
// agentproto.MaxInline travels as a body after its line.
func TestReplyBound(t *testing.T) {
	e := newEnv(t)
	var big bytes.Buffer
	for i := 0; big.Len() < 3<<20; i++ {
		big.Write(prompt(sid(0), fmt.Sprintf("prompt %d %s", i, strings.Repeat("x", 4000))))
	}
	refs := make([]agentproto.TranscriptRef, agentproto.MaxTailRefs)
	for i := range refs {
		e.write(e.claudePath(sid(i)), big.Bytes())
		refs[i] = agentproto.TranscriptRef{Kind: "claude", Session: sid(i), Back: true}
	}
	rep, res := e.run(ActionTail, agentproto.TailRequest{Refs: refs})
	if !rep.OK || rep.PluginLength == 0 || len(rep.Plugin) != 0 {
		t.Fatalf("reply %+v", rep)
	}
	if len(res) > MaxReplyBytes {
		t.Fatalf("a reply of %d bytes", len(res))
	}
	var out agentproto.TailReply
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatal(err)
	}
	for _, tl := range out.Tails {
		b, _ := json.Marshal(tl)
		if !tl.More || len(tl.Events) == 0 || len(b) > MaxReplyBytes/agentproto.MaxTailRefs {
			t.Errorf("page of %d bytes, %d events, more %v", len(b), len(tl.Events), tl.More)
		}
	}
	// One ref takes a page of agentproto.MaxTailBytes.
	rep, res = e.run(ActionTail, agentproto.TailRequest{Refs: refs[:1]})
	if !rep.OK || len(res) > agentproto.MaxTailBytes || len(res) < agentproto.MaxTailBytes/2 {
		t.Fatalf("one page of %d bytes", len(res))
	}
}

// A session resolves when its transcript exists and records the
// directory asked about, which is compared, never looked at.
func TestResolve(t *testing.T) {
	e := newEnv(t)
	e.write(e.claudePath(claudeSession), content(vectorLines(t, "claude-2.1.330-tools")))
	e.write(e.codexPath(codexSession), content(vectorLines(t, "codex-0.170.0-exec")))
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

// At most MaxReads transcripts are read at once: a read waits for its
// turn, and gives up when its request ends.
func TestReadsTakeTurns(t *testing.T) {
	e := newEnv(t)
	e.write(e.claudePath(claudeSession), content(vectorLines(t, "claude-2.1.330-tools")))
	req := agentproto.TailRequest{Refs: []agentproto.TranscriptRef{{Kind: "claude", Session: claudeSession, Back: true}}}
	held := 0
	take := func() { reads <- struct{}{}; held++ }
	give := func() { <-reads; held-- }
	t.Cleanup(func() {
		for held > 0 {
			give()
		}
	})
	for range MaxReads {
		take()
	}
	done := make(chan agentproto.TailReply, 1)
	go func() { done <- tail(context.Background(), resolver(e.env), req) }()
	select {
	case <-done:
		t.Fatal("a read ran while every turn was taken")
	case <-time.After(200 * time.Millisecond):
	}
	give()
	select {
	case got := <-done:
		if tl := got.Tails[0]; tl.Code != "" || len(tl.Events) == 0 {
			t.Fatalf("the read in its turn: %+v", tl)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the read got no turn")
	}
	if len(reads) != held {
		t.Fatalf("%d turns taken, %d held here", len(reads), held)
	}
	// Its request ends while it waits.
	take()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { done <- tail(ctx, resolver(e.env), req) }()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case got := <-done:
		if tl := got.Tails[0]; len(tl.Events) != 0 || tl.Next != 0 {
			t.Fatalf("a read given up: %+v", tl)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the wait outlived its request")
	}
	if _, ok := acquire(ctx); ok {
		t.Error("a turn for an ended request")
	}
}

// countTails counts the transcript reads (tailFile) of the test.
func countTails(t *testing.T) *atomic.Int64 {
	t.Helper()
	var n atomic.Int64
	orig := tailFile
	tailFile = func(ctx context.Context, kind string, f *os.File, ref agentproto.TranscriptRef, lim transcript.Limits) (agentproto.TranscriptTail, error) {
		n.Add(1)
		return orig(ctx, kind, f, ref, lim)
	}
	t.Cleanup(func() { tailFile = orig })
	return &n
}

// A view's first read of a transcript whose lines make no event waits;
// lines appended that make none either are read once each time, not again
// at every look of the wait, and a line with an event ends the wait.
func TestWaitReadsAnAppendOnce(t *testing.T) {
	fast(t)
	e := newEnv(t)
	quiet := []byte(`{"type":"file-history-snapshot","x":"` + strings.Repeat("a", 900) + `"}` + "\n")
	p := e.write(e.claudePath(sid(1)), bytes.Repeat(quiet, 2000))
	n := countTails(t)
	ref := agentproto.TranscriptRef{Kind: "claude", Session: sid(1), Back: true}
	done := make(chan agentproto.TranscriptTail, 1)
	go func() { done <- e.tailOne(ref, 10000) }()
	// Two appends that make no event, each looked at for many polls.
	for range 2 {
		time.Sleep(20 * pollEvery)
		appendTo(t, p, quiet)
	}
	time.Sleep(20 * pollEvery)
	if got := n.Load(); got != 3 {
		t.Fatalf("%d reads for a first read and two appends", got)
	}
	appendTo(t, p, prompt(sid(1), "MARKER at last"))
	select {
	case tl := <-done:
		if !strings.Contains(eventsJSON(t, tl.Events), "MARKER at last") {
			t.Fatalf("%+v", tl)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the line with an event did not end the wait")
	}
	if got := n.Load(); got != 4 {
		t.Fatalf("%d reads in all", got)
	}
}
