//go:build unix

package chathost

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/chatproto"
)

// OpTrust refuses what may not be trusted: the root, the home directory and
// those above it, a directory its group may write, one below a directory
// others may write without the sticky bit, another user's, and what a
// symbolic link leads to that is any of those.
func TestTrustRefusals(t *testing.T) {
	h := startHost(t, nil)
	home, _ := os.UserHomeDir()
	dir := func(name string, mode os.FileMode) string {
		p := filepath.Join(h.cwd, name)
		if err := os.Mkdir(p, 0o700); err != nil {
			t.Fatal(err)
		}
		os.Chmod(p, mode)
		return p
	}
	group := dir("group", 0o770)
	open := dir("open", 0o777)
	below := filepath.Join(open, "below")
	os.Mkdir(below, 0o700)
	sticky := dir("sticky", 0o777|os.ModeSticky)
	safe := filepath.Join(sticky, "safe")
	os.Mkdir(safe, 0o700)
	link := filepath.Join(h.cwd, "link")
	os.Symlink(group, link)
	unsafe := []string{"/", home, filepath.Dir(home), group, below, link}
	if os.Getuid() != 0 {
		unsafe = append(unsafe, "/usr")
	}
	for _, p := range unsafe {
		e := h.refused(chatproto.Request{Op: chatproto.OpTrust, Cwd: p}, chatproto.CodeUnsafeFolder)
		if !strings.Contains(e.Message, p) {
			t.Errorf("%s: %s", p, e.Message)
		}
	}
	h.ok(chatproto.Request{Op: chatproto.OpTrust, Cwd: safe})
	var n int
	h.served().j.db.QueryRow(`SELECT COUNT(*) FROM trusted`).Scan(&n)
	if n != 1 {
		t.Errorf("%d trusted", n)
	}
}

// A trusted directory that is another one at an agent's start (another
// inode), or one that became unsafe, is trusted no more; OpUntrust takes
// back the trust that covers a directory, an ancestor's too.
func TestTrustRechecked(t *testing.T) {
	h := startHost(t, nil)
	proj := filepath.Join(h.cwd, "proj")
	sub := filepath.Join(proj, "sub")
	os.MkdirAll(sub, 0o700)
	start := func(cwd string) bool {
		t.Helper()
		h.create(chatproto.Request{Cwd: cwd})
		h.fake.session(t)
		return h.fake.lastStart(t).Trusted
	}
	h.ok(chatproto.Request{Op: chatproto.OpTrust, Cwd: proj})
	if !start(sub) {
		t.Fatal("below a trusted directory: not trusted")
	}
	// Replaced by another directory of the same path.
	os.RemoveAll(proj)
	os.MkdirAll(sub, 0o700)
	if start(sub) {
		t.Error("a directory replaced since it was trusted is trusted")
	}
	h.ok(chatproto.Request{Op: chatproto.OpTrust, Cwd: proj})
	if !start(proj) {
		t.Fatal("trusted again: not trusted")
	}
	// Others may write it now.
	os.Chmod(proj, 0o777)
	if start(proj) {
		t.Error("a directory others may write is trusted")
	}
	os.Chmod(proj, 0o700)
	if start(proj) {
		t.Error("its trust came back by itself")
	}

	h.ok(chatproto.Request{Op: chatproto.OpTrust, Cwd: proj})
	h.ok(chatproto.Request{Op: chatproto.OpTrust, Cwd: sub})
	h.refused(chatproto.Request{Op: chatproto.OpUntrust, Cwd: "relative"}, chatproto.CodeBadRequest)
	h.ok(chatproto.Request{Op: chatproto.OpUntrust, Cwd: sub})
	if start(sub) {
		t.Error("untrusted, below a directory that was trusted: trusted")
	}
	// A directory that is no more may be untrusted.
	h.ok(chatproto.Request{Op: chatproto.OpUntrust, Cwd: filepath.Join(h.cwd, "gone")})
}

// A prompt sent again with the page's id of one the chat took is answered
// OK and not sent again: while its turn runs, once queued, after the
// host's restart, and while the first one still waits for the agent's
// start (it gets that one's answer).
func TestPromptSentAgain(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	cmd := func(text string) chatproto.Command {
		return chatproto.Command{Op: chatproto.OpPrompt, Content: []json.RawMessage{textBlock(text)}, ClientID: "page-" + text}
	}
	s.must(cmd("one"))
	s.session.expect(t, "prompt:one")
	s.must(cmd("one"))
	s.must(cmd("two"))
	s.session.expect(t, "prompt:two") // queued
	s.must(cmd("two"))
	s.session.endTurn("end_turn")
	s.must(cmd("one"))
	select {
	case c := <-s.session.calls:
		t.Fatalf("sent again: %s", c)
	case <-time.After(100 * time.Millisecond):
	}
	var users int
	for _, e := range s.until(isKind("turn:end")) {
		if e.T == chatproto.EventUser {
			users++
		}
	}
	if users != 1 {
		t.Errorf("%d user events", users)
	}

	h.restart()
	h.fake.set(func(a *fakeAdapter) { a.startGate = make(chan struct{}) })
	s = h.attach(s.chat.ID, 0)
	s.must(cmd("one"))
	s.must(cmd("two"))
	h.fake.mu.Lock()
	starts := len(h.fake.starts)
	h.fake.mu.Unlock()
	if starts != 1 {
		t.Errorf("a prompt sent again started the agent: %d starts", starts)
	}

	// Two of a prompt that waits for the start: one turn, both answered.
	a := s.send(cmd("three"))
	eventually(t, "the start", func() bool {
		h.fake.mu.Lock()
		defer h.fake.mu.Unlock()
		return len(h.fake.starts) == 2
	})
	b := s.send(cmd("three"))
	time.Sleep(50 * time.Millisecond)
	close(h.fake.startGate)
	sess := h.fake.session(t)
	if e := s.ack(a); e != nil {
		t.Errorf("the first: %+v", e)
	}
	if e := s.ack(b); e != nil {
		t.Errorf("the second: %+v", e)
	}
	sess.expect(t, "prompt:three")
	select {
	case c := <-sess.calls:
		t.Fatalf("sent twice: %s", c)
	case <-time.After(100 * time.Millisecond):
	}
}

// A chat's log tells once that its agent started without the project's
// own settings; again only after a start in a trusted folder.
func TestUntrustedNoticeOnce(t *testing.T) {
	h := startHost(t, nil)
	h.fake.set(func(a *fakeAdapter) { a.untrusted = true })
	s := h.newChat()
	count := func() int {
		n := 0
		for _, e := range h.attach(s.chat.ID, 0).until(func(e event) bool { return e.Seq == h.chat(s.chat.ID).Seq }) {
			if e.kind() == notice(agentproto.NoticeUntrustedFolder) {
				n++
			}
		}
		return n
	}
	restart := func() {
		t.Helper()
		h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: s.chat.ID})
		s.prompt("go " + time.Now().String())
		s.session = h.fake.session(t)
		s.session.endTurn("end_turn")
		h.waitState(s.chat.ID, chatproto.StateIdle)
	}
	restart()
	restart()
	if n := count(); n != 1 {
		t.Errorf("told %d times", n)
	}
	h.ok(chatproto.Request{Op: chatproto.OpTrust, Cwd: h.cwd})
	restart()
	h.ok(chatproto.Request{Op: chatproto.OpUntrust, Cwd: h.cwd})
	restart()
	restart()
	if n := count(); n != 2 {
		t.Errorf("told %d times, after a trusted start", n)
	}
}

// The agent's own title of the session names the chat, unless the user
// named it.
func TestAgentTitle(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	s.turn("first prompt")
	title := func(v string) {
		s.session.sink.Update(func(c *chatproto.Chat) { c.Title = v })
	}
	title("The agent's title")
	eventually(t, "the agent's title", func() bool { return h.chat(s.chat.ID).Title == "The agent's title" })
	s.must(chatproto.Command{Op: chatproto.OpRename, Title: "Mine"})
	title("Another")
	time.Sleep(50 * time.Millisecond)
	if got := h.chat(s.chat.ID).Title; got != "Mine" {
		t.Errorf("title %q after the user's", got)
	}
	s.session.endTurn("end_turn")
	h.restart()
	s = h.attach(s.chat.ID, 0)
	s.prompt("again")
	s.session = h.fake.session(t)
	title("Yet another")
	time.Sleep(50 * time.Millisecond)
	if got := h.chat(s.chat.ID).Title; got != "Mine" {
		t.Errorf("title %q after a restart", got)
	}
}

// A mode the agent changes to by itself (a plan's approval) is the chat's
// from then on, also after the host's restart; the mode an agent starts in
// is not.
func TestAgentModeKept(t *testing.T) {
	h := startHost(t, nil)
	mode := chatproto.ConfigOption{ID: "mode", Name: "Mode", Category: chatproto.CategoryMode, Type: chatproto.ConfigSelect, CurrentValue: "default",
		Options: []chatproto.ConfigValue{{Value: "default"}, {Value: "acceptEdits"}, {Value: "plan"}}}
	h.fake.set(func(a *fakeAdapter) { a.config = append(a.config, mode) })
	chat := h.create(chatproto.Request{Options: &chatproto.Options{Mode: chatproto.ModePlan}})
	s := h.attach(chat.ID, 0)
	s.session = h.fake.session(t)
	s.until(isKind("state:idle"))
	again := func() string {
		t.Helper()
		h.ok(chatproto.Request{Op: chatproto.OpClose, Chat: chat.ID})
		s.prompt("go " + time.Now().String())
		s.session = h.fake.session(t)
		s.session.endTurn("end_turn")
		h.waitState(chat.ID, chatproto.StateIdle)
		return h.fake.lastStart(t).Options.Mode
	}
	// It started in "default" (as the fake always states): still plan.
	if m := again(); m != chatproto.ModePlan {
		t.Errorf("started again in %q", m)
	}
	s.session.sink.Update(func(c *chatproto.Chat) {
		c.Config = slices.Clone(c.Config)
		for i := range c.Config {
			if c.Config[i].ID == "mode" {
				c.Config[i].CurrentValue = chatproto.ModeAcceptEdits
			}
		}
	})
	eventually(t, "the info", func() bool {
		for _, o := range h.chat(chat.ID).Config {
			if o.ID == "mode" && o.CurrentValue == chatproto.ModeAcceptEdits {
				return true
			}
		}
		return false
	})
	if m := again(); m != chatproto.ModeAcceptEdits {
		t.Errorf("started again in %q after the agent's change", m)
	}
	h.restart()
	s = h.attach(chat.ID, 0)
	s.prompt("after the restart")
	h.fake.session(t)
	if m := h.fake.lastStart(t).Options.Mode; m != chatproto.ModeAcceptEdits {
		t.Errorf("started in %q after the host's restart", m)
	}
}

// A watcher that comes is told first the states the others were told last,
// and then what changes after them.
func TestWatchStartsWhereOthersAre(t *testing.T) {
	h := startHost(t, nil)
	s := h.newChat()
	watch := func() (*client, chatproto.Response) {
		c := h.dial()
		c.write(chatproto.Request{Op: chatproto.OpWatch})
		var res chatproto.Response
		c.read(&res)
		return c, res
	}
	a, _ := watch()
	s.turn("hi")
	s.session.endTurn("end_turn")
	var last chatproto.ChatState
	for last.Status != chatproto.StatusDone {
		a.read(&last)
	}
	// Stored events that change no state: no watcher is told.
	s.session.say("i9", "after")
	s.until(isKind("update:agent_message_chunk"))
	_, res := watch()
	if len(res.States) != 1 || res.States[0] != last {
		t.Errorf("the new watcher starts at %+v; the others were told %+v", res.States, last)
	}
}

// A host that does not end in time after it began to stop is ended by
// Options.Exit.
func TestHardExit(t *testing.T) {
	exited := make(chan int, 1)
	h := startHost(t, func(h *testHost) {
		h.o.stopDeadline = 200 * time.Millisecond
		h.o.closeGrace = 5 * time.Second
		h.o.Exit = func(code int) { exited <- code }
	})
	h.fake.set(func(a *fakeAdapter) { a.closeDelay = 1500 * time.Millisecond })
	h.newChat()
	h.stop()
	select {
	case code := <-exited:
		if code != 1 {
			t.Errorf("exit %d", code)
		}
	case <-time.After(patience):
		t.Fatal("no exit")
	}
	h.wait()
}

// The host's log file starts again past its bounds, the one before kept.
func TestLogFile(t *testing.T) {
	dir := t.TempDir()
	w, err := OpenLog(dir)
	if err != nil {
		t.Fatal(err)
	}
	l := w.(*logFile)
	l.max = 100
	for range 30 {
		w.Write([]byte("0123456789\n"))
	}
	w.Close()
	cur, _ := os.ReadFile(l.path)
	old, _ := os.ReadFile(l.old)
	if len(cur) == 0 || len(cur) > 100 || len(old) == 0 || len(old) > 100 {
		t.Errorf("%d and %d bytes", len(cur), len(old))
	}
	if st, err := os.Stat(l.path); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", err)
	}
}

// A session another process runs (a terminal's) is neither imported nor
// resumed: a new chat that would take it up is refused, and a prompt that
// would resume it, the chat left as it is.
func TestSessionInTerminal(t *testing.T) {
	h := startHost(t, nil)
	const busy = "11111111-1111-4111-8111-111111111111"
	h.fake.set(func(a *fakeAdapter) { a.running = map[string]bool{busy: true} })
	for _, imp := range []bool{false, true} {
		h.refused(chatproto.Request{Op: chatproto.OpNew, Kind: fakeKind, Cwd: h.cwd, Resume: busy, Import: imp}, chatproto.CodeInTerminal)
	}
	if n := len(h.chats()); n != 0 {
		t.Fatalf("%d chats", n)
	}
	s := h.newChat()
	s.turn("hi")
	s.session.endTurn("end_turn")
	s.must(chatproto.Command{Op: chatproto.OpHandoff})
	s.session.expect(t, "close")
	h.fake.set(func(a *fakeAdapter) { a.running[s.session.id] = true })
	s.mustNot(chatproto.Command{Op: chatproto.OpPrompt, Content: []json.RawMessage{textBlock("again")}, ClientID: "x"}, chatproto.CodeInTerminal)
	h.fake.mu.Lock()
	starts := len(h.fake.starts)
	h.fake.mu.Unlock()
	if c := h.chat(s.chat.ID); c.State != chatproto.StateSleeping || !c.HandedOff || starts != 1 {
		t.Errorf("after the refusal: %s, handed off %v, %d starts", c.State, c.HandedOff, starts)
	}
	h.fake.set(func(a *fakeAdapter) { delete(a.running, s.session.id) })
	s.prompt("again")
	h.fake.session(t).expect(t, "prompt:again")
}

// An agent that states a mode of full access as it starts is set back once
// it runs.
func TestAgentStartsInFullAccess(t *testing.T) {
	h := startHost(t, nil)
	mode := chatproto.ConfigOption{ID: "mode", Name: "Mode", Category: chatproto.CategoryMode, Type: chatproto.ConfigSelect, CurrentValue: "yolo",
		Options: []chatproto.ConfigValue{{Value: "default"}, {Value: "yolo", Full: true}}}
	h.fake.set(func(a *fakeAdapter) { a.config = append(a.config, mode) })
	s := h.newChat()
	s.session.expect(t, "set_config:mode=default")
	s.until(isKind(notice(agentproto.NoticeFullAccessOff)))
}
