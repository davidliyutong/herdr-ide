//go:build integration

package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"veldr/internal/agentproto"
)

// hcServer is a server whose machine x gets the real herdr-core
// (HC_TEST_BIN, else hc on PATH); the terminal core is stopped at the end.
func hcServer(t *testing.T) (*Server, *lockedWriter) {
	t.Helper()
	bin := os.Getenv("HC_TEST_BIN")
	if bin == "" {
		var err error
		if bin, err = exec.LookPath("hc"); err != nil {
			t.Skip("herdr-core not installed (HC_TEST_BIN)")
		}
	}
	exe, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(exe)
	zw.Close()
	digest := fmt.Sprintf("%x", sha256.Sum256(exe))
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	s, _, audit := termServer(t, Options{HC: func(goos, goarch string) ([]byte, string, error) {
		return gz.Bytes(), digest, nil
	}}, false)
	t.Cleanup(func() {
		if sess := s.mg.Get("x").Session(); sess != nil {
			sess.Request(context.Background(), agentproto.Header{Op: agentproto.OpHC, Action: "stop"})
		}
	})
	return s, audit
}

// TestIntegrationTerm goes from a client of /api/v1/term to a program in a
// real herdr-core: the core installs the executable on the machine, starts
// the terminal core, and the client runs a shell, types and reads.
func TestIntegrationTerm(t *testing.T) {
	s, audit := hcServer(t)
	c := dialTerm(t, s)
	c.ready()
	if a := audit.String(); !strings.Contains(a, `"term.install"`) || !strings.Contains(a, `"term.start"`) {
		t.Fatalf("audit %s", a)
	}
	if n := len(c.until("snapshot")["terminals"].([]any)); n != 0 {
		t.Fatalf("%d terminals in a new session", n)
	}

	c.send(map[string]any{"t": "call", "rid": 1, "m": "x", "method": "terminal.run",
		"params": map[string]any{"argv": []string{"/bin/sh"}, "cwd": "/", "size": map[string]int{"cols": 80, "rows": 24}}})
	var addr string
	for addr == "" {
		switch m := c.next(); m["t"] {
		case "res":
			if m["error"] != nil {
				t.Fatalf("run: %v", m)
			}
			addr = m["result"].(map[string]any)["address"].(string)
		}
	}
	c.send(map[string]any{"t": "attach", "rid": 2, "m": "x", "terminal": addr, "cols": 100, "rows": 30})
	at := c.until("attached")
	sid := uint32(at["s"].(float64))
	c.ws.Write(context.Background(), 2, append([]byte{byte(sid), byte(sid >> 8), byte(sid >> 16), byte(sid >> 24), termData}, "echo term-$((40+2)) $(stty size)\r"...))
	var out string
	for !strings.Contains(out, "term-42 30 100") {
		m := c.until("bin")
		out += m["data"].(string)
		c.send(map[string]any{"t": "ack", "s": sid, "n": len(m["data"].(string))})
	}

	// A second client finds the terminal in its snapshot and watches it.
	c2 := dialTerm(t, s)
	c2.send(map[string]any{"t": "sub", "m": "x"})
	terms := c2.until("snapshot")["terminals"].([]any)
	if len(terms) != 1 || terms[0].(map[string]any)["address"] != addr || terms[0].(map[string]any)["cols"] != float64(100) {
		t.Fatalf("second client's snapshot %v", terms)
	}
	c2.send(map[string]any{"t": "attach", "rid": 1, "m": "x", "terminal": addr, "cols": 100, "rows": 30, "observe": true})
	out = ""
	for !strings.Contains(out, "term-42 30 100") {
		if m := c2.until("bin"); m["kind"] == float64(termData) {
			out += m["data"].(string)
		}
	}

	c.send(map[string]any{"t": "call", "rid": 3, "m": "x", "method": "terminal.kill", "params": map[string]any{"terminal": addr}})
	if m := c.until("closed"); m["reason"] != "killed" {
		t.Fatalf("closed %v", m)
	}
}

// fakeAgent is a script named like Claude Code that shows its screens: a
// turn in progress, a permission dialog once "block" exists beside it,
// and its prompt once "idle" does.
const fakeAgent = `#!/bin/sh
d=$(dirname "$0")
printf '\033[2J\033[H\342\234\273 Thinking\342\200\246 (3s \302\267 esc to interrupt)\n'
while [ ! -e "$d/block" ]; do sleep 0.1; done
printf '\033[2J\033[H Do you want to proceed?\n \342\235\257 1. Yes\n   2. No\n'
while [ ! -e "$d/idle" ]; do sleep 0.1; done
printf '\033[2J\033[H\342\217\272 Done.\n\342\224\200\342\224\200\342\224\200\n\342\235\257 \n\342\224\200\342\224\200\342\224\200\n'
while :; do sleep 1; done
`

// TestIntegrationDetect runs a program the agent takes for Claude Code in
// a real herdr-core and follows its status through the agent's detection
// to /api/v1/term and /ws: working, blocked, done. Not being Claude Code,
// it has no session.
func TestIntegrationDetect(t *testing.T) {
	shortGrace(t)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	s, _ := hcServer(t)
	dir, err := os.MkdirTemp("/tmp", "hcd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	script := filepath.Join(dir, "claude")
	if err := os.WriteFile(script, []byte(fakeAgent), 0o700); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?events=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	var wsMu sync.Mutex
	var wsAgent []string
	go func() {
		for {
			_, data, err := ws.Read(context.Background())
			if err != nil {
				return
			}
			var m struct {
				T    string `json:"t"`
				Data struct {
					Terminal string `json:"terminal"`
					Status   string `json:"agent_status"`
				} `json:"data"`
			}
			if json.Unmarshal(data, &m) == nil && m.T == "agent" {
				wsMu.Lock()
				wsAgent = append(wsAgent, m.Data.Terminal+":"+m.Data.Status)
				wsMu.Unlock()
			}
		}
	}()

	c := dialTerm(t, s)
	c.ready()
	c.send(map[string]any{"t": "call", "rid": 1, "m": "x", "method": "terminal.run",
		"params": map[string]any{"argv": []string{"/bin/sh", script}, "cwd": dir}})
	var addr string
	for addr == "" {
		if m := c.next(); m["t"] == "res" {
			if m["error"] != nil {
				t.Fatalf("run: %v", m)
			}
			addr = m["result"].(map[string]any)["address"].(string)
		}
	}
	status := func(want string) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			m := c.until("event")
			if m["type"] != "agent" || m["terminal"] != addr {
				continue
			}
			d := m["data"].(map[string]any)
			if d["agent"] != "claude" || d["agent_session"] != nil {
				t.Fatalf("agent %v", m)
			}
			if d["agent_status"] == want {
				return
			}
		}
		t.Fatalf("no %s", want)
	}
	status("working")
	os.WriteFile(filepath.Join(dir, "block"), nil, 0o600)
	status("blocked")
	os.WriteFile(filepath.Join(dir, "idle"), nil, 0o600)
	status("done")
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		wsMu.Lock()
		got := strings.Join(wsAgent, " ")
		wsMu.Unlock()
		if strings.Contains(got, addr+":blocked") && strings.Contains(got, addr+":done") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("/ws agent messages %q", got)
		}
	}
	c.send(map[string]any{"t": "call", "rid": 2, "m": "x", "method": "terminal.kill", "params": map[string]any{"terminal": addr}})
	for {
		if m := c.until("event"); m["type"] == "agent" && m["terminal"] == addr && m["data"].(map[string]any)["agent"] == nil {
			break
		}
	}
}

// TestIntegrationTermShells types into a real shell the way enabling
// program windows does: the record says it waits at its prompt, and the
// text typed as a viewer of its size runs.
func TestIntegrationTermShells(t *testing.T) {
	s, _ := hcServer(t)
	c := dialTerm(t, s)
	c.ready()
	c.send(map[string]any{"t": "call", "rid": 1, "m": "x", "method": "terminal.run",
		"params": map[string]any{"argv": []string{"/bin/sh"}, "cwd": "/"}})
	var addr string
	for addr == "" {
		if m := c.next(); m["t"] == "res" {
			addr = m["result"].(map[string]any)["address"].(string)
		}
	}
	sh := termShells{s.term.existing("x")}
	ctx := context.Background()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		if pid, idle, err := sh.Shell(ctx, addr); err == nil && pid > 0 && idle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the shell never waited at its prompt")
		}
	}
	conn := s.term.existing("x").connection()
	var before struct{ Cols, Rows int }
	conn.Call(ctx, "terminal.get", map[string]string{"terminal": addr}, &before)
	if err := sh.Send(ctx, addr, "echo typed-$((40+2))\r"); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		var res struct {
			Text string `json:"text"`
		}
		conn.Call(ctx, "terminal.read", map[string]string{"terminal": addr}, &res)
		if strings.Contains(res.Text, "typed-42") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("screen %q", res.Text)
		}
	}
	var rec struct{ Cols, Rows int }
	conn.Call(ctx, "terminal.get", map[string]string{"terminal": addr}, &rec)
	if rec != before || rec.Cols == 0 {
		t.Fatalf("typing changed the size: %+v, before %+v", rec, before)
	}
}

// TestIntegrationTermHidden runs a terminal as the agent runs the chat
// host (the reserved name and the hidden label, through the terminal
// core's own API) in a real herdr-core: clients see it in no snapshot or
// list and reach it by no address, name or core-prefixed form, the
// shells keep away from it, and an attach in the instant before its
// creation's event reached the backend is refused too. A terminal of
// another machine is refused without asking the core, and a terminal that
// carries the label without the name stays the clients'.
func TestIntegrationTermHidden(t *testing.T) {
	s, audit := hcServer(t)
	c := dialTerm(t, s)
	c.ready()
	c.until("snapshot")
	b := s.term.existing("x")
	conn := b.connection()
	b.mu.Lock()
	core := b.core
	b.mu.Unlock()
	if core.ID == "" || core.Name == "" {
		t.Fatalf("the core's hello names no core: %+v", core)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	host := agentproto.ChatHostName
	run := func(name string, labels map[string]string) string {
		t.Helper()
		params := map[string]any{"argv": []string{"/bin/sh"}, "cwd": "/", "labels": labels,
			"size": map[string]int{"cols": 80, "rows": 24}, "no_parent": true}
		if name != "" {
			params["name"] = name
		}
		var res struct {
			Address string `json:"address"`
		}
		if err := conn.Call(ctx, "terminal.run", params, &res); err != nil || res.Address == "" {
			t.Fatalf("run %s: %v", name, err)
		}
		return res.Address
	}
	hiddenLabels := map[string]string{agentproto.HiddenLabel: agentproto.HiddenChatHost}
	// A terminal of the clients', and one that a program labeled as the
	// chat host's without its name.
	c.send(map[string]any{"t": "call", "rid": 1, "m": "x", "method": "terminal.run",
		"params": map[string]any{"argv": []string{"/bin/sh"}, "cwd": "/"}})
	mine := c.until("res")["result"].(map[string]any)["address"].(string)
	labeled := run("", hiddenLabels)

	// The hidden terminal: its creation reaches the backend, not the
	// clients.
	hidden := run(host, hiddenLabels)
	for deadline := time.Now().Add(10 * time.Second); !b.isHidden(hidden); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the backend never had the terminal as hidden")
		}
	}
	c2 := dialTerm(t, s)
	c2.send(map[string]any{"t": "sub", "m": "x"})
	snap := addresses(c2.until("snapshot")["terminals"])
	if strings.Contains(" "+snap+" ", " "+hidden+" ") || !strings.Contains(snap, mine) || !strings.Contains(snap, labeled) {
		t.Fatalf("snapshot %q (hidden %s, mine %s, labeled %s)", snap, hidden, mine, labeled)
	}
	res, _ := c.call(2, "terminal.list", map[string]any{"all": true})["result"].(map[string]any)
	if list := addresses(res["terminals"]); strings.Contains(" "+list+" ", " "+hidden+" ") || !strings.Contains(list, labeled) {
		t.Fatalf("list %q", list)
	}

	// No address, name or core-prefixed form reaches it.
	rid := 10
	targets := []string{hidden, host, core.ID + "/" + hidden, core.Name + "/" + hidden, core.ID + "/" + host, core.Name + "/" + host}
	for _, target := range targets {
		rid++
		if m := c.call(rid, "terminal.read", map[string]any{"terminal": target}); errKind(m) != "not_found" {
			t.Fatalf("read %s: %v", target, m)
		}
		for _, observe := range []bool{false, true} {
			rid++
			c.send(map[string]any{"t": "attach", "rid": rid, "m": "x", "terminal": target, "cols": 80, "rows": 24, "observe": observe})
			if m := c.until("res"); m["rid"] != float64(rid) || errKind(m) != "not_found" {
				t.Fatalf("attach %s: %v", target, m)
			}
		}
	}
	sh := termShells{b}
	for _, target := range []string{hidden, host, core.Name + "/" + hidden} {
		if _, _, err := sh.Shell(ctx, target); err == nil || !strings.Contains(err.Error(), "not_found") {
			t.Fatalf("the shell of %s: %v", target, err)
		}
		if err := sh.Send(ctx, target, "echo typed\r"); err == nil {
			t.Fatalf("typed into %s", target)
		}
	}
	if all, _ := sh.All(ctx); strings.Contains(" "+strings.Join(all, " ")+" ", " "+hidden+" ") {
		t.Fatalf("shells %v", all)
	}

	// The creation window: the backend has not heard of the terminal yet.
	b.mu.Lock()
	delete(b.hidden, hidden)
	b.mu.Unlock()
	rid++
	c.send(map[string]any{"t": "attach", "rid": rid, "m": "x", "terminal": hidden, "cols": 80, "rows": 24})
	if m := c.until("res"); m["rid"] != float64(rid) || errKind(m) != "not_found" {
		t.Fatalf("attach in the creation window: %v", m)
	}
	rid++
	if m := c.call(rid, "terminal.read", map[string]any{"terminal": hidden}); errKind(m) != "not_found" {
		t.Fatalf("read in the creation window: %v", m)
	}
	if _, _, err := sh.Shell(ctx, hidden); err == nil {
		t.Fatal("the shell of a hidden terminal in the creation window")
	}
	b.mu.Lock()
	b.hidden[hidden] = true
	b.mu.Unlock()
	// And as it happens: a client attaches as soon as the terminal exists.
	var killed []string
	for i := 0; i < 5; i++ {
		conn.Call(ctx, "terminal.kill", map[string]string{"terminal": hidden}, nil)
		killed = append(killed, hidden)
		for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
			var rec struct {
				State string `json:"state"`
			}
			if err := conn.Call(ctx, "terminal.get", map[string]string{"terminal": hidden}, &rec); err != nil || rec.State != "live" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the hidden terminal did not end")
			}
		}
		hidden = run(host, hiddenLabels)
		rid++
		c.send(map[string]any{"t": "attach", "rid": rid, "m": "x", "terminal": hidden, "cols": 80, "rows": 24})
		if m := c.until("res"); m["rid"] != float64(rid) || errKind(m) != "not_found" {
			t.Fatalf("attach to a hidden terminal as it starts: %v", m)
		}
	}

	// Another machine's terminal: refused here, the core is not asked.
	rid++
	if m := c.call(rid, "terminal.read", map[string]any{"terminal": "far/" + mine}); errKind(m) != "not_found" {
		t.Fatalf("read far/%s: %v", mine, m)
	}
	// The clients' own terminals stay theirs, by name of the core too.
	rid++
	if m := c.call(rid, "terminal.read", map[string]any{"terminal": core.Name + "/" + mine}); m["error"] != nil {
		t.Fatalf("read %s/%s: %v", core.Name, mine, m)
	}
	rid++
	c.send(map[string]any{"t": "attach", "rid": rid, "m": "x", "terminal": labeled, "cols": 80, "rows": 24, "observe": true})
	if m := c.until("attached"); m["rid"] != float64(rid) {
		t.Fatalf("attach %s: %v", labeled, m)
	}
	a := audit.String()
	if !strings.Contains(a, `"reason":"hidden"`) || !strings.Contains(a, `"reason":"machine"`) {
		t.Errorf("audit %s", a)
	}
	t.Logf("hidden terminals %v and %s, the clients' %s and %s", killed, hidden, mine, labeled)
}
