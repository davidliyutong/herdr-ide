//go:build unix && integration

// Moves from a previous name's namespace whose terminal core is a real
// herdr-core, in an isolated session with its own state and home:
//
//	HC_TEST_BIN=/path/to/herdr-core go test -tags integration ./internal/agent/plugin/migrate -run Integration -v
package migrate

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"veldr/internal/agent/plugin"
	"veldr/internal/agentproto"
	"veldr/internal/brand"
	"veldr/internal/hc"
)

// The previous namespace of instance "it": scanned with what runs in its
// terminals, released (layout written at its version, the moved terminal
// ended, the other left), its core stopped and its files removed.
func TestIntegrationMigrate(t *testing.T) {
	bin := os.Getenv("HC_TEST_BIN")
	if bin == "" {
		t.Skip("herdr-core not given (HC_TEST_BIN)")
	}
	home, err := os.MkdirTemp("/tmp", "mit")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	old := brand.LegacySlugs
	brand.LegacySlugs = []string{"oldname"}
	t.Cleanup(func() { brand.LegacySlugs = old })
	state, cfg := filepath.Join(home, "state"), filepath.Join(home, "cfg")
	t.Setenv("XDG_STATE_HOME", state)
	prev := filepath.Join(home, ".oldname-it")
	for _, d := range []string{filepath.Join(prev, "run"), filepath.Join(prev, "hc"), filepath.Join(home, brand.DataDir("it")), state, cfg} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// The previous version's executable, where its stop finds it.
	exe, err := os.ReadFile(bin)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prev, "hc", "herdr-core"), exe, 0o700); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(prev, "run", "hc.sock")
	environ := []string{"HOME=" + home, "PATH=" + os.Getenv("PATH"), "HC_SESSION=oldname-it", "HC_SOCKET=" + socket, "XDG_STATE_HOME=" + state, "XDG_CONFIG_HOME=" + cfg}
	core := func(args ...string) ([]byte, error) {
		cmd := exec.Command(bin, args...)
		cmd.Env = environ
		return cmd.CombinedOutput()
	}
	if out, err := core("server", "start", "--json"); err != nil {
		t.Fatalf("server start: %v: %s", err, out)
	}
	t.Cleanup(func() { core("server", "stop", "--json") })
	t.Setenv("HOME", home)
	env := &plugin.Env{Home: home, Base: filepath.Join(home, brand.DataDir("it")), Logger: log.New(io.Discard, "", 0)}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	ns := find(env)
	conn, _, err := ns.dial(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	run := func() string {
		var term hc.Terminal
		if err := conn.Call(ctx, "terminal.run", map[string]any{"argv": []string{"/bin/sh"}, "cwd": home, "size": map[string]int{"cols": 80, "rows": 24}}, &term); err != nil {
			t.Fatal(err)
		}
		return term.Address
	}
	shell, busy := run(), run()
	s, _, err := conn.Attach(ctx, hc.AttachParams{Terminal: busy, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	s.Write([]byte("cd /tmp && sleep 600\r"))
	s.Close()
	layout := json.RawMessage(`{"version":2,"selected":0,"workspaces":[{"id":"w","name":"x","cwd":"","selected":0,"tabs":[{"root":{"terminal":"` + busy + `"},"focused":"` + busy + `"}]}]}`)
	if err := conn.Call(ctx, "doc.set", map[string]any{"name": layoutDocument, "value": layout, "version": 0}, nil); err != nil {
		t.Fatal(err)
	}

	// The scan sees sleep in the foreground, in its directory.
	var scan agentproto.MigrateScan
	for i := 0; ; i++ {
		scan = agentproto.MigrateScan{}
		if rep := call(t, env, agentproto.MigrateActionScan, nil, &scan); !rep.OK {
			t.Fatalf("scan: %+v", rep)
		}
		found := false
		for _, x := range scan.Terminals {
			found = found || x.Address == busy && x.Program == "sleep" && filepath.Base(x.Cwd) == "tmp"
		}
		if found {
			break
		}
		if i > 100 {
			t.Fatalf("scan: %+v", scan.Terminals)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !scan.Running || len(scan.Terminals) != 2 || scan.LayoutVersion == 0 {
		t.Fatalf("scan %+v", scan)
	}
	var doc map[string]any
	if json.Unmarshal(scan.Layout, &doc) != nil || doc["version"] != float64(2) {
		t.Fatalf("layout %s", scan.Layout)
	}

	rest := json.RawMessage(`{"version":2,"selected":0,"workspaces":[]}`)
	if rep := call(t, env, agentproto.MigrateActionRelease, agentproto.MigrateRelease{Layout: rest, Version: scan.LayoutVersion, Terminals: []string{busy}}, nil); !rep.OK {
		t.Fatalf("release: %+v", rep)
	}
	for i := 0; ; i++ {
		var st agentproto.MigrateStatus
		call(t, env, agentproto.MigrateActionStatus, nil, &st)
		if st.Terminals == 1 {
			break
		}
		if i > 100 {
			t.Fatalf("the moved terminal still runs: %+v", st)
		}
		time.Sleep(100 * time.Millisecond)
	}
	var after agentproto.MigrateScan
	call(t, env, agentproto.MigrateActionScan, nil, &after)
	if len(after.Terminals) != 1 || after.Terminals[0].Address != shell || after.LayoutVersion <= scan.LayoutVersion {
		t.Fatalf("after release: %+v", after)
	}
	if rep := call(t, env, agentproto.MigrateActionRelease, agentproto.MigrateRelease{Layout: rest, Version: scan.LayoutVersion}, nil); rep.Code != "conflict" {
		t.Fatalf("a stale release: %+v", rep)
	}

	conn.Close()
	if rep := call(t, env, agentproto.MigrateActionStop, nil, nil); !rep.OK {
		t.Fatalf("stop: %+v", rep)
	}
	var st agentproto.MigrateStatus
	if call(t, env, agentproto.MigrateActionStatus, nil, &st); st.Running {
		t.Fatal("still running after stop")
	}
	if rep := call(t, env, agentproto.MigrateActionRemove, nil, nil); !rep.OK {
		t.Fatalf("remove: %+v", rep)
	}
	for _, p := range []string{prev, filepath.Join(state, "herdr-core", "oldname-it")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s left", p)
		}
	}
}
