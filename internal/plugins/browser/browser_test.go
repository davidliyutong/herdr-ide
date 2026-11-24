//go:build unix

package browser

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"veldr/internal/agent"
	"veldr/internal/machines"
	"veldr/internal/plugin"
	"veldr/internal/settings"
	"veldr/internal/transport"
)

type fakeHost struct {
	mg *machines.Manager
	st *settings.Store
	// logs takes the plugin's log lines, when a test reads them.
	logs io.Writer
}

func (h *fakeHost) Machines() *machines.Manager                 { return h.mg }
func (h *fakeHost) Broadcast(string, string, any)               {}
func (h *fakeHost) Audit(*http.Request, string, map[string]any) {}
func (h *fakeHost) ReadOnly() bool                              { return false }
func (h *fakeHost) Settings() *settings.Store                   { return h.st }
func (h *fakeHost) Logger() *log.Logger {
	if h.logs != nil {
		return log.New(h.logs, "", 0)
	}
	return log.New(io.Discard, "", 0)
}

// testClock is the plugin's clock in a test, which moves it while the
// forwards' goroutines read it.
type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// forward makes (or finds) the forward of port on machine x and returns
// its local port.
func mkForward(t *testing.T, p *Plugin, h *fakeHost, port int) int {
	t.Helper()
	code, out := do(p, h, true, "POST", "x", "forwards", `{"port":`+strconv.Itoa(port)+`}`)
	if code != 200 {
		t.Fatalf("forward of %d: %d %v", port, code, out)
	}
	return int(out["local"].(float64))
}

// line sends a line over an open connection to the echo service and reads
// its answer.
func line(t *testing.T, c net.Conn, text string) {
	t.Helper()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte(text + "\n")); err != nil {
		t.Fatalf("writing %q: %v", text, err)
	}
	if got, err := bufio.NewReader(c).ReadString('\n'); err != nil || got != "echo: "+text+"\n" {
		t.Fatalf("answer to %q: %q %v", text, got, err)
	}
}

// ended reports whether the other side closed c: a read ends without a
// byte.
func ended(c net.Conn) bool {
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := c.Read(make([]byte, 1))
	var ne net.Error
	return n == 0 && err != nil && !(errors.As(err, &ne) && ne.Timeout())
}

// connections waits until the forward of port has n connections.
func connections(t *testing.T, p *Plugin, port, n int) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		p.mu.Lock()
		f := p.forwards[key{"x", port}]
		got := -1
		if f != nil {
			got = f.conns
		}
		p.mu.Unlock()
		if got == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the forward of %d has %d connections, not %d", port, got, n)
		}
	}
}

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
	clock := &testClock{t: time.Now()}
	p.now = clock.now
	port := echo(t)
	mkForward(t, p, h, port)
	// Unused for less than the time it stays, for more it ends.
	clock.add(time.Duration(DefaultIdle-1) * time.Minute)
	p.reap(h)
	if len(p.List()) != 1 {
		t.Fatal("ended too early")
	}
	clock.add(2 * time.Minute)
	p.reap(h)
	if len(p.List()) != 0 {
		t.Fatal("an idle forward stayed")
	}
	// A removed machine's forwards end.
	mkForward(t, p, h, port)
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
		mkForward(t, p, h, 20000+i)
	}
	if code, out := do(p, h, true, "POST", "x", "forwards", `{"port":19999}`); code != 400 || out["error"] != "too_many" {
		t.Errorf("one too many: %d %v", code, out)
	}
}

// What keeps a forward is its use: a connection accepted, bytes carried,
// a client asking for it. A connection that only stays open keeps nothing:
// the forward ends idle with it, and closes it.
func TestForwardIdleIsAboutUse(t *testing.T) {
	p, h := newTest(t)
	clock := &testClock{t: time.Now()}
	p.now = clock.now
	port := echo(t)
	local := mkForward(t, p, h, port)
	addr := "127.0.0.1:" + strconv.Itoa(local)
	almost, rest := time.Duration(DefaultIdle-1)*time.Minute, 2*time.Minute
	stays := func(what string) {
		t.Helper()
		p.reap(h)
		if len(p.List()) != 1 {
			t.Fatalf("%s: the forward ended", what)
		}
	}
	// Asking for it again is a use.
	clock.add(almost)
	mkForward(t, p, h, port)
	clock.add(rest)
	stays("asked for again")
	// A connection accepted is one.
	clock.add(almost - rest)
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	connections(t, p, port, 1)
	clock.add(rest)
	stays("a connection accepted")
	// Bytes carried are one, in a connection as old as it may be.
	clock.add(almost - rest)
	line(t, c, "still here")
	clock.add(rest)
	stays("bytes carried")
	// They are noted at most every second: the forward's last use moves
	// with the first chunk of a second and not with the next.
	p.mu.Lock()
	f := p.forwards[key{"x", port}]
	p.mu.Unlock()
	clock.add(useEvery)
	line(t, c, "one")
	first := f.lastUse()
	if !first.Equal(clock.now()) {
		t.Fatalf("bytes after a second: last use %v, now %v", first, clock.now())
	}
	clock.add(useEvery / 2)
	line(t, c, "two")
	if !f.lastUse().Equal(first) {
		t.Errorf("bytes within the second moved the last use from %v to %v", first, f.lastUse())
	}
	// The connection stays open and carries nothing: the forward is not in
	// use, however many connections it has, and ends with them.
	clock.add(almost)
	stays("not idle long enough")
	clock.add(rest)
	p.reap(h)
	if len(p.List()) != 0 {
		t.Fatal("a forward with a silent connection stayed")
	}
	if !ended(c) {
		t.Error("the silent connection outlived its forward")
	}
	if _, err := net.DialTimeout("tcp", addr, time.Second); err == nil {
		t.Error("the listener outlived its forward")
	}
	// The setting is the time; at 0 forwards stay until stopped, and with
	// the plugin off none does.
	h.st = settings.New("", Settings, plugin.Settings([]plugin.Plugin{p}, nil))
	if err := h.st.Set(SettingIdle, "", float64(5)); err != nil {
		t.Fatal(err)
	}
	mkForward(t, p, h, port)
	clock.add(4 * time.Minute)
	stays("less than the setting's time")
	clock.add(2 * time.Minute)
	p.reap(h)
	if len(p.List()) != 0 {
		t.Fatal("a forward stayed beyond the setting's time")
	}
	if err := h.st.Set(SettingIdle, "", float64(0)); err != nil {
		t.Fatal(err)
	}
	mkForward(t, p, h, port)
	clock.add(48 * time.Hour)
	stays("no idle time")
	if err := h.st.Set(plugin.EnableSetting(p), "", false); err != nil {
		t.Fatal(err)
	}
	p.reap(h)
	if len(p.List()) != 0 {
		t.Fatal("a forward stayed with the plugin off")
	}
}

// A forward carries at most maxConns connections at a time: one more is
// closed at once, the earlier ones go on, and a place that is freed is
// taken again.
func TestForwardConnectionsBound(t *testing.T) {
	p, h := newTest(t)
	port := echo(t)
	local := mkForward(t, p, h, port)
	addr := "127.0.0.1:" + strconv.Itoa(local)
	// All places but two are taken.
	p.mu.Lock()
	f := p.forwards[key{"x", port}]
	f.conns = maxConns - 2
	p.mu.Unlock()
	dial := func() net.Conn {
		t.Helper()
		c, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
	a, b := dial(), dial()
	line(t, a, "a")
	line(t, b, "b")
	connections(t, p, port, maxConns)
	// The one beyond the bound: accepted by the system, closed by the core.
	over := dial()
	over.Write([]byte("over\n"))
	if !ended(over) {
		t.Fatal("a connection beyond the bound was carried")
	}
	if got := p.List()[0].Connections; got != maxConns {
		t.Errorf("%d connections counted, at most %d", got, maxConns)
	}
	// The earlier ones were not disturbed.
	line(t, a, "a again")
	line(t, b, "b again")
	// One ends: its place is free for another.
	a.Close()
	connections(t, p, port, maxConns-1)
	line(t, dial(), "after")
	line(t, b, "b still")
}

// scripted is a listener whose Accept returns the errors of a script, one
// per call, and then waits until it is closed.
type scripted struct {
	mu     sync.Mutex
	errs   []error
	calls  int
	closed chan struct{}
	once   sync.Once
}

func newScripted(errs ...error) *scripted { return &scripted{errs: errs, closed: make(chan struct{})} }

func (l *scripted) Accept() (net.Conn, error) {
	l.mu.Lock()
	l.calls++
	var err error
	if len(l.errs) > 0 {
		err, l.errs = l.errs[0], l.errs[1:]
	}
	l.mu.Unlock()
	if err != nil {
		return nil, err
	}
	<-l.closed
	return nil, net.ErrClosed
}

func (l *scripted) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *scripted) Addr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1} }

func (l *scripted) accepts() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.calls
}

func (l *scripted) isClosed() bool {
	select {
	case <-l.closed:
		return true
	default:
		return false
	}
}

// timeout is a net.Error that says a deadline passed.
type timeout struct{}

func (timeout) Error() string   { return "deadline" }
func (timeout) Timeout() bool   { return true }
func (timeout) Temporary() bool { return true }

// A listener that fails for now (no descriptors left, a deadline) accepts
// again after a pause; one that fails for good ends its forward, which
// leaves the list with every listener and connection of its own.
func TestForwardAcceptFailures(t *testing.T) {
	sys := func(err error) error {
		return &net.OpError{Op: "accept", Net: "tcp", Err: os.NewSyscallError("accept", err)}
	}
	for _, e := range []error{sys(syscall.EMFILE), sys(syscall.ENFILE), sys(syscall.ECONNABORTED), timeout{}} {
		if !temporary(e) {
			t.Errorf("%v is not tried again", e)
		}
	}
	for _, e := range []error{sys(syscall.EINVAL), sys(syscall.EBADF), errors.New("broken"), net.ErrClosed} {
		if temporary(e) {
			t.Errorf("%v is tried again", e)
		}
	}

	var logs bytes.Buffer
	var logMu sync.Mutex
	h := &fakeHost{logs: writerFunc(func(b []byte) (int, error) {
		logMu.Lock()
		defer logMu.Unlock()
		return logs.Write(b)
	})}
	// add puts a forward of machine x into the plugin, served from lns.
	add := func(p *Plugin, port int, lns ...net.Listener) (*forward, chan struct{}) {
		ctx, cancel := context.WithCancel(context.Background())
		f := &forward{key: key{"x", port}, local: port, lns: lns, created: time.Now(), ctx: ctx, cancel: cancel}
		f.use(time.Now())
		p.mu.Lock()
		if p.forwards == nil {
			p.forwards = map[key]*forward{}
		}
		p.forwards[f.key] = f
		p.mu.Unlock()
		done := make(chan struct{})
		go func() {
			p.serve(h, f, lns[0])
			close(done)
		}()
		return f, done
	}
	wait := func(what string, done chan struct{}) {
		t.Helper()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: the listener is still served", what)
		}
	}

	// Temporary failures: tried again, the forward stays; then a failure
	// for good ends it.
	p := New()
	first, second := newScripted(sys(syscall.EMFILE), timeout{}, sys(syscall.ENFILE), sys(syscall.EINVAL)), newScripted()
	f, done := add(p, 3000, first, second)
	other, otherDone := add(p, 4000, newScripted())
	wait("a failure for good", done)
	if got := first.accepts(); got != 4 {
		t.Errorf("%d accepts, want one per failure", got)
	}
	if list := p.List(); len(list) != 1 || list[0].Port != 4000 {
		t.Errorf("the list after a listener failed: %v", list)
	}
	if !first.isClosed() || !second.isClosed() || f.ctx.Err() == nil {
		t.Error("a failed forward kept a listener or its connections")
	}
	if other.ctx.Err() != nil || other.lns[0].(*scripted).isClosed() {
		t.Error("another forward ended with it")
	}
	logMu.Lock()
	logged := logs.String()
	logs.Reset()
	logMu.Unlock()
	if !strings.Contains(logged, "port 3000 of x") || !strings.Contains(logged, syscall.EINVAL.Error()) {
		t.Errorf("the log says %q", logged)
	}

	// A forward that is stopped ends its listeners' loops without a word,
	// also one that waits to accept again.
	p.closeWhere(func(*forward) bool { return true })
	wait("a stopped forward", otherDone)
	many := make([]error, 100)
	for i := range many {
		many[i] = sys(syscall.EMFILE)
	}
	retrying := newScripted(many...)
	_, done = add(p, 5000, retrying)
	for deadline := time.Now().Add(5 * time.Second); retrying.accepts() < 3; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("a temporary failure was not tried again")
		}
	}
	if len(p.List()) != 1 {
		t.Fatal("a temporary failure ended the forward")
	}
	p.closeWhere(func(*forward) bool { return true })
	wait("a stopped forward that was pausing", done)
	// The pause grows: a hundred failures are not a hundred accepts at once.
	if got := retrying.accepts(); got > 20 {
		t.Errorf("%d accepts while failing: no pause between them", got)
	}
	logMu.Lock()
	defer logMu.Unlock()
	if logs.Len() != 0 {
		t.Errorf("stopping logged %q", logs.String())
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(b []byte) (int, error) { return f(b) }

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
