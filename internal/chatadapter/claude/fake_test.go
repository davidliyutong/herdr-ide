//go:build unix

package claude

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	ossignal "os/signal"
	"reflect"
	"strings"
	"syscall"
	"time"
)

// The tests run Claude Code as a fake: the test binary started again with
// FAKE_CLAUDE_SCRIPT set plays a script of the program's side of the
// protocol (a recording of design/testdata/chat/claude, prepared by the
// test). It writes the "out" lines, and at each "in" line waits for the
// adapter's line that matches it, answering the adapter's other control
// requests from canned answers meanwhile (and after the script, until its
// input ends). It records what it got in FAKE_CLAUDE_LOG and tells the test
// at FAKE_CLAUDE_SOCK where it is: {"at": <the script's line>, "written":
// <lines written so far>} at each "in" line, at -1 when the script ended.
// A run started with --allow-dangerously-skip-permissions plays
// FAKE_CLAUDE_FULL_SCRIPT instead when it is set.

// scriptLine is a line of a fake's script.
type scriptLine struct {
	// Dir is "in", "out", "raw" (Text written as it is), "big" (a line of
	// N bytes), "exit" (Text on stderr, then exit with Code), "sleep" (N
	// milliseconds), "spawn" (a process of the fake's group that holds its
	// output and standard error and sleeps; Text "stubborn" ignores
	// SIGTERM; its pid is logged).
	Dir  string          `json:"dir"`
	Msg  json.RawMessage `json:"msg,omitempty"`
	Text string          `json:"text,omitempty"`
	N    int             `json:"n,omitempty"`
	Code int             `json:"code,omitempty"`
}

// script is a fake's script and its canned answers.
type script struct {
	Lines []scriptLine `json:"lines"`
	// Canned are the answers to control requests of the adapter's own, by
	// subtype; Silent are the subtypes never answered.
	Canned map[string]json.RawMessage `json:"canned"`
	Silent []string                   `json:"silent,omitempty"`
}

// fakeRecord is a line of the fake's log.
type fakeRecord struct {
	Argv     []string          `json:"argv,omitempty"`
	Pid      int               `json:"pid,omitempty"`
	Child    int               `json:"child,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
	Got      json.RawMessage   `json:"got,omitempty"`
	Mismatch string            `json:"mismatch,omitempty"`
}

// grandchildMain is a process a fake left in its group ("spawn"): it
// sleeps, holding the fake's output and standard error.
func grandchildMain() {
	if os.Getenv("FAKE_CLAUDE_STUBBORN") != "" {
		ossignal.Ignore(syscall.SIGTERM)
	}
	// Ready: the fake goes on.
	ready := os.NewFile(3, "ready")
	ready.Write([]byte{1})
	ready.Close()
	time.Sleep(time.Hour)
}

func fakeMain() {
	var sc script
	file := os.Getenv("FAKE_CLAUDE_SCRIPT")
	for _, a := range os.Args[1:] {
		if f := os.Getenv("FAKE_CLAUDE_FULL_SCRIPT"); a == "--allow-dangerously-skip-permissions" && f != "" {
			file = f
		}
	}
	b, err := os.ReadFile(file)
	if err == nil {
		err = json.Unmarshal(b, &sc)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake: script:", err)
		os.Exit(2)
	}
	logf, err := os.OpenFile(os.Getenv("FAKE_CLAUDE_LOG"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		os.Exit(2)
	}
	record := func(r fakeRecord) {
		b, _ := json.Marshal(r)
		logf.Write(append(b, '\n'))
	}
	env := map[string]string{}
	for _, k := range []string{"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SDK_READS_SESSION_STATE", "CLAUDE_AGENT_SDK_VERSION", "NODE_OPTIONS", "KEEP_ME"} {
		if v, ok := os.LookupEnv(k); ok {
			env[k] = v
		}
	}
	record(fakeRecord{Argv: os.Args[1:], Env: env, Pid: os.Getpid()})
	var sock net.Conn
	if p := os.Getenv("FAKE_CLAUDE_SOCK"); p != "" {
		sock, _ = net.Dial("unix", p)
	}
	signal := func(at, written int) {
		if sock != nil {
			fmt.Fprintf(sock, "{\"at\":%d,\"written\":%d}\n", at, written)
		}
	}
	lines := make(chan []byte)
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 1<<20), 32<<20)
		for sc.Scan() {
			lines <- append([]byte(nil), sc.Bytes()...)
		}
		close(lines)
	}()
	w := bufio.NewWriter(os.Stdout)
	written := 0
	ids := map[string]string{}
	subst := func(s string) string {
		for from, to := range ids {
			s = strings.ReplaceAll(s, `"`+from+`"`, `"`+to+`"`)
		}
		return s
	}
	write := func(s string) {
		w.WriteString(s)
		w.WriteByte('\n')
		w.Flush()
		written++
	}
	auto := func(got []byte) bool {
		var r struct {
			Type      string         `json:"type"`
			RequestID string         `json:"request_id"`
			Request   map[string]any `json:"request"`
		}
		if json.Unmarshal(got, &r) != nil || r.Type != "control_request" {
			return false
		}
		sub, _ := r.Request["subtype"].(string)
		for _, s := range sc.Silent {
			if s == sub {
				return true
			}
		}
		var resp any = map[string]any{}
		switch sub {
		case "set_permission_mode":
			resp = map[string]any{"mode": r.Request["mode"]}
		case "set_model":
			resp = map[string]any{"model": r.Request["model"]}
		case "interrupt":
			resp = map[string]any{"still_queued": []any{}}
		case "cancel_async_message":
			resp = map[string]any{"cancelled": true, "message_uuid": r.Request["message_uuid"]}
		}
		if c, ok := sc.Canned[sub]; ok {
			resp = c
		}
		b, _ := json.Marshal(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": r.RequestID, "response": resp}})
		write(string(b))
		return true
	}
	for i, l := range sc.Lines {
		switch l.Dir {
		case "out":
			write(subst(string(l.Msg)))
		case "raw":
			write(l.Text)
		case "big":
			write(`{"type":"assistant","pad":"` + strings.Repeat("x", l.N) + `"}`)
		case "sleep":
			time.Sleep(time.Duration(l.N) * time.Millisecond)
		case "spawn":
			exe, _ := os.Executable()
			cmd := exec.Command(exe)
			cmd.Env = append(os.Environ(), "FAKE_CLAUDE_ROLE=grandchild")
			if l.Text == "stubborn" {
				cmd.Env = append(cmd.Env, "FAKE_CLAUDE_STUBBORN=1")
			}
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			r, w, err := os.Pipe()
			if err == nil {
				cmd.ExtraFiles = []*os.File{w}
				err = cmd.Start()
				w.Close()
			}
			if err != nil {
				record(fakeRecord{Mismatch: "spawn: " + err.Error()})
				os.Exit(5)
			}
			// Once it ignores what it is to ignore.
			r.Read(make([]byte, 1))
			r.Close()
			record(fakeRecord{Child: cmd.Process.Pid})
		case "exit":
			w.Flush()
			fmt.Fprint(os.Stderr, l.Text)
			os.Exit(l.Code)
		case "in":
			signal(i, written)
			want := []byte(subst(string(l.Msg)))
			for {
				got, ok := <-lines
				if !ok {
					record(fakeRecord{Mismatch: fmt.Sprintf("line %d: the input ended", i)})
					os.Exit(3)
				}
				record(fakeRecord{Got: got})
				if bind, ok := match(want, got); ok {
					for k, v := range bind {
						ids[k] = v
					}
					break
				}
				if auto(got) {
					continue
				}
				record(fakeRecord{Mismatch: fmt.Sprintf("line %d: want %s", i, want)})
				os.Exit(4)
			}
		}
	}
	signal(-1, written)
	for got := range lines {
		record(fakeRecord{Got: got})
		auto(got)
	}
	os.Exit(0)
}

// canonical is a JSON value decoded, for comparing.
func canonical(raw []byte) any {
	var v any
	_ = json.Unmarshal(raw, &v)
	return v
}

// match tells whether got is the adapter's line that want stands for, and
// the ids of want's that got names otherwise (a user message's uuid, a
// control request's id).
func match(want, got []byte) (map[string]string, bool) {
	var w, g map[string]any
	if json.Unmarshal(want, &w) != nil || json.Unmarshal(got, &g) != nil || w["type"] != g["type"] {
		return nil, false
	}
	switch w["type"] {
	case "user":
		wm, _ := w["message"].(map[string]any)
		gm, _ := g["message"].(map[string]any)
		wc := wm["content"]
		if s, ok := wc.(string); ok {
			wc = []any{map[string]any{"type": "text", "text": s}}
		}
		if gm == nil || !reflect.DeepEqual(wc, gm["content"]) {
			return nil, false
		}
		bind := map[string]string{}
		if wu, _ := w["uuid"].(string); wu != "" {
			bind[wu], _ = g["uuid"].(string)
		}
		return bind, true
	case "control_request":
		if !reflect.DeepEqual(w["request"], g["request"]) {
			return nil, false
		}
		wid, _ := w["request_id"].(string)
		gid, _ := g["request_id"].(string)
		return map[string]string{wid: gid}, true
	case "control_response":
		wr, _ := w["response"].(map[string]any)
		gr, _ := g["response"].(map[string]any)
		if gr == nil || wr["request_id"] != gr["request_id"] || wr["subtype"] != gr["subtype"] {
			return nil, false
		}
		wb, _ := wr["response"].(map[string]any)
		gb, _ := gr["response"].(map[string]any)
		if gb == nil || wb["behavior"] != gb["behavior"] {
			return nil, false
		}
		if wb["behavior"] == "allow" && (!reflect.DeepEqual(wb["updatedInput"], gb["updatedInput"]) || !reflect.DeepEqual(wb["updatedPermissions"], gb["updatedPermissions"])) {
			return nil, false
		}
		return nil, true
	}
	return nil, reflect.DeepEqual(w, g)
}
