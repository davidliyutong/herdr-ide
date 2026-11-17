//go:build unix

package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"herdr-ide/internal/agent"
	"herdr-ide/internal/machines"
	"herdr-ide/internal/plugin"
	"herdr-ide/internal/settings"
	"herdr-ide/internal/transport"
)

type fakeHost struct {
	mg *machines.Manager
	st *settings.Store
}

func (h *fakeHost) Machines() *machines.Manager                 { return h.mg }
func (h *fakeHost) Broadcast(string, string, any)               {}
func (h *fakeHost) Audit(*http.Request, string, map[string]any) {}
func (h *fakeHost) ReadOnly() bool                              { return false }
func (h *fakeHost) Settings() *settings.Store                   { return h.st }
func (h *fakeHost) Logger() *log.Logger                         { return log.New(io.Discard, "", 0) }

// newTest is the plugin with two machines: "x", an ssh machine whose agent
// runs in the test (so its loopback is the test's), and the local one.
func newTest(t *testing.T) (*Plugin, *fakeHost) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	logger := log.New(io.Discard, "", 0)
	dial := func(ctx context.Context, spec machines.Spec) (*transport.Session, string, error) {
		s, err := transport.DialLocal(ctx, agent.Options{Logger: logger})
		return s, "test/test", err
	}
	mg := machines.NewManager([]machines.Spec{
		{ID: "x", Label: "x", Kind: machines.KindSSH, Target: "x", Enabled: true},
		{ID: "here", Label: "here", Kind: machines.KindLocal, Enabled: false},
	}, dial, logger)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		mg.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	for deadline := time.Now().Add(10 * time.Second); mg.Get("x").Session() == nil; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("machine did not connect")
		}
	}
	p := New()
	t.Cleanup(func() { p.closeWhere(func(*forward) bool { return true }) })
	return p, &fakeHost{mg: mg}
}

// echo is a service on loopback that answers each line with "echo: " and
// the line; its port.
func echo(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				sc := bufio.NewScanner(c)
				for sc.Scan() {
					c.Write([]byte("echo: " + sc.Text() + "\n"))
				}
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// do calls a route of the plugin as a client on the core's host would
// (sameHost) for machine m.
func do(p *Plugin, h *fakeHost, sameHost bool, method, m, path, body string) (int, map[string]any) {
	mux := http.NewServeMux()
	for _, rt := range p.Routes() {
		rt := rt
		mux.HandleFunc(plugin.Pattern(ID, rt), func(w http.ResponseWriter, r *http.Request) {
			c := &plugin.Call{Host: h, SameHost: sameHost}
			if rt.Machine {
				c.Machine = h.mg.Get(r.PathValue("id"))
			}
			rt.Handler(c, w, r)
		})
	}
	url := "/api/p/browser/" + path
	if m != "" {
		url = "/api/m/" + m + "/p/browser/" + path
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(method, url, strings.NewReader(body)))
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func ask(t *testing.T, addr, line string) (string, error) {
	t.Helper()
	c, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte(line + "\n")); err != nil {
		return "", err
	}
	return bufio.NewReader(c).ReadString('\n')
}

// A forward listens on the core host's loopback and carries connections to
// the machine's port; it is found again, listed, and ends when stopped,
// with its connections.
func TestForward(t *testing.T) {
	p, h := newTest(t)
	port := echo(t)
	body := `{"port":` + strconv.Itoa(port) + `}`
	code, out := do(p, h, true, "POST", "x", "forwards", body)
	if code != 200 {
		t.Fatalf("forward %d %v", code, out)
	}
	local := int(out["local"].(float64))
	// The machine is this host here, so the service holds its own port and
	// the forward listens on another.
	if local == port || local < 1024 {
		t.Fatalf("local port %d for %d", local, port)
	}
	addr := "127.0.0.1:" + strconv.Itoa(local)
	if got, err := ask(t, addr, "hello"); err != nil || got != "echo: hello\n" {
		t.Fatalf("through the forward: %q %v", got, err)
	}
	// On ::1 too, where "localhost" may lead, when the host has it.
	p.mu.Lock()
	both := len(p.forwards[key{"x", port}].lns) == 2
	p.mu.Unlock()
	if both {
		if got, err := ask(t, "[::1]:"+strconv.Itoa(local), "six"); err != nil || got != "echo: six\n" {
			t.Errorf("through ::1: %q %v", got, err)
		}
	}
	// Asked again it is the same one.
	if code, again := do(p, h, true, "POST", "x", "forwards", body); code != 200 || int(again["local"].(float64)) != local {
		t.Fatalf("again %d %v", code, again)
	}
	_, list := do(p, h, true, "GET", "", "forwards", "")
	if fs := list["forwards"].([]any); len(fs) != 1 || list["available"] != true || fs[0].(map[string]any)["m"] != "x" {
		t.Fatalf("list %v", list)
	}
	if _, list := do(p, h, false, "GET", "", "forwards", ""); list["available"] != false {
		t.Errorf("available to a client elsewhere: %v", list)
	}
	// Stopping ends the listener and the open connections.
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte("open\n"))
	bufio.NewReader(c).ReadString('\n')
	if code, _ := do(p, h, true, "DELETE", "x", "forwards/"+strconv.Itoa(port), ""); code != 200 {
		t.Fatalf("stop %d", code)
	}
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Read(make([]byte, 1)); err == nil {
		t.Error("a connection outlived its forward")
	}
	if _, err := net.DialTimeout("tcp", addr, time.Second); err == nil {
		t.Error("the listener outlived its forward")
	}
	if code, _ := do(p, h, true, "DELETE", "x", "forwards/"+strconv.Itoa(port), ""); code != 404 {
		t.Errorf("stopping none: %d", code)
	}
}

// Forwards are for clients on the core's host and for other machines'
// ports; a port nothing answers on closes its connections.
func TestForwardRefusals(t *testing.T) {
	p, h := newTest(t)
	port := echo(t)
	body := `{"port":` + strconv.Itoa(port) + `}`
	if code, out := do(p, h, false, "POST", "x", "forwards", body); code != 403 || out["error"] != "forward_local_only" {
		t.Errorf("a client elsewhere: %d %v", code, out)
	}
	if code, out := do(p, h, true, "POST", "here", "forwards", body); code != 400 || out["error"] != "local_machine" {
		t.Errorf("the local machine: %d %v", code, out)
	}
	for _, bad := range []string{`{"port":0}`, `{"port":65536}`, `{"port":-1}`, `{}`} {
		if code, _ := do(p, h, true, "POST", "x", "forwards", bad); code != 400 {
			t.Errorf("%s: %d", bad, code)
		}
	}
	if len(p.List()) != 0 {
		t.Fatalf("forwards made by refused requests: %v", p.List())
	}
	// A port without a service: the forward exists, its connections end.
	ln, _ := net.Listen("tcp4", "127.0.0.1:0")
	dead := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	_, out := do(p, h, true, "POST", "x", "forwards", `{"port":`+strconv.Itoa(dead)+`}`)
	c, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(int(out["local"].(float64))), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	if n, err := c.Read(make([]byte, 1)); err == nil || n != 0 {
		t.Errorf("a connection to no service stayed open: %d %v", n, err)
	}
}

// Forwards end unused after the setting's time, when their machine is
// removed, and are bounded.
func TestForwardsEnd(t *testing.T) {
	p, h := newTest(t)
	now := time.Now()
	p.now = func() time.Time { return now }
	port := echo(t)
	mk := func(port int) int {
		t.Helper()
		code, out := do(p, h, true, "POST", "x", "forwards", `{"port":`+strconv.Itoa(port)+`}`)
		if code != 200 {
			t.Fatalf("forward of %d: %d %v", port, code, out)
		}
		return int(out["local"].(float64))
	}
	local := mk(port)
	// In use it stays, however old.
	c, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(local))
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte("x\n"))
	bufio.NewReader(c).ReadString('\n')
	now = now.Add(2 * time.Hour)
	p.reap(h)
	if len(p.List()) != 1 {
		t.Fatal("a forward in use ended")
	}
	c.Close()
	for deadline := time.Now().Add(5 * time.Second); p.List()[0].Connections != 0; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the connection did not end")
		}
	}
	// Unused for less than the time it stays, for more it ends.
	now = now.Add(time.Duration(DefaultIdle-1) * time.Minute)
	p.reap(h)
	if len(p.List()) != 1 {
		t.Fatal("ended too early")
	}
	now = now.Add(2 * time.Minute)
	p.reap(h)
	if len(p.List()) != 0 {
		t.Fatal("an idle forward stayed")
	}
	// A removed machine's forwards end.
	mk(port)
	p.ForgetMachine(h, "other")
	if len(p.List()) != 1 {
		t.Fatal("another machine's removal ended it")
	}
	p.ForgetMachine(h, "x")
	if len(p.List()) != 0 {
		t.Fatal("a removed machine's forward stayed")
	}
	// At most MaxForwards.
	for i := range MaxForwards {
		mk(20000 + i)
	}
	if code, out := do(p, h, true, "POST", "x", "forwards", `{"port":19999}`); code != 400 || out["error"] != "too_many" {
		t.Errorf("one too many: %d %v", code, out)
	}
}

// The forward listens on the port asked for when it is free, on loopback
// only, never on a port whose ::1 side another program holds.
func TestListenLoopback(t *testing.T) {
	ln, _ := net.Listen("tcp4", "127.0.0.1:0")
	free := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	lns, local, err := listenLoopback(free)
	if err != nil || local != free {
		t.Fatalf("a free port: %d %v", local, err)
	}
	for _, l := range lns {
		if ip := l.Addr().(*net.TCPAddr).IP; !ip.IsLoopback() {
			t.Errorf("listening on %v", ip)
		}
		l.Close()
	}
	// Taken on 127.0.0.1: another port.
	held, _ := net.Listen("tcp4", "127.0.0.1:0")
	defer held.Close()
	taken := held.Addr().(*net.TCPAddr).Port
	lns, local, err = listenLoopback(taken)
	if err != nil || local == taken {
		t.Fatalf("a taken port: %d %v", local, err)
	}
	for _, l := range lns {
		l.Close()
	}
	// Taken on ::1 only: not used either, or "localhost" could lead there.
	six, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Skip("no IPv6 loopback")
	}
	defer six.Close()
	taken = six.Addr().(*net.TCPAddr).Port
	lns, local, err = listenLoopback(taken)
	if err != nil || local == taken {
		t.Fatalf("a port taken on ::1: %d %v", local, err)
	}
	for _, l := range lns {
		l.Close()
	}
	// A port of the system's is not asked for.
	lns, local, err = listenLoopback(80)
	if err != nil || local == 80 {
		t.Fatalf("port 80: %d %v", local, err)
	}
	for _, l := range lns {
		l.Close()
	}
}

// The machine's listening ports include a service of the test.
func TestListening(t *testing.T) {
	p, h := newTest(t)
	port := echo(t)
	code, out := do(p, h, true, "GET", "x", "listening", "")
	if code != 200 {
		t.Fatalf("listening %d %v", code, out)
	}
	found := false
	for _, e := range out["ports"].([]any) {
		if int(e.(map[string]any)["port"].(float64)) == port {
			found = true
		}
	}
	if !found {
		t.Errorf("port %d not among %v", port, out["ports"])
	}
}
