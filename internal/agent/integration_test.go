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
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"webherdr/internal/agentproto"
	"webherdr/internal/herdr"
	"webherdr/internal/transport"
)

const itSession = "webherdr-it"

// startHerdr runs a herdr server in the isolated session and returns an agent
// session and an API client for it.
func startHerdr(t *testing.T) (*transport.Session, *herdr.Client) {
	t.Helper()
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
	t.Cleanup(func() { s.Close() })
	api := &herdr.Client{Dial: func(ctx context.Context) (net.Conn, error) {
		c, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpHerdrAPI, Session: itSession})
		return c, err
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for i := 0; ; i++ {
		if _, err := api.Call(ctx, "ping", nil); err == nil {
			break
		} else if i > 50 {
			t.Fatalf("herdr server did not come up: %v", err)
		}
		time.Sleep(200 * time.Millisecond)
	}
	return s, api
}

// newPane creates a workspace and returns its pane.
func newPane(ctx context.Context, t *testing.T, api *herdr.Client) string {
	t.Helper()
	var created struct {
		RootPane struct {
			PaneID string `json:"pane_id"`
		} `json:"root_pane"`
	}
	if err := api.CallInto(ctx, "workspace.create", map[string]any{"cwd": t.TempDir()}, &created); err != nil {
		t.Fatal(err)
	}
	return created.RootPane.PaneID
}

func TestIntegrationTerminalStream(t *testing.T) {
	s, api := startHerdr(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pane := newPane(ctx, t, api)

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

// keyRow is one entry of the pane input contract shared with the web tests.
type keyRow struct {
	Name  string `json:"name"`
	Bytes string `json:"bytes"`
	Herdr *struct {
		Key    string  `json:"key"`
		Legacy *string `json:"legacy"`
		App    *string `json:"app"`
	} `json:"herdr"`
}

// TestIntegrationKeyParity compares herdr's own key encoding (pane.send_keys,
// which follows the pane's input modes) with the bytes the browser sends
// (web/src/__tests__/testdata/keys.json), in normal mode and in application
// cursor/keypad mode. Differences must be listed in the table.
func TestIntegrationKeyParity(t *testing.T) {
	data, err := os.ReadFile("../../web/src/__tests__/testdata/keys.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []keyRow
	if err := json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	_, api := startHerdr(t)
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	for _, mode := range []struct{ name, setup string }{
		{"legacy", ""},
		{"app", `printf '\033[?1h\033='; `},
	} {
		t.Run(mode.name, func(t *testing.T) {
			pane := newPane(ctx, t, api)
			out := filepath.Join(t.TempDir(), "keys")
			cmd := mode.setup + "stty raw -echo; cat > " + out
			if _, err := api.Call(ctx, "pane.send_text", map[string]any{"pane_id": pane, "text": cmd}); err != nil {
				t.Fatal(err)
			}
			if _, err := api.Call(ctx, "pane.send_keys", map[string]any{"pane_id": pane, "keys": []string{"enter"}}); err != nil {
				t.Fatal(err)
			}
			for i := 0; ; i++ {
				if _, err := os.Stat(out); err == nil {
					break
				} else if i > 100 {
					t.Fatal("raw reader did not start")
				}
				time.Sleep(100 * time.Millisecond)
			}
			// Each key is followed by a separator that no encoding contains.
			var sent []keyRow
			for _, r := range rows {
				if r.Herdr == nil {
					continue
				}
				if _, err := api.Call(ctx, "pane.send_keys", map[string]any{"pane_id": pane, "keys": []string{r.Herdr.Key}}); err != nil {
					t.Fatalf("%s: %v", r.Name, err)
				}
				if _, err := api.Call(ctx, "pane.send_text", map[string]any{"pane_id": pane, "text": "|"}); err != nil {
					t.Fatal(err)
				}
				sent = append(sent, r)
			}
			var got []string
			for i := 0; ; i++ {
				b, _ := os.ReadFile(out)
				if got = strings.Split(string(b), "|"); len(got) > len(sent) {
					break
				} else if i > 100 {
					t.Fatalf("received %q", b)
				}
				time.Sleep(100 * time.Millisecond)
			}
			for i, r := range sent {
				want := r.Bytes
				if r.Herdr.Legacy != nil {
					want = *r.Herdr.Legacy
				}
				if mode.name == "app" && r.Herdr.App != nil {
					want = *r.Herdr.App
				}
				if got[i] != want {
					t.Errorf("%s: herdr sends %q in %s mode, keys.json expects %q; update the table (and the browser mapping if the browser should follow)", r.Name, got[i], mode.name, want)
				}
			}
		})
	}
}
