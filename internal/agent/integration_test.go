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

	"herdr-ide/internal/agent"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/herdr"
	"herdr-ide/internal/transport"
)

const itSession = "herdr-ide-it"

// startHerdr runs a herdr server in the isolated session and returns an agent
// session and an API client for it.
func startHerdr(t *testing.T) (*transport.Session, *herdr.Client) {
	t.Helper()
	// HERDR_TEST_BIN selects another herdr, such as the bundled one.
	bin := os.Getenv("HERDR_TEST_BIN")
	if bin == "" {
		var err error
		if bin, err = exec.LookPath("herdr"); err != nil {
			t.Skip("herdr not installed")
		}
	}
	t.Setenv("HERDR_BIN", bin) // the agent must use the same herdr
	// herdr restores a session's saved workspaces when its server starts, so
	// the test starts from an empty session and deletes it again afterwards.
	// This also clears what an interrupted earlier run left behind.
	exec.Command(bin, "--session", itSession, "server", "stop").Run()
	deleteSession(t, bin)
	srv := exec.Command(bin, "--session", itSession, "server")
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		exec.Command(bin, "--session", itSession, "server", "stop").Run()
		srv.Process.Kill()
		srv.Wait()
		deleteSession(t, bin)
	})

	s, err := transport.DialLocal(context.Background(), agent.Options{Logger: log.New(io.Discard, "", 0)})
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

// deleteSession removes the isolated session's saved state. herdr refuses
// while the session's server is still shutting down, so it retries briefly.
func deleteSession(t *testing.T, bin string) {
	t.Helper()
	var out []byte
	var err error
	for range 50 {
		if out, err = exec.Command(bin, "session", "delete", itSession).CombinedOutput(); err == nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Errorf("herdr session delete %s: %v: %s", itSession, err, out)
}

// newPane creates a workspace and returns its pane. The workspace is closed
// when the test ends, before the server stops.
func newPane(ctx context.Context, t *testing.T, api *herdr.Client) string {
	t.Helper()
	var created struct {
		Workspace struct {
			WorkspaceID string `json:"workspace_id"`
		} `json:"workspace"`
		RootPane struct {
			PaneID string `json:"pane_id"`
		} `json:"root_pane"`
	}
	if err := api.CallInto(ctx, "workspace.create", map[string]any{"cwd": t.TempDir()}, &created); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// ctx belongs to the test body and may be cancelled by now.
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := api.Call(ctx, "workspace.close", map[string]any{"workspace_id": created.Workspace.WorkspaceID}); err != nil {
			t.Errorf("workspace.close %s: %v", created.Workspace.WorkspaceID, err)
		}
	})
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

// Starting and stopping a session's server through the agent, as the UI does
// (feature 17). HOME and herdr's directories are temporary, so neither
// herdr's nor the application's real state is touched.
func TestIntegrationHerdrManage(t *testing.T) {
	bin := os.Getenv("HERDR_TEST_BIN")
	if bin == "" {
		var err error
		if bin, err = exec.LookPath("herdr"); err != nil {
			t.Skip("herdr not installed")
		}
	}
	root, err := os.MkdirTemp("/tmp", "hit-") // short: macOS socket paths
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	t.Setenv("HOME", filepath.Join(root, "home"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "state"))
	t.Setenv("HERDR_SOCKET_PATH", "")
	t.Setenv("HERDR_BIN", bin)
	os.MkdirAll(filepath.Join(root, "home"), 0o700)
	t.Cleanup(func() { exec.Command(bin, "--session", itSession, "server", "stop").Run() })

	s, err := transport.DialLocal(context.Background(), agent.Options{Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	op := func(action string) *agentproto.HerdrStatus {
		t.Helper()
		conn, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpHerdr, Action: action, Session: itSession})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		var rep agentproto.Reply
		if err := agentproto.ReadLine(conn, &rep); err != nil || rep.Herdr == nil {
			t.Fatalf("%s: %+v %v", action, rep, err)
		}
		return rep.Herdr
	}
	if st := op("status"); st.Running || st.Bin != bin || st.Version == "" {
		t.Fatalf("status: %+v", st)
	}
	for range 2 { // starting a running server is a no-op
		if st := op("start"); st.Error != "" || !st.Running || st.ServerVersion == "" {
			t.Fatalf("start: %+v", st)
		}
	}
	if st := op("stop"); st.Error != "" || st.Running {
		t.Fatalf("stop: %+v", st)
	}
}
