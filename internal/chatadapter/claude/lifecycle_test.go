//go:build unix

package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

// shortGraces makes a run's waits short for a test.
func shortGraces(t *testing.T, close, kill time.Duration) {
	t.Helper()
	c, k := closeGrace, killGrace
	closeGrace, killGrace = close, kill
	t.Cleanup(func() { closeGrace, killGrace = c, k })
}

// gonePid waits until no process has pid.
func gonePid(t *testing.T, pid int, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("process %d is still there", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// children are the pids of the processes the fake left in its group, and
// runs the pids of the fake's runs, as its log has them.
func (r *fakeRun) pids() (runs, children []int) {
	for _, rec := range r.records() {
		if rec.Pid != 0 {
			runs = append(runs, rec.Pid)
		}
		if rec.Child != 0 {
			children = append(children, rec.Child)
		}
	}
	return runs, children
}

// waitRuns waits until the fake started n times.
func (r *fakeRun) waitRuns(n int) []int {
	r.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		runs, _ := r.pids()
		if len(runs) >= n {
			return runs
		}
		if time.Now().After(deadline) {
			r.t.Fatalf("%d runs, not %d; the log:\n%s", len(runs), n, r.log())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A program that exits leaves a process in its group that ignores SIGTERM
// and holds its output and standard error: the group is swept (SIGTERM,
// then SIGKILL), and the session ends at once with the program's error.
func TestGroupSweptAfterExit(t *testing.T) {
	shortGraces(t, 5*time.Second, 300*time.Millisecond)
	lines := append(initLines(t), scriptLine{Dir: "spawn", Text: "stubborn"}, scriptLine{Dir: "exit", Code: 2, Text: "boom\n"})
	r, s, err := start(t, lines, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	select {
	case <-s.Done():
	case <-time.After(5 * time.Second):
		t.Fatalf("the session did not end; the log:\n%s", r.log())
	}
	if d := time.Since(t0); d > 4*time.Second {
		t.Errorf("ended after %v", d)
	}
	_, children := r.pids()
	if len(children) != 1 {
		t.Fatalf("children %v", children)
	}
	gonePid(t, children[0], 5*time.Second)
	var e *chatproto.Error
	if !errors.As(s.Err(), &e) || e.Code != chatproto.CodeEnded || !strings.Contains(e.Message, "exit status 2") || !strings.Contains(e.Stderr, "boom") {
		t.Errorf("err %#v", s.Err())
	}
}

// Close ends a program whose group holds on: the program exits as its
// input ends, and what it left in its group goes then, without waiting
// for the close's grace.
func TestGroupSweptAfterClose(t *testing.T) {
	shortGraces(t, 5*time.Second, 300*time.Millisecond)
	lines := append(initLines(t), scriptLine{Dir: "spawn", Text: "stubborn"})
	r, s, err := start(t, lines, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.until(s, -1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	t0 := time.Now()
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(t0); d > 3*time.Second {
		t.Errorf("closed after %v (the close's grace is %v)", d, closeGrace)
	}
	if s.Err() != nil {
		t.Errorf("err after Close: %v", s.Err())
	}
	_, children := r.pids()
	if len(children) != 1 {
		t.Fatalf("children %v", children)
	}
	gonePid(t, children[0], 5*time.Second)
}

// fullScript has the runs that go into full access play lines instead.
func fullScript(t *testing.T, r *fakeRun, sc script) func(*chatadapter.StartParams) {
	t.Helper()
	file := filepath.Join(r.dir, "full.json")
	if err := os.WriteFile(file, rawOf(sc), 0o600); err != nil {
		t.Fatal(err)
	}
	return func(p *chatadapter.StartParams) { p.Env = append(p.Env, "FAKE_CLAUDE_FULL_SCRIPT="+file) }
}

// startWith starts a session with the fake playing lines, after edit,
// which may know the run.
func startWith(t *testing.T, lines []scriptLine, edit func(r *fakeRun, p *chatadapter.StartParams)) (*fakeRun, *session) {
	t.Helper()
	sc := script{Lines: lines, Canned: canned(t)}
	delete(sc.Canned, "initialize")
	r := newFakeRun(t, sc)
	p := r.params()
	if edit != nil {
		edit(r, &p)
	}
	ss, err := Adapter{}.Start(context.Background(), p, r.sink)
	if err != nil {
		t.Fatalf("start: %v\n%s", err, r.log())
	}
	s := ss.(*session)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.Close(ctx)
	})
	return r, s
}

// Close while a restart into full access waits for its new program's
// initialize calls the restart off: Close returns, the new program is
// gone, the session ended.
func TestCloseDuringRestart(t *testing.T) {
	sc := script{Canned: canned(t), Silent: []string{"initialize"}}
	r, s := startWith(t, initLines(t), func(r *fakeRun, p *chatadapter.StartParams) { fullScript(t, r, sc)(p) })
	r.until(s, -1)
	setDone := make(chan error, 1)
	go func() { setDone <- s.SetConfig(context.Background(), optionMode, chatproto.ModeFull) }()
	runs := r.waitRuns(2)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}
	select {
	case err := <-setDone:
		if err == nil {
			t.Error("the restart went on after Close")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the restart did not end")
	}
	select {
	case <-s.Done():
	default:
		t.Error("the session did not end")
	}
	if s.Err() != nil {
		t.Errorf("err after Close: %v", s.Err())
	}
	gonePid(t, runs[1], 5*time.Second)
}

// Close once a restart's new program is up, before the session took it:
// the restart stops it and the session ends. Meanwhile the session tells
// no process: the old program exited.
func TestCloseAfterRestartLaunch(t *testing.T) {
	sc := script{Lines: initLines(t), Canned: canned(t)}
	delete(sc.Canned, "initialize")
	r, s := startWith(t, initLines(t), func(r *fakeRun, p *chatadapter.StartParams) { fullScript(t, r, sc)(p) })
	r.until(s, -1)
	pidBetween := -1
	closed := make(chan error, 1)
	afterRestartLaunch = func(s *session) {
		pidBetween = s.PID()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		go func() {
			defer cancel()
			closed <- s.Close(ctx)
		}()
		for !s.isClosing() {
			time.Sleep(time.Millisecond)
		}
	}
	defer func() { afterRestartLaunch = nil }()
	if err := s.SetConfig(context.Background(), optionMode, chatproto.ModeFull); err == nil {
		t.Error("the restart went on after Close")
	}
	select {
	case err := <-closed:
		if err != nil {
			t.Errorf("close: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Close did not return")
	}
	if pidBetween != 0 {
		t.Errorf("pid %d while no program ran", pidBetween)
	}
	runs := r.waitRuns(2)
	gonePid(t, runs[1], 5*time.Second)
	select {
	case <-s.Done():
	default:
		t.Error("the session did not end")
	}
	if s.PID() != 0 {
		t.Errorf("pid %d of an ended session", s.PID())
	}
}

// A run whose program exited tells no process, while what it left in its
// group is still being ended.
func TestPIDAfterExit(t *testing.T) {
	shortGraces(t, 5*time.Second, 2*time.Second)
	lines := append(initLines(t), scriptLine{Dir: "spawn", Text: "stubborn"}, userIn("go"), scriptLine{Dir: "exit", Code: 1})
	r, s, err := start(t, lines, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.until(s, 3)
	s.mu.Lock()
	pr := s.proc
	s.mu.Unlock()
	if s.PID() != pr.cmd.Process.Pid {
		t.Fatalf("pid %d, the program's %d", s.PID(), pr.cmd.Process.Pid)
	}
	s.Prompt(context.Background(), chatadapter.PromptParams{Content: []json.RawMessage{rawOf(obj{"type": "text", "text": "go"})}})
	<-pr.exited
	select {
	case <-s.Done():
		t.Fatal("the session ended before its group was gone")
	default:
	}
	if s.PID() != 0 {
		t.Errorf("pid %d of a program that exited", s.PID())
	}
	waitDone(t, s)
}

// writeConfig writes Claude Code's global configuration at file.
func writeConfig(t *testing.T, file, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// A folder is trusted by Claude Code when its global configuration says
// the user accepted the trust dialog for it or a folder above it; a file
// that is not there, too large or no configuration trusts nothing. The
// configuration is CLAUDE_CONFIG_DIR's when set, else the home's, a
// legacy .config.json first.
func TestTrust(t *testing.T) {
	// Claude Code names folders as getcwd has them: without links.
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(home, "src", "proj", "sub")
	if err := os.MkdirAll(work, 0o700); err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + home, "PATH=/usr/bin"}
	var logs bytes.Buffer
	logger := log.New(&logs, "", 0)
	trusts := func(env []string, dir string) bool { return trustedByClaude(env, dir, logger) }
	if trusts(env, work) {
		t.Error("trusted without a configuration")
	}
	cfg := filepath.Join(home, ".claude.json")
	writeConfig(t, cfg, `{"numStartups":3,"projects":{"`+filepath.Join(home, "src", "proj")+`":{"hasTrustDialogAccepted":true,"allowedTools":[]},"`+work+`":{"hasTrustDialogAccepted":false}}}`)
	if !trusts(env, work) || !trusts(env, filepath.Join(home, "src", "proj")) {
		t.Error("a folder below a trusted one is not trusted")
	}
	if trusts(env, filepath.Join(home, "src")) || trusts(env, home) {
		t.Error("a folder above a trusted one is trusted")
	}
	// The folder by another name (a link) is the same folder.
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(work, link); err != nil {
		t.Fatal(err)
	}
	if !trusts(env, link) {
		t.Error("a link to a trusted folder is not trusted")
	}
	writeConfig(t, cfg, `{"projects":`)
	if trusts(env, work) || !strings.Contains(logs.String(), "is no configuration") {
		t.Errorf("a malformed configuration trusts; log %q", logs.String())
	}
	f, err := os.Create(cfg)
	if err != nil {
		t.Fatal(err)
	}
	f.Truncate(maxGlobalConfig + 1)
	f.Close()
	if trusts(env, work) || !strings.Contains(logs.String(), "not read") {
		t.Errorf("an oversized configuration trusts; log %q", logs.String())
	}
	os.Remove(cfg)
	if err := os.Mkdir(cfg, 0o700); err != nil {
		t.Fatal(err)
	}
	if trusts(env, work) {
		t.Error("a configuration that is a directory trusts")
	}
	os.Remove(cfg)

	// CLAUDE_CONFIG_DIR's configuration, not the home's.
	writeConfig(t, cfg, `{"projects":{"`+work+`":{"hasTrustDialogAccepted":true}}}`)
	dir := t.TempDir()
	withDir := append(env, "CLAUDE_CONFIG_DIR="+dir)
	if trusts(withDir, work) {
		t.Error("the home's configuration was read with CLAUDE_CONFIG_DIR set")
	}
	writeConfig(t, filepath.Join(dir, ".claude.json"), `{"projects":{"`+work+`":{"hasTrustDialogAccepted":true}}}`)
	if !trusts(withDir, work) {
		t.Error("CLAUDE_CONFIG_DIR's configuration was not read")
	}
	writeConfig(t, filepath.Join(dir, ".config.json"), `{"projects":{}}`)
	if trusts(withDir, work) {
		t.Error("the legacy configuration was not read first")
	}
	// Nothing written.
	if b, _ := os.ReadFile(cfg); string(b) != `{"projects":{"`+work+`":{"hasTrustDialogAccepted":true}}}` {
		t.Errorf("the configuration changed: %s", b)
	}
}

// In a folder nobody trusted, the program starts without the project's
// own settings, once a notice says so; restarts do not tell it again. A
// folder the user trusted through the host, or Claude Code itself,
// starts with them, without a notice.
func TestUntrustedStart(t *testing.T) {
	argvs := func(r *fakeRun) []string {
		var out []string
		for _, rec := range r.records() {
			if rec.Argv != nil {
				out = append(out, strings.Join(rec.Argv, " "))
			}
		}
		return out
	}
	notices := func(r *fakeRun) []chatproto.Event {
		var out []chatproto.Event
		for _, ev := range r.eventsOf(chatproto.EventNotice) {
			if ev.Method == agentproto.NoticeMethod(agentproto.NoticeUntrustedFolder) {
				out = append(out, ev)
			}
		}
		return out
	}
	r, s, err := start(t, initLines(t), nil, func(p *chatadapter.StartParams) { p.Trusted = false })
	if err != nil {
		t.Fatal(err)
	}
	r.until(s, -1)
	if err := s.SetConfig(context.Background(), optionMode, chatproto.ModeFull); err != nil {
		t.Fatalf("full: %v\n%s", err, r.log())
	}
	a := argvs(r)
	if len(a) != 2 {
		t.Fatalf("argv %q", a)
	}
	for _, x := range a {
		if !strings.Contains(x, " --setting-sources=user ") {
			t.Errorf("argv %q", x)
		}
	}
	if n := notices(r); len(n) != 1 || string(n[0].Params) != string(rawOf(map[string]string{"cwd": r.dir})) {
		t.Errorf("notices %+v", n)
	}

	for name, edit := range map[string]func(*chatadapter.StartParams){
		"the host's": func(p *chatadapter.StartParams) { p.Trusted = true },
		"Claude Code's": func(p *chatadapter.StartParams) {
			p.Trusted = false
			cfgDir := t.TempDir()
			writeConfig(t, filepath.Join(cfgDir, ".claude.json"), `{"projects":{"`+filepath.Dir(p.Cwd)+`":{"hasTrustDialogAccepted":true}}}`)
			p.Env = append(p.Env, "CLAUDE_CONFIG_DIR="+cfgDir)
		},
	} {
		r, s, err := start(t, initLines(t), nil, edit)
		if err != nil {
			t.Fatal(err)
		}
		r.until(s, -1)
		quiet(t, s)
		if a := argvs(r); len(a) != 1 || !strings.Contains(a[0], " --setting-sources=user,project,local ") {
			t.Errorf("%s trust: argv %q", name, a)
		}
		if n := notices(r); len(n) != 0 {
			t.Errorf("%s trust: notices %+v", name, n)
		}
	}
}

// The mode option's full access is marked as such.
func TestFullValue(t *testing.T) {
	r, s, err := start(t, initLines(t), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.until(s, -1)
	quiet(t, s)
	r.sink.mu.Lock()
	defer r.sink.mu.Unlock()
	found := false
	for _, o := range r.sink.chat.Config {
		for _, v := range o.Options {
			if v.Full != (o.ID == optionMode && v.Value == chatproto.ModeFull) {
				t.Errorf("%s %s: full %v", o.ID, v.Value, v.Full)
			}
			found = found || v.Full
		}
	}
	if !found {
		t.Error("no full access value")
	}
}

// Resuming a session Claude Code does not have fails as not found, with
// what it said (its words, from Claude Code 2.1.330); another failure to
// start stays start_failed.
func TestResumeNotFound(t *testing.T) {
	const missing = "7c9e6679-7425-40de-944b-e07fc1f2a1b1"
	resume := func(p *chatadapter.StartParams) { p.Resume, p.SessionID = missing, "" }
	lines := []scriptLine{
		outL(obj{"type": "result", "subtype": "error_during_execution", "is_error": true, "num_turns": 0, "session_id": missing,
			"errors": []string{"No conversation found with session ID: " + missing}}),
		{Dir: "exit", Code: 1, Text: "No conversation found with session ID: " + missing + "\n"},
	}
	_, _, err := start(t, lines, nil, resume)
	var e *chatproto.Error
	if !errors.As(err, &e) || e.Code != chatproto.CodeNotFound || !strings.Contains(e.Stderr, missing) {
		t.Errorf("err %#v", err)
	}
	_, _, err = start(t, []scriptLine{{Dir: "exit", Code: 1, Text: "something else\n"}}, nil, resume)
	if !hasCode(err, chatproto.CodeStartFailed) {
		t.Errorf("another failure: %v", err)
	}
	// A new session's start that says so is no resume.
	_, _, err = start(t, lines[1:], nil, nil)
	if !hasCode(err, chatproto.CodeStartFailed) {
		t.Errorf("a new session: %v", err)
	}
}

// The end of the standard error kept is chatproto.MaxStderr bytes, valid
// UTF-8 (a character cut at its start left out).
func TestStderrTail(t *testing.T) {
	tl := &tail{max: maxStderr}
	io.WriteString(tl, strings.Repeat("x", 3*chatproto.MaxStderr))
	// é is 2 bytes: the tail keeps its second only.
	io.WriteString(tl, "é"+strings.Repeat("y", chatproto.MaxStderr-1))
	if got := tl.String(); got != strings.Repeat("y", chatproto.MaxStderr-1) {
		t.Errorf("tail of %d bytes: %q…", len(got), got[:min(len(got), 8)])
	}
	io.WriteString(tl, "z\xff")
	if got := tl.String(); !strings.HasSuffix(got, "z\uFFFD") || len(got) > chatproto.MaxStderr+2 {
		t.Errorf("tail ends %q", got[max(len(got)-8, 0):])
	}
}
