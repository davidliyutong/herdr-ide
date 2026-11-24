//go:build unix

package agent

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"image"
	"net"
	"os"
	"os/exec"
	"testing"
	"time"

	"herdr-ide/internal/agentproto"
)

// guiTestCore is a core attached to a test display's window manager.
type guiTestCore struct {
	t    *testing.T
	conn net.Conn
	msgs chan guiMsg
}

func attachTestCore(t *testing.T, g *gui, client string) *guiTestCore {
	t.Helper()
	core, agentEnd := net.Pipe()
	t.Cleanup(func() { core.Close() })
	go g.attach(&session{client: client}, agentEnd)
	core.SetDeadline(time.Now().Add(60 * time.Second))
	var rep agentproto.Reply
	if err := agentproto.ReadLine(core, &rep); err != nil || !rep.OK {
		t.Fatalf("attach %s: %v %+v", client, err, rep)
	}
	c := &guiTestCore{t: t, conn: core, msgs: make(chan guiMsg, 256)}
	go func() {
		defer close(c.msgs)
		for {
			kind, p, err := agentproto.ReadGUI(core)
			if err != nil {
				return
			}
			switch kind {
			case agentproto.GUIJSON:
				var ev agentproto.GUIEvent
				json.Unmarshal(p, &ev)
				c.msgs <- guiMsg{ev: &ev}
			case agentproto.GUIFrame:
				h, _ := agentproto.ParseGUIFrameHeader(p)
				img, _, _ := image.Decode(bytes.NewReader(p[agentproto.GUIFrameHeaderLen:]))
				c.msgs <- guiMsg{frame: &h, img: img}
			}
		}
	}()
	return c
}

func (c *guiTestCore) send(cmd agentproto.GUICommand) {
	b, _ := json.Marshal(cmd)
	if err := agentproto.WriteGUI(c.conn, agentproto.GUIJSON, b); err != nil {
		c.t.Fatal(err)
	}
}

func (c *guiTestCore) next(what string, ok func(guiMsg) bool) guiMsg {
	c.t.Helper()
	timeout := time.After(20 * time.Second)
	for {
		select {
		case m, open := <-c.msgs:
			if !open {
				c.t.Fatalf("stream ended waiting for %s", what)
			}
			if ok(m) {
				return m
			}
		case <-timeout:
			c.t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func (c *guiTestCore) role(what string, control bool) {
	c.t.Helper()
	c.next(what, func(m guiMsg) bool { return m.ev != nil && m.ev.Ev == "role" && m.ev.Control == control })
}

// Two cores attach to one window manager: the first controls, the second
// views. Both get the windows and their frames; the viewer's input is
// ignored until it takes control, which makes the other the viewer; the
// controller gone, the viewer takes control.
func TestGUITwoCores(t *testing.T) {
	g := guiTestXvfb(t)
	n, _ := g.display()
	cookie, _ := g.serverCookie()
	a := attachTestCore(t, g, "a")
	a.role("a controls", true)
	b := attachTestCore(t, g, "b")
	b.role("b views", false)

	helper := exec.Command(os.Args[0], "-test.run=^TestHelperXClient$")
	helper.Env = append(os.Environ(), "GUI_TEST_SOCKET="+xSocket(n), "GUI_TEST_COOKIE="+hex.EncodeToString(cookie))
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
	expectLine := func(want string) {
		t.Helper()
		select {
		case l := <-lines:
			if l != want {
				t.Fatalf("helper said %q, want %q", l, want)
			}
		case <-time.After(20 * time.Second):
			t.Fatalf("helper did not report %q", want)
		}
	}
	noLine := func(why string) {
		t.Helper()
		select {
		case l := <-lines:
			t.Fatalf("%s: helper said %q", why, l)
		case <-time.After(500 * time.Millisecond):
		}
	}
	isWindow := func(m guiMsg) bool { return m.ev != nil && m.ev.Ev == "window" && m.ev.Window.Title == "helper window" }
	w := a.next("window for a", isWindow).ev.Window
	b.next("window for b", isWindow)
	expectLine("mapped")

	// Both watch it and get its pixels.
	for _, c := range []*guiTestCore{a, b} {
		c.send(agentproto.GUICommand{Cmd: "watch", ID: w.ID})
		f := c.next("frame", func(m guiMsg) bool { return m.frame != nil && m.frame.Window == w.ID && m.img != nil })
		if r, gg, bb, _ := f.img.At(10, 10).RGBA(); r>>8 < 200 || gg>>8 > 60 || bb>>8 > 60 {
			t.Errorf("pixel = %d,%d,%d, want red", r>>8, gg>>8, bb>>8)
		}
		c.send(agentproto.GUICommand{Cmd: "ack", ID: w.ID, Seq: f.frame.Seq})
	}

	// The viewer's input does not reach the program; the controller's does.
	click := func(c *guiTestCore) {
		c.send(agentproto.GUICommand{Cmd: "button", ID: w.ID, X: 5, Y: 6, Button: 1, Down: true})
		c.send(agentproto.GUICommand{Cmd: "button", ID: w.ID, X: 5, Y: 6, Button: 1})
	}
	click(b)
	noLine("a viewer's click")
	click(a)
	expectLine("button 1 5 6")

	// b takes control.
	b.send(agentproto.GUICommand{Cmd: "control"})
	b.role("b controls", true)
	a.role("a views", false)
	click(a)
	noLine("a click of the former controller")
	click(b)
	expectLine("button 1 5 6")

	// b leaves: a controls again.
	b.conn.Close()
	a.role("a controls again", true)
	click(a)
	expectLine("button 1 5 6")
}
