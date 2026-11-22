//go:build unix

package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/chatadapter"
	"herdr-ide/internal/chatproto"
)

var update = flag.Bool("update", false, "rewrite the golden files of the replays")

const fixtureDir = "../../../design/testdata/chat/claude"

// testSession is the session id the replays run with.
const testSession = "11111111-1111-4111-8111-111111111111"

func TestMain(m *testing.M) {
	if os.Getenv("FAKE_CLAUDE_SCRIPT") != "" {
		fakeMain()
		return
	}
	// Nothing here reads a home directory; should anything, it is not the
	// user's.
	home, err := os.MkdirTemp("", "claude-home")
	if err != nil {
		panic(err)
	}
	os.Setenv("HOME", home)
	code := m.Run()
	os.RemoveAll(home)
	os.Exit(code)
}

// fixtureLine is a line of a recording.
type fixtureLine struct {
	Dir string          `json:"dir"`
	Msg json.RawMessage `json:"msg"`
}

func readFixture(t testing.TB, name string) []fixtureLine {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatal(err)
	}
	var out []fixtureLine
	for _, l := range bytes.Split(bytes.TrimSpace(b), []byte("\n")) {
		var f fixtureLine
		if err := json.Unmarshal(l, &f); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		out = append(out, f)
	}
	return out
}

// msg is a line's message decoded.
func (f fixtureLine) msg() map[string]any {
	var m map[string]any
	_ = json.Unmarshal(f.Msg, &m)
	return m
}

func (f fixtureLine) request() (id, subtype string, req map[string]any) {
	m := f.msg()
	if m["type"] != "control_request" {
		return "", "", nil
	}
	req, _ = m["request"].(map[string]any)
	id, _ = m["request_id"].(string)
	subtype, _ = req["subtype"].(string)
	return id, subtype, req
}

// canned are the answers the fake gives to the adapter's own requests:
// initialize as the recording of a start, get_context_usage as one of the
// recorded answers.
func canned(t testing.TB) map[string]json.RawMessage {
	t.Helper()
	out := map[string]json.RawMessage{}
	for _, f := range [][2]string{{"claude-01-initialize.jsonl", "initialize"}, {"claude-06-controls.jsonl", "get_context_usage"}} {
		lines := readFixture(t, f[0])
		var id string
		for _, l := range lines {
			if rid, sub, _ := l.request(); sub == f[1] && l.Dir == "in" && id == "" {
				id = rid
			}
			m := l.msg()
			if r, _ := m["response"].(map[string]any); m["type"] == "control_response" && id != "" && r["request_id"] == id {
				out[f[1]], _ = json.Marshal(r["response"])
				break
			}
		}
		if out[f[1]] == nil {
			t.Fatalf("no answer to %s in %s", f[1], f[0])
		}
	}
	return out
}

func rawOf(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// prepare makes a recording the fake's script: the adapter's own
// get_context_usage and list_models requests (and their answers) left to
// the canned answers; an answer to a request the program cancelled left
// out (the adapter sends none); a start without one gets initialize; a
// set_model names the model the alias resolves to (the adapter pins it);
// an "always allow" sends only the addRules suggestions.
func prepare(t testing.TB, lines []fixtureLine, models map[string]string) []scriptLine {
	t.Helper()
	drop := map[string]bool{}
	cancelled := map[string]bool{}
	hasInit := false
	for _, l := range lines {
		if id, sub, _ := l.request(); l.Dir == "in" && (sub == "get_context_usage" || sub == "list_models") {
			drop[id] = true
		} else if sub == "initialize" {
			hasInit = true
		}
	}
	var out []scriptLine
	if !hasInit {
		out = append(out,
			scriptLine{Dir: "in", Msg: rawOf(map[string]any{"type": "control_request", "request_id": "req_init", "request": map[string]any{"subtype": "initialize"}})},
			scriptLine{Dir: "out", Msg: rawOf(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": "req_init", "response": json.RawMessage(canned(t)["initialize"])}})})
	}
	for _, l := range lines {
		m := l.msg()
		if id, _, _ := l.request(); drop[id] {
			continue
		}
		if r, _ := m["response"].(map[string]any); m["type"] == "control_response" && drop[fmt.Sprint(r["request_id"])] {
			continue
		}
		if m["type"] == "control_cancel_request" {
			cancelled[fmt.Sprint(m["request_id"])] = true
		}
		if r, _ := m["response"].(map[string]any); l.Dir == "in" && m["type"] == "control_response" {
			if cancelled[fmt.Sprint(r["request_id"])] {
				continue
			}
			if b, _ := r["response"].(map[string]any); b != nil && b["updatedPermissions"] != nil {
				var rules []any
				for _, p := range b["updatedPermissions"].([]any) {
					if p.(map[string]any)["type"] == "addRules" {
						rules = append(rules, p)
					}
				}
				b["updatedPermissions"] = rules
				l.Msg = rawOf(m)
			}
		}
		if req, _ := m["request"].(map[string]any); m["type"] == "control_request" && req["subtype"] == "set_model" {
			if r := models[fmt.Sprint(req["model"])]; r != "" {
				req["model"] = r
				l.Msg = rawOf(m)
			}
		}
		out = append(out, scriptLine{Dir: l.Dir, Msg: l.Msg})
	}
	return out
}

// sink records what a session reports, and answers its permissions and
// questions as the recording did (by the tool call they are about); one the
// recording did not answer waits until it is cancelled.
type sink struct {
	mu        sync.Mutex
	events    []chatproto.Event
	perms     []chatadapter.PermissionRequest
	questions []chatadapter.QuestionRequest
	chat      chatproto.Chat
	permAns   map[string]chatadapter.PermissionAnswer
	questAns  map[string]chatadapter.QuestionAnswer
}

func newSink() *sink {
	return &sink{permAns: map[string]chatadapter.PermissionAnswer{}, questAns: map[string]chatadapter.QuestionAnswer{}}
}

func (s *sink) Event(ev chatproto.Event) {
	s.mu.Lock()
	s.events = append(s.events, ev)
	s.mu.Unlock()
}

func (s *sink) Update(fn func(*chatproto.Chat)) {
	s.mu.Lock()
	fn(&s.chat)
	s.mu.Unlock()
}

func toolCallID(raw json.RawMessage) string {
	var c struct {
		ID string `json:"toolCallId"`
	}
	_ = json.Unmarshal(raw, &c)
	return c.ID
}

func (s *sink) Permission(ctx context.Context, r chatadapter.PermissionRequest) (chatadapter.PermissionAnswer, error) {
	s.mu.Lock()
	s.perms = append(s.perms, r)
	a, ok := s.permAns[toolCallID(r.ToolCall)]
	s.mu.Unlock()
	if !ok {
		<-ctx.Done()
		return chatadapter.PermissionAnswer{}, ctx.Err()
	}
	return a, nil
}

func (s *sink) Question(ctx context.Context, r chatadapter.QuestionRequest) (chatadapter.QuestionAnswer, error) {
	s.mu.Lock()
	s.questions = append(s.questions, r)
	a, ok := s.questAns[toolCallID(r.ToolCall)]
	s.mu.Unlock()
	if !ok {
		<-ctx.Done()
		return chatadapter.QuestionAnswer{}, ctx.Err()
	}
	return a, nil
}

// answersOf sets the sink's answers from the recording's answers to the
// program's can_use_tool requests.
func (s *sink) answersOf(lines []fixtureLine) {
	type ask struct {
		tool, use string
		input     map[string]any
	}
	asked := map[string]ask{}
	for _, l := range lines {
		m := l.msg()
		if m["type"] == "control_cancel_request" {
			// Answered after the program cancelled it: never, by the user.
			delete(asked, fmt.Sprint(m["request_id"]))
		}
		if id, sub, req := l.request(); l.Dir == "out" && sub == "can_use_tool" {
			in, _ := req["input"].(map[string]any)
			asked[id] = ask{fmt.Sprint(req["tool_name"]), fmt.Sprint(req["tool_use_id"]), in}
		}
		r, _ := m["response"].(map[string]any)
		if l.Dir != "in" || m["type"] != "control_response" || r == nil {
			continue
		}
		q, ok := asked[fmt.Sprint(r["request_id"])]
		if !ok {
			continue
		}
		b, _ := r["response"].(map[string]any)
		allowed := b["behavior"] == "allow"
		switch q.tool {
		case "AskUserQuestion":
			if !allowed {
				s.questAns[q.use] = chatadapter.QuestionAnswer{Cancelled: true}
				continue
			}
			answers := map[string][]string{}
			in, _ := b["updatedInput"].(map[string]any)
			given, _ := in["answers"].(map[string]any)
			for i, x := range q.input["questions"].([]any) {
				if a, ok := given[fmt.Sprint(x.(map[string]any)["question"])]; ok {
					answers[fmt.Sprint(i)] = []string{fmt.Sprint(a)}
				}
			}
			s.questAns[q.use] = chatadapter.QuestionAnswer{Answers: answers}
		case "ExitPlanMode":
			opt := chatadapter.OptionRejectOnce
			if allowed {
				opt = chatadapter.PlanOption(chatproto.ModeDefault)
			}
			s.permAns[q.use] = chatadapter.PermissionAnswer{Option: opt}
		default:
			opt := chatadapter.OptionRejectOnce
			switch {
			case allowed && b["updatedPermissions"] != nil:
				opt = chatadapter.OptionAllowSession
			case allowed:
				opt = chatadapter.OptionAllowOnce
			}
			s.permAns[q.use] = chatadapter.PermissionAnswer{Option: opt}
		}
	}
}

// fakeRun is a session of the adapter with the fake.
type fakeRun struct {
	t       testing.TB
	dir     string
	sink    *sink
	signals chan signalLine
	ln      net.Listener
	logPath string
}

type signalLine struct {
	At      int `json:"at"`
	Written int `json:"written"`
}

// newFakeRun writes sc for the fake and listens for its signals.
func newFakeRun(t testing.TB, sc script) *fakeRun {
	t.Helper()
	// A short directory: unix socket paths are short on macOS.
	dir, err := os.MkdirTemp("", "cf")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if err := os.WriteFile(filepath.Join(dir, "script.json"), rawOf(sc), 0o600); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", filepath.Join(dir, "s"))
	if err != nil {
		t.Fatal(err)
	}
	r := &fakeRun{t: t, dir: dir, sink: newSink(), signals: make(chan signalLine, 1024), ln: ln, logPath: filepath.Join(dir, "log.jsonl")}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				sc := bufio.NewScanner(c)
				for sc.Scan() {
					var s signalLine
					if json.Unmarshal(sc.Bytes(), &s) == nil {
						r.signals <- s
					}
				}
			}()
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return r
}

// params are the StartParams of a run.
func (r *fakeRun) params() chatadapter.StartParams {
	exe, err := os.Executable()
	if err != nil {
		r.t.Fatal(err)
	}
	return chatadapter.StartParams{
		Kind: "claude", Argv: []string{exe}, Cwd: r.dir, SessionID: testSession,
		Env: []string{
			"HOME=" + os.Getenv("HOME"), "PATH=/usr/bin:/bin", "NODE_OPTIONS=--inspect", "KEEP_ME=1",
			"CLAUDE_CODE_ENTRYPOINT=sdk-ts",
			"FAKE_CLAUDE_SCRIPT=" + filepath.Join(r.dir, "script.json"),
			"FAKE_CLAUDE_SOCK=" + filepath.Join(r.dir, "s"),
			"FAKE_CLAUDE_LOG=" + r.logPath,
		},
		Options: chatproto.Options{Mode: chatproto.ModeDefault},
		Client:  chatadapter.ClientInfo{Name: "test", Version: "0"},
		Logger:  log.New(io.Discard, "", 0),
	}
}

// signal waits for the fake's next signal.
func (r *fakeRun) signal() signalLine {
	r.t.Helper()
	select {
	case s := <-r.signals:
		return s
	case <-time.After(20 * time.Second):
		r.t.Fatalf("no signal from the fake; its log:\n%s", r.log())
	}
	return signalLine{}
}

// settle waits until s handled n lines of the fake's.
func settle(t testing.TB, s *session, n int) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for s.lines.Load() < int64(n) {
		if time.Now().After(deadline) {
			t.Fatalf("the session read %d lines, not %d", s.lines.Load(), n)
		}
		time.Sleep(time.Millisecond)
	}
}

// quiet waits until no control request of s's waits for its answer.
func quiet(t testing.TB, s *session) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		s.mu.Lock()
		pr := s.proc
		s.mu.Unlock()
		pr.mu.Lock()
		n := len(pr.pending)
		pr.mu.Unlock()
		if n == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d requests wait", n)
		}
		time.Sleep(time.Millisecond)
	}
}

func (r *fakeRun) log() string {
	b, _ := os.ReadFile(r.logPath)
	return string(b)
}

// records are the fake's log.
func (r *fakeRun) records() []fakeRecord {
	var out []fakeRecord
	for _, l := range strings.Split(strings.TrimSpace(r.log()), "\n") {
		var rec fakeRecord
		if json.Unmarshal([]byte(l), &rec) == nil {
			out = append(out, rec)
		}
	}
	return out
}

var (
	ourID   = regexp.MustCompile(`"req_[0-9a-f]{8}_(\d+)"`)
	anyUUID = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
)

// normalizer names the random ids of a run by their order.
type normalizer map[string]string

func (n normalizer) norm(s string) string {
	s = ourID.ReplaceAllString(s, `"req_$1"`)
	return anyUUID.ReplaceAllStringFunc(s, func(u string) string {
		if strings.HasPrefix(u, "00000000-0000-4000-8000-") || u == testSession {
			return u
		}
		if _, ok := n[u]; !ok {
			n[u] = fmt.Sprintf("<uuid-%d>", len(n)+1)
		}
		return n[u]
	})
}

// golden is what a replay is checked against.
type golden struct {
	Argv        []string          `json:"argv"`
	Env         map[string]string `json:"env"`
	Events      []json.RawMessage `json:"events"`
	Permissions []json.RawMessage `json:"permissions,omitempty"`
	Questions   []json.RawMessage `json:"questions,omitempty"`
	Wrote       []json.RawMessage `json:"wrote"`
	Chat        json.RawMessage   `json:"chat"`
	Echoes      int               `json:"echoes"`
	Unknown     int               `json:"unknown"`
	Err         string            `json:"err,omitempty"`
}

// goldenOf is what a run gives, its random ids named by their order.
func goldenOf(t testing.TB, r *fakeRun, s *session) golden {
	t.Helper()
	n := normalizer{}
	var g golden
	recs := r.records()
	for _, rec := range recs {
		switch {
		case rec.Argv != nil && g.Argv == nil:
			g.Argv, g.Env = rec.Argv, rec.Env
			for i, a := range g.Argv {
				g.Argv[i] = strings.ReplaceAll(a, r.dir, "<dir>")
			}
		case rec.Got != nil:
			g.Wrote = append(g.Wrote, json.RawMessage(n.norm(string(rec.Got))))
		case rec.Mismatch != "":
			t.Errorf("the fake: %s", rec.Mismatch)
		}
	}
	r.sink.mu.Lock()
	defer r.sink.mu.Unlock()
	for _, ev := range r.sink.events {
		ev.At = time.Time{}
		g.Events = append(g.Events, json.RawMessage(n.norm(string(rawOf(ev)))))
	}
	for _, p := range r.sink.perms {
		g.Permissions = append(g.Permissions, json.RawMessage(n.norm(string(rawOf(p)))))
	}
	for _, q := range r.sink.questions {
		g.Questions = append(g.Questions, json.RawMessage(n.norm(string(rawOf(q)))))
	}
	chat := r.sink.chat
	chat.Commands = chat.Commands[:min(len(chat.Commands), 3)]
	g.Chat = json.RawMessage(n.norm(string(rawOf(chat))))
	s.mu.Lock()
	g.Echoes, g.Unknown = s.echoes, s.unknown
	s.mu.Unlock()
	if err := s.Err(); err != nil {
		g.Err = n.norm(strings.ReplaceAll(err.Error(), r.dir, "<dir>"))
	}
	return g
}

// checkGolden compares g with testdata/<name>.golden.json (writes it with
// -update).
func checkGolden(t testing.TB, name string, g golden) {
	t.Helper()
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(g); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join("testdata", name+".golden.json")
	if *update {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, b.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("%v (run with -update)", err)
	}
	if !bytes.Equal(want, b.Bytes()) {
		got, wnt := strings.Split(b.String(), "\n"), strings.Split(string(want), "\n")
		for i := range max(len(got), len(wnt)) {
			var gl, wl string
			if i < len(got) {
				gl = got[i]
			}
			if i < len(wnt) {
				wl = wnt[i]
			}
			if gl != wl {
				t.Fatalf("%s differs at line %d:\n got  %s\n want %s", file, i+1, gl, wl)
			}
		}
	}
}

// modelsOf maps the canned models' values to the ids they resolve to.
func modelsOf(t testing.TB) map[string]string {
	var ini initResponse
	if err := json.Unmarshal(canned(t)["initialize"], &ini); err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, m := range ini.Models {
		out[m.Value] = m.Resolved
	}
	return out
}

// acpContent is a recorded user message's content as a prompt's ACP
// blocks.
func acpContent(t testing.TB, c any) []json.RawMessage {
	t.Helper()
	if s, ok := c.(string); ok {
		return []json.RawMessage{rawOf(map[string]any{"type": "text", "text": s})}
	}
	var out []json.RawMessage
	for _, b := range c.([]any) {
		m := b.(map[string]any)
		switch m["type"] {
		case "text":
			out = append(out, rawOf(map[string]any{"type": "text", "text": m["text"]}))
		case "image":
			src := m["source"].(map[string]any)
			out = append(out, rawOf(map[string]any{"type": "image", "mimeType": src["media_type"], "data": src["data"]}))
		default:
			t.Fatalf("a block of type %v", m["type"])
		}
	}
	return out
}

// act does what the recording's "in" line at is the adapter's for: a
// prompt (the user's message, /compact), a cancel, a configuration;
// nothing for what the adapter sends on its own.
func act(t testing.TB, ctx context.Context, r *fakeRun, s *session, l scriptLine, uuids map[string]string) {
	t.Helper()
	var m map[string]any
	_ = json.Unmarshal(l.Msg, &m)
	switch m["type"] {
	case "user":
		msg := m["message"].(map[string]any)
		if msg["content"] == "/compact" {
			if err := s.Compact(ctx); err != nil {
				t.Fatalf("compact: %v\n%s", err, r.log())
			}
			return
		}
		id := fmt.Sprint(len(uuids) + 1)
		uuids[fmt.Sprint(m["uuid"])] = "m" + id
		// The host records a prompt it sees start a turn.
		s.mu.Lock()
		recorded := !s.inTurn
		s.mu.Unlock()
		if err := s.Prompt(ctx, chatadapter.PromptParams{Content: acpContent(t, msg["content"]), Message: "m" + id, ClientID: "c" + id, Recorded: recorded}); err != nil {
			t.Fatalf("prompt: %v\n%s", err, r.log())
		}
	case "control_request":
		req := m["request"].(map[string]any)
		var err error
		switch req["subtype"] {
		case "interrupt":
			err = s.Cancel(ctx)
		case "set_model":
			for v, r := range modelsOf(t) {
				if r == req["model"] && v != "default" && v != "opus" && v != "fable" && v != "sonnet" || v == req["model"] {
					err = s.SetConfig(ctx, optionModel, v)
					break
				}
			}
		case "set_permission_mode":
			err = s.SetConfig(ctx, optionMode, chatMode(fmt.Sprint(req["mode"])))
		case "apply_flag_settings":
			err = s.SetConfig(ctx, optionEffort, fmt.Sprint(req["settings"].(map[string]any)["effortLevel"]))
		case "cancel_async_message":
			err = s.CancelQueued(ctx, uuids[fmt.Sprint(req["message_uuid"])])
		}
		if err != nil {
			t.Fatalf("%v: %v (the session: %v)\n%s", req["subtype"], err, s.Err(), r.log())
		}
	}
}

// replay runs a recording through the adapter and the fake, and checks
// the golden file of its name.
func replay(t *testing.T, name string, edit func(p *chatadapter.StartParams)) {
	lines := readFixture(t, name)
	models := modelsOf(t)
	sc := script{Lines: prepare(t, lines, models), Canned: canned(t)}
	delete(sc.Canned, "initialize")
	r := newFakeRun(t, sc)
	r.sink.answersOf(lines)
	p := r.params()
	if edit != nil {
		edit(&p)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	ss, err := Adapter{}.Start(ctx, p, r.sink)
	if err != nil {
		t.Fatalf("start: %v\n%s", err, r.log())
	}
	s := ss.(*session)
	uuids := map[string]string{}
	for {
		sig := r.signal()
		settle(t, s, sig.Written)
		if sig.At < 0 {
			break
		}
		act(t, ctx, r, s, sc.Lines[sig.At], uuids)
	}
	// The answer to the last get_context_usage.
	quiet(t, s)
	if err := s.Close(ctx); err != nil {
		t.Fatal(err)
	}
	g := goldenOf(t, r, s)
	checkGolden(t, strings.TrimSuffix(name, ".jsonl"), g)
}

func TestReplay(t *testing.T) {
	files, err := filepath.Glob(filepath.Join(fixtureDir, "claude-[0-9]*.jsonl"))
	if err != nil || len(files) < 17 {
		t.Fatalf("fixtures: %v %v", files, err)
	}
	for _, f := range files {
		name := filepath.Base(f)
		t.Run(name, func(t *testing.T) {
			var edit func(*chatadapter.StartParams)
			if strings.Contains(name, "resume") || strings.Contains(name, "07b") || strings.Contains(name, "13-") {
				edit = func(p *chatadapter.StartParams) { p.Resume, p.SessionID = testSession, "" }
			}
			replay(t, name, edit)
		})
	}
	// The fixtures one by one; their goldens are all there.
	goldens, _ := filepath.Glob("testdata/claude-*.golden.json")
	if !*update && len(goldens) != len(files) {
		t.Errorf("%d goldens for %d fixtures", len(goldens), len(files))
	}
}
