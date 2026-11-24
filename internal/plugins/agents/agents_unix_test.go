//go:build unix

package agents

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agentplugin "veldr/internal/agent/plugin"
	_ "veldr/internal/agent/plugin/agents"
	"veldr/internal/agentproto"
	"veldr/internal/machines"
	"veldr/internal/plugin"
)

// machineSide runs the actions on the machine side's handler in this
// process, over a pipe, as an agent's plugin op does: the reply's line,
// then its body when it has one; the pipe is closed when ctx ends.
func machineSide(env *agentplugin.Env) func(ctx context.Context, mc *machines.Machine, action string, params, out any) error {
	return func(ctx context.Context, mc *machines.Machine, action string, params, out any) error {
		h := agentplugin.Lookup(ID)
		b, err := json.Marshal(params)
		if err != nil {
			return err
		}
		a, c := net.Pipe()
		defer c.Close()
		stop := context.AfterFunc(ctx, func() { c.Close() })
		defer stop()
		go h(context.Background(), a, action, b, env)
		var rep agentproto.Reply
		if err := agentproto.ReadLine(c, &rep); err != nil {
			return &plugin.Error{Code: "transport", Message: err.Error()}
		}
		if !rep.OK {
			return &plugin.Error{Code: rep.Code, Message: rep.Error}
		}
		res := []byte(rep.Plugin)
		if rep.PluginLength > 0 {
			if res, err = agentproto.ReadBody(c, rep.PluginLength); err != nil {
				return &plugin.Error{Code: "transport", Message: err.Error()}
			}
		}
		return json.Unmarshal(res, out)
	}
}

// The route with the machine side's own handler: the action's name and
// shapes agree.
func TestWithTheMachineSide(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("CODEX_HOME", "")
	v, err := os.ReadFile(filepath.Join("../../../design/testdata/transcript", "claude-2.1.330-tools.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vec struct {
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal(v, &vec); err != nil {
		t.Fatal(err)
	}
	data := strings.Join(vec.Lines, "\n") + "\n"
	file := filepath.Join(home, ".claude", "projects", "-home-dev-project", sid1+".jsonl")
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	p, _, mg := testPlugin(t)
	p.call = machineSide(&agentplugin.Env{Home: home})
	mc := mg.Get("box")

	w := do(context.Background(), p.getResolve, mc, "resolve", "kind=claude&session="+sid1+"&cwd=/home/dev/project/")
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"ok":true}` {
		t.Fatalf("resolve: %d %s", w.Code, w.Body)
	}
	w = do(context.Background(), p.getResolve, mc, "resolve", "kind=claude&session="+sid1+"&cwd=/home/dev")
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"ok":false,"code":"other_cwd"}` {
		t.Fatalf("resolve elsewhere: %d %s", w.Code, w.Body)
	}
	w = do(context.Background(), p.getResolve, mc, "resolve", "kind=codex&session="+sid2+"&cwd=/home/dev/project")
	if w.Code != http.StatusOK || strings.TrimSpace(w.Body.String()) != `{"ok":false,"code":"not_found"}` {
		t.Fatalf("resolve of no transcript: %d %s", w.Code, w.Body)
	}
}
