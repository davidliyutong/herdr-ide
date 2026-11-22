//go:build unix

package agent

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
)

// hiddenCore is a terminal core on an agent's socket that takes
// terminal.run: it keeps the parameters and answers with answer, a result
// or an error member of the reply.
type hiddenCore struct {
	mu     sync.Mutex
	answer string
	runs   []map[string]any
}

func (f *hiddenCore) set(answer string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answer = answer
}

func (f *hiddenCore) last(t *testing.T) map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.runs) == 0 {
		t.Fatal("the terminal core got no terminal.run")
	}
	return f.runs[len(f.runs)-1]
}

func (f *hiddenCore) serve(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	if _, err := br.ReadString('\n'); err != nil {
		return
	}
	io.WriteString(c, `{"jsonrpc":"2.0","id":0,"result":{"generation":1,"version":"9.9.9","framed":true}}`+"\n")
	for {
		var h [9]byte
		if _, err := io.ReadFull(br, h[:]); err != nil {
			return
		}
		payload := make([]byte, binary.LittleEndian.Uint32(h[5:]))
		if _, err := io.ReadFull(br, payload); err != nil {
			return
		}
		var req struct {
			ID     uint64         `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if json.Unmarshal(payload, &req) != nil || req.Method != "terminal.run" {
			continue
		}
		f.mu.Lock()
		f.runs = append(f.runs, req.Params)
		answer := f.answer
		f.mu.Unlock()
		id, _ := json.Marshal(req.ID)
		body := []byte(`{"jsonrpc":"2.0","id":` + string(id) + `,` + answer + `}`)
		frame := binary.LittleEndian.AppendUint32(nil, 0)
		frame = append(frame, 0)
		frame = binary.LittleEndian.AppendUint32(frame, uint32(len(body)))
		c.Write(append(frame, body...))
	}
}

// hiddenAgent is an agent whose run directory is short enough for a socket.
func hiddenAgent(t *testing.T) *Agent {
	t.Helper()
	home, err := os.MkdirTemp("/tmp", "hid")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("HOME", home)
	base := filepath.Join(home, ".x")
	run := filepath.Join(base, "run")
	if err := os.MkdirAll(run, 0o700); err != nil {
		t.Fatal(err)
	}
	return &Agent{logger: log.New(io.Discard, "", 0), home: home, base: base, runDir: run}
}

// A helper runs as a terminal of the terminal core that carries the label
// which hides it, under its name, without a parent, not notifying, removed
// when it exits, in the user's home, with the agent's environment for the
// programs it starts but for the variables of the terminal it was started
// in, of an ssh session and of a terminal's identity.
func TestRunHidden(t *testing.T) {
	t.Setenv("HIDDEN_TEST", "kept")
	t.Setenv("HC_TERMINAL_ID", "t7")
	t.Setenv("TMUX", "/tmp/tmux-1/default,1,0")
	t.Setenv("SSH_CONNECTION", "10.0.0.1 22 10.0.0.2 22")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/ssh-x/agent.1")
	t.Setenv("TERM", "xterm-256color")
	t.Setenv("TERM_PROGRAM", "iTerm.app")
	t.Setenv("TERM_PROGRAM_VERSION", "3")
	t.Setenv("COLORTERM", "truecolor")
	t.Setenv("TERMINFO", "/usr/share/terminfo")
	a := hiddenAgent(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	argv := []string{"/opt/agent", "chat-host", "--base", a.base, "--run", a.runDir}

	// No terminal core: the agent starts none, and says so.
	if err := a.runHidden(ctx, agentproto.ChatHostName, argv); !errors.Is(err, plugin.ErrNoTerminalCore) {
		t.Fatalf("without a terminal core: %v", err)
	}

	ln, err := net.Listen("unix", a.hcSocket())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	core := &hiddenCore{answer: `"result":{"address":"t3"}`}
	var silent sync.Mutex // held: what listens is no terminal core
	closing := false
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			silent.Lock()
			drop := closing
			silent.Unlock()
			if drop {
				c.Close()
				continue
			}
			go core.serve(c)
		}
	}()

	if err := a.runHidden(ctx, agentproto.ChatHostName, argv); err != nil {
		t.Fatal(err)
	}
	p := core.last(t)
	env, _ := p["env"].(map[string]any)
	delete(p, "env")
	want := map[string]any{
		"argv": []any{"/opt/agent", "chat-host", "--base", a.base, "--run", a.runDir},
		"cwd":  a.home,
		"name": agentproto.ChatHostName, "labels": map[string]any{agentproto.HiddenLabel: agentproto.HiddenChatHost},
		"size":      map[string]any{"cols": float64(80), "rows": float64(24)},
		"no_parent": true, "no_notify": true, "rm": true,
	}
	if !reflect.DeepEqual(p, want) {
		t.Errorf("terminal.run with\n %v\nwant\n %v", p, want)
	}
	if env["HIDDEN_TEST"] != "kept" || env["HOME"] != a.home || env["TERMINFO"] != "/usr/share/terminfo" {
		t.Errorf("the helper lacks the agent's environment: HIDDEN_TEST=%v HOME=%v TERMINFO=%v", env["HIDDEN_TEST"], env["HOME"], env["TERMINFO"])
	}
	for k := range env {
		if strings.HasPrefix(k, "HC_") || strings.HasPrefix(k, "SSH_") || k == "TMUX" || k == "TERM" || k == "COLORTERM" || strings.HasPrefix(k, "TERM_PROGRAM") {
			t.Errorf("the helper got %s", k)
		}
	}

	// The name is the lock: a terminal that has it is the helper running.
	core.set(`"error":{"code":-32000,"message":"a live terminal is already named \"herdr-ide-chat-host\"","data":{"kind":"name_taken"}}`)
	if err := a.runHidden(ctx, agentproto.ChatHostName, argv); err != nil {
		t.Errorf("a name that is taken: %v", err)
	}
	// Any other answer is the terminal core's error.
	core.set(`"error":{"code":-32000,"message":"no such file","data":{"kind":"spawn_failed"}}`)
	if err := a.runHidden(ctx, agentproto.ChatHostName, argv); err == nil || errors.Is(err, plugin.ErrNoTerminalCore) || !strings.Contains(err.Error(), "spawn_failed") {
		t.Errorf("a program that does not start: %v", err)
	}
	// What listens on the socket without answering is no terminal core.
	silent.Lock()
	closing = true
	silent.Unlock()
	if err := a.runHidden(ctx, agentproto.ChatHostName, argv); !errors.Is(err, plugin.ErrNoTerminalCore) {
		t.Errorf("a socket that does not answer: %v", err)
	}
}

// Plugins get the runner.
func TestPluginEnvRunsHidden(t *testing.T) {
	a := hiddenAgent(t)
	env := a.pluginEnv()
	if env.RunHidden == nil {
		t.Fatal("plugins have no RunHidden")
	}
	if err := env.RunHidden(context.Background(), agentproto.ChatHostName, []string{"/bin/true"}); !errors.Is(err, plugin.ErrNoTerminalCore) {
		t.Fatalf("without a terminal core: %v", err)
	}
}
