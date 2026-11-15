package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/transport"
)

// fakeTermCore is a terminal core on a machine's socket: it answers the
// calls the tests make, echoes a stream's input as output and records the
// frames it receives on streams.
type fakeTermCore struct {
	t  *testing.T
	ln net.Listener

	mu     sync.Mutex
	conns  []net.Conn
	frames []string // "kind:payload" of stream frames
	attach []string // params of terminal.attach
	calls  []string // params of terminal.run
}

func (f *fakeTermCore) seen(want string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, fr := range append(f.frames, f.attach...) {
		if strings.Contains(fr, want) {
			return true
		}
	}
	return false
}

func (f *fakeTermCore) waitFor(want string) {
	f.t.Helper()
	for deadline := time.Now().Add(5 * time.Second); !f.seen(want); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			f.t.Fatalf("the core never got %q; frames %q, attaches %q", want, f.frames, f.attach)
		}
	}
}

// drop closes the core's connections, as a core that stopped.
func (f *fakeTermCore) drop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.conns {
		c.Close()
	}
	f.conns = nil
}

func frameOf(channel uint32, kind byte, payload []byte) []byte {
	b := binary.LittleEndian.AppendUint32(nil, channel)
	b = append(b, kind)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(payload)))
	return append(b, payload...)
}

func (f *fakeTermCore) serve(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	line, err := br.ReadString('\n')
	if err != nil {
		return
	}
	framed := strings.Contains(line, `"framed":true`)
	io.WriteString(c, `{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"9.9.9","framed":`+map[bool]string{true: "true", false: "false"}[framed]+`}}`+"\n")
	if !framed {
		return
	}
	var wmu sync.Mutex
	write := func(b []byte) {
		wmu.Lock()
		c.Write(b)
		wmu.Unlock()
	}
	next := uint32(1)
	for {
		var h [9]byte
		if _, err := io.ReadFull(br, h[:]); err != nil {
			return
		}
		ch, kind := binary.LittleEndian.Uint32(h[:4]), h[4]
		payload := make([]byte, binary.LittleEndian.Uint32(h[5:]))
		if _, err := io.ReadFull(br, payload); err != nil {
			return
		}
		if ch != 0 {
			f.mu.Lock()
			f.frames = append(f.frames, string('0'+kind)+":"+string(payload))
			f.mu.Unlock()
			if kind == 0 { // echo input as output
				write(frameOf(ch, 0, append([]byte("echo:"), payload...)))
			}
			continue
		}
		var req struct {
			ID     uint64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		json.Unmarshal(payload, &req)
		id, _ := json.Marshal(req.ID)
		reply := func(body string) []byte {
			return frameOf(0, 0, []byte(`{"jsonrpc":"2.0","id":`+string(id)+`,`+body+`}`))
		}
		switch req.Method {
		case "events.subscribe":
			next++
			write(reply(`"result":{"channel":` + string('0'+byte(next)) + `,"seq":1,"terminals":[{"address":"t1","state":"live","cols":80,"rows":24,"future_field":7}]}`))
			write(frameOf(next, 0, []byte(`{"jsonrpc":"2.0","method":"event","params":{"seq":2,"type":"status","terminal":"t1","data":{"status":{"state":"working"},"records":{},"reported":true}}}`+"\n")))
		case "terminal.attach":
			f.mu.Lock()
			f.attach = append(f.attach, string(req.Params))
			f.mu.Unlock()
			if strings.Contains(string(req.Params), `"t404"`) {
				write(reply(`"error":{"code":-32000,"message":"no terminal t404","data":{"kind":"not_found"}}`))
				break
			}
			next++
			n := string('0' + byte(next))
			out := reply(`"result":{"channel":` + n + `,"automatic_input":true,"resize_notifications":true,"terminal":{"address":"t1","cols":100,"rows":30}}`)
			if strings.Contains(string(req.Params), `"observe":true`) {
				out = append(out, frameOf(next, 3, []byte{100, 0, 30, 0})...)
			}
			write(append(out, frameOf(next, 0, []byte("paint"))...))
			if strings.Contains(string(req.Params), `"history":1`) { // the test asks for the program's end
				write(frameOf(next, 2, []byte(`{"reason":"exited","exit_code":0,"signal":null}`)))
			}
		case "terminal.run":
			f.mu.Lock()
			f.calls = append(f.calls, string(req.Params))
			f.mu.Unlock()
			write(reply(`"result":{"address":"t2"}`))
		case "terminal.get":
			write(reply(`"result":{"address":"t1","state":"live","pid":42,"cols":80,"rows":24,"argv":[],"cwd":"/","created_ms":1,"labels":{},"screen":"exact","foreground":{"pid":42,"name":"zsh","argv":["zsh"],"cwd":"/"}}`))
		case "terminal.list":
			write(reply(`"result":{"terminals":[],"hidden_finished":0}`))
		case "terminal.kill":
			write(reply(`"error":{"code":-32000,"message":"no terminal t9","data":{"kind":"not_found","hint":"h"}}`))
		default:
			write(reply(`"result":{"method":"` + req.Method + `"}`))
		}
	}
}

// termServer is a server with machine "x", whose agent lives in a home
// short enough for unix sockets. With core, a fake terminal core listens on
// the machine's socket.
func termServer(t *testing.T, opts Options, core bool) (*Server, *fakeTermCore, *lockedWriter) {
	t.Helper()
	dialLocal := dialAgent(t)
	home, err := os.MkdirTemp("/tmp", "hct")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	logger := log.New(io.Discard, "", 0)
	dial := func(ctx context.Context, spec machines.Spec) (*transport.Session, string, error) {
		s, err := dialLocal(ctx, logger)
		return s, "test/test", err
	}
	mg := machines.NewManager([]machines.Spec{{ID: "x", Label: "x", Kind: machines.KindSSH, Target: "x", Enabled: true}}, dial, logger)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		mg.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	mc := mg.Get("x")
	for deadline := time.Now().Add(10 * time.Second); mc.Session() == nil || mc.State().Info == nil; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("machine did not connect")
		}
	}
	var f *fakeTermCore
	if core {
		f = listenTermCore(t, filepath.Join(home, ".herdr-ide", "run", "hc.sock"))
	}
	audit := &lockedWriter{w: &bytes.Buffer{}}
	opts.Logger, opts.Audit = logger, audit
	return New(mg, opts), f, audit
}

// listenTermCore starts a fake terminal core on socket.
func listenTermCore(t *testing.T, socket string) *fakeTermCore {
	t.Helper()
	os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeTermCore{t: t, ln: ln}
	t.Cleanup(func() { ln.Close(); f.drop() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			f.mu.Lock()
			f.conns = append(f.conns, c)
			f.mu.Unlock()
			go f.serve(c)
		}
	}()
	return f
}

type lockedWriter struct {
	mu sync.Mutex
	w  *bytes.Buffer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

func (l *lockedWriter) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.String()
}

// termConn is a client of /api/v1/term.
type termConn struct {
	t  *testing.T
	ws *websocket.Conn
}

func dialTerm(t *testing.T, s *Server) *termConn {
	t.Helper()
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	ws, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/term", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	return &termConn{t, ws}
}

func (c *termConn) send(v any) {
	c.t.Helper()
	b, _ := json.Marshal(v)
	if err := c.ws.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Fatal(err)
	}
}

// next returns the next message: a JSON object, or a binary frame as
// {"bin": stream, "kind": kind, "data": payload}.
func (c *termConn) next() map[string]any {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	typ, data, err := c.ws.Read(ctx)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	if typ == websocket.MessageBinary {
		return map[string]any{"bin": float64(binary.LittleEndian.Uint32(data)), "kind": float64(data[4]), "data": string(data[5:])}
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		c.t.Fatalf("message %q: %v", data, err)
	}
	return m
}

// until skips messages until one of type t ("bin" for a binary frame).
func (c *termConn) until(typ string) map[string]any {
	c.t.Helper()
	for {
		m := c.next()
		if m["t"] == typ || typ == "bin" && m["bin"] != nil {
			return m
		}
	}
}

func (c *termConn) ready() {
	c.t.Helper()
	c.send(map[string]any{"t": "sub", "m": "x"})
	for {
		if m := c.until("backend"); m["state"] == termReady {
			return
		} else if m["state"] == termError {
			c.t.Fatalf("backend: %v", m)
		}
	}
}

func TestTermProtocol(t *testing.T) {
	s, core, audit := termServer(t, Options{}, true)
	c := dialTerm(t, s)
	c.send(map[string]any{"t": "sub", "m": "nope"}) // unknown machines are ignored
	c.send(map[string]any{"t": "sub", "m": "x"})
	if m := c.until("backend"); m["m"] != "x" || m["state"] != termStarting {
		t.Fatalf("first state %v", m)
	}
	if m := c.until("backend"); m["state"] != termReady || m["version"] != "9.9.9" {
		t.Fatalf("ready state %v", m)
	}
	snap := c.until("snapshot")
	terms := snap["terminals"].([]any)
	if len(terms) != 1 || terms[0].(map[string]any)["future_field"] != float64(7) {
		t.Fatalf("snapshot %v", snap)
	}
	if ev := c.until("event"); ev["type"] != "status" || ev["terminal"] != "t1" {
		t.Fatalf("event %v", ev)
	}

	// Calls: allowed ones pass with their errors, the rest is refused.
	c.send(map[string]any{"t": "call", "rid": 1, "m": "x", "method": "terminal.list"})
	if m := c.until("res"); m["rid"] != float64(1) || m["result"] == nil {
		t.Fatalf("list %v", m)
	}
	c.send(map[string]any{"t": "call", "rid": 2, "m": "x", "method": "terminal.kill", "params": map[string]any{"terminal": "t9"}})
	if m := c.until("res"); m["error"].(map[string]any)["kind"] != "not_found" {
		t.Fatalf("kill %v", m)
	}
	for i, call := range []map[string]any{
		{"method": "machine.exec", "params": map[string]any{"argv": []string{"id"}}},
		{"method": "file.read", "params": map[string]any{"path": "/etc/passwd"}},
		{"method": "server.stop"},
		{"method": "terminal.attach"},
		{"method": "terminal.read", "params": map[string]any{"terminal": "t1", "on": "other"}},
	} {
		call["t"], call["rid"], call["m"] = "call", 10+i, "x"
		c.send(call)
		if m := c.until("res"); m["error"] == nil || m["error"].(map[string]any)["kind"] != "refused" {
			t.Fatalf("%v: %v", call["method"], m)
		}
	}
	c.send(map[string]any{"t": "call", "rid": 20, "m": "y", "method": "terminal.list"})
	if m := c.until("res"); m["error"].(map[string]any)["kind"] != "unavailable" {
		t.Fatalf("call on a machine not subscribed to: %v", m)
	}
	if a := audit.String(); !strings.Contains(a, `"denied.term"`) || !strings.Contains(a, `"machine.exec"`) || !strings.Contains(a, `"terminal.kill"`) ||
		!strings.Contains(a, `"method":"terminal.read","param":"on"`) {
		t.Fatalf("audit %s", a)
	}
	// Interrupting and keeping terminals are audited like killing them.
	for i, method := range []string{"terminal.interrupt", "terminal.keep"} {
		c.send(map[string]any{"t": "call", "rid": 30 + i, "m": "x", "method": method, "params": map[string]any{"terminal": "t1"}})
		if m := c.until("res"); m["result"] == nil {
			t.Fatalf("%s: %v", method, m)
		}
		if a := audit.String(); !strings.Contains(a, `"event":"`+method+`"`) || !strings.Contains(a, `"terminal":"t1"`) {
			t.Fatalf("%s not audited: %s", method, a)
		}
	}

	// A stream: the reply, then output; input, credit and size reach the core.
	c.send(map[string]any{"t": "attach", "rid": 3, "m": "x", "terminal": "t1", "cols": 90, "rows": 20})
	at := c.until("attached")
	if at["rid"] != float64(3) || at["observe"] != false || at["automatic"] != true || at["cols"] != float64(100) {
		t.Fatalf("attached %v", at)
	}
	sid := uint32(at["s"].(float64))
	if m := c.next(); m["bin"] != float64(sid) || m["kind"] != float64(termData) || m["data"] != "paint" {
		t.Fatalf("first frame %v", m)
	}
	bin := func(kind byte, payload string) {
		b := append(binary.LittleEndian.AppendUint32(nil, sid), kind)
		c.ws.Write(context.Background(), websocket.MessageBinary, append(b, payload...))
	}
	bin(termData, "ls\r")
	if m := c.until("bin"); m["data"] != "echo:ls\r" {
		t.Fatalf("echo %v", m)
	}
	bin(termAutomatic, "\x1b[?1;2c")
	core.waitFor("6:\x1b[?1;2c")
	c.send(map[string]any{"t": "ack", "s": sid, "n": 5})
	core.waitFor("1:\x05\x00\x00\x00")
	// Credit is returned for output the client was sent, no more: of 13
	// bytes ("paint", "echo:ls\r") 8 are left, and then none.
	c.send(map[string]any{"t": "ack", "s": sid, "n": 1000})
	core.waitFor("1:\x08\x00\x00\x00")
	c.send(map[string]any{"t": "ack", "s": sid, "n": 50})
	c.send(map[string]any{"t": "resize", "s": sid, "cols": 120, "rows": 40})
	core.waitFor("3:\x78\x00\x28\x00")
	if core.seen("1:\xe8\x03") || core.seen("1:2\x00") {
		t.Fatalf("credit beyond the output sent: %q", core.frames)
	}
	c.send(map[string]any{"t": "focus", "s": sid, "focused": true})
	core.waitFor("4:\x01")
	c.send(map[string]any{"t": "facts", "s": sid, "display": map[string]any{"bg": "#101010"}})
	core.waitFor(`5:{"bg":"#101010"}`)
	c.send(map[string]any{"t": "detach", "s": sid})
	core.waitFor("2:")

	c.send(map[string]any{"t": "attach", "rid": 4, "m": "x", "terminal": "t404", "cols": 80, "rows": 24})
	if m := c.until("res"); m["rid"] != float64(4) || m["error"].(map[string]any)["kind"] != "not_found" {
		t.Fatalf("attach to a missing terminal: %v", m)
	}
	// A program that ends closes its stream with how.
	c.send(map[string]any{"t": "attach", "rid": 5, "m": "x", "terminal": "t1", "cols": 80, "rows": 24, "history": 1})
	if m := c.until("closed"); m["reason"] != "exited" || m["exit_code"] != float64(0) {
		t.Fatalf("closed %v", m)
	}

	// A later client gets the terminals with the events applied.
	c2 := dialTerm(t, s)
	c2.send(map[string]any{"t": "sub", "m": "x"})
	t1 := c2.until("snapshot")["terminals"].([]any)[0].(map[string]any)
	if t1["status"].(map[string]any)["state"] != "working" || t1["reported"] != true || t1["future_field"] != float64(7) {
		t.Fatalf("second client's snapshot %v", t1)
	}

	// The core goes away: open streams end, the backend reports it and
	// comes back when the core answers again.
	c.send(map[string]any{"t": "attach", "rid": 6, "m": "x", "terminal": "t1", "cols": 80, "rows": 24})
	c.until("attached")
	core.drop()
	sawClosed, sawError := false, false
	for !sawClosed || !sawError {
		switch m := c.next(); m["t"] {
		case "closed":
			sawClosed = m["reason"] == termCodeLost
		case "backend":
			sawError = sawError || m["state"] == termError && m["code"] == termCodeLost
		}
	}
	s.term.wakeUp("x")
	for {
		if m := c.until("backend"); m["state"] == termReady {
			break
		}
	}
	c.until("snapshot")
}

func TestTermReadOnly(t *testing.T) {
	s, core, _ := termServer(t, Options{ReadOnly: true}, true)
	c := dialTerm(t, s)
	c.ready()
	c.send(map[string]any{"t": "call", "rid": 1, "m": "x", "method": "terminal.run", "params": map[string]any{"argv": []string{"sh"}}})
	if m := c.until("res"); m["error"].(map[string]any)["kind"] != "read_only" {
		t.Fatalf("run %v", m)
	}
	c.send(map[string]any{"t": "call", "rid": 2, "m": "x", "method": "terminal.read", "params": map[string]any{"terminal": "t1"}})
	if m := c.until("res"); m["result"] == nil {
		t.Fatalf("read %v", m)
	}
	// A watcher's attach observes, without display facts: the terminal's
	// size comes in the stream, and nothing it sends reaches the program.
	b := s.term.existing("x")
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "done"})
	c.send(map[string]any{"t": "attach", "rid": 3, "m": "x", "terminal": "t1", "cols": 80, "rows": 24,
		"display": map[string]any{"bg": "#101010"}})
	at := c.until("attached")
	if at["observe"] != true {
		t.Fatalf("attached %v", at)
	}
	core.waitFor(`"observe":true`)
	if core.seen(`"display"`) {
		t.Fatalf("an observer's attach carried display facts: %q", core.attach)
	}
	if m := c.next(); m["kind"] != float64(termResize) || m["data"] != "\x64\x00\x1e\x00" {
		t.Fatalf("size frame %v", m)
	}
	if m := c.next(); m["data"] != "paint" {
		t.Fatalf("paint %v", m)
	}
	sid := uint32(at["s"].(float64))
	c.ws.Write(context.Background(), websocket.MessageBinary, append(append(binary.LittleEndian.AppendUint32(nil, sid), termData), "rm -rf\r"...))
	c.send(map[string]any{"t": "resize", "s": sid, "cols": 10, "rows": 10})
	c.send(map[string]any{"t": "focus", "s": sid, "focused": true})
	c.send(map[string]any{"t": "facts", "s": sid, "display": map[string]any{"bg": "#202020"}})
	// Credit only for the 5 bytes of output sent.
	c.send(map[string]any{"t": "ack", "s": sid, "n": 500})
	core.waitFor("1:\x05\x00\x00\x00") // the credit arrived, after the rest would have
	if core.seen("rm -rf") || core.seen("3:") || core.seen("4:") || core.seen("5:") || core.seen("1:\xf4\x01") {
		t.Fatalf("a watcher's input reached the core: %q", core.frames)
	}
	// A watcher looking at a finished turn does not mark it seen.
	b.mu.Lock()
	status := b.agents["t1"].Status
	b.mu.Unlock()
	if status != "done" {
		t.Fatalf("a watcher's focus saw the turn: %s", status)
	}
}

func TestTermWithoutCore(t *testing.T) {
	// No terminal core on the machine and none in this build.
	s, _, _ := termServer(t, Options{}, false)
	c := dialTerm(t, s)
	c.send(map[string]any{"t": "sub", "m": "x"})
	for {
		if m := c.until("backend"); m["state"] == termError {
			if m["code"] != termCodeNotBundled {
				t.Fatalf("code %v", m)
			}
			break
		}
	}
	c.send(map[string]any{"t": "call", "rid": 1, "m": "x", "method": "terminal.list"})
	if m := c.until("res"); m["error"].(map[string]any)["kind"] != "unavailable" {
		t.Fatalf("call without a core: %v", m)
	}

	// A read-only core starts nothing, also with an executable to offer.
	s, _, audit := termServer(t, Options{ReadOnly: true, HC: func(goos, goarch string) ([]byte, string, error) {
		return []byte("x"), strings.Repeat("a", 64), nil
	}}, false)
	c = dialTerm(t, s)
	c.send(map[string]any{"t": "sub", "m": "x"})
	for {
		if m := c.until("backend"); m["state"] == termError {
			if m["code"] != termCodeNotBundled {
				t.Fatalf("read-only code %v", m)
			}
			break
		}
	}
	if strings.Contains(audit.String(), "term.install") {
		t.Fatal("a read-only core installed herdr-core")
	}
}

// The terminal core is stopped, started and restarted from the UI. A
// stopped core stays stopped while a client is subscribed (code stopped)
// until it is started again; the machine's state shows the backend's, and
// every action is audited.
func TestHCLifecycle(t *testing.T) {
	s, core, audit := termServer(t, Options{}, true)
	home := os.Getenv("HOME")
	socket := filepath.Join(home, ".herdr-ide", "run", "hc.sock")
	// A stand-in executable: its server commands succeed, and a start waits
	// until the test plays the started core.
	bin := filepath.Join(home, ".herdr-ide", "hc", "herdr-core")
	os.MkdirAll(filepath.Dir(bin), 0o700)
	os.WriteFile(bin, []byte("#!/bin/sh\nif [ \"$2\" = start ]; then touch \"$HOME/starting\"; while [ ! -e \"$HOME/listening\" ]; do sleep 0.05; done; fi\nexit 0\n"), 0o700)
	c := dialTerm(t, s)
	c.ready()
	mc := s.mg.Get("x")
	waitUntil := func(what string, ok func() bool) {
		t.Helper()
		for deadline := time.Now().Add(10 * time.Second); !ok(); time.Sleep(10 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s (hc %+v)", what, mc.State().HC)
			}
		}
	}
	waitUntil("the machine's state", func() bool {
		st := mc.State().HC
		return st != nil && st.State == termReady && st.Version == "9.9.9"
	})
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	do := func(method, path string) (int, map[string]any) {
		req, _ := http.NewRequest(method, srv.URL+path, nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var body map[string]any
		json.NewDecoder(res.Body).Decode(&body)
		return res.StatusCode, body
	}
	if code, st := do("GET", "/api/m/x/hc"); code != 200 || st["running"] != true || st["version"] != "9.9.9" || st["digest"] == "" {
		t.Fatalf("status: %d %v", code, st)
	}

	// Stop: the core goes away and the backend does not start another.
	core.ln.Close()
	core.drop()
	if code, st := do("POST", "/api/m/x/hc/stop"); code != 200 || st["running"] != false {
		t.Fatalf("stop: %d %v", code, st)
	}
	for {
		m := c.until("backend")
		if m["code"] == termCodeStopped {
			break
		}
	}
	waitUntil("stopped in the machine's state", func() bool { st := mc.State().HC; return st != nil && st.Code == termCodeStopped })

	// Start: the stand-in starts, the test listens as the new core.
	go func() {
		for i := 0; i < 500; i++ {
			if _, err := os.Stat(filepath.Join(home, "starting")); err == nil {
				listenTermCore(t, socket)
				os.WriteFile(filepath.Join(home, "listening"), nil, 0o600)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	if code, st := do("POST", "/api/m/x/hc/start"); code != 200 || st["running"] != true {
		t.Fatalf("start: %d %v", code, st)
	}
	for {
		if m := c.until("backend"); m["state"] == termReady {
			break
		}
	}
	if code, st := do("POST", "/api/m/x/hc/restart"); code != 200 || st["running"] != true {
		t.Fatalf("restart: %d %v", code, st)
	}
	for _, want := range []string{`"event":"hc.stop"`, `"event":"hc.start"`, `"event":"hc.restart"`, `"event":"term.restart"`} {
		if !strings.Contains(audit.String(), want) {
			t.Fatalf("audit lacks %s: %s", want, audit.String())
		}
	}
}

// New terminals get the machine's virtual display: its variables replace
// the client's, the rest of the client's environment stays, and the audit
// log names them. Malformed environments are refused.
func TestTermRunGetsTheDisplay(t *testing.T) {
	s, core, audit := termServer(t, Options{}, true)
	s.displayEnv = func(*machines.Machine) map[string]string {
		return map[string]string{"DISPLAY": ":20", "XAUTHORITY": "/home/u/.herdr-ide/run/xauth"}
	}
	c := dialTerm(t, s)
	c.ready()
	c.send(map[string]any{"t": "call", "rid": 1, "m": "x", "method": "terminal.run",
		"params": map[string]any{"argv": []string{"sh"}, "cwd": "/srv/api", "env": map[string]string{"DISPLAY": ":0", "TOKEN": "s3cret"}}})
	if m := c.until("res"); m["error"] != nil {
		t.Fatalf("run %v", m)
	}
	core.mu.Lock()
	got := strings.Join(core.calls, " ")
	core.mu.Unlock()
	if !strings.Contains(got, `"DISPLAY":":20"`) || !strings.Contains(got, `"TOKEN":"s3cret"`) || !strings.Contains(got, `"XAUTHORITY":"/home/u/.herdr-ide/run/xauth"`) {
		t.Fatalf("run params %s", got)
	}
	// The audit entry names the variables added and those the client gave,
	// with its working directory, but no values.
	if a := audit.String(); !strings.Contains(a, `"env":["DISPLAY","XAUTHORITY"]`) || !strings.Contains(a, `"client_env":["DISPLAY","TOKEN"]`) ||
		!strings.Contains(a, `"cwd":"/srv/api"`) || strings.Contains(a, "s3cret") {
		t.Fatalf("audit %s", a)
	}
	c.send(map[string]any{"t": "call", "rid": 2, "m": "x", "method": "terminal.run", "params": map[string]any{"env": "DISPLAY=:0"}})
	if m := c.until("res"); m["error"].(map[string]any)["kind"] != "usage" {
		t.Fatalf("malformed env %v", m)
	}
	// Without a display nothing is added.
	s.displayEnv = func(*machines.Machine) map[string]string { return nil }
	c.send(map[string]any{"t": "call", "rid": 3, "m": "x", "method": "terminal.run", "params": map[string]any{"argv": []string{"sh"}}})
	c.until("res")
	core.mu.Lock()
	last := core.calls[len(core.calls)-1]
	core.mu.Unlock()
	if strings.Contains(last, "env") {
		t.Fatalf("env without a display: %s", last)
	}
}

// Enabling program windows in terminals reads each terminal's record now
// and types as a viewer of the terminal's own size; without a connected
// terminal core, or a display, nothing is typed.
func TestTermShells(t *testing.T) {
	s, core, _ := termServer(t, Options{}, true)
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	post := func(body string) (int, string) {
		res, err := http.Post(srv.URL+"/api/m/x/gui/enable", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	if code, body := post(`{"terminals":["t1"]}`); code != 409 || !strings.Contains(body, "no_terminals") {
		t.Fatalf("without terminals: %d %s", code, body)
	}
	c := dialTerm(t, s)
	c.ready()
	if code, body := post(`{"terminals":["t1"]}`); code != 409 || !strings.Contains(body, "not_ready") {
		t.Fatalf("without a display: %d %s", code, body)
	}
	sh := termShells{s.term.existing("x")}
	ctx := context.Background()
	if all, _ := sh.All(ctx); len(all) != 1 || all[0] != "t1" {
		t.Fatalf("all %v", all)
	}
	if pid, idle, err := sh.Shell(ctx, "t1"); pid != 42 || !idle || err != nil {
		t.Fatalf("shell %d %v %v", pid, idle, err)
	}
	if err := sh.Send(ctx, "t1", "echo typed\r"); err != nil {
		t.Fatal(err)
	}
	core.waitFor("0:echo typed\r")
	core.waitFor(`"resumed":true`)
	core.waitFor(`"cols":80,"rows":24`)
}

// Detected agents reach the terminal records, the subscribers (an "agent"
// event) and /ws (agent messages, with the terminal's address). A turn
// that ended is seen, and reported idle, when a client has the terminal
// focused, then or later.
func TestTermAgents(t *testing.T) {
	s, _, _ := termServer(t, Options{}, true)
	var mu sync.Mutex
	var ws []string
	s.mg.Subscribe(func(machines.State) {}, func(ev machines.AgentEvent) {
		mu.Lock()
		ws = append(ws, string(ev.Data))
		mu.Unlock()
	})
	c := dialTerm(t, s)
	c.ready()
	b := s.term.existing("x")
	agentEvent := func() map[string]any {
		t.Helper()
		for {
			if m := c.until("event"); m["type"] == "agent" {
				return m
			}
		}
	}
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "working"})
	if m := agentEvent(); m["terminal"] != "t1" || m["data"].(map[string]any)["agent_status"] != "working" {
		t.Fatalf("event %v", m)
	}
	// A later subscriber finds it in the record.
	c2 := dialTerm(t, s)
	c2.send(map[string]any{"t": "sub", "m": "x"})
	rec := c2.until("snapshot")["terminals"].([]any)[0].(map[string]any)
	if rec["agent"] != "claude" || rec["agent_status"] != "working" {
		t.Fatalf("record %v", rec)
	}
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "done"})
	if m := agentEvent(); m["data"].(map[string]any)["agent_status"] != "done" {
		t.Fatalf("done %v", m)
	}
	// Focusing the terminal sees it.
	c.send(map[string]any{"t": "attach", "rid": 1, "m": "x", "terminal": "t1", "cols": 80, "rows": 24})
	sid := c.until("attached")["s"]
	c.send(map[string]any{"t": "focus", "s": sid, "focused": true})
	if m := agentEvent(); m["data"].(map[string]any)["agent_status"] != "idle" {
		t.Fatalf("seen %v", m)
	}
	// While it has the focus, a turn that ends is seen at once.
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "working"})
	agentEvent()
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1", Agent: "claude", Status: "done"})
	if m := agentEvent(); m["data"].(map[string]any)["agent_status"] != "idle" {
		t.Fatalf("done while focused %v", m)
	}
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1"})
	if m := agentEvent(); m["data"].(map[string]any)["agent"] != nil {
		t.Fatalf("cleared %v", m)
	}
	b.applyAgent(agentproto.DetectEvent{Terminal: "t1"}) // nothing to clear: no event
	mu.Lock()
	defer mu.Unlock()
	if len(ws) != 6 || !strings.Contains(ws[0], `"terminal":"t1"`) || !strings.Contains(ws[0], `"agent_status":"working"`) || !strings.Contains(ws[1], `"done"`) {
		t.Fatalf("/ws agent messages %q", ws)
	}
}
