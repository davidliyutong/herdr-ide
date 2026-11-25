// Command fakecodex is a Codex for the end-to-end tests: `codex app-server
// --listen stdio://` speaks Codex's app-server protocol (v2, as
// spec/vectors/chat/codex records it: JSON-RPC without the jsonrpc member)
// on its standard input and output, deterministic and offline. The tests
// install it as `codex` in a directory of the isolated instance's PATH, so
// the chat host runs it for the kind codex.
//
// What a turn does depends on the prompt's text:
//
//   - "permission <name>": a command that writes <name> in the thread's
//     directory, after item/commandExecution/requestApproval; the file is
//     written only when the user allows it.
//   - "hold": a turn that runs until turn/interrupt.
//   - anything else: "Echo #<n>: <text>", n counting the thread's turns,
//     which the thread keeps across processes (thread/resume), so a test can
//     tell a resumed thread from a new one.
//
// Threads are files below $HOME/.fakecodex; nothing else is written but
// the files the user allows. A thread started or resumed other than
// read-only and asking the user, or a turn without its policies, is what
// the chat host must never ask for: the fake writes it to
// $HOME/.fakecodex/violations, which the tests expect to be missing.
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result any             `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type thread struct {
	ID      string `json:"id"`
	Cwd     string `json:"cwd"`
	Preview string `json:"preview"`
	Turns   int    `json:"turns"`
	Created int64  `json:"createdAt"`
	Updated int64  `json:"updatedAt"`
}

type server struct {
	out     *bufio.Writer
	outMu   sync.Mutex
	mu      sync.Mutex
	nextID  int
	pending map[string]chan json.RawMessage // our requests' ids → their results
	stop    map[string]chan struct{}        // a thread's running turn
	dir     string
	home    string
}

func main() {
	if len(os.Args) < 2 || os.Args[1] != "app-server" {
		fmt.Fprintln(os.Stderr, "usage: codex app-server --listen stdio:// (a fake Codex for end-to-end tests)")
		os.Exit(2)
	}
	home, _ := os.UserHomeDir()
	s := &server{
		out:     bufio.NewWriter(os.Stdout),
		pending: map[string]chan json.RawMessage{},
		stop:    map[string]chan struct{}{},
		dir:     filepath.Join(home, ".fakecodex"),
		home:    home,
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := in.ReadBytes('\n')
		if len(strings.TrimSpace(string(line))) > 0 {
			var m message
			if json.Unmarshal(line, &m) == nil {
				s.handle(m)
			}
		}
		if err != nil {
			// The input closed: the running turns end with the process.
			return
		}
	}
}

func (s *server) send(m message) {
	b, _ := json.Marshal(m)
	s.outMu.Lock()
	defer s.outMu.Unlock()
	s.out.Write(b)
	s.out.WriteByte('\n')
	s.out.Flush()
}

func (s *server) reply(id json.RawMessage, result any) { s.send(message{ID: id, Result: result}) }

func (s *server) fail(id json.RawMessage, msg string) {
	s.send(message{ID: id, Error: &rpcError{Code: -32600, Message: msg}})
}

func (s *server) notify(method string, params any) {
	p, _ := json.Marshal(params)
	s.send(message{Method: method, Params: p})
}

// request sends a request of the app-server's own and waits for its result.
func (s *server) request(method string, params any, stop <-chan struct{}) (json.RawMessage, bool) {
	s.mu.Lock()
	id := json.RawMessage(fmt.Sprint(s.nextID))
	s.nextID++
	ch := make(chan json.RawMessage, 1)
	s.pending[string(id)] = ch
	s.mu.Unlock()
	p, _ := json.Marshal(params)
	s.send(message{ID: id, Method: method, Params: p})
	select {
	case r := <-ch:
		return r, true
	case <-stop:
		return nil, false
	}
}

// violation records what the chat host must never ask for.
func (s *server) violation(what string) {
	f, err := os.OpenFile(filepath.Join(s.dir, "violations"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err == nil {
		fmt.Fprintln(f, what)
		f.Close()
	}
}

func newID() string {
	var b [16]byte
	rand.Read(b[:])
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-7" + h[13:16] + "-8" + h[17:20] + "-" + h[20:32]
}

func (s *server) load(id string) (*thread, bool) {
	if strings.ContainsAny(id, "/.") || id == "" {
		return nil, false
	}
	b, err := os.ReadFile(filepath.Join(s.dir, id+".json"))
	if err != nil {
		return nil, false
	}
	var t thread
	if json.Unmarshal(b, &t) != nil {
		return nil, false
	}
	return &t, true
}

func (s *server) save(t *thread) {
	b, _ := json.Marshal(t)
	os.WriteFile(filepath.Join(s.dir, t.ID+".json"), b, 0o600)
}

func (s *server) threadInfo(t *thread) map[string]any {
	return map[string]any{
		"id": t.ID, "sessionId": t.ID, "preview": t.Preview, "name": nil, "cwd": t.Cwd, "ephemeral": false,
		"parentThreadId": nil, "createdAt": t.Created, "updatedAt": t.Updated, "cliVersion": "0.171.0",
		"modelProvider": "openai", "source": "vscode", "status": map[string]any{"type": "idle"}, "turns": []any{},
		"projectId": nil,
	}
}

func (s *server) threadResult(t *thread) map[string]any {
	return map[string]any{
		"thread": s.threadInfo(t), "model": "gpt-fake", "modelProvider": "openai", "reasoningEffort": "low", "cwd": t.Cwd,
		"approvalPolicy": "on-request", "approvalsReviewer": "user", "sandbox": map[string]any{"type": "readOnly", "networkAccess": false},
	}
}

// readOnly tells whether thread/start's or thread/resume's params keep the
// thread read-only and asking the user.
func readOnly(p map[string]any) bool {
	return p["sandbox"] == "read-only" && p["approvalPolicy"] == "on-request" && p["approvalsReviewer"] == "user"
}

func (s *server) handle(m message) {
	if m.Method == "" { // a response to one of ours
		s.mu.Lock()
		ch := s.pending[string(m.ID)]
		delete(s.pending, string(m.ID))
		s.mu.Unlock()
		if ch != nil {
			if m.Result == nil {
				ch <- json.RawMessage("null")
			} else {
				b, _ := json.Marshal(m.Result)
				ch <- b
			}
		}
		return
	}
	if len(m.ID) == 0 { // a notification (initialized)
		return
	}
	var p map[string]any
	json.Unmarshal(m.Params, &p)
	str := func(k string) string { v, _ := p[k].(string); return v }
	switch m.Method {
	case "initialize":
		s.reply(m.ID, map[string]any{"userAgent": "fakecodex/0.171.0 (e2e)", "codexHome": filepath.Join(s.home, ".codex"),
			"platformFamily": "unix", "platformOs": runtime.GOOS})
	case "model/list":
		s.reply(m.ID, map[string]any{"data": []any{map[string]any{
			"id": "gpt-fake", "model": "gpt-fake", "displayName": "GPT Fake", "description": "The end-to-end tests' model.",
			"hidden": false, "isDefault": true, "defaultReasoningEffort": "low", "inputModalities": []string{"text", "image"},
			"supportedReasoningEfforts": []any{
				map[string]any{"reasoningEffort": "low", "description": "Fast"},
				map[string]any{"reasoningEffort": "high", "description": "Deep"},
			},
		}}, "nextCursor": nil})
	case "account/read":
		s.reply(m.ID, map[string]any{"account": map[string]any{"type": "apiKey"}, "requiresOpenaiAuth": true})
	case "thread/start":
		if !readOnly(p) {
			s.violation("thread/start " + string(m.Params))
		}
		now := time.Now().Unix()
		t := &thread{ID: newID(), Cwd: str("cwd"), Created: now, Updated: now}
		s.save(t)
		s.reply(m.ID, s.threadResult(t))
	case "thread/resume":
		if !readOnly(p) {
			s.violation("thread/resume " + string(m.Params))
		}
		t, ok := s.load(str("threadId"))
		if !ok {
			s.fail(m.ID, "no rollout found for thread id "+str("threadId"))
			return
		}
		s.reply(m.ID, s.threadResult(t))
	case "thread/list":
		s.reply(m.ID, map[string]any{"data": s.list(p), "nextCursor": nil})
	case "thread/turns/list":
		s.reply(m.ID, map[string]any{"data": []any{}, "nextCursor": nil})
	case "turn/start":
		for _, k := range []string{"approvalPolicy", "sandboxPolicy", "collaborationMode"} {
			if p[k] == nil {
				s.violation("turn/start without " + k)
			}
		}
		if sp, _ := p["sandboxPolicy"].(map[string]any); sp != nil && sp["excludeTmpdirEnvVar"] == true {
			s.violation("turn/start with excludeTmpdirEnvVar")
		}
		s.startTurn(m.ID, p)
	case "turn/interrupt":
		s.mu.Lock()
		ch := s.stop[str("threadId")]
		delete(s.stop, str("threadId"))
		s.mu.Unlock()
		if ch != nil {
			close(ch)
		}
		s.reply(m.ID, map[string]any{})
	default:
		s.fail(m.ID, "unknown variant `"+m.Method+"`")
	}
}

func (s *server) list(p map[string]any) []any {
	entries, _ := os.ReadDir(s.dir)
	var ts []*thread
	for _, e := range entries {
		if id, ok := strings.CutSuffix(e.Name(), ".json"); ok {
			if t, ok := s.load(id); ok {
				ts = append(ts, t)
			}
		}
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i].Updated > ts[j].Updated })
	var out []any
	ids, _ := p["includedThreadIds"].([]any)
	for _, t := range ts {
		if cwd, _ := p["cwd"].(string); cwd != "" && t.Cwd != cwd {
			continue
		}
		if len(ids) > 0 && !contains(ids, t.ID) {
			continue
		}
		out = append(out, s.threadInfo(t))
	}
	if out == nil {
		out = []any{}
	}
	return out
}

func contains(ids []any, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// startTurn answers turn/start and plays the turn.
func (s *server) startTurn(id json.RawMessage, p map[string]any) {
	threadID, _ := p["threadId"].(string)
	t, ok := s.load(threadID)
	if !ok {
		s.fail(id, "thread not found: "+threadID)
		return
	}
	var text []string
	input, _ := p["input"].([]any)
	for _, in := range input {
		if b, _ := in.(map[string]any); b != nil && b["type"] == "text" {
			v, _ := b["text"].(string)
			text = append(text, v)
		}
	}
	prompt := strings.TrimSpace(strings.Join(text, " "))
	t.Turns++
	t.Updated = time.Now().Unix()
	if t.Preview == "" {
		t.Preview = prompt
	}
	s.save(t)
	turn := fmt.Sprintf("turn-%d", t.Turns)
	stop := make(chan struct{})
	s.mu.Lock()
	s.stop[threadID] = stop
	s.mu.Unlock()
	s.reply(id, map[string]any{"turn": map[string]any{"id": turn, "status": "inProgress", "items": []any{}}})
	tp := map[string]any{"threadId": threadID, "turn": map[string]any{"id": turn, "status": "inProgress", "items": []any{}}}
	s.notify("turn/started", tp)
	clientID, _ := p["clientUserMessageId"].(string)
	user := map[string]any{"type": "userMessage", "id": fmt.Sprintf("user-%d", t.Turns), "content": input, "clientId": clientID}
	s.notify("item/started", map[string]any{"threadId": threadID, "turnId": turn, "item": user})
	s.notify("item/completed", map[string]any{"threadId": threadID, "turnId": turn, "item": user})
	go func() {
		status := s.play(t, turn, prompt, stop)
		s.mu.Lock()
		if s.stop[threadID] == stop {
			delete(s.stop, threadID)
		}
		s.mu.Unlock()
		s.notify("turn/completed", map[string]any{"threadId": threadID, "turn": map[string]any{"id": turn, "status": status, "items": []any{}}})
	}()
}

// play runs a turn's items; its status.
func (s *server) play(t *thread, turn, prompt string, stop <-chan struct{}) string {
	item := func(started bool, it map[string]any) {
		m := "item/completed"
		if started {
			m = "item/started"
		}
		s.notify(m, map[string]any{"threadId": t.ID, "turnId": turn, "item": it})
	}
	say := func(text string) {
		id := fmt.Sprintf("msg-%d", t.Turns)
		item(true, map[string]any{"type": "agentMessage", "id": id, "text": "", "phase": nil})
		for _, w := range strings.SplitAfter(text, " ") {
			s.notify("item/agentMessage/delta", map[string]any{"threadId": t.ID, "turnId": turn, "itemId": id, "delta": w})
		}
		item(false, map[string]any{"type": "agentMessage", "id": id, "text": text, "phase": "final_answer"})
		s.notify("thread/tokenUsage/updated", map[string]any{"threadId": t.ID, "turnId": turn, "tokenUsage": map[string]any{
			"last":               map[string]any{"totalTokens": 1000, "inputTokens": 900, "cachedInputTokens": 0, "outputTokens": 100, "reasoningOutputTokens": 0},
			"total":              map[string]any{"totalTokens": 1000, "inputTokens": 900, "cachedInputTokens": 0, "outputTokens": 100, "reasoningOutputTokens": 0},
			"modelContextWindow": 100000,
		}})
	}
	switch {
	case prompt == "hold":
		item(true, map[string]any{"type": "reasoning", "id": fmt.Sprintf("think-%d", t.Turns), "summary": []string{}, "content": []string{}})
		<-stop
		return "interrupted"
	case strings.HasPrefix(prompt, "permission "):
		name := filepath.Base(strings.TrimSpace(strings.TrimPrefix(prompt, "permission ")))
		id := fmt.Sprintf("cmd-%d", t.Turns)
		command := fmt.Sprintf("/bin/sh -c 'echo written by the fake codex > %s'", name)
		cmd := map[string]any{"type": "commandExecution", "id": id, "command": command, "cwd": t.Cwd, "status": "inProgress",
			"commandActions": []any{}, "aggregatedOutput": nil, "exitCode": nil}
		item(true, cmd)
		res, ok := s.request("item/commandExecution/requestApproval", map[string]any{"threadId": t.ID, "turnId": turn, "itemId": id,
			"command": command, "cwd": t.Cwd, "reason": "write " + name, "startedAtMs": time.Now().UnixMilli()}, stop)
		if !ok {
			return "interrupted"
		}
		var r struct {
			Decision any `json:"decision"`
		}
		json.Unmarshal(res, &r)
		if d, _ := r.Decision.(string); d == "accept" || d == "acceptForSession" {
			os.WriteFile(filepath.Join(t.Cwd, name), []byte("written by the fake codex\n"), 0o600)
			cmd["status"], cmd["exitCode"], cmd["aggregatedOutput"] = "completed", 0, ""
			item(false, cmd)
			say("Permission granted, wrote " + name + ".")
		} else {
			if _, amended := r.Decision.(map[string]any); amended {
				s.violation("an approval with an amendment")
			}
			cmd["status"] = "declined"
			item(false, cmd)
			say("Permission rejected.")
		}
	default:
		say(fmt.Sprintf("Echo #%d: %s", t.Turns, prompt))
	}
	return "completed"
}
