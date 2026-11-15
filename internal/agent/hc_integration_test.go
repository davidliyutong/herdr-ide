//go:build unix && integration

package agent_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
)

// TestIntegrationHC installs a real herdr-core through the agent, starts the
// agent's terminal core, has it run the Full Disk Access probe, runs a
// program in it through the API pipe and stops the core again. The core's state goes to a temporary directory.
func TestIntegrationHC(t *testing.T) {
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
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	s, home := hcAgent(t, "it")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	digest := fmt.Sprintf("%x", sha256.Sum256(exe))
	conn, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "install", Digest: digest})
	if err != nil {
		t.Fatal(err)
	}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(exe)
	zw.Close()
	cw := agentproto.ChunkWriter{W: conn}
	cw.Write(gz.Bytes())
	cw.Finish()
	var rep agentproto.Reply
	if err := agentproto.ReadLine(conn, &rep); err != nil || !rep.OK || rep.HC.Digest != digest {
		t.Fatalf("install: %+v %v", rep, err)
	}
	conn.Close()

	r, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "start"})
	if err != nil || !r.HC.Running || r.HC.Version == "" || r.HC.Session != "herdr-ide-it" {
		t.Fatalf("start: %+v %v", r, err)
	}
	t.Cleanup(func() {
		s.Request(context.Background(), agentproto.Header{Op: agentproto.OpHC, Action: "stop"})
	})
	if info, err := os.Stat(r.HC.Socket); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode: %v %v", info.Mode(), err)
	}
	// Starting again finds the running core.
	if r, err = s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "start"}); err != nil || !r.HC.Running {
		t.Fatalf("second start: %+v %v", r, err)
	}
	// Full Disk Access as the terminal core has it: the probe runs there
	// (machine.exec). In this home the protected folder is a plain one,
	// which every process opens.
	defer agent.SetPrivacyOS("darwin")()
	if err := os.MkdirAll(filepath.Join(home, "Library", "Safari"), 0o700); err != nil {
		t.Fatal(err)
	}
	if p, err := s.Request(ctx, agentproto.Header{Op: agentproto.OpPrivacy}); err != nil ||
		p.Privacy.Terminals != agentproto.AccessGranted || p.Privacy.Files != agentproto.AccessGranted {
		t.Fatalf("privacy: %+v %v", p.Privacy, err)
	}

	api, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpHCAPI})
	if err != nil {
		t.Fatal(err)
	}
	c, hello, err := hc.Dial(ctx, api)
	if err != nil || hello.Version != r.HC.Version {
		t.Fatalf("dial: %+v %v", hello, err)
	}
	defer c.Close()
	var term hc.Terminal
	if err := c.Call(ctx, "terminal.run", map[string]any{"argv": []string{"/bin/sh"}}, &term); err != nil {
		t.Fatal(err)
	}
	st, _, err := c.Attach(ctx, hc.AttachParams{Terminal: term.Address, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	// Programs inherit the core's environment, with the session and socket
	// the agent selected: herdr-core commands typed in a terminal reach
	// the core that terminal runs in.
	st.Write([]byte("echo got-$((40+2)) session=[$HC_SESSION] socket=[$HC_SOCKET] state=[$XDG_STATE_HOME]\r"))
	var out []byte
	printed := func() bool {
		i := bytes.Index(out, []byte("got-42"))
		return i >= 0 && bytes.IndexByte(out[i:], '\n') >= 0
	}
	for !printed() {
		o, err := st.Recv(ctx)
		if err != nil {
			t.Fatalf("output: %v; got %q", err, out)
		}
		out = append(out, o.Data...)
		st.Ack(len(o.Data))
	}
	line := string(out[bytes.Index(out, []byte("got-42")):])
	if !strings.Contains(line, "session=[herdr-ide-it]") || !strings.Contains(line, "socket=["+r.HC.Socket+"]") {
		t.Fatalf("program environment: %q", line)
	}

	if r, err = s.Request(ctx, agentproto.Header{Op: agentproto.OpHC, Action: "stop"}); err != nil || r.HC.Running {
		t.Fatalf("stop: %+v %v", r, err)
	}
	select {
	case <-c.Done():
	case <-ctx.Done():
		t.Fatal("the connection survived the core")
	}
}
