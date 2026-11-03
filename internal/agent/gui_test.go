package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"math"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/composite"
	"github.com/jezek/xgb/xproto"

	"herdr-ide/internal/agentproto"
)

// Each start writes a new cookie for the display, to Xvfb's file and the
// panes' file, both private.
func TestCookieRotation(t *testing.T) {
	g := newGUI(testAgent(t))
	if err := g.newCookie(21); err != nil {
		t.Fatal(err)
	}
	c1, err := g.serverCookie()
	if err != nil || len(c1) != 16 {
		t.Fatalf("cookie = %x, %v", c1, err)
	}
	if pane, _ := readXauthCookie(g.xauthPath()); !bytes.Equal(pane, c1) {
		t.Error("panes' file has another cookie")
	}
	for _, p := range []string{g.xauthPath(), g.serverAuthPath()} {
		if info, _ := os.Stat(p); info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode %v", p, info.Mode().Perm())
		}
	}
	b, _ := os.ReadFile(g.xauthPath())
	if !bytes.HasPrefix(b, []byte{0xff, 0xff, 0, 0, 0, 2, '2', '1', 0, 18}) {
		t.Errorf("not a FamilyWild entry for display 21: %x", b[:10])
	}
	g.newCookie(21)
	if c2, _ := g.serverCookie(); bytes.Equal(c1, c2) {
		t.Error("cookie not rotated")
	}
}

// useTmp makes the X socket and lock files live in a private directory.
func useTmp(t *testing.T) string {
	old := xTmp
	xTmp = shortTempDir(t)
	t.Cleanup(func() { xTmp = old })
	os.Mkdir(xTmp+"/.X11-unix", 0o1777)
	return xTmp
}

// A reservation is kept only while nothing of another user's, and no other
// server, is on the number: another user could pose as the X server.
func TestDisplayReservation(t *testing.T) {
	useTmp(t)
	g := newGUI(testAgent(t))
	n, err := g.display()
	if err != nil || n != guiFirstDisplay {
		t.Fatalf("display = %d, %v", n, err)
	}
	if m, _ := g.display(); m != n {
		t.Fatalf("reservation not kept: %d then %d", n, m)
	}
	me, other := os.Getuid(), os.Getuid()+1
	if !usableBy(n, guiState{}, me) {
		t.Fatal("empty number not usable")
	}
	// Files of another user (played by another uid) make the number unusable.
	os.WriteFile(xLock(n), []byte("         0\n"), 0o644)
	if usableBy(n, guiState{}, other) {
		t.Error("lock file of another user accepted")
	}
	if !usableBy(n, guiState{}, me) {
		t.Error("own stale lock file refused")
	}
	// A live lock of another server of ours moves the reservation.
	os.WriteFile(xLock(n), []byte(fmt.Sprintf("%10d\n", os.Getpid())), 0o644)
	if m, _ := g.display(); m == n {
		t.Errorf("display %d kept although another server holds it", n)
	}
	os.Remove(xLock(n))
	if runtime.GOOS == "linux" {
		// A listener counts only when it is the server this instance started.
		ln, err := net.Listen("unix", xSocket(n))
		if err != nil {
			t.Fatal(err)
		}
		defer ln.Close()
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				c.Close()
			}
		}()
		if usableBy(n, guiState{}, me) || usableBy(n, guiState{Pid: os.Getpid()}, other) {
			t.Error("foreign listener accepted")
		}
		if !usableBy(n, guiState{Display: n, Pid: os.Getpid()}, me) {
			t.Error("own server refused")
		}
		g.writeState(guiState{Display: n, Pid: 999999999})
		if g.running(n) {
			t.Error("running() trusts a server this instance did not start")
		}
		g.writeState(guiState{Display: n, Pid: os.Getpid()})
		if g.running(n) {
			t.Error("running() accepts a server without its abstract socket, which anyone could take")
		}
		abs, err := net.Listen("unix", "@"+xSocket(n))
		if err != nil {
			t.Fatal(err)
		}
		defer abs.Close()
		go func() {
			for {
				c, err := abs.Accept()
				if err != nil {
					return
				}
				c.Close()
			}
		}()
		if !g.running(n) {
			t.Error("running() does not recognize this instance's server")
		}
	}
}

// The socket directory must not be a link or an unprotected directory.
func TestX11DirSafe(t *testing.T) {
	dir := useTmp(t)
	if !x11DirSafe() {
		t.Fatal("sticky directory refused")
	}
	os.Chmod(dir+"/.X11-unix", 0o777)
	if x11DirSafe() {
		t.Error("world-writable directory without sticky bit accepted")
	}
	os.Chmod(dir+"/.X11-unix", 0o770)
	if x11DirSafe() {
		t.Error("group-writable directory without sticky bit accepted")
	}
	os.Chmod(dir+"/.X11-unix", 0o755)
	if !x11DirSafe() {
		t.Error("directory only the user can write refused")
	}
	os.Remove(dir + "/.X11-unix")
	os.Symlink(t.TempDir(), dir+"/.X11-unix")
	if x11DirSafe() {
		t.Error("symlink accepted")
	}
	if _, err := newGUI(testAgent(t)).display(); err == nil {
		t.Error("display reserved in an unsafe directory")
	}
}

// TestHelperXClient is not a test of its own: started by TestGUIWindows as a
// subprocess, it shows a red window and reports what it receives.
func TestHelperXClient(t *testing.T) {
	sock := os.Getenv("GUI_TEST_SOCKET")
	if sock == "" {
		t.Skip("helper process")
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		os.Exit(1)
	}
	x, err := xgb.NewConnNetWithCookieHex(conn, os.Getenv("GUI_TEST_COOKIE"))
	if err != nil {
		os.Exit(2)
	}
	scr := xproto.Setup(x).DefaultScreen(x)
	atom := func(name string) xproto.Atom {
		r, _ := xproto.InternAtom(x, false, uint16(len(name)), name).Reply()
		return r.Atom
	}
	win, _ := xproto.NewWindowId(x)
	xproto.CreateWindow(x, scr.RootDepth, win, scr.Root, 40, 30, 200, 100, 0, xproto.WindowClassInputOutput, scr.RootVisual,
		xproto.CwBackPixel|xproto.CwEventMask, []uint32{0xff0000, xproto.EventMaskButtonPress | xproto.EventMaskKeyPress | xproto.EventMaskStructureNotify})
	title := []byte("helper window")
	xproto.ChangeProperty(x, xproto.PropModeReplace, win, atom("_NET_WM_NAME"), atom("UTF8_STRING"), 8, uint32(len(title)), title)
	del := atom("WM_DELETE_WINDOW")
	xproto.ChangeProperty(x, xproto.PropModeReplace, win, atom("WM_PROTOCOLS"), xproto.AtomAtom, 32, 1, u32(uint32(del)))
	xproto.ChangeProperty(x, xproto.PropModeReplace, win, atom("_NET_WM_PID"), xproto.AtomCardinal, 32, 1, u32(uint32(os.Getpid())))
	xproto.MapWindow(x, win)
	for {
		ev, _ := x.WaitForEvent()
		switch e := ev.(type) {
		case nil:
			os.Exit(0)
		case xproto.MapNotifyEvent:
			if os.Getenv("GUI_TEST_GRAB") != "" {
				// Like Tk's focus -force: take the focus without the WM.
				xproto.SetInputFocus(x, xproto.InputFocusPointerRoot, win, xproto.TimeCurrentTime)
				x.Sync()
			}
			fmt.Println("mapped")
		case xproto.ButtonPressEvent:
			fmt.Printf("button %d %d %d\n", e.Detail, e.EventX, e.EventY)
		case xproto.KeyPressEvent:
			fmt.Printf("key %d\n", e.Detail)
		case xproto.ClientMessageEvent:
			if xproto.Atom(e.Data.Data32[0]) == del {
				fmt.Println("delete")
				os.Exit(0)
			}
		}
	}
}

// guiTestXvfb starts a display for a test agent, or skips when the machine
// has no Xvfb (GUI_TEST_INSTALL=1 fetches the distribution package).
func guiTestXvfb(t testing.TB) *gui {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("virtual displays are provided on Linux only")
	}
	g := newGUI(testAgent(t))
	if g.findXvfb() == "" {
		if os.Getenv("GUI_TEST_INSTALL") != "1" {
			t.Skip("no Xvfb on this machine")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if err := g.install(ctx); err != nil {
			t.Fatalf("install: %v", err)
		}
	}
	if err := g.start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		st := g.readState()
		syscall.Kill(st.Pid, syscall.SIGTERM)
		for i := 0; i < 50 && processAlive(st.Pid); i++ {
			time.Sleep(100 * time.Millisecond)
		}
	})
	return g
}

type guiMsg struct {
	ev    *agentproto.GUIEvent
	frame *agentproto.GUIFrameHeader
	img   image.Image
}

// A program's window is announced with its pane, streamed, receives input
// and is closed through the window manager.
func TestGUIWindows(t *testing.T) {
	g := guiTestXvfb(t)
	n, _ := g.display()
	cookie, _ := g.serverCookie()

	core, agentEnd := net.Pipe()
	defer core.Close()
	go g.attach(agentEnd)
	core.SetDeadline(time.Now().Add(60 * time.Second))
	var rep agentproto.Reply
	if err := agentproto.ReadLine(core, &rep); err != nil || !rep.OK {
		t.Fatalf("attach: %v %+v", err, rep)
	}
	msgs := make(chan guiMsg, 64)
	go func() {
		defer close(msgs)
		for {
			kind, p, err := agentproto.ReadGUI(core)
			if err != nil {
				return
			}
			switch kind {
			case agentproto.GUIJSON:
				var ev agentproto.GUIEvent
				json.Unmarshal(p, &ev)
				msgs <- guiMsg{ev: &ev}
			case agentproto.GUIFrame:
				h, _ := agentproto.ParseGUIFrameHeader(p)
				img, _, _ := image.Decode(bytes.NewReader(p[agentproto.GUIFrameHeaderLen:]))
				msgs <- guiMsg{frame: &h, img: img}
			}
		}
	}()
	send := func(c agentproto.GUICommand) {
		b, _ := json.Marshal(c)
		if err := agentproto.WriteGUI(core, agentproto.GUIJSON, b); err != nil {
			t.Fatal(err)
		}
	}
	next := func(what string, ok func(guiMsg) bool) guiMsg {
		t.Helper()
		timeout := time.After(20 * time.Second)
		for {
			select {
			case m, open := <-msgs:
				if !open {
					t.Fatalf("stream ended waiting for %s", what)
				}
				if ok(m) {
					return m
				}
			case <-timeout:
				t.Fatalf("timed out waiting for %s", what)
			}
		}
	}

	helper := exec.Command(os.Args[0], "-test.run=^TestHelperXClient$")
	helper.Env = append(os.Environ(), "GUI_TEST_SOCKET="+xSocket(n), "GUI_TEST_COOKIE="+hex.EncodeToString(cookie),
		"HERDR_PANE_ID=w1:p2", "HERDR_SOCKET_PATH=/tmp/herdr-test.sock")
	out, _ := helper.StdoutPipe()
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	defer helper.Process.Kill()
	lines := make(chan string, 16)
	go func() {
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	expectLine := func(prefix string) string {
		t.Helper()
		select {
		case l := <-lines:
			if !strings.HasPrefix(l, prefix) {
				t.Fatalf("helper said %q, want %q", l, prefix)
			}
			return l
		case <-time.After(20 * time.Second):
			t.Fatalf("helper did not report %q", prefix)
		}
		return ""
	}

	w := next("window event", func(m guiMsg) bool { return m.ev != nil && m.ev.Ev == "window" }).ev.Window
	if w.Title != "helper window" || w.W != 200 || w.H != 100 || w.Pane != "w1:p2" || w.Socket != "/tmp/herdr-test.sock" || w.Pid != helper.Process.Pid {
		t.Fatalf("window = %+v", w)
	}
	expectLine("mapped")

	send(agentproto.GUICommand{Cmd: "watch", ID: w.ID})
	f := next("frame", func(m guiMsg) bool { return m.frame != nil && m.frame.Window == w.ID })
	if f.frame.Layer != w.ID || f.img == nil {
		t.Fatalf("frame %+v (image %v)", f.frame, f.img != nil)
	}
	if r, gg, b, _ := f.img.At(10, 10).RGBA(); r>>8 < 200 || gg>>8 > 60 || b>>8 > 60 {
		t.Errorf("window pixel = %d,%d,%d, want red", r>>8, gg>>8, b>>8)
	}
	send(agentproto.GUICommand{Cmd: "ack", ID: w.ID, Seq: f.frame.Seq})

	// Input coordinates are relative to the window.
	send(agentproto.GUICommand{Cmd: "focus", ID: w.ID})
	send(agentproto.GUICommand{Cmd: "button", ID: w.ID, X: 12, Y: 34, Button: 1, Down: true})
	send(agentproto.GUICommand{Cmd: "button", ID: w.ID, X: 12, Y: 34, Button: 1})
	if l := expectLine("button"); l != "button 1 12 34" {
		t.Errorf("helper got %q", l)
	}
	send(agentproto.GUICommand{Cmd: "key", ID: w.ID, Keycode: 38, Down: true}) // KeyA
	send(agentproto.GUICommand{Cmd: "key", ID: w.ID, Keycode: 38})
	if l := expectLine("key"); l != "key 38" {
		t.Errorf("helper got %q", l)
	}

	// Another program's window appears: it does not take the keys meant
	// for the first one.
	other := exec.Command(os.Args[0], "-test.run=^TestHelperXClient$")
	other.Env = append(os.Environ(), "GUI_TEST_SOCKET="+xSocket(n), "GUI_TEST_COOKIE="+hex.EncodeToString(cookie), "HERDR_PANE_ID=w1:p3", "GUI_TEST_GRAB=1")
	otherOut, _ := other.StdoutPipe()
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	defer other.Process.Kill()
	next("second window", func(m guiMsg) bool { return m.ev != nil && m.ev.Ev == "window" && m.ev.Window.Pane == "w1:p3" })
	// The second program takes the focus itself once mapped.
	if l, _ := bufio.NewReader(otherOut).ReadString('\n'); l != "mapped\n" {
		t.Fatalf("second helper said %q", l)
	}
	send(agentproto.GUICommand{Cmd: "key", ID: w.ID, Keycode: 39, Down: true}) // KeyS
	send(agentproto.GUICommand{Cmd: "key", ID: w.ID, Keycode: 39})
	if l := expectLine("key"); l != "key 39" {
		t.Errorf("first window got %q after a second window appeared", l)
	}

	send(agentproto.GUICommand{Cmd: "close", ID: w.ID})
	expectLine("delete")
	next("gone event", func(m guiMsg) bool { return m.ev != nil && m.ev.Ev == "gone" && m.ev.ID == w.ID })
}

// An unpacked package is found and an older unused one is pruned.
func TestFindUnpackedXvfb(t *testing.T) {
	g := newGUI(testAgent(t))
	t.Setenv("PATH", t.TempDir())
	if _, err := os.Stat("/usr/bin/Xvfb"); err == nil {
		t.Skip("Xvfb installed system-wide")
	}
	old := filepath.Join(g.root(), "1.0")
	cur := filepath.Join(g.root(), "2.0")
	writeExec(t, filepath.Join(old, "usr", "bin", "Xvfb"))
	writeExec(t, filepath.Join(cur, "usr", "bin", "Xvfb"))
	past := time.Now().Add(-versionRetention - time.Hour)
	os.Chtimes(old, past, past)
	if got := g.findXvfb(); got != filepath.Join(cur, "usr", "bin", "Xvfb") {
		t.Fatalf("findXvfb = %q", got)
	}
	g.prune(cur)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("old package kept: %v", err)
	}
	if _, err := os.Stat(cur); err != nil {
		t.Errorf("current package removed: %v", err)
	}
}

// Shells started with the display are recognized from their environment.
func TestShellsWithDisplay(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	g := newGUI(testAgent(t))
	with := exec.Command("sleep", "30")
	with.Env = append(os.Environ(), "DISPLAY=:77")
	without := exec.Command("sleep", "30")
	without.Env = append(os.Environ(), "DISPLAY=:78")
	for _, c := range []*exec.Cmd{with, without} {
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		defer c.Process.Kill()
	}
	// /proc/<pid>/environ reads empty until exec has set it up, which can
	// be after Start returns.
	for _, c := range []*exec.Cmd{with, without} {
		deadline := time.Now().Add(5 * time.Second)
		for {
			env, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", c.Process.Pid))
			if err == nil && len(env) > 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("environ of %d: %q, %v", c.Process.Pid, env, err)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	got := g.shells([]string{fmt.Sprint(with.Process.Pid), fmt.Sprint(without.Process.Pid), "x", "1"}, ":77")
	if len(got) != 2 || got[0].Pid != with.Process.Pid || !got[0].Display || got[1].Display {
		t.Fatalf("shells = %+v", got)
	}
	// A program that replaced its shell is told apart by its name.
	if got[0].Comm != "sleep" {
		t.Errorf("comm = %q", got[0].Comm)
	}
}

// A huge window is captured in bounded tiles, no more per tick than may be
// in flight; the rest follows.
func TestCaptureTiles(t *testing.T) {
	m := &managedWin{xwin: xwin{id: 1, w: 20000, h: 20000}, watched: true}
	m.dirty = m.all()
	wm := &windowManager{wins: map[xproto.Window]*managedWin{1: m}, layers: map[xproto.Window]*layerWin{}}
	jobs := wm.collect(time.Now())
	if len(jobs) != guiInflight {
		t.Fatalf("%d captures in one tick", len(jobs))
	}
	for _, j := range jobs {
		if j.r.w > guiTile || j.r.h > guiTile || j.r.empty() {
			t.Errorf("tile %+v", j.r)
		}
	}
	if m.dirty.empty() {
		t.Error("the rest of the window was dropped")
	}
	if more := wm.collect(time.Now()); len(more) != 0 {
		t.Errorf("%d captures beyond the in-flight bound", len(more))
	}
	m.acked = m.seq
	if more := wm.collect(time.Now()); len(more) == 0 {
		t.Error("nothing sent after acknowledgement")
	}
	if got := tiles(rect{0, 0, 2500, 1000}); len(got) != 3 || got[2] != (rect{2048, 0, 452, 1000}) {
		t.Errorf("tiles = %v", got)
	}
}

// A watched window reports what its frames cost once a second: counts,
// sizes, times, ticks held back and the latency of acknowledged frames.
func TestFrameStats(t *testing.T) {
	var out bytes.Buffer
	m := &managedWin{xwin: xwin{id: 1, w: 20000, h: 20000}, watched: true}
	m.dirty = m.all()
	wm := &windowManager{out: &out, wins: map[xproto.Window]*managedWin{1: m}, layers: map[xproto.Window]*layerWin{}}
	t0 := time.Now()
	m.since = t0
	jobs := wm.collect(t0)
	wm.collect(t0) // held back: nothing acknowledged yet
	costs := []frameCost{}
	for _, j := range jobs {
		costs = append(costs, frameCost{window: j.window, capture: time.Millisecond, convert: 2 * time.Millisecond,
			encode: 3 * time.Millisecond, pixels: j.r.w * j.r.h, bytes: 1000, enc: agentproto.GUIEncJPEG})
	}
	wm.account(costs, t0.Add(10*time.Millisecond))
	if out.Len() != 0 {
		t.Fatal("stats sent before a second passed")
	}
	m.ackedAt(2, t0.Add(40*time.Millisecond)) // acknowledges frames 1 and 2
	m.acked = 2
	if len(m.inflight) != 1 || m.inflight[0].seq != 3 {
		t.Fatalf("in flight %+v", m.inflight)
	}
	wm.account(nil, t0.Add(time.Second))
	kind, p, err := agentproto.ReadGUI(&out)
	if err != nil || kind != agentproto.GUIJSON {
		t.Fatalf("read: %v", err)
	}
	var ev agentproto.GUIEvent
	json.Unmarshal(p, &ev)
	st := ev.Stats
	if ev.Ev != "stats" || st == nil || st.Window != 1 || st.Updates != 1 || st.Frames != 3 || st.JPEG != 3 || st.Bytes != 3000 ||
		st.Capture != 3000 || st.Encode != 9000 || st.Waits != 1 || st.Acked != 1 || st.Latency != 40000 ||
		st.Interval != 1000000 || st.Pixels != 3*guiTile*guiTile {
		t.Fatalf("stats %+v", st)
	}
	if m.stats != (agentproto.GUIStats{}) {
		t.Error("stats not reset after the report")
	}
}

// BenchmarkGUICapture measures the steps of sending a 1706×960 window (a
// MuJoCo viewer's size) the way the window manager does, in tiles: reading
// the pixels from Xvfb, converting and encoding them, for a rendered scene
// and a plot. It needs Linux with Xvfb:
//
//	go test ./internal/agent -run '^$' -bench GUICapture
func BenchmarkGUICapture(b *testing.B) {
	g := guiTestXvfb(b)
	n, _ := g.display()
	cookie, _ := g.serverCookie()
	conn, err := net.Dial("unix", xSocket(n))
	if err != nil {
		b.Fatal(err)
	}
	x, err := xgb.NewConnNetWithCookieHex(conn, hex.EncodeToString(cookie))
	if err != nil {
		b.Fatal(err)
	}
	defer x.Close()
	if err := composite.Init(x); err != nil {
		b.Fatal(err)
	}
	scr := xproto.Setup(x).DefaultScreen(x)
	composite.RedirectSubwindows(x, scr.Root, composite.RedirectAutomatic)
	const w, h = 1706, 960
	win, _ := xproto.NewWindowId(x)
	xproto.CreateWindow(x, scr.RootDepth, win, scr.Root, 0, 0, w, h, 0, xproto.WindowClassInputOutput, scr.RootVisual, xproto.CwBackPixel, []uint32{0})
	xproto.MapWindow(x, win)
	gc, _ := xproto.NewGcontextId(x)
	xproto.CreateGC(x, gc, xproto.Drawable(win), 0, nil)
	ts := tiles(rect{0, 0, w, h})

	for _, c := range []struct {
		name string
		img  *image.RGBA
	}{{"scene", benchScene(w, h)}, {"plot", benchPlot(w, h)}} {
		putRGBA(x, win, gc, c.img)
		var data [][]byte
		b.Run(c.name+"/capture", func(b *testing.B) {
			b.SetBytes(w * h * 4)
			for i := 0; i < b.N; i++ {
				data = data[:0]
				for _, t := range ts {
					r, err := xproto.GetImage(x, xproto.ImageFormatZPixmap, xproto.Drawable(win), int16(t.x), int16(t.y), uint16(t.w), uint16(t.h), 0xffffffff).Reply()
					if err != nil {
						b.Fatal(err)
					}
					data = append(data, r.Data)
				}
			}
		})
		var imgs []*image.RGBA
		b.Run(c.name+"/convert", func(b *testing.B) {
			b.SetBytes(w * h * 4)
			for i := 0; i < b.N; i++ {
				imgs = imgs[:0]
				for k, t := range ts {
					imgs = append(imgs, bgrxToRGBA(data[k], t.w, t.h))
				}
			}
		})
		if imgs[0].Pix[0] != c.img.Pix[0] || imgs[0].Pix[2] != c.img.Pix[2] {
			b.Fatal("captured pixels differ from the drawn ones")
		}
		encode := func(name string, enc func(io.Writer, image.Image) error) {
			b.Run(c.name+"/"+name, func(b *testing.B) {
				var size int
				for i := 0; i < b.N; i++ {
					size = 0
					for _, img := range imgs {
						var buf bytes.Buffer
						if err := enc(&buf, img); err != nil {
							b.Fatal(err)
						}
						size += buf.Len()
					}
				}
				b.ReportMetric(float64(size), "bytes/frame")
			})
		}
		encode("jpeg", func(w io.Writer, img image.Image) error { return jpeg.Encode(w, img, &jpeg.Options{Quality: 85}) })
		encode("png", func(w io.Writer, img image.Image) error {
			e := png.Encoder{CompressionLevel: png.BestSpeed}
			return e.Encode(w, img)
		})
	}
}

// putRGBA draws img into win in strips small enough for one request.
func putRGBA(x *xgb.Conn, win xproto.Window, gc xproto.Gcontext, img *image.RGBA) {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	const rows = 32
	buf := make([]byte, w*rows*4)
	for y := 0; y < h; y += rows {
		n := min(rows, h-y)
		for i := 0; i < w*n; i++ {
			p := img.Pix[y*img.Stride+i*4:]
			buf[i*4], buf[i*4+1], buf[i*4+2], buf[i*4+3] = p[2], p[1], p[0], 0
		}
		xproto.PutImage(x, xproto.ImageFormatZPixmap, xproto.Drawable(win), gc, uint16(w), uint16(n), 0, int16(y), 0, 24, buf[:w*n*4])
	}
	xproto.GetInputFocus(x).Reply() // wait until drawn
}

// benchScene is a rendered 3D scene's kind of picture: a sky gradient, a
// checkered floor in perspective and shaded balls.
func benchScene(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	horizon := h * 2 / 5
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var r, g, b float64
			if y < horizon {
				f := float64(y) / float64(horizon)
				r, g, b = 90+80*f, 140+70*f, 220-20*f
			} else {
				d := float64(y-horizon+1) / float64(h-horizon)
				u := (float64(x) - float64(w)/2) / (d * 200)
				v := 1 / d * 4
				shade := 0.4 + 0.6*d
				if (int(math.Floor(u))+int(math.Floor(v)))%2 == 0 {
					r, g, b = 200*shade, 200*shade, 210*shade
				} else {
					r, g, b = 60*shade, 70*shade, 90*shade
				}
			}
			for _, s := range [][4]float64{{0.3, 0.6, 0.12, 0}, {0.55, 0.7, 0.09, 1}, {0.75, 0.55, 0.06, 2}} {
				cx, cy, rad := s[0]*float64(w), s[1]*float64(h), s[2]*float64(w)
				dx, dy := (float64(x)-cx)/rad, (float64(y)-cy)/rad
				if q := dx*dx + dy*dy; q < 1 {
					l := math.Max(0, -0.5*dx-0.6*dy+0.6*math.Sqrt(1-q))
					base := [3][3]float64{{220, 60, 50}, {60, 180, 90}, {230, 200, 60}}[int(s[3])]
					r, g, b = base[0]*(0.2+0.8*l), base[1]*(0.2+0.8*l), base[2]*(0.2+0.8*l)
				}
			}
			i := y*img.Stride + x*4
			img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = uint8(r), uint8(g), uint8(b), 0xff
		}
	}
	return img
}

// benchPlot is a plot's kind of picture: white, with a grid, axes, curves
// and blocks of text.
func benchPlot(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	set := func(x, y int, c [3]uint8) {
		if x >= 0 && y >= 0 && x < w && y < h {
			i := y*img.Stride + x*4
			img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c[0], c[1], c[2], 0xff
		}
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			set(x, y, [3]uint8{255, 255, 255})
			if (x-120)%100 == 0 || (y-60)%80 == 0 {
				set(x, y, [3]uint8{225, 225, 225})
			}
		}
	}
	for x := 120; x < w-40; x++ {
		set(x, h-80, [3]uint8{0, 0, 0})
	}
	for y := 40; y < h-80; y++ {
		set(120, y, [3]uint8{0, 0, 0})
	}
	colors := [][3]uint8{{31, 119, 180}, {255, 127, 14}, {44, 160, 44}}
	for k, c := range colors {
		for x := 121; x < w-40; x++ {
			y := float64(h-80) / 2 * (1 + 0.8*math.Sin(float64(x)/(60+20*float64(k))+float64(k)))
			for d := 0; d < 2; d++ {
				set(x, int(y)+d, c)
			}
		}
	}
	// Text: rows of glyph-sized marks under the axis and in a legend.
	for row, y0 := range []int{h - 60, 50, 70, 90} {
		x0 := 140
		if row > 0 {
			x0 = w - 260
		}
		for g := 0; g < 30; g++ {
			for y := y0; y < y0+10; y++ {
				for x := x0 + g*7; x < x0+g*7+5; x++ {
					if (x*7+y*3+g)%5 != 0 {
						set(x, y, [3]uint8{30, 30, 30})
					}
				}
			}
		}
	}
	return img
}

// Downloads left by a killed agent go away after an hour; libraries are
// preloaded only when root alone can change them; version names cannot
// escape the package directory.
func TestGUIHousekeeping(t *testing.T) {
	g := newGUI(testAgent(t))
	old := filepath.Join(g.root(), ".fetch-old")
	fresh := filepath.Join(g.root(), ".fetch-new")
	os.MkdirAll(old, 0o755)
	os.MkdirAll(fresh, 0o755)
	past := time.Now().Add(-2 * stagingRetention)
	os.Chtimes(old, past, past)
	g.cleanStaging()
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("old staging directory kept")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("staging directory of a running install removed")
	}

	lib := filepath.Join(t.TempDir(), "libvglfaker.so")
	os.WriteFile(lib, nil, 0o644)
	if _, ok := rootOnly(lib); os.Getuid() != 0 && ok {
		t.Error("library owned by the user accepted")
	}
	if real, ok := rootOnly("/bin/sh"); ok && !filepath.IsAbs(real) {
		t.Errorf("resolved path %q", real)
	}

	for v, ok := range map[string]bool{"2_21.1.12-1ubuntu1.9": true, "1.20.11+deb11u1": true, "..": false, ".": false, "": false, "x1": false} {
		if versionName.MatchString(v) != ok {
			t.Errorf("version %q accepted = %v", v, !ok)
		}
	}
}
