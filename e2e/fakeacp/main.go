// Command fakeacp is a coding agent for the end-to-end tests: it speaks the
// Agent Client Protocol on its standard input and output as `kimi acp` does
// (design/testdata/chat/acp), deterministic and offline. The tests install
// it as `kimi` in a directory of the isolated instance's PATH, so the chat
// host runs it for the kind kimi.
//
// What it answers depends on the prompt's text:
//
//   - "permission <name>": a tool call that writes <name> in the session's
//     directory, after a session/request_permission; the file is written
//     only when the user allows it. "permission <name> when <flag>" asks
//     once the file $HOME/<flag> exists, so a test decides when.
//   - "hold": a turn that keeps working until session/cancel.
//   - anything else: "Echo #<n>: <text>", n counting the session's turns,
//     which the session keeps across processes (session/resume), so a test
//     can tell a resumed session from a new one.
//
// Sessions are files below $HOME/.fakeacp; nothing else is written but the
// files permission prompts allow.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type session struct {
	ID      string `json:"sessionId"`
	Cwd     string `json:"cwd"`
	Title   string `json:"title,omitempty"`
	Turns   int    `json:"turns"`
	Updated string `json:"updatedAt"`
}

type agent struct {
	out     *bufio.Writer
	outMu   sync.Mutex
	mu      sync.Mutex
	nextID  int
	pending map[string]chan json.RawMessage // our requests' ids → their results
	cancel  map[string]chan struct{}        // a session's running turn
	dir     string
}

func main() {
	if len(os.Args) < 2 || os.Args[1] != "acp" {
		fmt.Fprintln(os.Stderr, "usage: kimi acp (a fake agent for end-to-end tests)")
		os.Exit(2)
	}
	home, _ := os.UserHomeDir()
	a := &agent{
		out:     bufio.NewWriter(os.Stdout),
		pending: map[string]chan json.RawMessage{},
		cancel:  map[string]chan struct{}{},
		dir:     filepath.Join(home, ".fakeacp"),
	}
	if err := os.MkdirAll(a.dir, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := in.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			var m message
			if json.Unmarshal(line, &m) == nil {
				a.handle(m)
			}
		}
		if err != nil {
			return
		}
	}
}

func (a *agent) send(m message) {
	m.JSONRPC = "2.0"
	b, _ := json.Marshal(m)
	a.outMu.Lock()
	defer a.outMu.Unlock()
	a.out.Write(b)
	a.out.WriteByte('\n')
	a.out.Flush()
}

func (a *agent) reply(id json.RawMessage, result any) { a.send(message{ID: id, Result: result}) }

func (a *agent) fail(id json.RawMessage, code int, msg string) {
	a.send(message{ID: id, Error: &rpcError{Code: code, Message: msg}})
}

func (a *agent) update(sessionID string, u map[string]any) {
	p, _ := json.Marshal(map[string]any{"sessionId": sessionID, "update": u})
	a.send(message{Method: "session/update", Params: p})
}

// request sends a request of the agent's own and waits for its result.
func (a *agent) request(method string, params any, cancel <-chan struct{}) (json.RawMessage, bool) {
	a.mu.Lock()
	a.nextID++
	id := json.RawMessage(fmt.Sprint(a.nextID))
	ch := make(chan json.RawMessage, 1)
	a.pending[string(id)] = ch
	a.mu.Unlock()
	p, _ := json.Marshal(params)
	a.send(message{ID: id, Method: method, Params: p})
	select {
	case r := <-ch:
		return r, true
	case <-cancel:
		return nil, false
	}
}

func (a *agent) handle(m message) {
	if m.Method == "" { // a response to one of ours
		a.mu.Lock()
		ch := a.pending[string(m.ID)]
		delete(a.pending, string(m.ID))
		a.mu.Unlock()
		if ch != nil {
			r, _ := json.Marshal(m.Result)
			ch <- r
		}
		return
	}
	var p struct {
		SessionID string            `json:"sessionId"`
		Cwd       string            `json:"cwd"`
		ConfigID  string            `json:"configId"`
		Value     string            `json:"value"`
		Prompt    []json.RawMessage `json:"prompt"`
	}
	json.Unmarshal(m.Params, &p)
	switch m.Method {
	case "initialize":
		a.reply(m.ID, map[string]any{
			"protocolVersion": 1,
			"agentCapabilities": map[string]any{
				"loadSession":         true,
				"promptCapabilities":  map[string]any{"image": false, "audio": false, "embeddedContext": true},
				"sessionCapabilities": map[string]any{"list": map[string]any{}, "resume": map[string]any{}},
			},
			"authMethods": []any{},
			"agentInfo":   map[string]any{"name": "Fake ACP agent", "version": "1.0.0"},
		})
	case "session/new":
		s := &session{ID: fmt.Sprintf("fake-%d", time.Now().UnixNano()), Cwd: p.Cwd}
		a.save(s)
		a.reply(m.ID, map[string]any{"sessionId": s.ID, "configOptions": configOptions("default")})
	case "session/resume", "session/load":
		if _, ok := a.load(p.SessionID); !ok {
			a.fail(m.ID, -32002, "session not found")
			return
		}
		a.reply(m.ID, map[string]any{"configOptions": configOptions("default")})
	case "session/list":
		a.reply(m.ID, map[string]any{"sessions": a.list(p.Cwd)})
	case "session/set_config_option":
		mode := "default"
		if p.ConfigID == "mode" {
			mode = p.Value
		}
		a.reply(m.ID, map[string]any{"configOptions": configOptions(mode)})
	case "session/cancel":
		a.mu.Lock()
		if c := a.cancel[p.SessionID]; c != nil {
			close(c)
			delete(a.cancel, p.SessionID)
		}
		a.mu.Unlock()
	case "session/prompt":
		s, ok := a.load(p.SessionID)
		if !ok {
			a.fail(m.ID, -32002, "session not found")
			return
		}
		text := ""
		for _, raw := range p.Prompt {
			var b struct{ Type, Text string }
			json.Unmarshal(raw, &b)
			if b.Type == "text" {
				text += b.Text
			}
		}
		c := make(chan struct{})
		a.mu.Lock()
		a.cancel[s.ID] = c
		a.mu.Unlock()
		go a.turn(m.ID, s, strings.TrimSpace(text), c)
	default:
		if len(m.ID) > 0 {
			a.fail(m.ID, -32601, "method not found")
		}
	}
}

var permissionPrompt = regexp.MustCompile(`^permission ([A-Za-z0-9._-]+)(?: when ([A-Za-z0-9._-]+))?$`)

// turn answers one prompt.
func (a *agent) turn(id json.RawMessage, s *session, text string, cancel chan struct{}) {
	stop := "end_turn"
	defer func() {
		a.mu.Lock()
		if a.cancel[s.ID] == cancel {
			delete(a.cancel, s.ID)
		}
		a.mu.Unlock()
		s.Turns++
		a.save(s)
		a.reply(id, map[string]any{"stopReason": stop})
		a.update(s.ID, map[string]any{"sessionUpdate": "usage_update", "used": 1000 * (s.Turns + 1), "size": 200000})
	}()
	if s.Title == "" {
		s.Title = text
		a.update(s.ID, map[string]any{"sessionUpdate": "session_info_update", "title": text})
	}
	say := func(t string) {
		a.update(s.ID, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": t}})
	}
	switch mt := permissionPrompt.FindStringSubmatch(text); {
	case mt != nil:
		name := mt[1]
		if flag := mt[2]; flag != "" && !waitFile(filepath.Join(filepath.Dir(a.dir), flag), cancel) {
			stop = "cancelled"
			return
		}
		call := fmt.Sprintf("call-%d", s.Turns+1)
		a.update(s.ID, map[string]any{"sessionUpdate": "tool_call", "toolCallId": call, "title": "Write " + name, "kind": "edit", "status": "pending",
			"rawInput": map[string]any{"path": name, "content": "written by the fake agent\n"}})
		res, ok := a.request("session/request_permission", map[string]any{
			"sessionId": s.ID,
			"toolCall":  map[string]any{"toolCallId": call, "title": "Write " + name, "kind": "edit"},
			"options": []any{
				map[string]any{"optionId": "approve_once", "name": "Approve once", "kind": "allow_once"},
				map[string]any{"optionId": "reject", "name": "Reject", "kind": "reject_once"},
			},
		}, cancel)
		if !ok {
			stop = "cancelled"
			return
		}
		var r struct {
			Outcome struct{ Outcome, OptionID string } `json:"outcome"`
		}
		json.Unmarshal(res, &r)
		if r.Outcome.Outcome != "selected" || r.Outcome.OptionID != "approve_once" {
			a.update(s.ID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": call, "status": "failed"})
			say("Permission rejected.")
			return
		}
		err := os.WriteFile(filepath.Join(s.Cwd, name), []byte("written by the fake agent\n"), 0o644)
		status := "completed"
		if err != nil {
			status = "failed"
		}
		a.update(s.ID, map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": call, "status": status,
			"content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "Wrote " + name}}}})
		say("Permission granted, wrote " + name + ".")
	case text == "hold":
		say("Holding until cancelled.")
		<-cancel
		stop = "cancelled"
	default:
		say(fmt.Sprintf("Echo #%d", s.Turns+1))
		say(": " + text)
	}
}

// waitFile waits for a file to exist; false when the turn is cancelled.
func waitFile(path string, cancel <-chan struct{}) bool {
	t := time.NewTicker(50 * time.Millisecond)
	defer t.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		select {
		case <-cancel:
			return false
		case <-t.C:
		}
	}
}

func configOptions(mode string) []any {
	return []any{
		map[string]any{"type": "select", "id": "model", "name": "Model", "category": "model", "currentValue": "fake-model",
			"options": []any{map[string]any{"value": "fake-model", "name": "Fake Model"}}},
		map[string]any{"type": "select", "id": "mode", "name": "Mode", "category": "mode", "currentValue": mode,
			"options": []any{
				map[string]any{"value": "default", "name": "Default", "description": "Manual approvals."},
				map[string]any{"value": "plan", "name": "Plan", "description": "Read-only planning."},
			}},
	}
}

var safeID = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

func (a *agent) path(id string) string { return filepath.Join(a.dir, id+".json") }

func (a *agent) save(s *session) {
	s.Updated = time.Now().UTC().Format(time.RFC3339Nano)
	b, _ := json.Marshal(s)
	os.WriteFile(a.path(s.ID), b, 0o600)
}

func (a *agent) load(id string) (*session, bool) {
	if !safeID.MatchString(id) {
		return nil, false
	}
	b, err := os.ReadFile(a.path(id))
	if err != nil {
		return nil, false
	}
	var s session
	return &s, json.Unmarshal(b, &s) == nil
}

func (a *agent) list(cwd string) []session {
	out := []session{}
	files, _ := filepath.Glob(filepath.Join(a.dir, "*.json"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		var s session
		if err == nil && json.Unmarshal(b, &s) == nil && (cwd == "" || s.Cwd == cwd) {
			out = append(out, s)
		}
	}
	return out
}
