//go:build unix

package acp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// The test binary is also the fake agent: started with fakeScript in its
// environment, it plays the agent of a script instead of running tests.
const (
	fakeScript  = "ACP_FAKE_SCRIPT"
	fakePIDFile = "ACP_FAKE_PIDFILE"
)

func TestMain(m *testing.M) {
	if script := os.Getenv(fakeScript); script != "" {
		os.Exit(fakeAgent(script))
	}
	os.Exit(m.Run())
}

// step is a line of a script: a message of a recording (spec/vectors/
// chat/acp: "in" the agent writes it, "out" the client is to send one like
// it), or a directive of the fake: "exit" with Code (after writing Stderr
// to its standard error), "child" (start a process in its group, its pid
// written to the file of fakePIDFile), "stubborn" (ignore SIGTERM and the
// end of the input).
type step struct {
	Dir    string          `json:"dir"`
	Msg    json.RawMessage `json:"msg,omitempty"`
	Code   int             `json:"code,omitempty"`
	Stderr string          `json:"stderr,omitempty"`
}

// wire is a JSON-RPC message, its members raw.
type wire struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func (w wire) response() bool { return w.Method == "" }

// exactParams are the methods whose params a client must send as the
// recording has them (initialize's clientInfo is the client's own).
var exactParams = map[string]bool{
	"session/new": true, "session/load": true, "session/resume": true, "session/prompt": true,
	"session/cancel": true, "session/set_config_option": true, "session/set_mode": true, "session/list": true,
}

// fakeAgent plays a script: it writes the agent's lines and checks the
// client's against the recording's, in order, but in any order within a
// run of the client's lines (a cancel and the answer of the permission it
// cancels race). Responses go out with the ids the client gave the calls.
// Once through the script it reads its input to its end, as an agent does.
// A client line that does not match fails it: exit status 3, the reason on
// its standard error.
func fakeAgent(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake:", err)
		return 3
	}
	var steps []step
	for line := range bytes.Lines(b) {
		var s step
		if err := json.Unmarshal(line, &s); err != nil {
			fmt.Fprintln(os.Stderr, "fake: script:", err)
			return 3
		}
		steps = append(steps, s)
	}
	lines := make(chan []byte, 1024)
	go func() {
		defer close(lines)
		br := bufio.NewReaderSize(os.Stdin, 1<<20)
		for {
			l, err := br.ReadBytes('\n')
			if len(l) > 0 {
				lines <- l
			}
			if err != nil {
				return
			}
		}
	}()
	out := bufio.NewWriter(os.Stdout)
	ids := map[string]json.RawMessage{} // the recording's ids of the client's calls → the client's
	stubborn := false
	fail := func(i int, format string, args ...any) int {
		fmt.Fprintf(os.Stderr, "fake: step %d: %s\n", i+1, fmt.Sprintf(format, args...))
		return 3
	}
	for i := 0; i < len(steps); i++ {
		s := steps[i]
		switch s.Dir {
		case "in":
			var m wire
			json.Unmarshal(s.Msg, &m)
			msg := s.Msg
			if m.response() {
				id, ok := ids[string(m.ID)]
				if !ok {
					return fail(i, "a response to a call the client did not make: %s", m.ID)
				}
				var obj map[string]json.RawMessage
				json.Unmarshal(s.Msg, &obj)
				obj["id"] = id
				msg, _ = json.Marshal(obj)
			}
			out.Write(msg)
			out.WriteByte('\n')
			out.Flush()
		case "out":
			j := i
			for j < len(steps) && steps[j].Dir == "out" {
				j++
			}
			want := steps[i:j]
			matched := make([]bool, len(want))
			for range want {
				var l []byte
				select {
				case l = <-lines:
				case <-time.After(10 * time.Second):
					return fail(i, "the client sent nothing")
				}
				if l == nil {
					return fail(i, "the client's output ended")
				}
				var got wire
				if err := json.Unmarshal(l, &got); err != nil {
					return fail(i, "the client sent %q", l)
				}
				k, why := match(want, matched, got)
				if k < 0 {
					return fail(i, "the client sent %s: %s", bytes.TrimSpace(l), why)
				}
				matched[k] = true
				var w wire
				json.Unmarshal(want[k].Msg, &w)
				if !w.response() && len(w.ID) > 0 {
					ids[string(w.ID)] = got.ID
				}
			}
			i = j - 1
		case "exit":
			out.Flush()
			os.Stderr.WriteString(s.Stderr)
			return s.Code
		case "child":
			c := exec.Command("/bin/sleep", "300")
			if err := c.Start(); err != nil {
				return fail(i, "child: %v", err)
			}
			os.WriteFile(os.Getenv(fakePIDFile), []byte(strconv.Itoa(c.Process.Pid)), 0o600)
		case "stubborn":
			stubborn = true
			signal.Ignore(syscall.SIGTERM)
		default:
			return fail(i, "unknown step %q", s.Dir)
		}
	}
	for range lines {
	}
	if stubborn {
		time.Sleep(time.Hour)
	}
	return 0
}

// match is the first unmatched line of want that got is: a call or a
// notification of the same method (the same params for exactParams), or
// the response of the same id and outcome. -1 and why for none.
func match(want []step, matched []bool, got wire) (int, string) {
	why := "nothing of the recording"
	for k, s := range want {
		if matched[k] {
			continue
		}
		var w wire
		json.Unmarshal(s.Msg, &w)
		switch {
		case w.response() != got.response():
			continue
		case w.response():
			if string(w.ID) != string(got.ID) {
				continue
			}
			if !sameJSON(w.Result, got.Result) || !sameError(w.Error, got.Error) {
				why = "another answer than " + string(s.Msg)
				continue
			}
		default:
			if w.Method != got.Method {
				continue
			}
			if exactParams[w.Method] && !sameJSON(w.Params, got.Params) {
				why = "other params than " + string(w.Params)
				continue
			}
			if w.Method == "initialize" && !sameInit(w.Params, got.Params) {
				why = "other initialize params than " + string(w.Params)
				continue
			}
		}
		return k, ""
	}
	return -1, why
}

func sameJSON(a, b json.RawMessage) bool {
	if len(a) == 0 || len(b) == 0 {
		return len(a) == len(b)
	}
	var x, y any
	return json.Unmarshal(a, &x) == nil && json.Unmarshal(b, &y) == nil && reflect.DeepEqual(x, y)
}

func sameError(a, b json.RawMessage) bool {
	var x, y struct {
		Code int `json:"code"`
	}
	json.Unmarshal(a, &x)
	json.Unmarshal(b, &y)
	return len(a) == 0 && len(b) == 0 || len(a) > 0 && len(b) > 0 && x.Code == y.Code
}

// sameInit compares initialize's params but for clientInfo.
func sameInit(a, b json.RawMessage) bool {
	var x, y map[string]any
	json.Unmarshal(a, &x)
	json.Unmarshal(b, &y)
	delete(x, "clientInfo")
	delete(y, "clientInfo")
	return reflect.DeepEqual(x, y)
}

// recording is a file of spec/vectors/chat/acp as steps, its working
// directory /work made dir.
func recording(t *testing.T, agent, name, dir string) []step {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "spec", "vectors", "chat", "acp", agent, name+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var steps []step
	for line := range bytes.Lines(b) {
		var r struct {
			Dir string          `json:"dir"`
			Msg json.RawMessage `json:"msg"`
		}
		if err := json.Unmarshal(line, &r); err != nil {
			t.Fatal(err)
		}
		msg := bytes.ReplaceAll(r.Msg, []byte(`"/work`), []byte(`"`+dir))
		steps = append(steps, step{Dir: r.Dir, Msg: msg})
	}
	return steps
}

// without is steps without the messages of a method, and the responses to
// the calls of it.
func without(steps []step, method string) []step {
	var out []step
	ids := map[string]bool{}
	for _, s := range steps {
		var w wire
		json.Unmarshal(s.Msg, &w)
		switch {
		case w.Method == method:
			if s.Dir == "out" && len(w.ID) > 0 {
				ids[string(w.ID)] = true
			}
			continue
		case w.response() && s.Dir == "in" && ids[string(w.ID)]:
			continue
		}
		out = append(out, s)
	}
	return out
}

// edit changes the message of the first step for which fn returns true,
// fn changing the message decoded.
func edit(t *testing.T, steps []step, fn func(m map[string]any) bool) {
	t.Helper()
	for i, s := range steps {
		var m map[string]any
		if json.Unmarshal(s.Msg, &m) != nil {
			continue
		}
		if fn(m) {
			b, err := json.Marshal(m)
			if err != nil {
				t.Fatal(err)
			}
			steps[i].Msg = b
			return
		}
	}
	t.Fatal("edit: no step changed")
}

// msgLine is a step of a message given as JSON text.
func msgLine(dir, msg string) step { return step{Dir: dir, Msg: json.RawMessage(msg)} }

// writeScript writes steps where the fake reads them.
func writeScript(t *testing.T, steps []step) string {
	t.Helper()
	var b bytes.Buffer
	for _, s := range steps {
		line, err := json.Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	path := filepath.Join(t.TempDir(), "script.jsonl")
	if err := os.WriteFile(path, b.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// fakeArgv is the command that plays the fake agent.
func fakeArgv(t *testing.T) []string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return []string{exe, "-test.run=^$"}
}

// fakeEnv is the fake's whole environment. A test binary built with the
// race detector sleeps a second as it exits unless told not to.
func fakeEnv(t *testing.T, script string, extra ...string) []string {
	return append([]string{fakeScript + "=" + script, "HOME=" + t.TempDir(), "PATH=/usr/bin:/bin", "GORACE=atexit_sleep_ms=0"}, extra...)
}

// promptOf is the content of the first session/prompt of steps.
func promptOf(t *testing.T, steps []step) []json.RawMessage {
	t.Helper()
	for _, s := range steps {
		var w wire
		json.Unmarshal(s.Msg, &w)
		if s.Dir == "out" && w.Method == "session/prompt" {
			var p struct {
				Prompt []json.RawMessage `json:"prompt"`
			}
			json.Unmarshal(w.Params, &p)
			return p.Prompt
		}
	}
	t.Fatal("no prompt")
	return nil
}

// answers are the client's answers to the permissions of steps, in order:
// the option chosen, "" for cancelled.
func answers(steps []step) []string {
	var out []string
	asked := map[string]bool{}
	for _, s := range steps {
		var w wire
		json.Unmarshal(s.Msg, &w)
		switch {
		case s.Dir == "in" && w.Method == "session/request_permission":
			asked[string(w.ID)] = true
		case s.Dir == "out" && w.response() && asked[string(w.ID)]:
			var r struct {
				Outcome struct {
					Outcome  string `json:"outcome"`
					OptionID string `json:"optionId"`
				} `json:"outcome"`
			}
			json.Unmarshal(w.Result, &r)
			out = append(out, r.Outcome.OptionID) // "" for cancelled
		}
	}
	return out
}
