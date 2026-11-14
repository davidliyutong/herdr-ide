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

	"herdr-ide/internal/agent"
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
	home, err := os.MkdirTemp("/tmp", "hct")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("HERDR_SOCKET_PATH", "")
	logger := log.New(io.Discard, "", 0)
	dial := func(ctx context.Context, spec machines.Spec) (*transport.Session, string, error) {
		s, err := transport.DialLocal(ctx, agent.Options{Logger: logger})
		return s, "test/test", err
	}
	mg := machines.NewManager([]machines.Spec{{ID: "x", Label: "x", Kind: machines.KindSSH, Session: "herdr-ide-none", Enabled: true}}, dial, logger)
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
	if a := audit.String(); !strings.Contains(a, `"denied.term"`) || !strings.Contains(a, `"machine.exec"`) || !strings.Contains(a, `"terminal.kill"`) {
		t.Fatalf("audit %s", a)
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
	c.send(map[string]any{"t": "resize", "s": sid, "cols": 120, "rows": 40})
	core.waitFor("3:\x78\x00\x28\x00")
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
	// A watcher's attach observes: the terminal's size comes in the stream,
	// and nothing it sends reaches the program.
	c.send(map[string]any{"t": "attach", "rid": 3, "m": "x", "terminal": "t1", "cols": 80, "rows": 24})
	at := c.until("attached")
	if at["observe"] != true {
		t.Fatalf("attached %v", at)
	}
	core.waitFor(`"observe":true`)
	if m := c.next(); m["kind"] != float64(termResize) || m["data"] != "\x64\x00\x1e\x00" {
		t.Fatalf("size frame %v", m)
	}
	sid := uint32(at["s"].(float64))
	c.ws.Write(context.Background(), websocket.MessageBinary, append(append(binary.LittleEndian.AppendUint32(nil, sid), termData), "rm -rf\r"...))
	c.send(map[string]any{"t": "resize", "s": sid, "cols": 10, "rows": 10})
	c.send(map[string]any{"t": "ack", "s": sid, "n": 5})
	core.waitFor("1:\x05\x00\x00\x00") // the credit arrived, after the rest would have
	if core.seen("rm -rf") || core.seen("3:") {
		t.Fatalf("a watcher's input reached the core: %q", core.frames)
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
