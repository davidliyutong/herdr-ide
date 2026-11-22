//go:build unix && integration

// Runs captures against a real herdr-core in an isolated session with its
// own state, home and configuration:
//
//	HC_TEST_BIN=/path/to/herdr-core go test -tags integration ./internal/agent/plugin/history -run Integration -v
package history

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
)

const itSession = "herdr-ide-it"

// startCore starts a terminal core whose socket is the agent's in a run
// directory of its own (short: holders listen beside it) and returns the
// agent's environment for it.
func startCore(t *testing.T) *plugin.Env {
	t.Helper()
	bin := os.Getenv("HC_TEST_BIN")
	if bin == "" {
		t.Skip("herdr-core not given (HC_TEST_BIN)")
	}
	root, err := os.MkdirTemp("/tmp", "hhit")
	if err != nil {
		t.Fatal(err)
	}
	os.Chmod(root, 0o700)
	home, base, run, cfg, state := path.Join(root, "h"), path.Join(root, "d"), path.Join(root, "r"), path.Join(root, "c"), path.Join(root, "s")
	for _, d := range []string{home, base, run, cfg, state} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HOME", home)
	environ := []string{"HOME=" + home, "PATH=" + os.Getenv("PATH"), "HC_SESSION=" + itSession,
		"HC_SOCKET=" + path.Join(run, hcSocketName), "XDG_STATE_HOME=" + state, "XDG_CONFIG_HOME=" + cfg}
	core := func(args ...string) ([]byte, error) {
		cmd := exec.Command(bin, args...)
		cmd.Env = environ
		return cmd.CombinedOutput()
	}
	if out, err := core("server", "start", "--json"); err != nil {
		os.RemoveAll(root)
		t.Fatalf("server start: %v: %s", err, out)
	}
	t.Cleanup(func() {
		core("server", "stop", "--json")
		os.RemoveAll(root)
	})
	return &plugin.Env{Home: home, Base: base, RunDir: run, Environ: func() []string { return environ }}
}

// A terminal with scrollback and a title is captured with the lines asked
// for, from its paint's CAN to before its end, without the title; a
// second capture without a change attaches nothing.
func TestIntegrationCapture(t *testing.T) {
	env := startCore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	conn, err := dial(ctx, env.RunDir)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var term hc.Terminal
	err = conn.Call(ctx, "terminal.run", map[string]any{
		"argv": []string{"/bin/sh"}, "cwd": env.Home, "size": map[string]int{"cols": 80, "rows": 24},
	}, &term)
	if err != nil {
		t.Fatal(err)
	}
	s, _, err := conn.Attach(ctx, hc.AttachParams{Terminal: term.Address, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	s.Write([]byte("printf '\\033]2;it-title\\033\\\\'; i=1; while [ $i -le 1500 ]; do echo line-$i; i=$((i+1)); done; echo done-$((40+2))\r"))
	var out []byte
	for !bytes.Contains(out, []byte("done-42")) {
		o, err := s.Recv(ctx)
		if err != nil {
			t.Fatalf("waiting for the output: %v", err)
		}
		out = append(out, o.Data...)
		s.Ack(len(o.Data))
		if len(out) > 1<<20 {
			out = out[len(out)-4096:]
		}
	}
	s.Close()
	// The screen settles (the prompt after the output).
	var last string
	for i := 0; ; i++ {
		var screen struct {
			Text string `json:"text"`
		}
		if err := conn.Call(ctx, "terminal.read", map[string]any{"terminal": term.Address}, &screen); err != nil {
			t.Fatal(err)
		}
		if screen.Text == last && strings.Contains(last, "done-42") {
			break
		}
		if i > 50 {
			t.Fatalf("the screen does not settle: %q", screen.Text)
		}
		last = screen.Text
		time.Sleep(100 * time.Millisecond)
	}

	p := agentproto.HistoryCaptureParams{Lines: 500, MaxTerminals: 8, MaxTotalBytes: 64 << 20, Days: 1}
	res, err := capture(ctx, env, p)
	if err != nil || res.Captured != 1 || res.Failed != 0 {
		t.Fatalf("capture: %+v %v", res, err)
	}
	d, err := read(env, agentproto.HistoryReadParams{Terminal: term.Address, Generation: agentproto.HistoryCurrent})
	if err != nil {
		t.Fatal(err)
	}
	data := d.Data
	t.Logf("snapshot of %d bytes, %dx%d, %d lines", len(data), d.Cols, d.Rows, d.Lines)
	if len(data) == 0 || data[0] != 0x18 {
		t.Fatalf("the snapshot does not start with CAN: %q", data[:min(len(data), 40)])
	}
	for _, bad := range []string{"\x1b]0;", "\x1b]1;", "\x1b]2;", "\x1b[?9001", "it-title"} {
		if bytes.Contains(data, []byte(bad)) {
			t.Errorf("the snapshot holds %q", bad)
		}
	}
	// The grid is the terminal's own now: without a viewer that types, the
	// core gave it its size for headless terminals.
	var now hc.Terminal
	if err := conn.Call(ctx, "terminal.get", map[string]any{"terminal": term.Address}, &now); err != nil {
		t.Fatal(err)
	}
	if d.Lines != 500 || d.Cols != now.Cols || d.Rows != now.Rows || d.PID != *term.PID {
		t.Fatalf("snapshot %+v of a terminal of %dx%d", d.HistorySnapshot, now.Cols, now.Rows)
	}
	// The history part: between the first screen clear and the one before
	// the screen; every line of it is one of the program's.
	clearScreen := []byte("\x1b[H\x1b[2J")
	first := bytes.Index(data, clearScreen)
	second := bytes.Index(data[first+len(clearScreen):], clearScreen)
	if first < 0 || second < 0 {
		t.Fatalf("no history part: %q", data[:min(len(data), 400)])
	}
	history := data[first+len(clearScreen) : first+len(clearScreen)+second]
	if n := bytes.Count(history, []byte("line-")); n != 500 {
		t.Fatalf("%d history lines, want 500", n)
	}
	if restoredByCore(data) {
		t.Fatal("restored without the core's line")
	}

	// Nothing changed: nothing is attached to, nothing written.
	vt := term.Address + ".vt"
	before, ok := generation(t, env.Base, vt)
	if !ok {
		t.Fatal("no snapshot")
	}
	if res, err = capture(ctx, env, p); err != nil || res.Skipped != 1 || res.Captured != 0 {
		t.Fatalf("second capture: %+v %v", res, err)
	}
	if after, ok := generation(t, env.Base, vt); !ok || !bytes.Equal(after, before) {
		t.Fatal("the snapshot was written again")
	}
}
