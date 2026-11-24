//go:build unix

package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"reflect"
	"strconv"
	"testing"
	"time"

	"veldr/internal/agentproto"
)

// service is a listener on a loopback address of the test that answers
// each line with "got: " and the line; its port. The test is skipped when
// the host has no such address.
func service(t *testing.T, network, addr string) int {
	t.Helper()
	ln, err := net.Listen(network, addr)
	if err != nil {
		t.Skipf("no listener on %s: %v", addr, err)
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
					c.Write([]byte("got: " + sc.Text() + "\n"))
				}
			}()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

// act runs an action of the plugin as the agent does, on one end of a
// stream; the other end is the core's, with the reply read from it. done
// is closed when the action returned.
func act(t *testing.T, ctx context.Context, action, params string) (core net.Conn, rep agentproto.Reply, done chan struct{}) {
	t.Helper()
	agent, core := net.Pipe()
	t.Cleanup(func() { core.Close() })
	done = make(chan struct{})
	go func() {
		handle(ctx, agent, action, json.RawMessage(params), nil)
		close(done)
	}()
	core.SetDeadline(time.Now().Add(10 * time.Second))
	if err := agentproto.ReadLine(core, &rep); err != nil {
		t.Fatalf("%s %s: reading the reply: %v", action, params, err)
	}
	return core, rep, done
}

func returned(t *testing.T, what string, done chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s: the action did not end", what)
	}
}

// dial connects the stream to a service on the machine's loopback and
// carries bytes both ways, until the core closes the stream.
func TestDial(t *testing.T) {
	for _, on := range []struct{ network, addr string }{{"tcp4", "127.0.0.1:0"}, {"tcp6", "[::1]:0"}} {
		t.Run(on.network, func(t *testing.T) {
			port := service(t, on.network, on.addr)
			core, rep, done := act(t, context.Background(), "dial", `{"port":`+strconv.Itoa(port)+`}`)
			if !rep.OK {
				t.Fatalf("dial: %+v", rep)
			}
			r := bufio.NewReader(core)
			for _, text := range []string{"one", "two"} {
				if _, err := core.Write([]byte(text + "\n")); err != nil {
					t.Fatal(err)
				}
				if got, err := r.ReadString('\n'); err != nil || got != "got: "+text+"\n" {
					t.Fatalf("through the stream: %q %v", got, err)
				}
			}
			core.Close()
			returned(t, "the core closed the stream", done)
		})
	}
}

// The stream ends when the service does, and when the agent stops.
func TestDialEnds(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 2)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepted <- c
		}
	}()
	params := `{"port":` + strconv.Itoa(ln.Addr().(*net.TCPAddr).Port) + `}`
	// The service closes its side.
	core, rep, done := act(t, context.Background(), "dial", params)
	if !rep.OK {
		t.Fatalf("dial: %+v", rep)
	}
	(<-accepted).Close()
	if n, err := core.Read(make([]byte, 1)); n != 0 || err == nil {
		t.Errorf("the stream of an ended service: %d %v", n, err)
	}
	returned(t, "the service ended", done)
	// The agent's context ends.
	ctx, cancel := context.WithCancel(context.Background())
	core, rep, done = act(t, ctx, "dial", params)
	if !rep.OK {
		t.Fatalf("dial: %+v", rep)
	}
	service := <-accepted
	defer service.Close()
	cancel()
	returned(t, "the agent stopped", done)
	if n, err := core.Read(make([]byte, 1)); n != 0 || err == nil {
		t.Errorf("the stream of a stopped agent: %d %v", n, err)
	}
	service.SetReadDeadline(time.Now().Add(5 * time.Second))
	if n, err := service.Read(make([]byte, 1)); n != 0 || err == nil {
		t.Errorf("the service's connection of a stopped agent: %d %v", n, err)
	}
}

// A port nobody listens on, and what is no port, are answered with a code
// and nothing is carried.
func TestDialRefusals(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	free := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	for _, c := range []struct{ action, params, code string }{
		{"dial", `{"port":` + strconv.Itoa(free) + `}`, "refused"},
		{"dial", `{"port":0}`, "bad_params"},
		{"dial", `{"port":65536}`, "bad_params"},
		{"dial", `{"port":-1}`, "bad_params"},
		{"dial", `{}`, "bad_params"},
		{"dial", `{"port":"80"}`, "bad_params"},
		{"dial", `{"port":`, "bad_params"},
		{"connect", `{"port":80}`, "bad_action"},
	} {
		core, rep, done := act(t, context.Background(), c.action, c.params)
		if rep.OK || rep.Code != c.code {
			t.Errorf("%s %s: %+v, want %s", c.action, c.params, rep, c.code)
		}
		returned(t, c.action+" "+c.params, done)
		if n, err := core.Read(make([]byte, 1)); n != 0 || err == nil {
			t.Errorf("%s %s: the stream stayed open: %d %v", c.action, c.params, n, err)
		}
	}
}

// The list of ports is sorted, has one entry per port (the one that names
// its program), no number that is no port, and is bounded.
func TestTidy(t *testing.T) {
	got := tidy([]Port{{Port: 8080}, {Port: 3000, Process: "node"}, {Port: 8080, Process: "python3"}, {Port: 3000}, {Port: 0}, {Port: 70000}, {Port: -1}})
	if want := []Port{{Port: 3000, Process: "node"}, {Port: 8080, Process: "python3"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("tidy: %v, want %v", got, want)
	}
	var many []Port
	for i := MaxPorts + 50; i >= 1; i-- {
		many = append(many, Port{Port: i})
	}
	if got := tidy(many); len(got) != MaxPorts || got[0].Port != 1 || got[MaxPorts-1].Port != MaxPorts {
		t.Errorf("tidy of %d ports: %d, from %d to %d", len(many), len(got), got[0].Port, got[len(got)-1].Port)
	}
	if got := tidy(nil); got == nil || len(got) != 0 {
		t.Errorf("tidy of nothing: %#v", got)
	}
}

// The machine's listening ports include a service of the test, where the
// system's list can be read.
func TestListeningHere(t *testing.T) {
	port := service(t, "tcp4", "127.0.0.1:0")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ports := tidy(listening(ctx))
	if len(ports) == 0 {
		t.Skip("the listening ports are not known on this system")
	}
	for _, p := range ports {
		if p.Port == port {
			return
		}
	}
	t.Errorf("port %d not among %v", port, ports)
}
