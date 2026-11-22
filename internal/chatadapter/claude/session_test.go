//go:build unix

package claude

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

// Lines of a fake's script.
func inL(v any) scriptLine  { return scriptLine{Dir: "in", Msg: rawOf(v)} }
func outL(v any) scriptLine { return scriptLine{Dir: "out", Msg: rawOf(v)} }

type obj = map[string]any

// initLines are a start: the adapter's initialize and its answer.
func initLines(t testing.TB) []scriptLine {
	return []scriptLine{
		inL(obj{"type": "control_request", "request_id": "req_init", "request": obj{"subtype": "initialize"}}),
		outL(obj{"type": "control_response", "response": obj{"subtype": "success", "request_id": "req_init", "response": json.RawMessage(canned(t)["initialize"])}}),
	}
}

func userIn(text string) scriptLine {
	return inL(obj{"type": "user", "uuid": "u-" + text, "message": obj{"role": "user", "content": text}})
}

func stateOut(state string) scriptLine {
	return outL(obj{"type": "system", "subtype": "session_state_changed", "state": state})
}

func textOut(id, text string) scriptLine {
	return outL(obj{"type": "assistant", "message": obj{"id": id, "role": "assistant", "content": []any{obj{"type": "text", "text": text}}}, "parent_tool_use_id": nil})
}

func resultOut() scriptLine {
	return outL(obj{"type": "result", "subtype": "success", "is_error": false, "stop_reason": "end_turn", "total_cost_usd": 0.5, "terminal_reason": "completed"})
}

// start starts a session with the fake playing lines.
func start(t *testing.T, lines []scriptLine, silent []string, edit func(*chatadapter.StartParams)) (*fakeRun, *session, error) {
	t.Helper()
	sc := script{Lines: lines, Canned: canned(t), Silent: silent}
	delete(sc.Canned, "initialize")
	r := newFakeRun(t, sc)
	p := r.params()
	if edit != nil {
		edit(&p)
	}
	ss, err := Adapter{}.Start(context.Background(), p, r.sink)
	if err != nil {
		return r, nil, err
	}
	s := ss.(*session)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.Close(ctx)
	})
	return r, s, nil
}

// until waits for the signal of the script's line at, and for the
// session to have read what came before it.
func (r *fakeRun) until(s *session, at int) {
	r.t.Helper()
	for {
		sig := r.signal()
		settle(r.t, s, sig.Written)
		if sig.At == at {
			return
		}
	}
}

func (r *fakeRun) eventsOf(kind string) []chatproto.Event {
	r.sink.mu.Lock()
	defer r.sink.mu.Unlock()
	var out []chatproto.Event
	for _, ev := range r.sink.events {
		if ev.T == kind {
			out = append(out, ev)
		}
	}
	return out
}

func waitDone(t *testing.T, s *session) {
	t.Helper()
	select {
	case <-s.Done():
	case <-time.After(20 * time.Second):
		t.Fatal("the session did not end")
	}
}

// The program ending in a turn fails the turn and ends the session with
// the end of its standard error.
func TestExitMidTurn(t *testing.T) {
	lines := append(initLines(t), userIn("go"), stateOut("running"),
		outL(obj{"type": "stream_event", "event": obj{"type": "message_start", "message": obj{"id": "msg_1"}}}),
		outL(obj{"type": "stream_event", "event": obj{"type": "content_block_start", "index": 0, "content_block": obj{"type": "text", "text": ""}}}),
		outL(obj{"type": "stream_event", "event": obj{"type": "content_block_delta", "index": 0, "delta": obj{"type": "text_delta", "text": "par"}}}),
		scriptLine{Dir: "exit", Code: 1, Text: "boom: the API went away\n"})
	r, s, err := start(t, lines, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.until(s, 2)
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Content: []json.RawMessage{rawOf(obj{"type": "text", "text": "go"})}, ClientID: "c1"}); err != nil {
		t.Fatal(err)
	}
	waitDone(t, s)
	var e *chatproto.Error
	if !errors.As(s.Err(), &e) || e.Code != chatproto.CodeEnded || !strings.Contains(e.Stderr, "boom") || !strings.Contains(e.Message, "exit status 1") {
		t.Errorf("err %#v", s.Err())
	}
	turns := r.eventsOf(chatproto.EventTurn)
	if len(turns) != 2 || turns[0].State != chatproto.TurnStart || turns[1].State != chatproto.TurnError || turns[1].Error.Code != chatproto.CodeEnded || !strings.Contains(turns[1].Error.Stderr, "boom") {
		t.Errorf("turns %+v", turns)
	}
	if ups := r.eventsOf(chatproto.EventUpdate); len(ups) != 1 || !ups[0].Live || ups[0].Item != "msg_1/0" {
		t.Errorf("updates %+v", ups)
	}
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Content: []json.RawMessage{rawOf(obj{"type": "text", "text": "again"})}}); !hasCode(err, chatproto.CodeEnded) {
		t.Errorf("a prompt after the end: %v", err)
	}
	if s.PID() != 0 {
		t.Errorf("pid %d of an ended session", s.PID())
	}
}

// Lines that are no JSON objects, longer than chatproto.MaxLine, of kinds
// the adapter does not know, and keep_alive are passed over and counted;
// the session goes on.
func TestUnreadableLines(t *testing.T) {
	lines := append(initLines(t),
		scriptLine{Dir: "raw", Text: "not json"},
		scriptLine{Dir: "raw", Text: "[1,2]"},
		scriptLine{Dir: "big", N: chatproto.MaxLine + 10},
		outL(obj{"type": "keep_alive"}),
		outL(obj{"type": "novel_frame"}),
		outL(obj{"type": "system", "subtype": "novel_system"}),
		userIn("go"), stateOut("running"), textOut("msg_1", "done"), resultOut(), stateOut("idle"))
	r, s, err := start(t, lines, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.until(s, 8)
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Content: []json.RawMessage{rawOf(obj{"type": "text", "text": "go"})}}); err != nil {
		t.Fatal(err)
	}
	r.until(s, -1)
	s.mu.Lock()
	unknown := s.unknown
	s.mu.Unlock()
	if unknown != 6 {
		t.Errorf("unknown %d", unknown)
	}
	turns := r.eventsOf(chatproto.EventTurn)
	if len(turns) != 2 || turns[1].State != chatproto.TurnEnd || turns[1].StopReason != "end_turn" {
		t.Errorf("turns %+v", turns)
	}
	if ups := r.eventsOf(chatproto.EventUpdate); len(ups) != 1 || ups[0].Item != "msg_1/0" || ups[0].Live {
		t.Errorf("updates %+v", ups)
	}
	if s.PID() <= 0 {
		t.Error("no pid")
	}
}

// A control request without an answer fails after its timeout; initialize
// without one fails the start.
func TestTimeouts(t *testing.T) {
	defer func(i, r time.Duration) { initTimeout, requestTimeout = i, r }(initTimeout, requestTimeout)
	initTimeout, requestTimeout = 300*time.Millisecond, 300*time.Millisecond

	_, s, err := start(t, initLines(t), []string{"set_model"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	if err := s.SetConfig(context.Background(), optionModel, "haiku"); !hasCode(err, chatproto.CodeFailed) || time.Since(t0) > 5*time.Second {
		t.Errorf("set_model without an answer: %v after %v", err, time.Since(t0))
	}

	_, _, err = start(t, nil, []string{"initialize"}, nil)
	if !hasCode(err, chatproto.CodeStartFailed) || !strings.Contains(err.Error(), "initialize") {
		t.Errorf("initialize without an answer: %v", err)
	}
}

// Start refuses what is not a session it can run, before running anything,
// and a model initialize does not list after it.
func TestStartRefuses(t *testing.T) {
	for name, edit := range map[string]func(*chatadapter.StartParams){
		"relative program":   func(p *chatadapter.StartParams) { p.Argv = []string{"claude"} },
		"no program":         func(p *chatadapter.StartParams) { p.Argv = nil },
		"relative directory": func(p *chatadapter.StartParams) { p.Cwd = "work" },
		"no session":         func(p *chatadapter.StartParams) { p.SessionID = "" },
		"bad session":        func(p *chatadapter.StartParams) { p.SessionID = "--resume" },
		"bad mode":           func(p *chatadapter.StartParams) { p.Options.Mode = "yolo" },
		"bad model":          func(p *chatadapter.StartParams) { p.Options.Model = "--dangerously-skip-permissions" },
		"bad effort":         func(p *chatadapter.StartParams) { p.Options.Effort = "ultra" },
	} {
		r := newFakeRun(t, script{})
		p := r.params()
		edit(&p)
		if _, err := (Adapter{}).Start(context.Background(), p, r.sink); !hasCode(err, chatproto.CodeBadRequest) {
			t.Errorf("%s: %v", name, err)
		}
		if strings.TrimSpace(r.log()) != "" {
			t.Errorf("%s: the program ran", name)
		}
	}
	_, _, err := start(t, initLines(t), nil, func(p *chatadapter.StartParams) { p.Options.Model = "claude-nonesuch-1" })
	if !hasCode(err, chatproto.CodeBadRequest) {
		t.Errorf("a model not listed: %v", err)
	}
}

// The chat's options at the start: an alias pinned to the model it
// resolves to, an effort applied; the configuration and capabilities.
func TestStartOptions(t *testing.T) {
	lines := initLines(t)
	// The program started in acceptEdits says so.
	var resp map[string]any
	json.Unmarshal(lines[1].Msg, &resp)
	resp["response"].(map[string]any)["response"].(map[string]any)["current_permission_mode"] = "acceptEdits"
	lines[1].Msg = rawOf(resp)
	r, s, err := start(t, lines, nil, func(p *chatadapter.StartParams) {
		p.Options = chatproto.Options{Model: "sonnet", Effort: "low", Mode: chatproto.ModeAcceptEdits}
	})
	if err != nil {
		t.Fatal(err)
	}
	r.until(s, -1)
	quiet(t, s)
	recs := r.records()
	if !strings.Contains(strings.Join(recs[0].Argv, " "), "--model=sonnet --permission-mode=acceptEdits") {
		t.Errorf("argv %v", recs[0].Argv)
	}
	var wrote []string
	for _, rec := range recs[1:] {
		wrote = append(wrote, string(rec.Got))
	}
	all := strings.Join(wrote, "\n")
	if !strings.Contains(all, `"model":"claude-sonnet-5-5","subtype":"set_model"`) || !strings.Contains(all, `"settings":{"effortLevel":"low"},"subtype":"apply_flag_settings"`) {
		t.Errorf("wrote %s", all)
	}
	r.sink.mu.Lock()
	chat := r.sink.chat
	r.sink.mu.Unlock()
	got := map[string]string{}
	for _, c := range chat.Config {
		got[c.ID] = c.CurrentValue
	}
	if got[optionModel] != "sonnet" || got[optionEffort] != "low" || got[optionMode] != chatproto.ModeAcceptEdits {
		t.Errorf("config %v", got)
	}
	if c := chat.Capabilities; !c.Images || !c.Effort || !c.Model || !c.Queue || !c.CancelQueued || !c.Plan || !c.Questions || !c.Compact {
		t.Errorf("capabilities %+v", c)
	}
	if chat.SessionID != testSession || chat.AgentVersion != "2.1.330" || len(chat.Commands) == 0 || chat.Usage == nil || chat.Usage.Size != 1000000 {
		t.Errorf("chat %+v", chat)
	}
	// Options of the chat only.
	if err := s.SetConfig(context.Background(), optionEffort, "ultra"); !hasCode(err, chatproto.CodeBadRequest) {
		t.Errorf("an effort not listed: %v", err)
	}
	if err := s.SetConfig(context.Background(), optionModel, "claude-sonnet-5-5"); !hasCode(err, chatproto.CodeBadRequest) {
		t.Errorf("a model by an id that is no value: %v", err)
	}
	if err := s.SetConfig(context.Background(), "temperature", "1"); !hasCode(err, chatproto.CodeBadRequest) {
		t.Errorf("an unknown option: %v", err)
	}
	// A model without effort levels drops the effort to its default.
	if err := s.SetConfig(context.Background(), optionModel, "claude-haiku-4-5-20251001"); err != nil {
		t.Fatal(err)
	}
	r.sink.mu.Lock()
	chat = r.sink.chat
	r.sink.mu.Unlock()
	for _, c := range chat.Config {
		if c.ID == optionEffort {
			t.Errorf("an effort option for a model without: %+v", c)
		}
	}
	if chat.Capabilities.Effort {
		t.Error("effort capability for a model without")
	}
}

// Going into full access starts the program again with the session
// resumed and permissions skippable; out of it and back needs no restart.
// A restart is refused while a turn runs.
func TestRestartFull(t *testing.T) {
	lines := append(initLines(t), userIn("go"), stateOut("running"), textOut("msg_1", "ok"), resultOut(), stateOut("idle"))
	r, s, err := start(t, lines, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.until(s, 2)
	pid := s.PID()
	if err := s.Prompt(context.Background(), chatadapter.PromptParams{Content: []json.RawMessage{rawOf(obj{"type": "text", "text": "go"})}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetConfig(context.Background(), optionMode, chatproto.ModeFull); !hasCode(err, chatproto.CodeBusy) {
		t.Errorf("a restart in a turn: %v", err)
	}
	r.until(s, -1)
	if err := s.SetConfig(context.Background(), optionMode, chatproto.ModeFull); err != nil {
		t.Fatalf("full: %v\n%s", err, r.log())
	}
	if s.PID() == pid || s.PID() <= 0 {
		t.Errorf("pid %d after %d", s.PID(), pid)
	}
	select {
	case <-s.Done():
		t.Fatalf("the session ended: %v", s.Err())
	default:
	}
	var argvs []string
	for _, rec := range r.records() {
		if rec.Argv != nil {
			argvs = append(argvs, strings.Join(rec.Argv, " "))
		}
	}
	if len(argvs) != 2 || !strings.Contains(argvs[1], "--resume="+testSession+" --permission-mode=bypassPermissions --allow-dangerously-skip-permissions") || strings.Contains(argvs[0], "dangerously") {
		t.Errorf("argv %q", argvs)
	}
	notices := r.eventsOf(chatproto.EventNotice)
	if len(notices) != 1 || notices[0].Method != agentproto.NoticeMethod(agentproto.NoticeRestarted) || string(notices[0].Params) != `{"mode":"full"}` {
		t.Errorf("notices %+v", notices)
	}
	mode := func() string {
		r.sink.mu.Lock()
		defer r.sink.mu.Unlock()
		for _, c := range r.sink.chat.Config {
			if c.ID == optionMode {
				return c.CurrentValue
			}
		}
		return ""
	}
	if mode() != chatproto.ModeFull {
		t.Errorf("mode %s", mode())
	}
	for _, m := range []string{chatproto.ModeDefault, chatproto.ModeFull} {
		if err := s.SetConfig(context.Background(), optionMode, m); err != nil || mode() != m {
			t.Errorf("%s: %v, mode %s", m, err, mode())
		}
	}
	n := 0
	for _, rec := range r.records() {
		if rec.Argv != nil {
			n++
		}
	}
	if n != 2 {
		t.Errorf("%d runs", n)
	}
}

// Close closes the program's input, then ends its group: SIGTERM after the
// grace period when it does not exit.
func TestCloseEscalates(t *testing.T) {
	defer func(c, k time.Duration) { closeGrace, killGrace = c, k }(closeGrace, killGrace)
	closeGrace, killGrace = 200*time.Millisecond, 200*time.Millisecond
	lines := append(initLines(t),
		inL(obj{"type": "control_request", "request_id": "req_g", "request": obj{"subtype": "get_context_usage", "detail": "summary"}}),
		outL(obj{"type": "control_response", "response": obj{"subtype": "success", "request_id": "req_g", "response": json.RawMessage(canned(t)["get_context_usage"])}}),
		scriptLine{Dir: "sleep", N: 60000})
	_, s, err := start(t, lines, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(t0); d < closeGrace || d > 5*time.Second {
		t.Errorf("closed after %v", d)
	}
	if s.Err() != nil {
		t.Errorf("err after Close: %v", s.Err())
	}
}

// Prompts become the program's content: images first, one text block
// last, resource links as @ mentions; what is no prompt is refused.
func TestClaudeContent(t *testing.T) {
	blocks := []json.RawMessage{
		rawOf(obj{"type": "text", "text": "look at"}),
		rawOf(obj{"type": "resource_link", "uri": "file:///work/src/a.go", "name": "a.go"}),
		rawOf(obj{"type": "resource_link", "uri": "file:///elsewhere/my%20file.txt", "name": "f"}),
		rawOf(obj{"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="}),
		rawOf(obj{"type": "text", "text": "and say why"}),
		rawOf(obj{"type": "resource", "resource": obj{"uri": "mem://x", "text": "notes"}}),
	}
	got, err := claudeContent(blocks, "/work")
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"source":{"data":"iVBORw0KGgo=","media_type":"image/png","type":"base64"},"type":"image"},{"text":"look at @src/a.go @\"/elsewhere/my file.txt\" and say why\n\nnotes","type":"text"}]`
	if string(rawOf(got)) != want {
		t.Errorf("content\n got  %s\n want %s", rawOf(got), want)
	}
	for name, b := range map[string]obj{
		"svg":         {"type": "image", "mimeType": "image/svg+xml", "data": "PHN2Zz4="},
		"not base64":  {"type": "image", "mimeType": "image/png", "data": "@@@"},
		"no data":     {"type": "image", "mimeType": "image/png"},
		"audio":       {"type": "audio", "mimeType": "audio/wav", "data": "AAAA"},
		"no uri":      {"type": "resource_link"},
		"blob":        {"type": "resource", "resource": obj{"uri": "x", "mimeType": "application/pdf", "blob": "AAAA"}},
		"empty":       {"type": "text", "text": ""},
		"no resource": {"type": "resource"},
	} {
		if _, err := claudeContent([]json.RawMessage{rawOf(b)}, "/work"); !hasCode(err, chatproto.CodeBadRequest) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := claudeContent([]json.RawMessage{json.RawMessage(`"text"`)}, "/work"); !hasCode(err, chatproto.CodeBadRequest) {
		t.Errorf("a block that is no object: %v", err)
	}
}

// "Allow for this session" sends only the addRules suggestions, their
// destination the session.
func TestSessionRules(t *testing.T) {
	in := []json.RawMessage{
		rawOf(obj{"type": "addRules", "rules": []any{obj{"toolName": "Bash", "ruleContent": "touch a"}}, "behavior": "allow", "destination": "localSettings"}),
		rawOf(obj{"type": "addDirectories", "directories": []any{"/work"}, "destination": "session"}),
		rawOf(obj{"type": "setMode", "mode": "acceptEdits", "destination": "session"}),
		rawOf(obj{"type": "addRules", "rules": []any{obj{"toolName": "Bash"}}, "behavior": "deny", "destination": "userSettings"}),
		json.RawMessage(`42`),
	}
	got := sessionRules(in)
	if len(got) != 1 || string(got[0]) != `{"behavior":"allow","destination":"session","rules":[{"ruleContent":"touch a","toolName":"Bash"}],"type":"addRules"}` {
		t.Errorf("rules %s", rawOf(got))
	}
	if sessionRules(in[1:3]) != nil {
		t.Error("rules without addRules")
	}
	for tool, kind := range map[string]string{"Bash": chatproto.PermissionCommand, "Write": chatproto.PermissionFile, "mcp__x__y": chatproto.PermissionMCP, "WebFetch": chatproto.PermissionTool} {
		if permissionKind(tool) != kind {
			t.Errorf("%s: %s", tool, permissionKind(tool))
		}
	}
}

// The program's requests the adapter does not serve are answered: an
// elicitation declined, others refused; a request it cancels is not
// answered.
func TestProgramRequests(t *testing.T) {
	lines := append(initLines(t),
		outL(obj{"type": "control_request", "request_id": "cli-1", "request": obj{"subtype": "elicitation", "mcp_server_name": "x", "message": "token?"}}),
		inL(obj{"type": "control_response", "response": obj{"subtype": "success", "request_id": "cli-1", "response": obj{"action": "decline"}}}),
		outL(obj{"type": "control_request", "request_id": "cli-2", "request": obj{"subtype": "hook_callback", "callback_id": "h"}}),
		outL(obj{"type": "control_request", "request_id": "cli-3", "request": obj{"subtype": "can_use_tool", "tool_name": "Bash", "tool_use_id": "toolu_x", "input": obj{"command": "rm -rf /"}}}),
		outL(obj{"type": "control_cancel_request", "request_id": "cli-3"}),
		scriptLine{Dir: "sleep", N: 200})
	r, s, err := start(t, lines, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.until(s, -1)
	time.Sleep(200 * time.Millisecond)
	if err := s.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	var answers []string
	for _, rec := range r.records() {
		if strings.Contains(string(rec.Got), "control_response") {
			answers = append(answers, string(rec.Got))
		}
	}
	all := strings.Join(answers, "\n")
	if !strings.Contains(all, `"request_id":"cli-2","error":"Unsupported control request subtype: hook_callback"`) || strings.Contains(all, "cli-3") || len(answers) != 2 {
		t.Errorf("answers:\n%s", all)
	}
	r.sink.mu.Lock()
	defer r.sink.mu.Unlock()
	if len(r.sink.perms) != 1 || r.sink.perms[0].Kind != chatproto.PermissionCommand {
		t.Errorf("permissions %+v", r.sink.perms)
	}
}

// The host's view of the turn is a moment behind: a prompt it did not
// record (it saw a turn run) that finds the turn ended starts the next one
// with its EventUser; a prompt it recorded that finds a turn running is
// queued under its client id.
func TestPromptRecorded(t *testing.T) {
	lines := append(initLines(t), userIn("one"), stateOut("running"), textOut("msg_1", "first"), resultOut(), stateOut("idle"),
		userIn("two"), stateOut("running"), userIn("three"), textOut("msg_2", "second"), resultOut(), stateOut("idle"))
	r, s, err := start(t, lines, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	prompt := func(text string, recorded bool) {
		t.Helper()
		if err := s.Prompt(context.Background(), chatadapter.PromptParams{Content: []json.RawMessage{rawOf(obj{"type": "text", "text": text})},
			Message: "m-" + text, ClientID: "c-" + text, Recorded: recorded}); err != nil {
			t.Fatal(err)
		}
	}
	r.until(s, 2)
	prompt("one", true)
	// The turn ends between the host's look and the prompt.
	r.until(s, 7)
	prompt("two", false)
	r.until(s, 9)
	prompt("three", true)
	r.until(s, -1)

	r.sink.mu.Lock()
	var got []string
	for _, ev := range r.sink.events {
		switch ev.T {
		case chatproto.EventUser:
			got = append(got, "user:"+ev.ClientID)
		case chatproto.EventQueued:
			got = append(got, "queued:"+ev.State+":"+ev.ClientID)
		case chatproto.EventTurn:
			got = append(got, "turn:"+ev.State)
		}
	}
	r.sink.mu.Unlock()
	want := "turn:start turn:end user:c-two turn:start queued:queued:c-three turn:end"
	if strings.Join(got, " ") != want {
		t.Errorf("events %s\nwant   %s", strings.Join(got, " "), want)
	}
}
