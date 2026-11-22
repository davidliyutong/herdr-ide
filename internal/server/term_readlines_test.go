package server

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"herdr-ide/internal/brand"
)

// readCore is the fake terminal core of the terminal protocol's tests
// (fakeTermCore) that also records the params of each terminal.read it
// receives, as they arrive on its socket.
type readCore struct {
	*fakeTermCore

	mu    sync.Mutex
	reads []json.RawMessage
}

// tapConn hands what the server sends to tap before the fake core reads it.
type tapConn struct {
	net.Conn
	tap func([]byte)
}

func (c tapConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.tap(p[:n])
	return n, err
}

// tap returns the recorder of one connection: after the hello line come
// frames [channel u32][kind u8][length u32][payload], and the calls are the
// frames of channel 0. A frame is recorded once whole, which is before the
// core can answer it.
func (r *readCore) tap() func([]byte) {
	var buf []byte
	greeted := false
	return func(b []byte) {
		buf = append(buf, b...)
		if !greeted {
			i := bytes.IndexByte(buf, '\n')
			if i < 0 {
				return
			}
			buf, greeted = buf[i+1:], true
		}
		for len(buf) >= 9 {
			n := int(binary.LittleEndian.Uint32(buf[5:9]))
			if len(buf) < 9+n {
				return
			}
			ch, payload := binary.LittleEndian.Uint32(buf[:4]), buf[9:9+n]
			buf = buf[9+n:]
			var req struct {
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if ch == 0 && json.Unmarshal(payload, &req) == nil && req.Method == "terminal.read" {
				r.mu.Lock()
				r.reads = append(r.reads, append(json.RawMessage(nil), req.Params...))
				r.mu.Unlock()
			}
		}
	}
}

// read returns the params of the terminal.read the core received for
// terminal.
func (r *readCore) read(t *testing.T, terminal string) map[string]json.RawMessage {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, raw := range r.reads {
		var p map[string]json.RawMessage
		if json.Unmarshal(raw, &p) == nil && string(p["terminal"]) == strconv.Quote(terminal) {
			return p
		}
	}
	t.Fatalf("the core got no terminal.read of %s: %s", terminal, r.reads)
	return nil
}

// termServerReads is termServer with a readCore on the machine's socket.
func termServerReads(t *testing.T, opts Options) (*Server, *readCore) {
	t.Helper()
	s, _, _ := termServer(t, opts, false)
	socket := filepath.Join(os.Getenv("HOME"), "."+brand.Slug, "run", "hc.sock")
	os.Remove(socket)
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	r := &readCore{fakeTermCore: &fakeTermCore{t: t, ln: ln}}
	t.Cleanup(func() { ln.Close(); r.drop() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			r.fakeTermCore.mu.Lock()
			r.conns = append(r.conns, c)
			r.fakeTermCore.mu.Unlock()
			go r.serve(tapConn{Conn: c, tap: r.tap()})
		}
	}()
	return s, r
}

// callRead calls terminal.read with the raw JSON params and returns the
// reply.
func callRead(c *termConn, rid int, params string) map[string]any {
	c.t.Helper()
	c.send(map[string]any{"t": "call", "rid": rid, "m": "x", "method": "terminal.read", "params": json.RawMessage(params)})
	m := c.until("res")
	if m["rid"] != float64(rid) {
		c.t.Fatalf("reply to %d: %v", rid, m)
	}
	return m
}

// A read-only client's terminal.read reads the screen only: the history
// lines it asks for, which would make the terminal core scroll a program on
// the alternate screen, do not reach the core, whatever their type or
// spelling. The rest of its params does.
func TestTermReadOnlyReadsTheScreenOnly(t *testing.T) {
	s, core := termServerReads(t, Options{ReadOnly: true})
	c := dialTerm(t, s)
	c.ready()
	for i, lines := range []string{
		`"lines":50`, `"lines":"50"`, `"lines":null`, `"lines":-1`, `"lines":1.5e3`, `"lines":true`,
		`"lines":[50]`, `"lines":{"n":50}`, `"Lines":50`, `"LINES":50`, `"lines":50`, `"lines":50,"lines":60`,
	} {
		terminal := "r" + strconv.Itoa(i)
		if m := callRead(c, i, `{"terminal":"`+terminal+`",`+lines+`,"future":1}`); m["result"] == nil {
			t.Fatalf("%s: %v", lines, m)
		}
		p := core.read(t, terminal)
		for k := range p {
			if strings.EqualFold(k, "lines") {
				t.Errorf("%s reached the core as %s", lines, p)
			}
		}
		if string(p["future"]) != "1" || len(p) != 2 {
			t.Errorf("%s: the core got %s", lines, p)
		}
	}

	// Params that are not an object are refused as before; null is passed on
	// as before.
	for i, params := range []string{`[{"lines":50}]`, `"lines"`, `50`} {
		if m := callRead(c, 100+i, params); m["error"] == nil || m["error"].(map[string]any)["kind"] != "usage" {
			t.Fatalf("%s: %v", params, m)
		}
	}
	if m := callRead(c, 200, `null`); m["result"] == nil {
		t.Fatalf("null: %v", m)
	}
	core.mu.Lock()
	defer core.mu.Unlock()
	if n := len(core.reads); n != 13 || string(core.reads[n-1]) != "null" {
		t.Fatalf("the core got %s", core.reads)
	}
}

// A client that may write reads history as it asks.
func TestTermReadLines(t *testing.T) {
	s, core := termServerReads(t, Options{})
	c := dialTerm(t, s)
	c.ready()
	for i, lines := range []string{`50`, `"50"`, `{"n":50}`} {
		terminal := "w" + strconv.Itoa(i)
		if m := callRead(c, i, `{"terminal":"`+terminal+`","lines":`+lines+`}`); m["result"] == nil {
			t.Fatalf("%s: %v", lines, m)
		}
		if got := core.read(t, terminal)["lines"]; string(got) != lines {
			t.Errorf("lines %s reached the core as %s", lines, got)
		}
	}
}
