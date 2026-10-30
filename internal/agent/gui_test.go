package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
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
func guiTestXvfb(t *testing.T) *gui {
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
