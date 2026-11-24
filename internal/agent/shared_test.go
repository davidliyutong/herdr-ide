//go:build unix

package agent

import (
	"context"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/jezek/xgb/xproto"

	"veldr/internal/agentproto"
)

// sharedAgent is an agent of a temporary home with no session yet.
func sharedAgent(t *testing.T) *Agent {
	t.Helper()
	// Short: macOS limits socket paths to 104 bytes.
	home, err := os.MkdirTemp("/tmp", "shr")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	a, err := NewAgent(Options{Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	return a
}

// fakeCore is a core's side of a session of a: answer handles each stream
// the agent opens (op vault), with the request line already read.
func fakeCore(t *testing.T, a *Agent, client string, answer func(req agentproto.VaultRequest, st net.Conn)) *yamux.Session {
	t.Helper()
	coreEnd, agentEnd := net.Pipe()
	go a.Serve(context.Background(), agentEnd, client, "")
	ys, err := yamux.Client(coreEnd, agentproto.YamuxConfig(log.New(io.Discard, "", 0)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ys.Close() })
	go func() {
		for {
			st, err := ys.AcceptStream()
			if err != nil {
				return
			}
			go func() {
				defer st.Close()
				var h agentproto.Header
				if agentproto.ReadLine(st, &h) != nil || h.Op != agentproto.OpVault {
					return
				}
				if answer == nil {
					agentproto.WriteLine(st, agentproto.Reply{Code: "unavailable", Error: "vault: off"})
					return
				}
				agentproto.WriteLine(st, agentproto.Reply{OK: true})
				var req agentproto.VaultRequest
				if agentproto.ReadLine(st, &req) != nil {
					return
				}
				answer(req, st)
			}()
		}
	}()
	// The session counts once the agent took it.
	for i := 0; len(a.liveSessions()) == 0 || a.liveSessions()[len(a.liveSessions())-1].client != client; i++ {
		if i > 200 {
			t.Fatal("no session")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return ys
}

// askMCP sends one request to the agent's vault socket as an MCP server.
func askMCP(t *testing.T, a *Agent, req agentproto.VaultRequest) agentproto.VaultResponse {
	t.Helper()
	sock := filepath.Join(a.runDir, "vault.sock")
	var c net.Conn
	for i := 0; ; i++ {
		var err error
		if c, err = net.Dial("unix", sock); err == nil {
			break
		}
		if i > 200 {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	if err := agentproto.WriteLine(c, req); err != nil {
		t.Fatal(err)
	}
	var resp agentproto.VaultResponse
	if err := agentproto.ReadLine(c, &resp); err != nil {
		t.Fatal(err)
	}
	return resp
}

func answerWith(resp agentproto.VaultResponse) func(agentproto.VaultRequest, net.Conn) {
	return func(_ agentproto.VaultRequest, st net.Conn) { agentproto.WriteLine(st, resp) }
}

// A request reaches every core of the node: the first that grants answers
// and the others' questions are withdrawn (their streams close); a request
// every core refused fails with the most telling refusal; list lists every
// core's variables once.
func TestVaultAsksEveryCore(t *testing.T) {
	a := sharedAgent(t)
	asked, withdrawn := make(chan struct{}), make(chan struct{})
	// The first core asks the user, who has not answered when the second
	// grants.
	fakeCore(t, a, "a", func(_ agentproto.VaultRequest, st net.Conn) {
		close(asked)
		var b [1]byte
		st.Read(b[:])
		close(withdrawn)
	})
	fakeCore(t, a, "b", func(_ agentproto.VaultRequest, st net.Conn) {
		<-asked
		agentproto.WriteLine(st, agentproto.VaultResponse{OK: true, Values: map[string]string{"TOKEN": "v"}})
	})
	if resp := askMCP(t, a, agentproto.VaultRequest{Tool: agentproto.VaultGet, Names: []string{"TOKEN"}}); !resp.OK || resp.Values["TOKEN"] != "v" {
		t.Fatalf("get: %+v", resp)
	}
	select {
	case <-withdrawn:
	case <-time.After(5 * time.Second):
		t.Fatal("the other core's question was not withdrawn")
	}
}

func TestVaultRefusalsAndLists(t *testing.T) {
	a := sharedAgent(t)
	fakeCore(t, a, "a", func(req agentproto.VaultRequest, st net.Conn) {
		if req.Tool == agentproto.VaultList {
			agentproto.WriteLine(st, agentproto.VaultResponse{OK: true, Variables: []agentproto.VaultVariable{{Name: "A"}, {Name: "SHARED", Description: "a's"}}})
			return
		}
		agentproto.WriteLine(st, agentproto.VaultResponse{Code: "not_found", Error: "no variable"})
	})
	fakeCore(t, a, "b", func(req agentproto.VaultRequest, st net.Conn) {
		if req.Tool == agentproto.VaultList {
			agentproto.WriteLine(st, agentproto.VaultResponse{OK: true, Variables: []agentproto.VaultVariable{{Name: "SHARED", Description: "b's"}, {Name: "B"}}})
			return
		}
		agentproto.WriteLine(st, agentproto.VaultResponse{Code: "vault_locked", Error: "locked"})
	})
	fakeCore(t, a, "c", nil) // its vault plugin is off
	if resp := askMCP(t, a, agentproto.VaultRequest{Tool: agentproto.VaultGet, Names: []string{"X"}}); resp.OK || resp.Code != "vault_locked" {
		t.Fatalf("get: %+v", resp)
	}
	resp := askMCP(t, a, agentproto.VaultRequest{Tool: agentproto.VaultList})
	names := map[string]string{}
	for _, v := range resp.Variables {
		if _, dup := names[v.Name]; dup {
			t.Fatalf("listed twice: %+v", resp.Variables)
		}
		names[v.Name] = v.Description
	}
	if !resp.OK || len(names) != 3 || names["A"] != "" || names["B"] != "" || (names["SHARED"] != "a's" && names["SHARED"] != "b's") {
		t.Fatalf("list: %+v", resp)
	}
}

func TestVaultWithoutACore(t *testing.T) {
	a := sharedAgent(t)
	if resp := askMCP(t, a, agentproto.VaultRequest{Tool: agentproto.VaultList}); resp.OK || resp.Code != "unavailable" {
		t.Fatalf("list: %+v", resp)
	}
}

// code-server released by one core's idle timeout stays while another
// core's session has a connection to it; bridge connections go to the core
// that last connected to it.
func TestSessionsShareCodeServer(t *testing.T) {
	a := &Agent{sessions: map[*session]struct{}{}}
	s1, s2 := &session{id: 1, client: "a"}, &session{id: 2, client: "b"}
	a.sessions[s1], a.sessions[s2] = struct{}{}, struct{}{}
	if a.otherUses(s1) || a.bridgeSession() != s2 {
		t.Fatal("no connections yet: released, the newest session gets the bridge")
	}
	s1.csPipes.Add(1)
	s1.csLast.Store(time.Now().UnixNano())
	if !a.otherUses(s2) || a.otherUses(s1) || a.bridgeSession() != s1 {
		t.Fatal("s1 uses code-server")
	}
}

// A viewer whose queue is full misses frames, gets none until its queue has
// room, then the whole window from the next frame on; the pacer is the
// controller while it watches, else the client attached longest.
func TestGUIViewerCatchesUp(t *testing.T) {
	ctl, view := newGUIClient(&session{id: 1}, nil), newGUIClient(&session{id: 2}, nil)
	ctl.control = true
	m := &managedWin{xwin: xwin{id: 5, w: 100, h: 100}}
	wm := &windowManager{clients: []*guiClient{ctl, view}, wins: map[xproto.Window]*managedWin{5: m}, layers: map[xproto.Window]*layerWin{}, done: make(chan struct{})}
	view.watched[5] = nil
	wm.watchersChanged(m)
	wm.repace(m)
	if m.pacer != view {
		t.Fatal("the viewer paces a window only it watches")
	}
	ctl.watched[5] = nil
	wm.watchersChanged(m)
	wm.repace(m)
	if m.pacer != ctl {
		t.Fatal("the controller paces a window it watches")
	}
	for range guiQueue {
		view.q <- guiOut{}
	}
	m.seq = 10
	wm.deliver(5, wm.targets(5, 10), []guiOut{{kind: agentproto.GUIFrame}})
	if !view.stale[5] || len(ctl.q) != 1 {
		t.Fatalf("stale %v, controller got %d", view.stale[5], len(ctl.q))
	}
	if ts := wm.targets(5, 11); len(ts) != 1 || ts[0].c != ctl || !ts[0].pace {
		t.Fatalf("targets while behind: %+v", ts)
	}
	wm.resend(m)
	if !view.stale[5] {
		t.Fatal("sent again before the queue had room")
	}
	for len(view.q) > 0 {
		<-view.q
	}
	wm.resend(m)
	if view.stale[5] || view.from[5] != 11 || !m.keyWanted || m.dirty != m.all() {
		t.Fatalf("after catching up: stale %v from %d key %v dirty %+v", view.stale[5], view.from[5], m.keyWanted, m.dirty)
	}
	if len(wm.targets(5, 10)) != 1 || len(wm.targets(5, 11)) != 2 {
		t.Fatal("the viewer gets frames from the full one on")
	}
}
