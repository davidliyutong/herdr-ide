//go:build unix

package chathost

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/store"
)

// The host says who it is, and refuses what is not a request.
func TestHelloAndBadRequests(t *testing.T) {
	h := startHost(t, nil)
	c := h.dial()
	if c.hello.Host.Proto != chatproto.Proto || c.hello.Host.PID != os.Getpid() || c.hello.Host.Version != agentproto.Version {
		t.Errorf("hello %+v", c.hello)
	}
	c.conn.Close()
	for _, tc := range []struct {
		line, code string
	}{
		{"not json\n", chatproto.CodeBadRequest},
		{`{"op":"nope"}` + "\n", chatproto.CodeBadRequest},
		{`{"op":"attach","chat":"cffffffffffffffff"}` + "\n", chatproto.CodeUnknownChat},
		{`{"op":"close","chat":"../x"}` + "\n", chatproto.CodeUnknownChat},
		{`{"op":"configure"}` + "\n", chatproto.CodeBadRequest},
	} {
		c := h.dial()
		c.conn.Write([]byte(tc.line))
		var res chatproto.Response
		c.read(&res)
		if res.OK || res.Error == nil || res.Error.Code != tc.code {
			t.Errorf("%s: %+v", strings.TrimSpace(tc.line), res.Error)
		}
		c.ended()
	}
}

// The socket is the user's alone, a second host finds the first, a socket
// nobody answers on is replaced, the journal is private, and the socket
// goes with the host.
func TestSocketAndFiles(t *testing.T) {
	h := startHost(t, nil)
	st, err := os.Lstat(h.sock)
	if err != nil || st.Mode()&os.ModeSocket == 0 || st.Mode().Perm() != 0o600 {
		t.Fatalf("socket %v %v", st.Mode(), err)
	}
	for path, mode := range map[string]os.FileMode{h.base: 0o700, store.HostFile(h.base, DBName): 0o600} {
		if st, err := os.Stat(path); err != nil {
			t.Error(err)
		} else if st.Mode().Perm() != mode {
			t.Errorf("%s: %v, want %v", path, st.Mode().Perm(), mode)
		}
	}
	err = Serve(context.Background(), Options{Base: h.base, Run: h.run})
	if !errors.Is(err, ErrRunning) {
		t.Errorf("a second host: %v", err)
	}
	h.stop()
	h.wait()
	if _, err := os.Lstat(h.sock); !os.IsNotExist(err) {
		t.Errorf("the socket outlived the host: %v", err)
	}

	// A socket nobody listens on is replaced.
	ln, err := net.Listen("unix", h.sock)
	if err != nil {
		t.Fatal(err)
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	ln.Close()
	h.serve()

	// Another file in the way is not.
	h.stop()
	h.wait()
	os.WriteFile(h.sock, nil, 0o600)
	if err := Serve(context.Background(), Options{Base: h.base, Run: h.run}); err == nil || !strings.Contains(err.Error(), "not a socket") {
		t.Errorf("a file in the socket's place: %v", err)
	}
}

// The run directory must be the user's alone, and the directories
// absolute.
func TestRunDirectory(t *testing.T) {
	dir := runDir(t)
	os.Chmod(dir, 0o755)
	if err := Serve(context.Background(), Options{Base: t.TempDir(), Run: dir}); err == nil || !strings.Contains(err.Error(), "0700") {
		t.Errorf("a run directory others can read: %v", err)
	}
	if err := Serve(context.Background(), Options{Base: "rel", Run: dir}); err == nil {
		t.Error("a relative base")
	}
}

// agents tells which kinds can start: by their Chat spec, their adapter
// and the PATH of the user's environment.
func TestAgents(t *testing.T) {
	h := startHost(t, nil)
	res := h.ok(chatproto.Request{Op: chatproto.OpAgents, Kinds: []string{fakeKind, "missing", "noadapter", "nochat"}})
	want := []chatproto.AgentStatus{{Kind: fakeKind, Available: true}, {Kind: "missing", Reason: chatproto.ReasonNotFound},
		{Kind: "noadapter", Reason: chatproto.ReasonUnsupported}, {Kind: "nochat", Reason: chatproto.ReasonUnsupported}}
	if len(res.Agents) != len(want) {
		t.Fatalf("agents %+v", res.Agents)
	}
	for i := range want {
		if res.Agents[i] != want[i] {
			t.Errorf("agent %d: %+v, want %+v", i, res.Agents[i], want[i])
		}
	}
	h.refused(chatproto.Request{Op: chatproto.OpAgents, Kinds: make([]string, maxKinds+1)}, chatproto.CodeBadRequest)
}

// The agent is found in the PATH of the login shell's environment, not
// the host's.
func TestAgentsInTheLoginShellsPath(t *testing.T) {
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "no-such-agent-program-x"), []byte("#!/bin/sh\n"), 0o755)
	h := startHost(t, func(h *testHost) {
		h.o.environ = func(context.Context) []string { return []string{"PATH=" + bin, "HOME=" + os.Getenv("HOME")} }
	})
	res := h.ok(chatproto.Request{Op: chatproto.OpAgents, Kinds: []string{"missing"}})
	if !res.Agents[0].Available {
		t.Errorf("not found in the login PATH: %+v", res.Agents[0])
	}
}

// new checks the kind, the directory, the session and the options.
func TestNewChecks(t *testing.T) {
	h := startHost(t, nil)
	file := filepath.Join(h.cwd, "file")
	os.WriteFile(file, nil, 0o600)
	for _, tc := range []struct {
		name string
		req  chatproto.Request
		code string
	}{
		{"no kind", chatproto.Request{Cwd: h.cwd}, chatproto.CodeUnsupported},
		{"kind without chat", chatproto.Request{Kind: "nochat", Cwd: h.cwd}, chatproto.CodeUnsupported},
		{"no adapter", chatproto.Request{Kind: "noadapter", Cwd: h.cwd}, chatproto.CodeUnsupported},
		{"relative cwd", chatproto.Request{Kind: fakeKind, Cwd: "work"}, chatproto.CodeBadRequest},
		{"unclean cwd", chatproto.Request{Kind: fakeKind, Cwd: h.cwd + "/../" + filepath.Base(h.cwd)}, chatproto.CodeBadRequest},
		{"missing cwd", chatproto.Request{Kind: fakeKind, Cwd: filepath.Join(h.cwd, "gone")}, chatproto.CodeBadRequest},
		{"file cwd", chatproto.Request{Kind: fakeKind, Cwd: file}, chatproto.CodeBadRequest},
		{"no cwd", chatproto.Request{Kind: fakeKind}, chatproto.CodeBadRequest},
		{"option resume", chatproto.Request{Kind: fakeKind, Cwd: h.cwd, Resume: "--dangerous"}, chatproto.CodeBadRequest},
		{"spaced resume", chatproto.Request{Kind: fakeKind, Cwd: h.cwd, Resume: "a b"}, chatproto.CodeBadRequest},
		{"import without resume", chatproto.Request{Kind: fakeKind, Cwd: h.cwd, Import: true}, chatproto.CodeBadRequest},
		{"mode", chatproto.Request{Kind: fakeKind, Cwd: h.cwd, Options: &chatproto.Options{Mode: "yolo"}}, chatproto.CodeBadRequest},
		{"model", chatproto.Request{Kind: fakeKind, Cwd: h.cwd, Options: &chatproto.Options{Model: "a\nb"}}, chatproto.CodeBadRequest},
	} {
		tc.req.Op = chatproto.OpNew
		if res := h.do(tc.req); res.OK || res.Error == nil || res.Error.Code != tc.code {
			t.Errorf("%s: %+v, want %s", tc.name, res.Error, tc.code)
		}
	}
	if n := len(h.chats()); n != 0 {
		t.Errorf("%d chats made", n)
	}
}

// A chat starts its agent with what the machine decides: the spec's
// program resolved in the user's PATH, the user's environment without the
// variables of terminals, ssh and agents' sessions, the options asked for
// and the settings' default mode.
func TestNewChatStartsTheAgent(t *testing.T) {
	h := startHost(t, func(h *testHost) {
		h.o.environ = func(context.Context) []string {
			return append(os.Environ(), "HC_TERMINAL_ID=t9", "HC_SCOPE=scope", "SSH_CONNECTION=x", "CLAUDECODE=1", "KEEP_ME=1")
		}
	})
	chat := h.create(chatproto.Request{Options: &chatproto.Options{Model: "large"}})
	s := h.attach(chat.ID, 0)
	s.session = h.fake.session(t)
	events := s.until(isKind("state:idle"))
	if got := kinds(events); got != "info state:idle" {
		t.Errorf("events %s", got)
	}
	info := events[0].Chat
	if info == nil || info.SessionID == "" || info.AgentVersion != "fake 1" || !info.Capabilities.Images || len(info.Config) != 1 {
		t.Fatalf("info %+v", info)
	}
	p := h.fake.lastStart(t)
	exe := testExecutable(t)
	if p.Kind != fakeKind || len(p.Argv) != 2 || p.Argv[0] != exe || p.Argv[1] != "--fake" || p.Cwd != h.cwd || p.Resume != "" {
		t.Errorf("start %+v", p)
	}
	if p.SessionID != info.SessionID || len(p.SessionID) != 36 {
		t.Errorf("session id %q, chat's %q", p.SessionID, info.SessionID)
	}
	if p.Options.Model != "large" || p.Options.Mode != chatproto.ModeDefault || p.Client.Name == "" || p.Settings.MaxLive == 0 {
		t.Errorf("options %+v, client %+v", p.Options, p.Client)
	}
	env := map[string]string{}
	for _, kv := range p.Env {
		k, v, _ := strings.Cut(kv, "=")
		env[k] = v
	}
	for _, k := range []string{"HC_TERMINAL_ID", "SSH_CONNECTION", "CLAUDECODE"} {
		if _, ok := env[k]; ok {
			t.Errorf("%s passed on", k)
		}
	}
	if env["HC_SCOPE"] != "scope" || env["KEEP_ME"] != "1" || env["FAKE_SPEC_VAR"] != "spec" || env["PWD"] != h.cwd {
		t.Errorf("env lacks what it needs: %v", env)
	}
	if c := h.chat(chat.ID); c.State != chatproto.StateIdle || c.Status != chatproto.StatusIdle || c.Seq != s.last {
		t.Errorf("chat %+v", c)
	}
}

// A turn: the user's message, the agent's events, live increments only to
// who is attached, the end; the chat is done until the user saw it.
func TestPromptTurn(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.prompt("hello there\nsecond line")
	s.session.expect(t, "prompt:hello there\nsecond line")
	events := s.expect("user", "state:working", "info", "turn:start")
	if events[0].ClientID != "u-hello there\nsecond line" || len(events[0].Content) != 1 {
		t.Errorf("user %s", events[0].raw)
	}
	if events[2].Chat.Title != "hello there" {
		t.Errorf("title %q", events[2].Chat.Title)
	}
	s.session.stream("m1", "Hel")
	select {
	case l := <-s.lives:
		if !l.Live || l.Seq != 0 || l.Item != "m1" || l.text() != "Hel" {
			t.Errorf("live %s", l.raw)
		}
	case <-time.After(patience):
		t.Fatal("no live event")
	}
	s.session.say("m1", "Hello")
	s.session.endTurn("end_turn")
	events = s.expect("update:agent_message_chunk", "turn:end", "state:idle")
	if events[0].Item != "m1" || events[0].text() != "Hello" || events[1].StopReason != "end_turn" {
		t.Errorf("events %s / %s", events[0].raw, events[1].raw)
	}
	c := h.chat(s.chat.ID)
	if c.Status != chatproto.StatusDone || c.State != chatproto.StateIdle {
		t.Fatalf("after the turn: %s %s", c.State, c.Status)
	}
	h.ok(chatproto.Request{Op: chatproto.OpSeen, Chat: c.ID, Seq: events[1].Seq - 1})
	if c := h.chat(c.ID); c.Status != chatproto.StatusDone || c.Seen != events[1].Seq-1 {
		t.Errorf("seen before the end: %s %d", c.Status, c.Seen)
	}
	h.ok(chatproto.Request{Op: chatproto.OpSeen, Chat: c.ID, Seq: 1 << 40})
	if c := h.chat(c.ID); c.Status != chatproto.StatusIdle || c.Seen != c.Seq {
		t.Errorf("seen: %s %d of %d", c.Status, c.Seen, c.Seq)
	}
	h.refused(chatproto.Request{Op: chatproto.OpSeen, Chat: "cffffffffffffffff"}, chatproto.CodeUnknownChat)

	// A message while the turn runs goes to the agent, which queues it.
	s.turn("first")
	s.prompt("second")
	s.session.expect(t, "prompt:second")
	q := s.expect("queued:queued")[0]
	if q.Message == "" || q.ClientID != "u-second" {
		t.Errorf("queued %s", q.raw)
	}
	s.must(chatproto.Command{Op: chatproto.OpCancelQueued, Message: q.Message})
	s.session.expect(t, "cancel_queued:"+q.Message)
	// Cancel: the agent is told, and ends the turn.
	s.must(chatproto.Command{Op: chatproto.OpCancel})
	s.session.expect(t, "cancel")
	s.expect("turn:end", "state:idle")
	// Nothing to cancel.
	s.must(chatproto.Command{Op: chatproto.OpCancel})
}

// A prompt is checked before it reaches the agent.
func TestPromptChecks(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	big := strings.Repeat("x", chatproto.MaxPrompt)
	image := func(n int) json.RawMessage {
		b, _ := json.Marshal(map[string]string{"type": "image", "mimeType": "image/png", "data": b64(n)})
		return b
	}
	for _, tc := range []struct {
		name    string
		content []json.RawMessage
		code    string
	}{
		{"none", nil, chatproto.CodeBadRequest},
		{"not a block", []json.RawMessage{json.RawMessage(`"text"`)}, chatproto.CodeBadRequest},
		{"other type", []json.RawMessage{json.RawMessage(`{"type":"audio","data":""}`)}, chatproto.CodeBadRequest},
		{"text without text", []json.RawMessage{json.RawMessage(`{"type":"text"}`)}, chatproto.CodeBadRequest},
		{"too long", []json.RawMessage{textBlock(big)}, chatproto.CodeTooLarge},
		{"image too large", []json.RawMessage{image(chatproto.MaxImage + 1)}, chatproto.CodeTooLarge},
		{"image not base64", []json.RawMessage{json.RawMessage(`{"type":"image","mimeType":"image/png","data":"!!"}`)}, chatproto.CodeBadRequest},
		{"image no type", []json.RawMessage{json.RawMessage(`{"type":"image","mimeType":"text/plain","data":"aGk="}`)}, chatproto.CodeBadRequest},
		{"link without uri", []json.RawMessage{json.RawMessage(`{"type":"resource_link","name":"a"}`)}, chatproto.CodeBadRequest},
	} {
		if e := s.command(chatproto.Command{Op: chatproto.OpPrompt, Content: tc.content}); e == nil || e.Code != tc.code {
			t.Errorf("%s: %+v, want %s", tc.name, e, tc.code)
		}
	}
	s.quiet()
	// What fits goes.
	s.must(chatproto.Command{Op: chatproto.OpPrompt, Content: []json.RawMessage{image(1000), textBlock("see"),
		json.RawMessage(`{"type":"resource_link","name":"a.go","uri":"file:///a.go"}`)}})
	s.session.expect(t, "prompt:see")
}

func b64(n int) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	// n bytes in base64: n/3*4 characters, padded.
	var b strings.Builder
	for i := 0; i < (n+2)/3*4; i++ {
		b.WriteByte(alphabet[i%64])
	}
	return b.String()
}
