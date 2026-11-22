//go:build unix

package agent

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
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
	// get answers terminal.get (a result or an error member), killed are
	// the terminals terminal.kill was asked to kill; after a kill get
	// answers with afterKill.
	get, afterKill string
	gets           []map[string]any
	killed         []string
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
		if json.Unmarshal(payload, &req) != nil {
			continue
		}
		f.mu.Lock()
		var answer string
		switch req.Method {
		case "terminal.run":
			f.runs = append(f.runs, req.Params)
			answer = f.answer
		case "terminal.get":
			f.gets = append(f.gets, req.Params)
			answer = f.get
		case "terminal.kill":
			f.killed = append(f.killed, fmt.Sprint(req.Params["terminal"]))
			f.get, answer = f.afterKill, `"result":{}`
		default:
			f.mu.Unlock()
			continue
		}
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
// when it exits, in the user's home, with only the user's variables of the
// agent's environment (home, user, shell, PATH, locale, TMPDIR, XDG): none
// of the terminal it was started in, of an ssh session, of a terminal's
// identity, nor any other.
func TestRunHidden(t *testing.T) {
	t.Setenv("HIDDEN_TEST", "dropped")
	t.Setenv("OPENAI_API_KEY", "sk-secret")
	t.Setenv("LC_ALL", "C.UTF-8")
	t.Setenv("XDG_CONFIG_HOME", "/x/config")
	t.Setenv("TMPDIR", "/x/tmp")
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
	if env["HOME"] != a.home || env["PATH"] != os.Getenv("PATH") || env["LC_ALL"] != "C.UTF-8" || env["XDG_CONFIG_HOME"] != "/x/config" || env["TMPDIR"] != "/x/tmp" {
		t.Errorf("the helper lacks the user's variables: %v", env)
	}
	for k := range env {
		if !hiddenVar(k) || k == "HIDDEN_TEST" || k == "OPENAI_API_KEY" || k == "TERMINFO" {
			t.Errorf("the helper got %s", k)
		}
	}

	// The name is the lock: a terminal that has it with the helper's hidden
	// identity is the helper running.
	helperRec, _ := json.Marshal(map[string]any{"address": "t3", "name": agentproto.ChatHostName, "state": "live",
		"argv": argv, "labels": map[string]string{agentproto.HiddenLabel: agentproto.HiddenChatHost}})
	core.mu.Lock()
	core.get = `"result":` + string(helperRec)
	core.mu.Unlock()
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

// A chat host's terminal that holds its name and does not serve is killed
// through the terminal core, once it is known to be one (its hidden label,
// the chat host's arguments, of any build's program), and the name waited
// for; another terminal of the name is left alone. Plugins have it
// (plugin.Env.KillHidden).
func TestKillHidden(t *testing.T) {
	a := hiddenAgent(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	argv := []string{"/new/agent", "chat-host", "--base", a.base, "--run", a.runDir}
	if _, err := killHidden(ctx, a.hcSocket(), agentproto.ChatHostName, argv, true); !errors.Is(err, plugin.ErrNoTerminalCore) {
		t.Fatalf("without a terminal core: %v", err)
	}
	ln, err := net.Listen("unix", a.hcSocket())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	core := &hiddenCore{}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go core.serve(c)
		}
	}()
	record := func(label string, args ...string) string {
		b, _ := json.Marshal(map[string]any{"address": "t9", "name": agentproto.ChatHostName, "state": "live",
			"argv": append([]string{"/old/agent"}, args...), "labels": map[string]string{agentproto.HiddenLabel: label}})
		return `"result":` + string(b)
	}
	set := func(get, after string) {
		core.mu.Lock()
		core.get, core.afterKill, core.killed = get, after, nil
		core.mu.Unlock()
	}
	gone := `"error":{"code":-32000,"message":"no terminal","data":{"kind":"not_found"}}`

	set(gone, "")
	if ok, err := killHidden(ctx, a.hcSocket(), agentproto.ChatHostName, argv, true); ok || err != nil {
		t.Errorf("no terminal of the name: %v %v", ok, err)
	}
	for _, rec := range []string{record("other", argv[1:]...), record(agentproto.HiddenChatHost, "chat-host", "--base", "/x", "--run", a.runDir)} {
		set(rec, gone)
		if ok, err := killHidden(ctx, a.hcSocket(), agentproto.ChatHostName, argv, true); ok || !errors.Is(err, errNotHelper) {
			t.Errorf("another terminal: %v %v", ok, err)
		}
	}
	set(record(agentproto.HiddenChatHost, argv[1:]...), gone)
	if ok, err := killHidden(ctx, a.hcSocket(), agentproto.ChatHostName, argv, false); !ok || err != nil {
		t.Errorf("held: %v %v", ok, err)
	}
	core.mu.Lock()
	if len(core.killed) != 0 || core.gets[len(core.gets)-1]["terminal"] != agentproto.ChatHostName {
		t.Errorf("asked: killed %v, got %v", core.killed, core.gets)
	}
	core.mu.Unlock()
	if ok, err := killHidden(ctx, a.hcSocket(), agentproto.ChatHostName, argv, true); !ok || err != nil {
		t.Errorf("kill: %v %v", ok, err)
	}
	core.mu.Lock()
	if len(core.killed) != 1 || core.killed[0] != "t9" {
		t.Errorf("killed %v", core.killed)
	}
	core.mu.Unlock()

	env := a.pluginEnv()
	if env.KillHidden == nil {
		t.Fatal("plugins cannot kill a stuck helper")
	}
	set(record(agentproto.HiddenChatHost, argv[1:]...), gone)
	if ok, err := env.KillHidden(ctx, agentproto.ChatHostName, argv, false); !ok || err != nil {
		t.Errorf("through the plugins' env: %v %v", ok, err)
	}
}

// When a user manually starts a terminal named herdr-ide-chat-host (without
// the hidden label/argv), runHidden leaves it alone and starts the chat host
// under a disambiguated hidden fallback name, and killHidden only ever kills
// the fallback helper (never the user's terminal).
func TestRunAndKillHiddenFallback(t *testing.T) {
	a := hiddenAgent(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	argv := []string{"/opt/agent", "chat-host", "--base", a.base, "--run", a.runDir}

	ln, err := net.Listen("unix", a.hcSocket())
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	var mu sync.Mutex
	terms := map[string]map[string]any{
		agentproto.ChatHostName: {
			"address": "t1",
			"name":    agentproto.ChatHostName,
			"state":   "live",
			"argv":    []string{"zsh"},
			"labels":  map[string]string{},
		},
	}
	var killed []string
	var runs []map[string]any

	serve := func(c net.Conn) {
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
			if json.Unmarshal(payload, &req) != nil {
				continue
			}
			mu.Lock()
			var answer string
			switch req.Method {
			case "terminal.run":
				runs = append(runs, req.Params)
				name, _ := req.Params["name"].(string)
				if _, exists := terms[name]; exists {
					answer = `"error":{"code":-32000,"message":"name taken","data":{"kind":"name_taken"}}`
				} else {
					addr := fmt.Sprintf("t%d", len(terms)+1)
					terms[name] = map[string]any{
						"address": addr,
						"name":    name,
						"state":   "live",
						"argv":    req.Params["argv"],
						"labels":  req.Params["labels"],
					}
					b, _ := json.Marshal(map[string]string{"address": addr})
					answer = `"result":` + string(b)
				}
			case "terminal.get":
				target, _ := req.Params["terminal"].(string)
				if rec, ok := terms[target]; ok {
					b, _ := json.Marshal(rec)
					answer = `"result":` + string(b)
				} else {
					answer = `"error":{"code":-32000,"message":"no terminal","data":{"kind":"not_found"}}`
				}
			case "terminal.kill":
				addr, _ := req.Params["terminal"].(string)
				killed = append(killed, addr)
				for k, rec := range terms {
					if rec["address"] == addr {
						delete(terms, k)
					}
				}
				answer = `"result":{}`
			}
			mu.Unlock()
			id, _ := json.Marshal(req.ID)
			body := []byte(`{"jsonrpc":"2.0","id":` + string(id) + `,` + answer + `}`)
			frame := binary.LittleEndian.AppendUint32(nil, 0)
			frame = append(frame, 0)
			frame = binary.LittleEndian.AppendUint32(frame, uint32(len(body)))
			c.Write(append(frame, body...))
		}
	}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go serve(c)
		}
	}()

	if err := a.runHidden(ctx, agentproto.ChatHostName, argv); err != nil {
		t.Fatalf("runHidden with user collision: %v", err)
	}
	fb := agentproto.ChatHostFallbackName(1)
	mu.Lock()
	fbRec := terms[fb]
	userRec := terms[agentproto.ChatHostName]
	mu.Unlock()
	if fbRec == nil || userRec == nil || userRec["address"] != "t1" {
		t.Fatalf("terms after run: fb=%v user=%v", fbRec, userRec)
	}

	// Second runHidden finds the running fallback helper and does not start another.
	if err := a.runHidden(ctx, agentproto.ChatHostName, argv); err != nil {
		t.Fatalf("second runHidden: %v", err)
	}
	mu.Lock()
	if terms[agentproto.ChatHostFallbackName(2)] != nil {
		t.Fatal("started a second fallback helper")
	}
	mu.Unlock()

	// killHidden detects and kills only the fallback helper, leaving user's t1 untouched.
	if ok, err := a.killHidden(ctx, agentproto.ChatHostName, argv, false); !ok || err != nil {
		t.Fatalf("killHidden(false): ok=%v err=%v", ok, err)
	}
	if ok, err := a.killHidden(ctx, agentproto.ChatHostName, argv, true); !ok || err != nil {
		t.Fatalf("killHidden(true): ok=%v err=%v", ok, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(killed) != 1 || killed[0] != "t2" || terms[agentproto.ChatHostName] == nil {
		t.Fatalf("killed=%v userTerm=%v", killed, terms[agentproto.ChatHostName])
	}
}
