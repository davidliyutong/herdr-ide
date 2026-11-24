//go:build unix

package migrate

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/brand"
	"herdr-ide/internal/hc"
)

// fakeCore answers what the plugin asks of a previous terminal core.
type fakeCore struct {
	mu      sync.Mutex
	terms   []hc.Terminal
	layout  json.RawMessage
	version int64
	killed  []string
}

func frame(ch uint32, kind byte, payload []byte) []byte {
	b := binary.LittleEndian.AppendUint32(nil, ch)
	b = append(b, kind)
	b = binary.LittleEndian.AppendUint32(b, uint32(len(payload)))
	return append(b, payload...)
}

func (f *fakeCore) serve(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	if _, err := br.ReadBytes('\n'); err != nil {
		return
	}
	io.WriteString(c, `{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"0.1.21","framed":true,"core":{"id":"c1","name":"box"},"methods":[],"features":[]}}`+"\n")
	for {
		var h [9]byte
		if _, err := io.ReadFull(br, h[:]); err != nil {
			return
		}
		p := make([]byte, binary.LittleEndian.Uint32(h[5:]))
		if _, err := io.ReadFull(br, p); err != nil {
			return
		}
		var req struct {
			ID     *uint64         `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(p, &req) != nil || req.ID == nil {
			continue
		}
		reply := func(body string) {
			c.Write(frame(0, 0, fmt.Appendf(nil, `{"jsonrpc":"2.0","id":%d,%s}`, *req.ID, body)))
		}
		result := func(v any) {
			b, _ := json.Marshal(v)
			reply(`"result":` + string(b))
		}
		f.mu.Lock()
		switch req.Method {
		case "terminal.list":
			result(map[string]any{"terminals": f.terms})
		case "doc.get":
			result(map[string]any{"value": f.layout, "version": f.version})
		case "doc.set":
			var q struct {
				Value   json.RawMessage `json:"value"`
				Version int64           `json:"version"`
			}
			json.Unmarshal(req.Params, &q)
			if q.Version != f.version {
				reply(`"error":{"code":-32000,"message":"conflict","data":{"kind":"conflict"}}`)
			} else {
				f.layout, f.version = q.Value, f.version+1
				result(map[string]any{"version": f.version})
			}
		case "terminal.kill":
			var q struct{ Terminal string }
			json.Unmarshal(req.Params, &q)
			f.killed = append(f.killed, q.Terminal)
			result(map[string]any{})
		default:
			reply(`"error":{"code":-32601,"message":"no method"}`)
		}
		f.mu.Unlock()
	}
}

func pid(n int) *int       { return &n }
func str(s string) *string { return &s }

// setup makes a home with this namespace's data directory and a previous
// name's beside it, whose terminal core is f.
func setup(t *testing.T, f *fakeCore) (*plugin.Env, string) {
	t.Helper()
	home, err := os.MkdirTemp("/tmp", "mig")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	old := brand.LegacySlugs
	brand.LegacySlugs = []string{"oldname"}
	t.Cleanup(func() { brand.LegacySlugs = old })
	base := filepath.Join(home, brand.DataDir("dev"))
	prev := filepath.Join(home, ".oldname-dev")
	os.MkdirAll(base, 0o700)
	os.MkdirAll(filepath.Join(prev, "run"), 0o700)
	if f != nil {
		ln, err := net.Listen("unix", filepath.Join(prev, "run", "hc.sock"))
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
				go f.serve(c)
			}
		}()
	}
	return &plugin.Env{Home: home, Base: base, Logger: log.New(io.Discard, "", 0)}, prev
}

// call runs an action as the agent's plugin op does and decodes the result.
func call(t *testing.T, env *plugin.Env, action string, params, out any) agentproto.Reply {
	t.Helper()
	a, b := net.Pipe()
	var raw json.RawMessage
	if params != nil {
		raw, _ = json.Marshal(params)
	}
	go handle(context.Background(), a, action, raw, env)
	var rep agentproto.Reply
	if err := agentproto.ReadLine(b, &rep); err != nil {
		t.Fatal(err)
	}
	if rep.OK && out != nil {
		body := rep.Plugin
		if rep.PluginLength > 0 {
			body = make([]byte, rep.PluginLength)
			io.ReadFull(b, body)
		}
		if err := json.Unmarshal(body, out); err != nil {
			t.Fatal(err)
		}
	}
	b.Close()
	return rep
}

func TestScanAndRelease(t *testing.T) {
	f := &fakeCore{
		layout:  json.RawMessage(`{"version":2,"workspaces":[],"selected":0}`),
		version: 3,
		terms: []hc.Terminal{
			{Address: "t1", State: "live", PID: pid(10), Cwd: "/w", Foreground: &hc.Foreground{PID: 11, Name: "vim", Argv: []string{"vim"}, Cwd: "/w/src"}},
			{Address: "t2", State: "live", PID: pid(20), Cwd: "/x", Foreground: &hc.Foreground{PID: 20, Name: "bash", Argv: []string{"-bash"}, Cwd: "/x"}},
			{Address: "t3", State: "finished"},
			{Address: "t4", State: "live", Name: str("oldname-chat-host"), Labels: map[string]string{"oldname.hidden": "chat-host"}},
		},
	}
	env, prev := setup(t, f)
	var st agentproto.MigrateStatus
	if rep := call(t, env, agentproto.MigrateActionStatus, nil, &st); !rep.OK || st.Slug != "oldname" || st.Dir != prev || !st.Running || st.Node || st.Terminals != 2 {
		t.Fatalf("status %+v %+v", rep, st)
	}
	var scan agentproto.MigrateScan
	if rep := call(t, env, agentproto.MigrateActionScan, nil, &scan); !rep.OK {
		t.Fatalf("scan %+v", rep)
	}
	if scan.LayoutVersion != 3 || len(scan.Terminals) != 2 {
		t.Fatalf("scan %+v", scan)
	}
	if got := scan.Terminals[0]; got.Program != "vim" || got.Cwd != "/w/src" || got.Agent != "" {
		t.Errorf("t1 %+v", got)
	}
	if got := scan.Terminals[1]; got.Program != "" || got.Cwd != "/x" {
		t.Errorf("t2 %+v", got)
	}
	// A stale version changes nothing; the right one writes, then ends the
	// namespace's live terminals named, and only those.
	rest := agentproto.MigrateRelease{Layout: json.RawMessage(`{"version":2,"workspaces":[],"selected":0,"x":1}`), Version: 2, Terminals: []string{"t1", "t4", "zz"}}
	if rep := call(t, env, agentproto.MigrateActionRelease, rest, nil); rep.OK || rep.Code != "conflict" || len(f.killed) != 0 {
		t.Fatalf("stale release %+v %v", rep, f.killed)
	}
	rest.Version = 3
	if rep := call(t, env, agentproto.MigrateActionRelease, rest, nil); !rep.OK {
		t.Fatalf("release %+v", rep)
	}
	if string(f.layout) != string(rest.Layout) || fmt.Sprint(f.killed) != "[t1]" {
		t.Errorf("layout %s killed %v", f.layout, f.killed)
	}
	if rep := call(t, env, agentproto.MigrateActionRelease, agentproto.MigrateRelease{Layout: json.RawMessage(`{}`), Version: 4, Terminals: []string{"../x"}}, nil); rep.OK || rep.Code != "bad_params" {
		t.Errorf("a bad address: %+v", rep)
	}
	// Its files stay while its terminal core runs.
	if rep := call(t, env, agentproto.MigrateActionRemove, nil, nil); rep.OK || rep.Code != "running" {
		t.Errorf("remove while running: %+v", rep)
	}
}

// Without a running core the namespace's files can go: its data directory
// and herdr-core's state of its session; this namespace's stay.
func TestRemove(t *testing.T) {
	env, prev := setup(t, nil)
	t.Setenv("XDG_STATE_HOME", filepath.Join(env.Home, "state"))
	state := filepath.Join(env.Home, "state", "herdr-core", "oldname-dev")
	os.MkdirAll(state, 0o700)
	var st agentproto.MigrateStatus
	if rep := call(t, env, agentproto.MigrateActionStatus, nil, &st); !rep.OK || st.Slug != "oldname" || st.Running {
		t.Fatalf("status %+v %+v", rep, st)
	}
	if rep := call(t, env, agentproto.MigrateActionRemove, nil, nil); !rep.OK {
		t.Fatalf("remove %+v", rep)
	}
	for _, p := range []string{prev, state} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s left", p)
		}
	}
	if _, err := os.Stat(env.Base); err != nil {
		t.Error("this namespace's directory went")
	}
	var after agentproto.MigrateStatus
	if rep := call(t, env, agentproto.MigrateActionStatus, nil, &after); !rep.OK || after.Slug != "" {
		t.Errorf("after: %+v", after)
	}
}
