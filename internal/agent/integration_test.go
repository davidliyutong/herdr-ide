//go:build integration

// Runs against a real herdr binary in an isolated session:
//
//	go test -tags integration ./internal/agent -run Integration -v
package agent_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"os/exec"
	"strings"
	"testing"
	"time"

	"webherdr/internal/agentproto"
	"webherdr/internal/herdr"
	"webherdr/internal/transport"
)

const itSession = "webherdr-it"

func TestIntegrationTerminalStream(t *testing.T) {
	bin, err := exec.LookPath("herdr")
	if err != nil {
		t.Skip("herdr not installed")
	}
	srv := exec.Command(bin, "--session", itSession, "server")
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		exec.Command(bin, "--session", itSession, "server", "stop").Run()
		srv.Process.Kill()
		srv.Wait()
	})

	s, err := transport.DialLocal(context.Background(), "", log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	api := &herdr.Client{Dial: func(ctx context.Context) (net.Conn, error) {
		c, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpHerdrAPI, Session: itSession})
		return c, err
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	for i := 0; ; i++ {
		if _, err := api.Call(ctx, "ping", nil); err == nil {
			break
		} else if i > 50 {
			t.Fatalf("herdr server did not come up: %v", err)
		}
		time.Sleep(200 * time.Millisecond)
	}
	var created struct {
		RootPane struct {
			PaneID string `json:"pane_id"`
		} `json:"root_pane"`
	}
	if err := api.CallInto(ctx, "workspace.create", map[string]any{"cwd": t.TempDir()}, &created); err != nil {
		t.Fatal(err)
	}
	pane := created.RootPane.PaneID

	conn, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpTerm, Session: itSession, Mode: "control", Target: pane, Cols: 90, Rows: 20, Takeover: true})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	agentproto.WriteLine(conn, map[string]any{"type": "terminal.input", "text": "echo it-$((40+2))-ok\r"})

	r := bufio.NewReader(conn)
	var screen strings.Builder
	sawFull := false
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		conn.SetReadDeadline(deadline)
		line, err := r.ReadBytes('\n')
		if err != nil {
			t.Fatalf("stream ended: %v (screen %q)", err, screen.String())
		}
		var f struct {
			Type   string `json:"type"`
			Full   bool   `json:"full"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
			Bytes  []byte `json:"bytes"`
		}
		json.Unmarshal(line, &f)
		if f.Type != "terminal.frame" {
			continue
		}
		if f.Width != 90 || f.Height != 20 {
			t.Fatalf("frame size %dx%d", f.Width, f.Height)
		}
		sawFull = sawFull || f.Full
		screen.Write(f.Bytes)
		if strings.Contains(screen.String(), "it-42-ok") {
			if !sawFull {
				t.Fatal("first frame was not a full frame")
			}
			return
		}
	}
	t.Fatal("command output never appeared")
}
