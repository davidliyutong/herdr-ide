//go:build integration

package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"

	"herdr-ide/internal/agentproto"
)

// TestIntegrationTerm goes from a client of /api/v1/term to a program in a
// real herdr-core: the core installs the executable on the machine, starts
// the terminal core, and the client runs a shell, types and reads.
func TestIntegrationTerm(t *testing.T) {
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
