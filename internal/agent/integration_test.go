//go:build integration

// Runs against a real herdr binary in an isolated session:
//
//	go test -tags integration ./internal/agent -run Integration -v
package agent_test

import (
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
	"herdr-ide/internal/herdr/endpoint"
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

// openEndpoint connects to herdr's client socket through the agent.
func openEndpoint(ctx context.Context, t *testing.T, s *transport.Session, cols, rows uint16) *endpoint.Conn {
	t.Helper()
	raw, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpHerdrClient, Session: itSession})
	if err != nil {
		t.Fatal(err)
	}
	conn, err := endpoint.Handshake(ctx, raw, endpoint.Options{Size: endpoint.Size{Cols: cols, Rows: rows, CellW: 8, CellH: 16}, Active: true})
	if err != nil {
		raw.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// surfaceText returns the rows of pane's inner rectangle.
func surfaceText(s *endpoint.Surface, pane string) string {
	var b strings.Builder
	for _, p := range s.Panes {
		if p.ID != pane {
			continue
		}
		for y := p.Inner.Y; y < p.Inner.Y+p.Inner.H; y++ {
			for x := p.Inner.X; x < p.Inner.X+p.Inner.W; x++ {
				c := s.Frame.Cells[int(y)*int(s.Frame.W)+int(x)]
				if !c.Skip {
					b.WriteString(c.Symbol)
				}
			}
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// The endpoint protocol through the agent: handshake, the first complete
// surface, patches after output, input, and surfaces equal to what a second
// connection receives from scratch.
func TestIntegrationEndpoint(t *testing.T) {
	s, api := startHerdr(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pane := newPane(ctx, t, api)

	conn := openEndpoint(ctx, t, s, 90, 20)
	if conn.Welcome.Generation != 1 || !conn.Has("surface_interest") {
		t.Fatalf("welcome %+v", conn.Welcome)
	}
	type update struct {
		full bool
		text string
	}
	updates := make(chan update, 1024)
	go conn.Run(ctx, func(e endpoint.Event) {
		switch {
		case e.Surface != nil:
			updates <- update{true, surfaceText(e.Surface, pane)}
		case e.Patch != nil:
			updates <- update{false, surfaceText(e.Current, pane)}
		}
	})
	if first := <-updates; !first.full {
		t.Fatal("first update was not a complete surface")
	}
	// The connection shows the tab herdr focuses; select the new pane's.
	if _, err := conn.Request(ctx, "pane.focus", map[string]string{"pane_id": pane}); err != nil {
		t.Fatal(err)
	}
	if snap := conn.Snapshot(); snap.BootID == "" {
		t.Fatalf("snapshot %+v", snap)
	}
	b, err := endpoint.EncodePaneInput(pane, []endpoint.InputEvent{{T: "text", Text: "echo it-$((40+2))-ok"}, {T: "key", Key: &endpoint.KeyEvent{Code: "Enter"}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Send(b); err != nil {
		t.Fatal(err)
	}
	var last string
	for !strings.Contains(last, "\nit-42-ok") {
		select {
		case u := <-updates:
			last = u.text
		case <-ctx.Done():
			t.Fatalf("output never appeared: %q", last)
		}
	}

	// A second connection starts from a complete surface with the same text.
	other := openEndpoint(ctx, t, s, 90, 20)
	got := make(chan string, 1)
	go other.Run(ctx, func(e endpoint.Event) {
		if e.Surface != nil {
			select {
			case got <- surfaceText(e.Surface, pane):
			default:
			}
		}
	})
	if g := <-got; !strings.Contains(g, "\nit-42-ok") {
		t.Fatalf("second connection: %q", g)
	}
}

// slowLink stands for a congested ssh connection: what the core sends
// arrives d later, and what it receives comes at bw bytes per second.
type slowLink struct {
	net.Conn
	bw int
	q  chan []byte
}

func newSlowLink(c net.Conn, d time.Duration, bw int) *slowLink {
	l := &slowLink{Conn: c, bw: bw, q: make(chan []byte, 1024)}
	go func() {
		for b := range l.q {
			time.Sleep(d)
			if _, err := c.Write(b); err != nil {
				return
			}
		}
	}()
	return l
}

func (l *slowLink) Write(b []byte) (int, error) {
	l.q <- append([]byte(nil), b...)
	return len(b), nil
}

func (l *slowLink) Read(b []byte) (int, error) {
	if len(b) > 4096 {
		b = b[:4096]
	}
	n, err := l.Conn.Read(b)
	time.Sleep(time.Duration(n) * time.Second / time.Duration(l.bw))
	return n, err
}

// A window drag over a slow link: herdr answers every new grid size with a
// complete surface (about 90 KB at 200x60). With one resize in flight the
// grid reaches the final size after a few surfaces; sending every size made
// it trail the window by ten seconds at this bandwidth.
func TestIntegrationResizeOverSlowLink(t *testing.T) {
	s, api := startHerdr(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	newPane(ctx, t, api)
	raw, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpHerdrClient, Session: itSession})
	if err != nil {
		t.Fatal(err)
	}
	size := func(cols, rows int) endpoint.Size {
		return endpoint.Size{Cols: uint16(cols), Rows: uint16(rows), CellW: 8, CellH: 16}
	}
	conn, err := endpoint.Handshake(ctx, newSlowLink(raw, 100*time.Millisecond, 150_000), endpoint.Options{Size: size(200, 60), Active: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	sizes := make(chan [2]uint16, 256)
	go conn.Run(ctx, func(e endpoint.Event) {
		if e.Surface != nil {
			sizes <- [2]uint16{e.Surface.Frame.W, e.Surface.Frame.H}
		}
	})
	select {
	case <-sizes:
	case <-ctx.Done():
		t.Fatal("no first surface")
	}
	for i := range 60 {
		conn.Resize(size(200-i, 60-i/3))
		time.Sleep(16 * time.Millisecond)
	}
	end := time.Now()
	seen := map[[2]uint16]bool{}
	for {
		select {
		case wh := <-sizes:
			seen[wh] = true
			if wh != [2]uint16{141, 41} {
				continue
			}
			t.Logf("final size %v after the drag, %d sizes shown", time.Since(end).Round(time.Millisecond), len(seen))
			if len(seen) > 5 {
				t.Errorf("herdr sent %d grid sizes for one drag: %v", len(seen), seen)
			}
			return
		case <-ctx.Done():
			t.Fatalf("the final size never arrived; sizes shown: %v", seen)
		}
	}
}

// herdr refuses another generation with a code the core maps for the UI.
func TestIntegrationEndpointRejectsGeneration(t *testing.T) {
	s, _ := startHerdr(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	raw, _, err := s.Open(ctx, agentproto.Header{Op: agentproto.OpHerdrClient, Session: itSession})
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	// Bypass the client's own size check with a raw hello.
	hello := `{"generation":2,"cell_width_px":8,"cell_height_px":16,"surface_size":{"cols":80,"rows":24},"pixel_mouse":false,"direct_graphics":false,"endpoint_keybindings":false,"mouse_capture":false,"snapshot_codecs":["shell.snapshot.v1"],"surface_codecs":["shell.surface.v1"],"input_codecs":["shell.input.semantic.v1"],"blob_codecs":["shell.blob.v1"]}`
	raw.Write(endpoint.EncodeControl(endpoint.HelloKind, hello))
	p, err := endpoint.ReadFrame(raw, endpoint.MaxHandshakeFrame)
	if err != nil {
		t.Fatal(err)
	}
	m, err := endpoint.DecodeMessage(p)
	if err != nil {
		t.Fatal(err)
	}
	c, ok := m.(endpoint.Control)
	if !ok || c.Kind != endpoint.WelcomeKind || !strings.Contains(c.Data, "unsupported_generation") {
		t.Fatalf("reply %+v", m)
	}
}

// keyRow is one entry of the pane input contract shared with the web tests.
type keyRow struct {
	Name   string                `json:"name"`
	Events []endpoint.InputEvent `json:"events"`
	// Bytes herdr writes to the pane per keyboard mode: legacy, application
	// cursor and keypad, and the kitty keyboard protocol (disambiguate).
	Bytes map[string]string `json:"bytes"`
}

// TestIntegrationKeyParity sends each row's pane input events
// (web/src/__tests__/testdata/keys.json, the events the browser sends) to a
// raw reader through herdr's endpoint, in each keyboard mode, and compares
// the bytes herdr encodes with the table. KEYS_RECORD=1 prints the table's
// bytes from what herdr sends instead.
func TestIntegrationKeyParity(t *testing.T) {
	path := "../../web/src/__tests__/testdata/keys.json"
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rows []keyRow
	if err := json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	s, api := startHerdr(t)
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	conn := openEndpoint(ctx, t, s, 100, 30)
	go conn.Run(ctx, func(endpoint.Event) {})
	recorded := map[string]map[string]string{}

	for _, mode := range []struct{ name, setup string }{
		{"legacy", ""},
		{"app", `printf '\033[?1h\033='; `},
		{"kitty", `printf '\033[>1u'; `},
	} {
		t.Run(mode.name, func(t *testing.T) {
			pane := newPane(ctx, t, api)
			if _, err := conn.Request(ctx, "pane.focus", map[string]string{"pane_id": pane}); err != nil {
				t.Fatal(err)
			}
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
			time.Sleep(200 * time.Millisecond)
			// Each row is followed by a separator that no encoding contains.
			var sent []keyRow
			for _, r := range rows {
				if len(r.Events) == 0 {
					continue
				}
				evs := append(append([]endpoint.InputEvent{}, r.Events...), endpoint.InputEvent{T: "text", Text: "|"})
				b, err := endpoint.EncodePaneInput(pane, evs)
				if err != nil {
					t.Fatalf("%s: %v", r.Name, err)
				}
				if err := conn.Send(b); err != nil {
					t.Fatal(err)
				}
				sent = append(sent, r)
				time.Sleep(20 * time.Millisecond)
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
				if recorded[r.Name] == nil {
					recorded[r.Name] = map[string]string{}
				}
				recorded[r.Name][mode.name] = got[i]
				want, ok := r.Bytes[mode.name]
				if !ok {
					want = r.Bytes["legacy"]
				}
				if os.Getenv("KEYS_RECORD") == "" && got[i] != want {
					t.Errorf("%s: herdr sends %q in %s mode, keys.json expects %q", r.Name, got[i], mode.name, want)
				}
			}
		})
	}
	if os.Getenv("KEYS_RECORD") != "" {
		b, _ := json.Marshal(recorded)
		t.Logf("recorded: %s", b)
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
	// Restarting starts a stopped server and replaces a running one.
	socket := filepath.Join(root, "config", "herdr", "sessions", itSession, "herdr.sock")
	if st := op("restart"); st.Error != "" || !st.Running {
		t.Fatalf("restart stopped: %+v", st)
	}
	before, err := os.Stat(socket)
	if err != nil {
		t.Fatal(err)
	}
	if st := op("restart"); st.Error != "" || !st.Running {
		t.Fatalf("restart running: %+v", st)
	}
	if after, err := os.Stat(socket); err != nil || os.SameFile(before, after) {
		t.Fatalf("server not replaced: %v", err)
	}
	if st := op("stop"); st.Error != "" || st.Running {
		t.Fatalf("stop after restart: %+v", st)
	}
}
