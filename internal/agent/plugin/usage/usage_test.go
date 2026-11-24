//go:build unix

package usage

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"veldr/internal/agent/plugin"
	"veldr/internal/agentproto"
	"veldr/internal/usage"
)

func call(t *testing.T, e *plugin.Env, action, params string) agentproto.Reply {
	t.Helper()
	a, b := net.Pipe()
	go handle(context.Background(), a, action, json.RawMessage(params), e)
	var rep agentproto.Reply
	if err := agentproto.ReadLine(b, &rep); err != nil {
		t.Fatal(err)
	}
	return rep
}

func TestActions(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", "")
	t.Setenv("OPENCODE_DB", "")
	e := &plugin.Env{Home: home, Base: filepath.Join(home, ".app"), Environ: func() []string { return nil }}
	if plugin.Lookup("usage") == nil {
		t.Fatal("not registered")
	}
	// No CLI is signed in: the providers are missing and nothing is asked.
	rep := call(t, e, "limits", `{"providers":["claude","kimi"]}`)
	var lim struct {
		Accounts []struct{ Provider, Status string }
	}
	if !rep.OK || json.Unmarshal(rep.Plugin, &lim) != nil || len(lim.Accounts) != 2 || lim.Accounts[0].Status != "missing" {
		t.Fatalf("limits %+v %s", rep, rep.Plugin)
	}
	rep = call(t, e, "cost", `{"since":0}`)
	if !rep.OK || !strings.Contains(string(rep.Plugin), `"rows":[]`) {
		t.Fatalf("cost %+v %s", rep, rep.Plugin)
	}
	rep = call(t, e, "setDeepseekKey", `{"key":"sk-abc"}`)
	if !rep.OK || strings.Contains(string(rep.Plugin), "sk-abc") {
		t.Fatalf("set key %+v", rep)
	}
	if b, err := os.ReadFile(filepath.Join(e.Base, "usage/deepseek.key")); err != nil || strings.TrimSpace(string(b)) != "sk-abc" {
		t.Fatalf("key file %q %v", b, err)
	}
	if rep = call(t, e, "setDeepseekKey", `{"key":"two words"}`); rep.OK || rep.Code != "bad_key" || strings.Contains(rep.Error, "two words") {
		t.Errorf("bad key %+v", rep)
	}
	if rep = call(t, e, "nope", `{}`); rep.OK || rep.Code != "bad_params" {
		t.Errorf("unknown action %+v", rep)
	}
	if rep = call(t, e, "limits", `[1]`); rep.OK || rep.Code != "bad_params" {
		t.Errorf("bad params %+v", rep)
	}
	// The user's prices as the setting makes them, nothing else.
	many := map[string]any{}
	for i := range usage.MaxOwnPrices + 1 {
		many[fmt.Sprintf("m%d", i)] = map[string]float64{"input": 1}
	}
	tooMany, _ := json.Marshal(map[string]any{"prices": many})
	for _, bad := range []string{
		string(tooMany),
		`{"prices":{"":{"input":1}}}`,
		`{"prices":{"grok-5":{"input":-1}}}`,
		`{"prices":{"grok-5":{"input":1,"inputMax":5}}}`,
		`{"prices":{"grok-5":{"input":1,"cacheWrite":20000}}}`,
	} {
		if rep = call(t, e, "cost", bad); rep.OK || rep.Code != "bad_params" {
			t.Errorf("prices %s: %+v", bad, rep)
		}
	}
	if rep = call(t, e, "cost", `{"prices":{"grok-5":{"input":3,"cached":0.75,"output":9}}}`); !rep.OK {
		t.Errorf("good prices %+v", rep)
	}
	// OpenCode's sessions, from its database in the XDG data directory.
	db, err := os.ReadFile("../../../usage/testdata/opencode/opencode.db")
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(home, ".local/share/opencode"), 0o700)
	os.WriteFile(filepath.Join(home, ".local/share/opencode/opencode.db"), db, 0o600)
	rep = call(t, e, "cost", `{"since":0,"providers":["opencode"]}`)
	var cost usage.CostReport
	if !rep.OK || json.Unmarshal(rep.Plugin, &cost) != nil || len(cost.Rows) == 0 || cost.Rows[0].Provider != usage.OpenCode {
		t.Errorf("OpenCode's cost %+v %s", rep, rep.Plugin)
	}
}

func TestCostEndsWhenTheCoreStopsWaiting(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	ctx, cancel := untilClosed(context.Background(), a, time.Minute)
	defer cancel()
	b.Close()
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("not cancelled when the stream closed")
	}
}
