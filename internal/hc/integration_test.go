//go:build integration

// Runs against a real herdr-core in an isolated session with its own state:
//
//	HC_TEST_BIN=/path/to/herdr-core go test -tags integration ./internal/hc -run Integration -v
package hc

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const itSession = "herdr-ide-it"

// startCore starts a core whose socket and state live in temporary
// directories and returns a connection to it and its hello.
func startCore(t *testing.T) (*Conn, *Hello) {
	t.Helper()
	bin := os.Getenv("HC_TEST_BIN")
	if bin == "" {
		var err error
		if bin, err = exec.LookPath("hc"); err != nil {
			t.Skip("herdr-core not installed (HC_TEST_BIN)")
		}
	}
	// The socket path must stay short (holders listen beside it).
	run, err := os.MkdirTemp("/tmp", "hcit")
	if err != nil {
		t.Fatal(err)
	}
	os.Chmod(run, 0o700)
	socket := filepath.Join(run, "hc.sock")
	env := append(os.Environ(), "HC_SESSION="+itSession, "HC_SOCKET="+socket, "XDG_STATE_HOME="+t.TempDir())
	hc := func(args ...string) ([]byte, error) {
		cmd := exec.Command(bin, args...)
		cmd.Env = env
		return cmd.CombinedOutput()
	}
	if out, err := hc("server", "start", "--json"); err != nil {
		t.Fatalf("server start: %v: %s", err, out)
	}
	t.Cleanup(func() {
		hc("server", "stop", "--json")
		os.RemoveAll(run)
	})
	nc, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	c, h, err := Dial(context.Background(), nc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c, h
}

// until receives output until a line of it contains want, returning all of it.
func until(t *testing.T, ctx context.Context, s *Stream, want string) string {
	t.Helper()
	var all []byte
	done := func() bool {
		i := bytes.Index(all, []byte(want))
		return i >= 0 && bytes.IndexByte(all[i:], '\n') >= 0
	}
	for !done() {
		o, err := s.Recv(ctx)
		if err != nil {
			t.Fatalf("waiting for %q: %v; got %q", want, err, all)
		}
		all = append(all, o.Data...)
		s.Ack(len(o.Data))
	}
	return string(all)
}

func TestIntegrationTerminal(t *testing.T) {
	c, h := startCore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	t.Logf("core %s, features %v", h.Version, h.Features)
	if h.Version == "" || h.Core.ID == "" || len(h.Methods) == 0 {
		t.Fatalf("hello %+v", h)
	}

	events, snap, err := c.Subscribe(ctx, SubscribeParams{})
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Terminals) != 0 {
		t.Fatalf("a new session has terminals: %+v", snap.Terminals)
	}
	next := func(typ string) Notification {
		t.Helper()
		for {
			n, err := events.Recv(ctx)
			if err != nil {
				t.Fatalf("waiting for %s: %v", typ, err)
			}
			if n.Type == typ {
				return n
			}
		}
	}

	var term Terminal
	err = c.Call(ctx, "terminal.run", map[string]any{
		"argv": []string{"/bin/sh"}, "cwd": "/", "size": map[string]int{"cols": 80, "rows": 24},
		"labels": map[string]string{"app": "it"},
	}, &term)
	if err != nil {
		t.Fatal(err)
	}
	if term.State != "live" || term.Cols != 80 || term.Rows != 24 || term.Labels["app"] != "it" {
		t.Fatalf("terminal %+v", term)
	}
	if n := next("created"); n.Terminal != term.Address {
		t.Fatalf("created %+v", n)
	}

	s, a, err := c.Attach(ctx, AttachParams{Terminal: term.Address, Cols: 100, Rows: 30})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("attached: automatic_input %v", a.AutomaticInput)
	var size struct{ Cols, Rows int }
	if n := next("size"); json.Unmarshal(n.Data, &size) != nil || size.Cols != 100 || size.Rows != 30 {
		t.Fatalf("size after attach: %s", n.Data)
	}

	// Raw bytes both ways; the program's environment names its terminal and
	// carries none of the state directories this test set for the core.
	s.Write([]byte("echo out-$((40+2)) id=$HC_TERMINAL_ID sock=$HC_TERMINAL_SOCKET term=$TERM stty=$(stty size)\r"))
	out := until(t, ctx, s, "out-42")
	t.Logf("output: %q", out)
	if !strings.Contains(out, "id="+term.Address) || !strings.Contains(out, "term=xterm-256color") || !strings.Contains(out, "stty=30 100") {
		t.Fatalf("environment or size: %q", out)
	}

	if err := s.Resize(90, 20); err != nil {
		t.Fatal(err)
	}
	if n := next("size"); json.Unmarshal(n.Data, &size) != nil || size.Cols != 90 || size.Rows != 20 {
		t.Fatalf("size after resize: %s", n.Data)
	}

	// A second viewer gets a first paint of what is on the screen.
	s2, _, err := c.Attach(ctx, AttachParams{Terminal: term.Address, Cols: 90, Rows: 20, Observe: true})
	if err != nil {
		t.Fatal(err)
	}
	until(t, ctx, s2, "out-42")
	s2.Close()

	// Documents: versioned writes.
	var doc struct {
		Value   json.RawMessage `json:"value"`
		Version uint64          `json:"version"`
	}
	if err := c.Call(ctx, "doc.get", map[string]any{"name": "layout"}, &doc); err != nil || doc.Version != 0 {
		t.Fatalf("doc.get %+v %v", doc, err)
	}
	if err := c.Call(ctx, "doc.set", map[string]any{"name": "layout", "value": map[string]int{"n": 1}, "version": 0}, &doc); err != nil {
		t.Fatal(err)
	}
	err = c.Call(ctx, "doc.set", map[string]any{"name": "layout", "value": 2, "version": 0}, nil)
	var e *Error
	if !asError(err, &e) || e.Kind != "conflict" {
		t.Fatalf("stale doc.set: %v", err)
	}
	if n := next("doc"); !strings.Contains(string(n.Data), `"layout"`) {
		t.Fatalf("doc event %+v", n)
	}

	// The program ends: the stream closes with how.
	if err := c.Call(ctx, "terminal.kill", map[string]any{"terminal": term.Address}, nil); err != nil {
		t.Fatal(err)
	}
	for {
		o, err := s.Recv(ctx)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		s.Ack(len(o.Data))
	}
	if x := s.Exit(); x == nil || x.Reason != "killed" {
		t.Fatalf("exit %+v", x)
	}
	next("finished")

	if err := c.Call(ctx, "terminal.attach", AttachParams{Terminal: "t999", Cols: 80, Rows: 24}, nil); !asError(err, &e) || e.Kind != "not_found" {
		t.Fatalf("attach to a missing terminal: %v", err)
	}
}

func asError(err error, e **Error) bool {
	x, ok := err.(*Error)
	*e = x
	return ok
}
