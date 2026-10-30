package gui

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/transport"
)

func testMachines() *machines.Manager {
	return machines.NewManager([]machines.Spec{
		{ID: "local", Kind: machines.KindLocal, Enabled: true},
		{ID: "m1", Kind: "ssh", Target: "m1", Enabled: true},
	}, nil, log.New(io.Discard, "", 0))
}

func testManager(t *testing.T, args ...string) *Manager {
	st := settings.New("", SettingDefs...)
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	st.RegisterFlags(fs)
	if err := fs.Parse(args); err != nil {
		t.Fatal(err)
	}
	return New(st, log.New(io.Discard, "", 0))
}

// Panes get the display, and VirtualGL as configured, only while the
// display is usable and never on the local machine.
func TestPaneEnv(t *testing.T) {
	mg := testMachines()
	status := &agentproto.GUIStatus{Supported: true, Display: ":20", XAuthority: "/h/.x/run/xauth", GPU: true, VGLPreload: "/usr/lib/libdlfaker.so:/usr/lib/libvglfaker.so"}
	setup := func(m *Manager, phase string) {
		m.mu.Lock()
		d := m.get(mg.Get("m1"))
		d.status, d.phase = status, phase
		m.mu.Unlock()
	}
	m := testManager(t)
	setup(m, PhaseReady)
	env := m.PaneEnv(mg.Get("m1"))
	if env["DISPLAY"] != ":20" || env["XAUTHORITY"] != status.XAuthority || env["VGL_DISPLAY"] != "egl0" || env["LD_PRELOAD"] != "" {
		t.Fatalf("env = %v", env)
	}
	if env := m.PaneEnv(mg.Get("local")); env != nil {
		t.Errorf("local machine env = %v", env)
	}
	setup(m, PhaseUnavailable)
	if env := m.PaneEnv(mg.Get("m1")); env != nil {
		t.Errorf("env without a display = %v", env)
	}

	setup(m, PhaseStarting)
	if env := m.PaneEnv(mg.Get("m1")); env != nil {
		t.Errorf("env while the display starts = %v", env)
	}

	all := testManager(t, "--gui-gpu", "all")
	setup(all, PhaseReady)
	if env := all.PaneEnv(mg.Get("m1")); env["LD_PRELOAD"] != status.VGLPreload || env["VGL_ISACTIVE"] != "1" {
		t.Errorf("gui-gpu=all env = %v", env)
	}
	off := testManager(t, "--gui", "off")
	setup(off, PhaseReady)
	if env := off.PaneEnv(mg.Get("m1")); env != nil {
		t.Errorf("gui=off env = %v", env)
	}
}

// attached returns a manager with a display whose agent side is the
// returned connection, and one window (id 7).
func attached(t *testing.T) (*Manager, *display, net.Conn) {
	m := testManager(t)
	mc := testMachines().Get("m1")
	core, agent := net.Pipe()
	t.Cleanup(func() { core.Close(); agent.Close() })
	m.mu.Lock()
	d := m.get(mc)
	d.stream, d.cmds, d.phase = core, make(chan []byte, 256), PhaseReady
	d.windows[7] = &agentproto.GUIWindow{ID: 7, Title: "plot", W: 640, H: 480}
	d.order = []uint32{7}
	go writeCommands(core, d.cmds)
	m.mu.Unlock()
	return m, d, agent
}

func readCmd(t *testing.T, c net.Conn) agentproto.GUICommand {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	kind, p, err := agentproto.ReadGUI(c)
	if err != nil || kind != agentproto.GUIJSON {
		t.Fatalf("read command: %v (kind %d)", err, kind)
	}
	var cmd agentproto.GUICommand
	json.Unmarshal(p, &cmd)
	return cmd
}

type recorder struct {
	frames []uint32
	events []string
	full   bool
}

func (r *recorder) viewer() *Viewer {
	return &Viewer{Send: func(kind byte, p []byte) bool {
		if r.full {
			return false
		}
		if kind == agentproto.GUIFrame {
			h, _ := agentproto.ParseGUIFrameHeader(p)
			r.frames = append(r.frames, h.Seq)
		} else {
			var ev agentproto.GUIEvent
			json.Unmarshal(p, &ev)
			r.events = append(r.events, ev.Ev)
		}
		return true
	}}
}

func frame(seq uint32) []byte {
	return agentproto.GUIFrameHeader{Window: 7, Layer: 7, W: 1, H: 1, Enc: agentproto.GUIEncPNG, Seq: seq}.Marshal()
}

// The fastest viewer paces the agent; a viewer that falls behind skips
// frames and gets the whole window once it caught up.
func TestFrameRouting(t *testing.T) {
	m, d, agent := attached(t)
	var fast, slow recorder
	fv, sv := fast.viewer(), slow.viewer()
	if !m.Attach("m1", 7, fv) || len(fast.events) != 1 || fast.events[0] != "window" {
		t.Fatalf("attach: events %v", fast.events)
	}
	if c := readCmd(t, agent); c.Cmd != "watch" || c.ID != 7 {
		t.Fatalf("first viewer: %+v", c)
	}
	m.Attach("m1", 7, sv)
	if c := readCmd(t, agent); c.Cmd != "refresh" {
		t.Fatalf("second viewer: %+v", c)
	}
	if m.Attach("m1", 8, &Viewer{Send: func(byte, []byte) bool { return true }}) {
		t.Fatal("attached to a window that does not exist")
	}

	for seq := uint32(1); seq <= 6; seq++ {
		m.frame(d, frame(seq))
		m.Command("m1", 7, fv, agentproto.GUICommand{Cmd: "ack", Seq: seq}, true)
		if c := readCmd(t, agent); c.Cmd != "ack" || c.Seq != seq {
			t.Fatalf("ack %d forwarded as %+v", seq, c)
		}
	}
	if len(fast.frames) != 6 || len(slow.frames) != viewerBacklog || !sv.stale {
		t.Fatalf("fast got %v, slow got %v (stale %v)", fast.frames, slow.frames, sv.stale)
	}
	// Acks behind the fastest viewer are not forwarded; catching up asks
	// for the whole window.
	m.Command("m1", 7, sv, agentproto.GUICommand{Cmd: "ack", Seq: 4}, true)
	if c := readCmd(t, agent); c.Cmd != "refresh" || c.ID != 7 {
		t.Fatalf("caught up: %+v", c)
	}
	// Input is passed on only when allowed.
	m.Command("m1", 7, fv, agentproto.GUICommand{Cmd: "key", Keycode: 38, Down: true}, false)
	m.Command("m1", 7, fv, agentproto.GUICommand{Cmd: "key", Keycode: 39, Down: true, ID: 99}, true)
	if c := readCmd(t, agent); c.Cmd != "key" || c.Keycode != 39 || c.ID != 7 {
		t.Fatalf("input: %+v", c)
	}
}

// Closing a browser window closes the program window after a grace period,
// unless the browser window comes back (a reload).
func TestCloseGrace(t *testing.T) {
	old := closeGrace
	closeGrace = 50 * time.Millisecond
	defer func() { closeGrace = old }()
	m, _, agent := attached(t)
	var r recorder
	v := r.viewer()
	m.Attach("m1", 7, v)
	readCmd(t, agent) // watch

	m.Close("m1", 7) // the beacon may arrive before the WebSocket closes
	m.Detach("m1", 7, v)
	if c := readCmd(t, agent); c.Cmd != "release" {
		t.Fatalf("detach: %+v", c)
	}
	readCmd(t, agent) // unwatch
	v2 := r.viewer()
	m.Attach("m1", 7, v2) // reloaded within the grace period
	if c := readCmd(t, agent); c.Cmd != "watch" {
		t.Fatalf("reattach: %+v", c)
	}
	time.Sleep(4 * closeGrace)

	m.Close("m1", 7)
	m.Detach("m1", 7, v2)
	readCmd(t, agent) // release
	readCmd(t, agent) // unwatch
	if c := readCmd(t, agent); c.Cmd != "close" || c.ID != 7 {
		t.Fatalf("after the grace period: %+v", c)
	}
}

// A machine's own value decides; machines without one follow the global.
func TestPaneEnvPerMachine(t *testing.T) {
	mg := machines.NewManager([]machines.Spec{
		{ID: "a", Kind: "ssh", Target: "a", Enabled: true},
		{ID: "b", Kind: "ssh", Target: "b", Enabled: true},
	}, nil, log.New(io.Discard, "", 0))
	m := testManager(t)
	status := &agentproto.GUIStatus{Supported: true, Display: ":20", XAuthority: "/x", GPU: true, VGLPreload: "/l/a.so:/l/b.so"}
	for _, id := range []string{"a", "b"} {
		m.mu.Lock()
		d := m.get(mg.Get(id))
		d.status, d.phase = status, PhaseReady
		m.mu.Unlock()
	}
	m.Settings.SetFor(SettingGUI, "a", "off")
	m.Settings.SetFor(SettingGPU, "b", GPUAll)
	if env := m.PaneEnv(mg.Get("a")); env != nil {
		t.Errorf("machine turned off gets %v", env)
	}
	if env := m.PaneEnv(mg.Get("b")); env["LD_PRELOAD"] != status.VGLPreload {
		t.Errorf("machine with gui-gpu=all gets %v", env)
	}
	m.Settings.SetFor(SettingGUI, "a", "")
	if env := m.PaneEnv(mg.Get("a")); env["DISPLAY"] != ":20" || env["LD_PRELOAD"] != "" {
		t.Errorf("machine back on the global values gets %v", env)
	}
	m.mu.Lock()
	m.ds["a"].phase = PhaseStarting
	m.mu.Unlock()
	if _, err := m.Enable(context.Background(), mg.Get("a"), nil); !errors.Is(err, ErrNotReady) {
		t.Errorf("enable while the display starts: %v", err)
	}
	m.Settings.SetFor(SettingGUI, "a", "off")
	if _, err := m.Enable(context.Background(), mg.Get("a"), nil); !errors.Is(err, ErrOff) {
		t.Errorf("enable on a machine turned off: %v", err)
	}
}

// Values are single-quoted for the shell, whatever they contain.
func TestExportCommand(t *testing.T) {
	got := ExportCommand(map[string]string{"XAUTHORITY": "/home/o'neil/.x/run/xauth", "DISPLAY": ":20"})
	want := ` export DISPLAY=':20' XAUTHORITY='/home/o'\''neil/.x/run/xauth'`
	if got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

// Read-only mode shows a running display but installs and starts nothing.
func TestPlan(t *testing.T) {
	for _, c := range []struct {
		st       agentproto.GUIStatus
		readOnly bool
		actions  string
		stop     string
	}{
		{agentproto.GUIStatus{}, false, "", PhaseUnsupported},
		{agentproto.GUIStatus{Supported: true, Running: true}, true, "", ""},
		{agentproto.GUIStatus{Supported: true, Xvfb: "/usr/bin/Xvfb"}, true, "", PhaseNotRunning},
		{agentproto.GUIStatus{Supported: true, Installable: true}, true, "", PhaseNotRunning},
		{agentproto.GUIStatus{Supported: true}, false, "", PhaseUnavailable},
		{agentproto.GUIStatus{Supported: true, Installable: true}, false, "install start", ""},
		{agentproto.GUIStatus{Supported: true, Xvfb: "/usr/bin/Xvfb"}, false, "start", ""},
	} {
		actions, stop := plan(&c.st, c.readOnly)
		if strings.Join(actions, " ") != c.actions || stop != c.stop {
			t.Errorf("plan(%+v, %v) = %v, %q", c.st, c.readOnly, actions, stop)
		}
	}
}

// A viewer can acknowledge only frames it was sent, and cannot have the
// window sent in full more often than refreshEvery.
func TestViewerAbuse(t *testing.T) {
	m, d, agent := attached(t)
	var r recorder
	v := r.viewer()
	m.Attach("m1", 7, v)
	readCmd(t, agent) // watch
	m.frame(d, frame(1))
	m.Command("m1", 7, v, agentproto.GUICommand{Cmd: "ack", Seq: 4294967295}, false)
	m.Command("m1", 7, v, agentproto.GUICommand{Cmd: "ack", Seq: 2}, false)
	for i := 0; i < 5; i++ {
		m.Command("m1", 7, v, agentproto.GUICommand{Cmd: "refresh"}, false)
	}
	m.Command("m1", 7, v, agentproto.GUICommand{Cmd: "ack", Seq: 1}, false)
	if c := readCmd(t, agent); c.Cmd != "refresh" {
		t.Fatalf("first refresh: %+v", c)
	}
	if c := readCmd(t, agent); c.Cmd != "ack" || c.Seq != 1 {
		t.Fatalf("forged acks or extra refreshes reached the agent before the real ack: %+v", c)
	}
	if d.acked[7] != 1 {
		t.Errorf("acked = %d", d.acked[7])
	}
	// A frame no viewer got is acknowledged by the core.
	m.Detach("m1", 7, v)
	readCmd(t, agent) // release
	readCmd(t, agent) // unwatch
	m.frame(d, frame(2))
	if c := readCmd(t, agent); c.Cmd != "ack" || c.Seq != 2 {
		t.Fatalf("undelivered frame: %+v", c)
	}
}

// Only known shells waiting at their prompt are typed into.
func TestDecide(t *testing.T) {
	shell := &agentproto.GUIProc{Pid: 10, Comm: "zsh"}
	for _, c := range []struct {
		p     *agentproto.GUIProc
		idle  bool
		typed bool
		want  string
	}{
		{shell, true, false, enableType},
		{shell, false, false, enableBusy},
		{&agentproto.GUIProc{Pid: 10, Comm: "python3"}, true, false, enableBusy}, // exec python
		{&agentproto.GUIProc{Pid: 10, Comm: "claude"}, true, false, enableBusy},
		{&agentproto.GUIProc{Pid: 10, Comm: "tcsh"}, true, false, enableBusy}, // no export
		{nil, true, false, enableBusy},
		{&agentproto.GUIProc{Pid: 10, Comm: "bash", Display: true}, false, false, enableAlready},
		{shell, true, true, enableAlready},
	} {
		if got := decide(c.p, c.idle, c.typed); got != c.want {
			t.Errorf("decide(%+v, idle %v, typed %v) = %s, want %s", c.p, c.idle, c.typed, got, c.want)
		}
	}
}

// Ctrl-C goes first, on its own, then the command with Enter; a failed
// interrupt types nothing.
func TestTypeExport(t *testing.T) {
	old := interruptPause
	interruptPause = time.Millisecond
	defer func() { interruptPause = old }()
	var sent []string
	send := func(s string) error { sent = append(sent, s); return nil }
	if err := typeExport(send, " export DISPLAY=':20'"); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || sent[0] != "\x03" || sent[1] != " export DISPLAY=':20'\r" {
		t.Errorf("sent %q", sent)
	}
	sent = nil
	failing := func(s string) error { sent = append(sent, s); return errors.New("gone") }
	if err := typeExport(failing, "x"); err == nil || len(sent) != 1 {
		t.Errorf("after a failed interrupt: %v, sent %q", err, sent)
	}
}

// A display is prepared once per connection: the machine's state changes
// (every herdr snapshot) do not start it again after a failure; forced
// retries (backoff, setting changes) do, and one arriving while a
// preparation runs is not lost.
func TestEnsureOncePerSession(t *testing.T) {
	a, b := new(transport.Session), new(transport.Session)
	d := &display{}
	if d.claim(nil, false) {
		t.Fatal("prepared without a connection")
	}
	if !d.claim(a, false) {
		t.Fatal("first ensure did not prepare")
	}
	if d.claim(a, false) {
		t.Fatal("prepared twice at once")
	}
	if d.again {
		t.Error("an unforced ensure asked to prepare again")
	}
	if next := d.finish(a, a); next != nil || d.ensuring {
		t.Fatalf("finish = %v, ensuring %v", next, d.ensuring)
	}
	// The preparation failed (no stream): state changes leave it alone.
	for range 3 {
		if d.claim(a, false) {
			t.Fatal("state change prepared again for the same connection")
		}
	}
	d.failures = 2
	if !d.claim(a, true) {
		t.Fatal("forced retry did not prepare")
	}
	if d.failures != 2 {
		t.Errorf("retry on the same connection reset failures to %d", d.failures)
	}
	// A forced ensure while preparing runs it again afterwards.
	d.claim(a, true)
	if next := d.finish(a, a); next != a || !d.ensuring {
		t.Fatalf("forced ensure during preparation: next %v", next)
	}
	d.finish(a, a)
	// A new connection is prepared, also when it came up meanwhile, and
	// starts the backoff over.
	if !d.claim(b, false) || d.failures != 0 {
		t.Fatalf("new connection: failures %d", d.failures)
	}
	d.finish(b, b)
	d.claim(b, true)
	if next := d.finish(b, a); next != a {
		t.Errorf("reconnect during preparation: next %v", next)
	}
	d.finish(a, nil)
	// Attached on the connection: nothing to do even when forced.
	d.stream, d.sess = &net.TCPConn{}, a
	if d.claim(a, true) {
		t.Error("prepared while attached")
	}
}

func TestRetryDelay(t *testing.T) {
	if retryDelay(0) != 5*time.Second || retryDelay(1) != 10*time.Second {
		t.Errorf("delays %v %v", retryDelay(0), retryDelay(1))
	}
	if retryDelay(6) != 5*time.Minute || retryDelay(100) != 5*time.Minute {
		t.Errorf("capped delays %v %v", retryDelay(6), retryDelay(100))
	}
}
