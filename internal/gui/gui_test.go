package gui

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"sort"
	"strings"
	"testing"
	"time"

	"veldr/internal/agentproto"
	"veldr/internal/machines"
	"veldr/internal/settings"
	"veldr/internal/transport"
)

func testMachines() *machines.Manager {
	return machines.NewManager([]machines.Spec{
		{ID: "local", Kind: machines.KindLocal, Enabled: true},
		{ID: "m1", Kind: "ssh", Target: "m1", Enabled: true},
	}, nil, log.New(io.Discard, "", 0))
}

func testManager(t *testing.T, args ...string) *Manager {
	st := settings.New("", Settings)
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
func attached(t *testing.T, flags ...string) (*Manager, *display, net.Conn) {
	m := testManager(t, flags...)
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
	if !m.Attach("m1", 7, fv) || len(fast.events) != 2 || fast.events[0] != "window" || fast.events[1] != "role" {
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
	// A viewer a few frames behind gets them all.
	if len(fast.frames) != 6 || len(slow.frames) != 6 || sv.stale {
		t.Fatalf("fast got %v, slow got %v (stale %v)", fast.frames, slow.frames, sv.stale)
	}
	// Once what it has not shown was shown elsewhere viewerLag ago, it
	// skips frames.
	for i := range sv.sent {
		sv.sent[i].at = sv.sent[i].at.Add(-2 * viewerLag)
	}
	m.frame(d, frame(7))
	m.Command("m1", 7, fv, agentproto.GUICommand{Cmd: "ack", Seq: 7}, true)
	readCmd(t, agent)
	if len(fast.frames) != 7 || len(slow.frames) != 6 || !sv.stale {
		t.Fatalf("fast got %v, slow got %v (stale %v)", fast.frames, slow.frames, sv.stale)
	}
	// Acks behind the fastest viewer are not forwarded; catching up asks
	// for the whole window.
	m.Command("m1", 7, sv, agentproto.GUICommand{Cmd: "ack", Seq: 6}, true)
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

// While another core controls the windows (role), viewers are told, input
// is not passed on, and a viewer may take control.
func TestViewOnly(t *testing.T) {
	m, d, agent := attached(t)
	var r recorder
	v := r.viewer()
	m.Attach("m1", 7, v)
	readCmd(t, agent) // watch
	role := func(control bool) {
		b, _ := json.Marshal(agentproto.GUIEvent{Ev: "role", Control: control})
		m.event(d, b)
	}
	role(false)
	if r.events[len(r.events)-1] != "role" || !m.States()[0].ViewOnly {
		t.Fatalf("view only: events %v, state %+v", r.events, m.States()[0])
	}
	m.Command("m1", 7, v, agentproto.GUICommand{Cmd: "key", Keycode: 38, Down: true}, true)
	m.Command("m1", 7, v, agentproto.GUICommand{Cmd: "control"}, false) // read-only
	m.Command("m1", 7, v, agentproto.GUICommand{Cmd: "control", ID: 7}, true)
	if c := readCmd(t, agent); c.Cmd != "control" || c.ID != 0 {
		t.Fatalf("control: %+v", c)
	}
	role(true)
	m.Command("m1", 7, v, agentproto.GUICommand{Cmd: "key", Keycode: 39, Down: true}, true)
	if c := readCmd(t, agent); c.Cmd != "key" || c.Keycode != 39 {
		t.Fatalf("input in control: %+v", c)
	}
}

// A window's stats go to the browser windows showing it, not to others.
func TestStatsRouting(t *testing.T) {
	m, d, agent := attached(t)
	var r recorder
	m.Attach("m1", 7, r.viewer())
	readCmd(t, agent) // watch
	stats := func(win uint32) []byte {
		b, _ := json.Marshal(agentproto.GUIEvent{Ev: "stats", Stats: &agentproto.GUIStats{Window: win, Frames: 3}})
		return b
	}
	m.event(d, stats(8))
	m.event(d, stats(7))
	if len(r.events) != 3 || r.events[2] != "stats" {
		t.Fatalf("events %v", r.events)
	}
}

// Video goes to windows whose viewers all decode it; a viewer that missed a
// frame of the stream gets nothing until a key frame, which is asked for
// once it caught up.
func TestVideoRouting(t *testing.T) {
	m, d, agent := attached(t)
	var a, b recorder
	av, bv := a.viewer(), b.viewer()
	av.Codecs, bv.Codecs = []string{"vp8", "avc1"}, []string{"vp8"}
	m.Attach("m1", 7, av)
	if c := readCmd(t, agent); c.Cmd != "watch" || strings.Join(c.Codecs, ",") != "avc1,vp8" {
		t.Fatalf("watch: %+v", c)
	}
	m.Attach("m1", 7, bv)
	if c := readCmd(t, agent); c.Cmd != "refresh" || strings.Join(c.Codecs, ",") != "vp8" {
		t.Fatalf("second viewer: %+v", c)
	}
	ev, _ := json.Marshal(agentproto.GUIEvent{Ev: "video", Video: &agentproto.GUIVideo{Window: 7, Codec: "vp8", W: 640, H: 480}})
	m.event(d, ev)
	if a.events[len(a.events)-1] != "video" || b.events[len(b.events)-1] != "video" {
		t.Fatalf("stream start: %v / %v", a.events, b.events)
	}
	vframe := func(seq uint32, key bool) []byte {
		enc := agentproto.GUIEncVideo
		if key {
			enc = agentproto.GUIEncVideoKey
		}
		return agentproto.GUIFrameHeader{Window: 7, Layer: 7, W: 640, H: 480, Enc: enc, Seq: seq}.Marshal()
	}
	ack := func(v *Viewer, seq uint32) {
		m.Command("m1", 7, v, agentproto.GUICommand{Cmd: "ack", Seq: seq}, true)
	}
	m.frame(d, vframe(1, true))
	ack(av, 1)
	readCmd(t, agent) // ack 1
	b.full = true
	m.frame(d, vframe(2, false)) // b misses it
	b.full = false
	ack(av, 2)
	readCmd(t, agent) // ack 2
	m.frame(d, vframe(3, false))
	ack(av, 3)
	readCmd(t, agent) // ack 3
	if fmt.Sprint(b.frames) != "[1]" {
		t.Fatalf("b got %v after missing frame 2", b.frames)
	}
	ack(bv, 1) // caught up: a key frame is asked for
	if c := readCmd(t, agent); c.Cmd != "keyframe" || c.ID != 7 {
		t.Fatalf("after catching up: %+v", c)
	}
	m.frame(d, vframe(4, true))
	m.frame(d, vframe(5, false))
	if fmt.Sprint(b.frames) != "[1 4 5]" || fmt.Sprint(a.frames) != "[1 2 3 4 5]" {
		t.Fatalf("frames a %v b %v", a.frames, b.frames)
	}

	// The viewer left decodes more.
	m.Detach("m1", 7, bv)
	if c := readCmd(t, agent); c.Cmd != "codecs" || strings.Join(c.Codecs, ",") != "avc1,vp8" {
		t.Fatalf("after detach: %+v", c)
	}
	// A viewer joining a running stream starts with it.
	var late recorder
	lv := late.viewer()
	lv.Codecs = []string{"vp8"}
	m.Attach("m1", 7, lv)
	if late.events[len(late.events)-1] != "video" || !lv.needKey {
		t.Fatalf("late viewer: %v", late.events)
	}
	// The stream ends: viewers joining later get pictures.
	end, _ := json.Marshal(agentproto.GUIEvent{Ev: "video", Video: &agentproto.GUIVideo{Window: 7}})
	m.event(d, end)
	if d.video[7] != nil {
		t.Error("ended stream kept")
	}
}

// Without --gui-video agents are told no viewer decodes video.
func TestVideoOff(t *testing.T) {
	m, _, agent := attached(t, "--gui-video=off")
	var r recorder
	v := r.viewer()
	v.Codecs = []string{"avc1"}
	m.Attach("m1", 7, v)
	if c := readCmd(t, agent); c.Cmd != "watch" || len(c.Codecs) != 0 {
		t.Fatalf("watch: %+v", c)
	}
}

// Turning video off or on for a machine tells its agent at once which
// streams the viewers of each window share.
func TestVideoSettingChange(t *testing.T) {
	m, d, agent := attached(t)
	var r recorder
	v := r.viewer()
	v.Codecs = []string{"avc1"}
	m.Attach("m1", 7, v)
	if c := readCmd(t, agent); c.Cmd != "watch" || strings.Join(c.Codecs, ",") != "avc1" {
		t.Fatalf("watch: %+v", c)
	}
	if err := m.Settings.Set(SettingVideo, "m1", false); err != nil {
		t.Fatal(err)
	}
	m.ApplyVideo(d.mc)
	if c := readCmd(t, agent); c.Cmd != "codecs" || c.ID != 7 || len(c.Codecs) != 0 {
		t.Fatalf("off: %+v", c)
	}
	m.Settings.Reset(SettingVideo, "m1")
	m.ApplyVideo(d.mc)
	if c := readCmd(t, agent); c.Cmd != "codecs" || strings.Join(c.Codecs, ",") != "avc1" {
		t.Fatalf("back on: %+v", c)
	}
}

// Read-only mode neither starts a display keeper nor pushes the encoder;
// otherwise the keeper always, the encoder with video on.
func TestAfterAttach(t *testing.T) {
	for _, c := range []struct {
		readOnly, video, keep, push bool
	}{{true, true, false, false}, {true, false, false, false}, {false, true, true, true}, {false, false, true, false}} {
		if keep, push := afterAttach(c.readOnly, c.video); keep != c.keep || push != c.push {
			t.Errorf("readOnly %v video %v: keep %v push %v", c.readOnly, c.video, keep, push)
		}
	}
}

// A keeper started while the terminal core was down leaves; the machine is
// asked again each time the terminal core is reachable again, not on every
// state change, and never in read-only mode.
func TestServerReadyKeeps(t *testing.T) {
	for _, readOnly := range []bool{false, true} {
		m, d, _ := attached(t)
		m.ReadOnly = readOnly
		kept := make(chan string, 8)
		m.keeper = func(d *display) { kept <- d.mc.ID() }
		count := func() int {
			time.Sleep(20 * time.Millisecond)
			return len(kept)
		}
		m.ServerReady(d.mc, false)
		m.ServerReady(d.mc, true)
		m.ServerReady(d.mc, true)
		want := 1
		if readOnly {
			want = 0
		}
		if n := count(); n != want {
			t.Fatalf("read-only %v: %d keep requests after the terminal core came up", readOnly, n)
		}
		m.ServerReady(d.mc, false)
		m.ServerReady(d.mc, true)
		if n := count(); n != 2*want {
			t.Fatalf("read-only %v: %d keep requests after the terminal core came back", readOnly, n)
		}
	}
}

// Commands reaching the agent are the core's: a viewer's refresh carries
// the streams all viewers decode, not its own list, an acknowledgement
// only its number, and the refresh after catching up the streams too.
func TestViewerCommands(t *testing.T) {
	m, d, agent := attached(t)
	var a, b recorder
	av, bv := a.viewer(), b.viewer()
	av.Codecs, bv.Codecs = []string{"avc1", "vp8"}, []string{"vp8"}
	m.Attach("m1", 7, av)
	readCmd(t, agent) // watch
	m.Attach("m1", 7, bv)
	readCmd(t, agent) // refresh
	m.Command("m1", 7, av, agentproto.GUICommand{Cmd: "refresh", Codecs: []string{"avc1"}}, true)
	if c := readCmd(t, agent); c.Cmd != "refresh" || strings.Join(c.Codecs, ",") != "vp8" {
		t.Fatalf("refresh: %+v", c)
	}
	m.frame(d, frame(1))
	m.Command("m1", 7, av, agentproto.GUICommand{Cmd: "ack", Seq: 1, Codecs: []string{"avc1"}, X: 5}, true)
	if c := readCmd(t, agent); c.Cmd != "ack" || c.Seq != 1 || len(c.Codecs) != 0 || c.X != 0 {
		t.Fatalf("ack: %+v", c)
	}
	// b fell behind: it skips frames, then catches up.
	for i := range bv.sent {
		bv.sent[i].at = bv.sent[i].at.Add(-2 * viewerLag)
	}
	m.frame(d, frame(2))
	if !bv.stale {
		t.Fatal("viewer behind not marked")
	}
	m.Command("m1", 7, av, agentproto.GUICommand{Cmd: "ack", Seq: 2}, true)
	readCmd(t, agent) // ack 2
	m.Command("m1", 7, bv, agentproto.GUICommand{Cmd: "ack", Seq: 1}, true)
	if c := readCmd(t, agent); c.Cmd != "refresh" || strings.Join(c.Codecs, ",") != "vp8" {
		t.Fatalf("refresh after catching up: %+v", c)
	}
	// A viewer holding viewerMaxBytes unshown skips frames.
	bv.sentBytes = viewerMaxBytes
	if !bv.behind(0, time.Now()) {
		t.Error("a viewer over the byte limit is not behind")
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
	m.Settings.Set(SettingGUI, "a", false)
	m.Settings.Set(SettingGPU, "b", GPUAll)
	if env := m.PaneEnv(mg.Get("a")); env != nil {
		t.Errorf("machine turned off gets %v", env)
	}
	if env := m.PaneEnv(mg.Get("b")); env["LD_PRELOAD"] != status.VGLPreload {
		t.Errorf("machine with gui-gpu=all gets %v", env)
	}
	m.Settings.Reset(SettingGUI, "a")
	if env := m.PaneEnv(mg.Get("a")); env["DISPLAY"] != ":20" || env["LD_PRELOAD"] != "" {
		t.Errorf("machine back on the global values gets %v", env)
	}
	m.mu.Lock()
	m.ds["a"].phase = PhaseStarting
	m.mu.Unlock()
	if _, err := m.Enable(context.Background(), mg.Get("a"), nil, nil); !errors.Is(err, ErrNotReady) {
		t.Errorf("enable while the display starts: %v", err)
	}
	m.Settings.Set(SettingGUI, "a", false)
	if _, err := m.Enable(context.Background(), mg.Get("a"), nil, nil); !errors.Is(err, ErrOff) {
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
// The GPU display is started where the machine can run it and the setting
// does not say xvfb; a display of the other kind is started anew (the
// agent replaces it while no program uses it).
func TestPlan(t *testing.T) {
	const xvfb, xwl = agentproto.GUIXvfb, agentproto.GUIXwayland
	for _, c := range []struct {
		st       agentproto.GUIStatus
		readOnly bool
		asked    string
		actions  string
		stop     string
	}{
		{agentproto.GUIStatus{}, false, DisplayAuto, "", PhaseUnsupported},
		{agentproto.GUIStatus{Supported: true, Running: true}, true, DisplayAuto, "", ""},
		{agentproto.GUIStatus{Supported: true, Xvfb: "/usr/bin/Xvfb"}, true, DisplayAuto, "", PhaseNotRunning},
		{agentproto.GUIStatus{Supported: true, Installable: true}, true, DisplayAuto, "", PhaseNotRunning},
		{agentproto.GUIStatus{Supported: true}, false, DisplayAuto, "", PhaseUnavailable},
		{agentproto.GUIStatus{Supported: true, Installable: true}, false, DisplayAuto, "install start", ""},
		{agentproto.GUIStatus{Supported: true, Xvfb: "/usr/bin/Xvfb"}, false, DisplayAuto, "start", ""},
		// The GPU display needs no Xvfb; with xvfb asked for it is not used.
		{agentproto.GUIStatus{Supported: true, GPUDisplay: true}, false, DisplayAuto, "start", ""},
		{agentproto.GUIStatus{Supported: true, GPUDisplay: true}, false, DisplayXvfb, "", PhaseUnavailable},
		{agentproto.GUIStatus{Supported: true, GPUDisplay: true, Installable: true}, false, DisplayXvfb, "install start", ""},
		{agentproto.GUIStatus{Supported: true, GPUDisplay: true}, true, DisplayAuto, "", PhaseNotRunning},
		// A display that runs: attached when it is of the kind wanted, or
		// of an agent that names none; started anew otherwise, never in
		// read-only mode.
		{agentproto.GUIStatus{Supported: true, Running: true, Kind: xwl, GPUDisplay: true}, false, DisplayAuto, "", ""},
		{agentproto.GUIStatus{Supported: true, Running: true, Kind: xvfb, GPUDisplay: true}, false, DisplayAuto, "start", ""},
		{agentproto.GUIStatus{Supported: true, Running: true, Kind: xvfb, GPUDisplay: true}, true, DisplayAuto, "", ""},
		{agentproto.GUIStatus{Supported: true, Running: true, Kind: xwl, GPUDisplay: true}, false, DisplayXvfb, "start", ""},
		{agentproto.GUIStatus{Supported: true, Running: true, Kind: xvfb, GPUDisplay: true}, false, DisplayXvfb, "", ""},
		{agentproto.GUIStatus{Supported: true, Running: true, Kind: xvfb}, false, DisplayAuto, "", ""},
		{agentproto.GUIStatus{Supported: true, Running: true, GPUDisplay: true}, false, DisplayAuto, "", ""},
	} {
		actions, stop := plan(&c.st, c.readOnly, c.asked)
		if strings.Join(actions, " ") != c.actions || stop != c.stop {
			t.Errorf("plan(%+v, %v, %s) = %v, %q", c.st, c.readOnly, c.asked, actions, stop)
		}
	}
}

// On a machine with several NVIDIA GPUs browsers are told which one
// windows of Vulkan programs come from. With the setting on and the
// library installed, panes get it with the table of GPUs, before
// VirtualGL's libraries; on the GPU display VirtualGL is not preloaded.
func TestPaneEnvGPUs(t *testing.T) {
	mg := testMachines()
	zero := 0
	status := func() *agentproto.GUIStatus {
		return &agentproto.GUIStatus{Supported: true, Display: ":20", XAuthority: "/h/.x/run/xauth", Running: true, Kind: agentproto.GUIXvfb,
			GPU: true, VGLPreload: "/usr/lib/libdlfaker.so:/usr/lib/libvglfaker.so", Pick: "/h/.x/gpupick/0123/gpupick.so",
			GPUs: []agentproto.GUIGPU{
				{Index: 0, Minor: 1, UUID: "GPU-70987003", Model: "A"},
				{Index: 1, Minor: 0, UUID: "GPU-dd0ff3fe", Model: "A"},
			}}
	}
	setup := func(m *Manager, st *agentproto.GUIStatus) State {
		m.mu.Lock()
		defer m.mu.Unlock()
		d := m.get(mg.Get("m1"))
		d.status, d.phase = st, PhaseReady
		return m.stateLocked(d)
	}
	off := testManager(t)
	st := setup(off, status())
	if st.VulkanGPU == nil || *st.VulkanGPU != 1 || st.Pick || st.Display != agentproto.GUIXvfb {
		t.Errorf("state = %+v", st)
	}
	if env := off.PaneEnv(mg.Get("m1")); env["LD_PRELOAD"] != "" || env["GPUPICK_TABLE"] != "" {
		t.Errorf("setting off: %v", env)
	}

	on := testManager(t, "--gui-gpu-pick", "true")
	if st := setup(on, status()); !st.Pick {
		t.Errorf("state with the setting on = %+v", st)
	}
	env := on.PaneEnv(mg.Get("m1"))
	if env["LD_PRELOAD"] != "/h/.x/gpupick/0123/gpupick.so" || env["GPUPICK_TABLE"] != "GPU-70987003=1,GPU-dd0ff3fe=0" ||
		env["GPUPICK_MIXED"] != "" || env["GPUPICK_DISPLAY"] != "" || env["VGL_DISPLAY"] != "egl0" {
		t.Errorf("env = %v", env)
	}
	// The GPU display draws with one of them; GPUs of two models.
	gpu := status()
	gpu.Kind, gpu.DisplayMinor, gpu.GPUs[1].Model = agentproto.GUIXwayland, &zero, "B"
	if st := setup(on, gpu); st.Display != agentproto.GUIXwayland {
		t.Errorf("state on the GPU display = %+v", st)
	}
	if env := on.PaneEnv(mg.Get("m1")); env["GPUPICK_DISPLAY"] != "0" || env["GPUPICK_MIXED"] != "1" {
		t.Errorf("env on the GPU display = %v", env)
	}
	// Not without the library, nor with a single GPU.
	missing := status()
	missing.Pick = ""
	if st := setup(on, missing); st.Pick {
		t.Errorf("state without the library = %+v", st)
	}
	if env := on.PaneEnv(mg.Get("m1")); env["LD_PRELOAD"] != "" || env["DISPLAY"] != ":20" {
		t.Errorf("env without the library = %v", env)
	}
	one := status()
	one.GPUs = one.GPUs[:1]
	if st := setup(on, one); st.Pick || st.VulkanGPU != nil {
		t.Errorf("state with one GPU = %+v", st)
	}
	if env := on.PaneEnv(mg.Get("m1")); env["LD_PRELOAD"] != "" {
		t.Errorf("env with one GPU = %v", env)
	}

	// With every program under VirtualGL: both libraries, gpupick first.
	all := testManager(t, "--gui-gpu-pick", "true", "--gui-gpu", "all")
	setup(all, status())
	if env := all.PaneEnv(mg.Get("m1")); env["LD_PRELOAD"] != "/h/.x/gpupick/0123/gpupick.so:/usr/lib/libdlfaker.so:/usr/lib/libvglfaker.so" || env["VGL_ISACTIVE"] != "1" {
		t.Errorf("gui-gpu=all env = %v", env)
	}
	setup(all, gpu)
	if env := all.PaneEnv(mg.Get("m1")); env["LD_PRELOAD"] != "/h/.x/gpupick/0123/gpupick.so" || env["VGL_ISACTIVE"] != "" || env["VGL_DISPLAY"] != "egl0" {
		t.Errorf("gui-gpu=all env on the GPU display = %v", env)
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

// fakeShells stands in for the terminal core's terminals in Enable: each
// terminal's answers to Shell in turn (the last one repeats), and what was
// typed into it.
type fakeShells struct {
	answers map[string][]fakeShell
	asked   map[string]int
	sent    map[string][]string
}

type fakeShell struct {
	pid  int
	idle bool
	err  error
}

func (f *fakeShells) All(context.Context) ([]string, error) {
	var ids []string
	for id := range f.answers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}

func (f *fakeShells) Shell(_ context.Context, id string) (int, bool, error) {
	a := f.answers[id]
	n := f.asked[id]
	f.asked[id]++
	if n >= len(a) {
		n = len(a) - 1
	}
	return a[n].pid, a[n].idle, a[n].err
}

func (f *fakeShells) Send(_ context.Context, id, text string) error {
	f.sent[id] = append(f.sent[id], text)
	return nil
}

// Enable types only into known shells waiting at their prompt, also when
// checked again right before; busy terminals (a program in front, a shell
// that started one meanwhile, no shell), unreachable ones and shells started
// with the display are reported, not typed into. Enabling again types into
// no shell twice, until the display changes.
func TestEnable(t *testing.T) {
	old, oldProcs := interruptPause, shellProcs
	interruptPause = time.Millisecond
	defer func() { interruptPause, shellProcs = old, oldProcs }()
	var askedPids [][]string
	shellProcs = func(_ context.Context, _ *machines.Machine, pids []string) (map[int]*agentproto.GUIProc, error) {
		askedPids = append(askedPids, pids)
		procs := map[int]*agentproto.GUIProc{}
		for _, p := range []agentproto.GUIProc{
			{Pid: 11, Comm: "zsh"}, {Pid: 12, Comm: "bash"}, {Pid: 13, Comm: "claude"},
			{Pid: 15, Comm: "zsh"}, {Pid: 16, Comm: "bash", Display: true},
		} {
			procs[p.Pid] = &p
		}
		return procs, nil
	}
	mc := testMachines().Get("m1")
	m := testManager(t)
	setDisplay := func(display string) {
		m.mu.Lock()
		d := m.get(mc)
		d.status, d.phase = &agentproto.GUIStatus{Supported: true, Display: display, XAuthority: "/x"}, PhaseReady
		m.mu.Unlock()
	}
	setDisplay(":20")
	sh := &fakeShells{asked: map[string]int{}, sent: map[string][]string{}, answers: map[string][]fakeShell{
		"idle":    {{pid: 11, idle: true}},
		"running": {{pid: 12, idle: false}},                        // a program in front of its shell
		"exec":    {{pid: 13, idle: true}},                         // claude replaced the shell
		"noshell": {{pid: 0}},                                      // no shell
		"started": {{pid: 15, idle: true}, {pid: 15, idle: false}}, // started a program meanwhile
		"display": {{pid: 16, idle: true}},                         // started with the display
		"gone":    {{err: errors.New("no such terminal")}},
	}}
	res, err := m.Enable(context.Background(), mc, sh, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Enabled != 1 || res.Already != 1 || fmt.Sprint(res.Typed) != "[idle]" || fmt.Sprint(res.Failed) != "[gone]" {
		t.Errorf("result %+v", res)
	}
	busy := append([]string(nil), res.Busy...)
	sort.Strings(busy)
	if fmt.Sprint(busy) != "[exec noshell running started]" {
		t.Errorf("busy %v", res.Busy)
	}
	if fmt.Sprint(sh.sent) != fmt.Sprintf("map[idle:[\x03 %s\r]]", res.Command) || !strings.Contains(res.Command, "DISPLAY=':20'") {
		t.Errorf("typed %q, command %q", sh.sent, res.Command)
	}
	if len(askedPids) != 1 || len(askedPids[0]) != 5 {
		t.Errorf("asked the agent about %v", askedPids)
	}

	// Again: the shell typed into has the display; nothing is typed.
	sh.sent = map[string][]string{}
	res, err = m.Enable(context.Background(), mc, sh, []string{"idle", "display"})
	if err != nil || res.Enabled != 0 || res.Already != 2 || len(sh.sent) != 0 {
		t.Errorf("enabled again: %+v %v, typed %q", res, err, sh.sent)
	}

	// A new display: the shell gets it.
	setDisplay(":21")
	res, err = m.Enable(context.Background(), mc, sh, []string{"idle"})
	if err != nil || res.Enabled != 1 || len(sh.sent["idle"]) != 2 || !strings.Contains(sh.sent["idle"][1], "DISPLAY=':21'") {
		t.Errorf("after the display changed: %+v %v, typed %q", res, err, sh.sent)
	}

	// The agent cannot be asked: nothing is typed.
	shellProcs = func(context.Context, *machines.Machine, []string) (map[int]*agentproto.GUIProc, error) {
		return nil, errors.New("machine not connected")
	}
	sh.sent = map[string][]string{}
	if _, err := m.Enable(context.Background(), mc, sh, []string{"started"}); err == nil || len(sh.sent) != 0 {
		t.Errorf("without the agent: %v, typed %q", err, sh.sent)
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
// (the terminal core's state, a rename) do not start it again after a
// failure; forced retries (backoff, setting changes) do, and one arriving
// while a preparation runs is not lost.
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

// A machine that is disabled, reconnects or fails leaves no display error
// or windows on screen; a removed one is forgotten, and a preparation still
// running for it publishes nothing.
func TestDisconnectedAndForget(t *testing.T) {
	m, d, agent := attached(t)
	var got []State
	m.OnState = func(st State) { got = append(got, st) }
	mc := d.mc

	m.Disconnected(mc)
	if len(got) != 1 || got[0].Phase != PhaseDisconnected || len(got[0].Windows) != 0 || got[0].Error != "" {
		t.Fatalf("states after disconnect = %+v", got)
	}
	m.mu.Lock()
	if d.stream != nil {
		t.Error("still attached after disconnect")
	}
	m.mu.Unlock()
	// The attach stream was closed.
	agent.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := agent.Read(make([]byte, 1)); err == nil {
		t.Error("attach stream still open")
	}
	m.Disconnected(mc)
	if len(got) != 1 {
		t.Errorf("repeated disconnect published %d states", len(got))
	}

	// A failure seen after the machine lost its connection is no error.
	m.mu.Lock()
	d.phase, d.err = PhaseStarting, ""
	m.mu.Unlock()
	m.fail(d, new(transport.Session), errors.New("stream closed"))
	if last := got[len(got)-1]; last.Phase != PhaseDisconnected || last.Error != "" {
		t.Errorf("failure on a lost connection = %+v", last)
	}

	m.Forget(mc.ID())
	if last := got[len(got)-1]; last.Phase != PhaseDisconnected {
		t.Errorf("forgotten machine = %+v", last)
	}
	if len(m.States()) != 0 {
		t.Errorf("states after forget = %+v", m.States())
	}
	n := len(got)
	m.setPhase(d, PhaseError, errors.New("late"))
	if len(got) != n {
		t.Errorf("a removed machine's preparation published %+v", got[n:])
	}
}

// Detaching when the setting is turned off works the same way.
func TestApplyOffDetaches(t *testing.T) {
	m, d, _ := attached(t, "--gui", "off")
	var got []State
	m.OnState = func(st State) { got = append(got, st) }
	m.Apply(d.mc)
	if len(got) != 1 || got[0].Phase != PhaseOff || len(got[0].Windows) != 0 {
		t.Fatalf("states = %+v", got)
	}
}
