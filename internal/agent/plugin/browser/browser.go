//go:build unix

// Package browser is the machine side of the browser plugin
// (internal/plugins/browser, docs/features/32-browser-and-ports.md): it
// connects the core to a service listening on the machine's own loopback
// interface, the way ssh -L does, and lists what listens there. Nothing
// listens on the machine for it: the core opens a stream per connection.
package browser

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"sort"
	"strconv"
	"sync"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
)

func init() { plugin.Register("browser", handle) }

// dialTimeout bounds connecting to a service of the machine itself.
const dialTimeout = 5 * time.Second

// MaxPorts bounds the list of listening ports.
const MaxPorts = 200

// Port is a TCP port something of the user listens on.
type Port struct {
	Port int `json:"port"`
	// Process is the listening program's name, when known.
	Process string `json:"process,omitempty"`
}

func handle(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *plugin.Env) error {
	switch action {
	case "dial":
		return dial(ctx, st, params)
	case "listening":
		lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return plugin.Reply(st, map[string]any{"ports": tidy(listening(lctx))}, nil)
	}
	return plugin.Reply(st, nil, plugin.Errorf("bad_action", "unknown action %q", action))
}

// dial connects st to the port of this machine's loopback interface that
// the parameters name ({port}), answers, and then carries bytes both ways
// until either side ends. Only loopback is dialed: the core reaches what a
// program of this machine could, not the machine's network.
func dial(ctx context.Context, st net.Conn, params json.RawMessage) error {
	var p struct {
		Port int `json:"port"`
	}
	if err := plugin.Decode(params, &p); err != nil {
		return plugin.Reply(st, nil, err)
	}
	if p.Port < 1 || p.Port > 65535 {
		return plugin.Reply(st, nil, plugin.Errorf("bad_params", "port %d", p.Port))
	}
	d := net.Dialer{Timeout: dialTimeout}
	var conn net.Conn
	var err error
	for _, host := range []string{"127.0.0.1", "::1"} {
		if conn, err = d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(p.Port))); err == nil {
			break
		}
	}
	if err != nil {
		return plugin.Reply(st, nil, plugin.Errorf("refused", "nothing answers on port %d of the machine: %v", p.Port, err))
	}
	if err := agentproto.WriteLine(st, agentproto.Reply{OK: true}); err != nil {
		conn.Close()
		st.Close()
		return err
	}
	stop := context.AfterFunc(ctx, func() {
		conn.Close()
		st.Close()
	})
	defer stop()
	pipe(st, conn)
	return nil
}

// pipe copies in both directions and closes both ends when either ends.
func pipe(a, b net.Conn) {
	var once sync.Once
	end := func() {
		once.Do(func() {
			a.Close()
			b.Close()
		})
	}
	done := make(chan struct{})
	go func() {
		io.Copy(a, b)
		end()
		close(done)
	}()
	io.Copy(b, a)
	end()
	<-done
}

// tidy sorts ports, keeps one entry per port (the one that names its
// process) and at most MaxPorts.
func tidy(ports []Port) []Port {
	by := map[int]Port{}
	for _, p := range ports {
		if p.Port < 1 || p.Port > 65535 {
			continue
		}
		if cur, ok := by[p.Port]; !ok || (cur.Process == "" && p.Process != "") {
			by[p.Port] = p
		}
	}
	out := make([]Port, 0, len(by))
	for _, p := range by {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	if len(out) > MaxPorts {
		out = out[:MaxPorts]
	}
	return out
}
